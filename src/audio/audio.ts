/**
 * ÉCHO — tout le son du jeu, 100 % procédural (Web Audio API).
 * Aucun fichier audio, aucune dépendance, aucun import du projet.
 *
 * Graphe :
 *   voix SFX ──► bus SFX ───────────────┐
 *        └────► envoi réverbe ─┐        ├─► gain maître ─► compresseur ─► sortie
 *   voix musique ─► porte ─► bus musique┤
 *                              └─► envoi réverbe ─► convolution ─► retour ─┘
 *
 * Toutes les méthodes publiques sont sans effet (et ne lèvent jamais d'erreur)
 * tant que init() n'a pas été appelé, ou si AudioContext n'existe pas (Node, tests).
 */

export type LoopEndKind = 'added' | 'replaced' | 'discarded' | 'empty';

/** Valeur plancher des enveloppes exponentielles (jamais 0 : interdit par l'API). */
const EPS = 0.0001;
/** Nombre de pas du séquenceur par boucle de jeu. */
const STEPS = 32;
/** Période du planificateur (ms) et horizon de planification (s). */
const TICK_MS = 25;
const LOOKAHEAD = 0.12;

/** Gamme pentatonique majeure (demi-tons) pour les ramassages d'éclats. */
const PENTA = [0, 2, 4, 7, 9];
/** Ré mineur pentatonique (notes MIDI) pour l'arpège de la musique. */
const ARP_SCALE = [62, 65, 67, 69, 72, 74, 77, 79, 81];
/** Motif de l'arpège sur les 32 pas : index dans ARP_SCALE, -1 = silence. */
const ARP_PATTERN = [
  0, -1, 2, -1, 4, -1, 3, -1,
  2, -1, -1, 5, -1, 4, -1, -1,
  1, -1, 3, -1, 5, -1, 4, -1,
  6, -1, -1, 4, -1, 2, -1, -1,
];
/** Les trois accords de la nappe (notes MIDI) : Rém7, Si♭maj7, Do sus2. */
const CHORDS = [
  [50, 57, 60, 65],
  [46, 53, 57, 62],
  [48, 55, 62, 67],
];

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  sfxBus: GainNode;
  musicBus: GainNode;
  /** Porte de la musique : 0 quand elle est arrêtée, 1 sinon. */
  musicGate: GainNode;
  /** Entrée de la réverbération (envoi). */
  reverb: ConvolverNode;
  /** Bruit blanc partagé, créé une seule fois. */
  noise: AudioBuffer;
}

interface OutOpts {
  /** Niveau d'envoi vers la réverbe (0 = sec). */
  send?: number;
  /** Panoramique -1..1. */
  pan?: number;
  /** Destination (bus SFX par défaut). */
  dest?: AudioNode;
}

interface ToneOpts extends OutOpts {
  at: number;
  type?: OscillatorType;
  /** Fréquence de départ (Hz) et, si glissando, fréquence d'arrivée. */
  f: number;
  f2?: number;
  /** Attaque et déclin (s). */
  a?: number;
  d: number;
  /** Gain de crête. */
  g: number;
  /** Passe-bas optionnel (Hz) pour adoucir. */
  lp?: number;
  /** Vibrato (pleurage de bande) : fréquence et profondeur en Hz. */
  vib?: { rate: number; depth: number };
}

interface NoiseOpts extends OutOpts {
  at: number;
  filter: BiquadFilterType;
  f: number;
  f2?: number;
  q?: number;
  a?: number;
  d: number;
  g: number;
}

interface FmOpts extends OutOpts {
  at: number;
  /** Porteuse (Hz). */
  f: number;
  /** Rapport modulante/porteuse (non entier = timbre de cristal/cloche). */
  ratio: number;
  /** Indice de modulation à l'attaque (retombe vers ~0 pendant le déclin). */
  index: number;
  a?: number;
  d: number;
  g: number;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
/** Remplace NaN/Infinity par une valeur par défaut. */
const fin = (x: number, def: number): number => (Number.isFinite(x) ? x : def);
/** Variation aléatoire de hauteur de ±3 % (évite l'effet mitraillette). */
const vary = (amount = 0.03): number => 1 + (Math.random() * 2 - 1) * amount;
const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);
const semi = (n: number): number => Math.pow(2, n / 12);
const hz = (f: number): number => clamp(f, 20, 18000);

type AudioCtor = new () => AudioContext;

function findAudioContext(): AudioCtor | null {
  const g = globalThis as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export class GameAudio {
  private gr: Graph | null = null;
  private masterVol = 0.8;
  private musicVol = 0.5;
  private paused = false;

  // --- musique ---
  private loopDur = 12;
  private musicOn = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private nextStepTime = 0;
  /** Dernier pas planifié et son instant (pour réaligner sans doubler une note). */
  private lastStep = -1;
  private lastStepTime = -1;
  private chordIdx = 0;
  private padEnd = 0;

  // --- limiteurs de débit ---
  private lastShardAt = -1;
  private echoWinStart = -1;
  private echoWinCount = 0;

  // ───────────────────────────── cycle de vie ─────────────────────────────

  /** Crée (ou reprend) l'AudioContext. À appeler sur un geste utilisateur. Idempotent. */
  init(): void {
    try {
      if (this.gr) {
        if (!this.paused && this.gr.ctx.state !== 'running') void this.gr.ctx.resume().catch(() => undefined);
        return;
      }
      const Ctor = findAudioContext();
      if (!Ctor) return;
      const ctx = new Ctor();

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
      comp.connect(ctx.destination);

      const master = ctx.createGain();
      master.gain.value = this.masterVol;
      master.connect(comp);

      const sfxBus = ctx.createGain();
      sfxBus.gain.value = 0.9;
      sfxBus.connect(master);

      const musicBus = ctx.createGain();
      musicBus.gain.value = this.musicLevel();
      musicBus.connect(master);

      const musicGate = ctx.createGain();
      musicGate.gain.value = 0;
      musicGate.connect(musicBus);

      // Réverbération : convolution d'un bruit décroissant, en envoi.
      const reverb = ctx.createConvolver();
      reverb.buffer = this.makeImpulse(ctx, 1.7);
      const reverbReturn = ctx.createGain();
      reverbReturn.gain.value = 0.55;
      reverb.connect(reverbReturn);
      reverbReturn.connect(master);

      const musicSend = ctx.createGain();
      musicSend.gain.value = 0.5;
      musicBus.connect(musicSend);
      musicSend.connect(reverb);

      // Bruit blanc partagé (2 s, mono).
      const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      this.gr = { ctx, master, sfxBus, musicBus, musicGate, reverb, noise };
      if (this.paused) void ctx.suspend().catch(() => undefined);
      else if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    } catch {
      this.gr = null;
    }
  }

  /** Volumes 0..1 (mémorisés même avant init()). */
  setVolume(master: number, music: number): void {
    this.masterVol = clamp(fin(master, this.masterVol), 0, 1);
    this.musicVol = clamp(fin(music, this.musicVol), 0, 1);
    const gr = this.gr;
    if (!gr) return;
    try {
      const t = gr.ctx.currentTime;
      gr.master.gain.setTargetAtTime(this.masterVol, t, 0.03);
      gr.musicBus.gain.setTargetAtTime(this.musicLevel(), t, 0.03);
    } catch {
      /* sans conséquence */
    }
  }

  /** Suspend ou reprend tout le contexte audio (menu pause). */
  setPaused(paused: boolean): void {
    this.paused = !!paused;
    const gr = this.gr;
    if (!gr) return;
    try {
      if (this.paused) void gr.ctx.suspend().catch(() => undefined);
      else void gr.ctx.resume().catch(() => undefined);
    } catch {
      /* sans conséquence */
    }
  }

  /** La pulsation musicale se cale sur la boucle : 32 pas par boucle. */
  setLoopDuration(seconds: number): void {
    this.loopDur = clamp(fin(seconds, this.loopDur), 2, 120);
  }

  /** Début de boucle : remet le séquenceur au pas 0. */
  syncLoop(): void {
    const gr = this.gr;
    if (!gr) return;
    const now = gr.ctx.currentTime;
    const sd = this.stepDur();
    // Si le pas 0 vient d'être planifié naturellement (à moins d'un demi-pas),
    // on garde la phase : inutile de rejouer la même note.
    if (this.lastStep === 0 && Math.abs(this.lastStepTime - now) < sd * 0.5) {
      this.step = 1;
      this.nextStepTime = this.lastStepTime + sd;
      return;
    }
    this.step = 0;
    this.nextStepTime = now + 0.02;
  }

  startMusic(): void {
    const gr = this.gr;
    if (!gr || this.musicOn) return;
    try {
      this.musicOn = true;
      const now = gr.ctx.currentTime;
      gr.musicGate.gain.cancelScheduledValues(now);
      gr.musicGate.gain.setTargetAtTime(1, now, 0.4);
      this.step = 0;
      this.nextStepTime = now + 0.05;
      this.lastStep = -1;
      this.padEnd = 0;
      if (this.timer === null) this.timer = setInterval(() => this.schedule(), TICK_MS);
    } catch {
      this.musicOn = false;
    }
  }

  stopMusic(): void {
    this.musicOn = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const gr = this.gr;
    if (!gr) return;
    try {
      // Les voix déjà planifiées s'éteignent derrière la porte puis s'arrêtent seules.
      const now = gr.ctx.currentTime;
      gr.musicGate.gain.cancelScheduledValues(now);
      gr.musicGate.gain.setTargetAtTime(0, now, 0.15);
    } catch {
      /* sans conséquence */
    }
  }

  // ───────────────────────────── combat ─────────────────────────────

  /** Tir du joueur. tier 0..4 : de plus en plus de grave et de corps. */
  shot(tier: number): void {
    this.play((t) => {
      const k = clamp(Math.round(fin(tier, 0)), 0, 4);
      const v = vary();
      // Corps tonal : « tchiou » court qui descend.
      this.tone({ at: t, type: 'triangle', f: (520 - k * 70) * v, f2: 150 - k * 20, d: 0.09 + k * 0.02, g: 0.26 });
      // Transitoire : claquement de bruit filtré.
      this.noise({ at: t, filter: 'bandpass', f: 2600 - k * 350, q: 0.8, d: 0.05 + k * 0.012, g: 0.2 + k * 0.03 });
      // Sous-grave à partir du deuxième palier.
      if (k >= 1) this.tone({ at: t, f: (110 - k * 12) * v, f2: 45, d: 0.12 + k * 0.04, g: 0.1 + k * 0.07 });
      // Grosses armes : queue de souffle réverbérée.
      if (k >= 3) this.noise({ at: t, filter: 'lowpass', f: 1400, f2: 300, d: 0.22 + (k - 3) * 0.08, g: 0.1, send: 0.35 });
    });
  }

  /** Impact sur une géode. stage 0..2 (fissures) : la hauteur monte. Cristallin et sec. */
  hit(stage: number): void {
    this.play((t) => {
      const s = clamp(Math.round(fin(stage, 0)), 0, 2);
      const f = 1250 * semi([0, 4, 7][s] ?? 0) * vary();
      this.fm({ at: t, f, ratio: 2.76, index: 1.5, d: 0.07, g: 0.15 });
      this.noise({ at: t, filter: 'highpass', f: 5000, d: 0.02, g: 0.11 });
      this.tone({ at: t, f: 320 * (1 + s * 0.15) * vary(), f2: 220, d: 0.05, g: 0.1 });
    });
  }

  /** Cassure d'une géode : cristal qui éclate + sous-grave. La hauteur monte par demi-tons avec le combo. */
  breakGeode(combo: number, big: boolean): void {
    this.play((t) => {
      const up = clamp(Math.floor(fin(combo, 0)), 0, 24);
      const base = (big ? 520 : 780) * semi(up) * vary();
      const dur = big ? 0.55 : 0.3;
      // Corps cristallin (FM légère) + partiel à la quinte, légèrement en retard.
      this.fm({ at: t, f: base, ratio: 3.51, index: 2.5, d: dur, g: 0.2, send: 0.35 });
      this.fm({ at: t + 0.025, f: base * 1.5, ratio: 2.4, index: 1.6, d: dur * 0.8, g: 0.1, send: 0.3 });
      // Éclatement : bruit aigu qui retombe.
      this.noise({ at: t, filter: 'bandpass', f: 6500, f2: 2400, q: 0.7, d: dur * 0.7, g: 0.22, send: 0.3 });
      // Sous-grave court : le « poids » de la pierre.
      this.tone({ at: t, f: big ? 90 : 120, f2: 40, d: big ? 0.28 : 0.14, g: big ? 0.4 : 0.28 });
      // Tessons : quelques scintillements aléatoires dans la queue.
      const glints = big ? 5 : 3;
      for (let i = 0; i < glints; i++) {
        const deg = PENTA[Math.floor(Math.random() * PENTA.length)] ?? 0;
        this.tone({
          at: t + 0.03 + Math.random() * (big ? 0.22 : 0.12),
          f: Math.min(base * 2 * semi(deg), 9000),
          d: 0.08 + Math.random() * 0.1,
          g: 0.04,
          send: 0.5,
          pan: Math.random() * 1.2 - 0.6,
        });
      }
    });
  }

  /** Explosion en chaîne. */
  blast(): void {
    this.play((t) => {
      const v = vary();
      this.tone({ at: t, f: 140 * v, f2: 32, d: 0.5, g: 0.5 });
      this.tone({ at: t, type: 'triangle', f: 220 * v, f2: 60, d: 0.2, g: 0.18 });
      this.noise({ at: t, filter: 'lowpass', f: 1800, f2: 200, d: 0.45, g: 0.4, send: 0.4 });
      this.noise({ at: t, filter: 'bandpass', f: 3000, q: 0.6, d: 0.06, g: 0.28 });
    });
  }

  /** « Tick » de ramassage d'un éclat ; monte dans la gamme pentatonique avec la série. Limité à ~30/s. */
  shardTick(streak: number): void {
    this.play((t) => {
      if (this.lastShardAt >= 0 && t - this.lastShardAt < 0.033 && t >= this.lastShardAt) return;
      this.lastShardAt = t;
      const i = clamp(Math.floor(fin(streak, 0)), 0, 12);
      const f = 660 * semi((PENTA[i % 5] ?? 0) + 12 * Math.floor(i / 5)) * vary(0.006);
      this.tone({ at: t, f, d: 0.06, g: 0.085 });
      this.tone({ at: t, type: 'triangle', f: f * 2, d: 0.03, g: 0.025 });
      this.noise({ at: t, filter: 'highpass', f: 6000, d: 0.012, g: 0.03 });
    });
  }

  // ───────────────────────────── boucle et échos ─────────────────────────────

  /** Fin de boucle : rembobinage (~0,8 s) puis conclusion selon le sort de l'enregistrement. */
  loopEnd(kind: LoopEndKind): void {
    this.play((t) => {
      // Bande qui remonte : glissando avec pleurage + bruit filtré qui s'ouvre.
      this.tone({ at: t, type: 'triangle', f: 160, f2: 1500, a: 0.6, d: 0.2, g: 0.16, lp: 2600, vib: { rate: 27, depth: 36 }, send: 0.3 });
      this.tone({ at: t, f: 80, f2: 750, a: 0.6, d: 0.2, g: 0.12, vib: { rate: 19, depth: 14 } });
      this.noise({ at: t, filter: 'bandpass', f: 400, f2: 5200, q: 3, a: 0.58, d: 0.22, g: 0.2, send: 0.3 });
      const t2 = t + 0.8;
      if (kind === 'added' || kind === 'replaced') {
        // Accord montant, égrené : plus riche quand un écho s'ajoute.
        const notes = kind === 'added' ? [62, 65, 69, 76] : [65, 69, 72];
        notes.forEach((n, i) => {
          const at = t2 + i * 0.07;
          const f = midi(n);
          this.tone({ at, f, a: 0.012, d: 0.75, g: 0.13, send: 0.5 });
          this.tone({ at, type: 'triangle', f: f * 2, a: 0.012, d: 0.4, g: 0.035, lp: 3200, send: 0.5 });
        });
        this.noise({ at: t2, filter: 'highpass', f: 5000, d: 0.05, g: 0.06, send: 0.4 });
      } else if (kind === 'discarded') {
        // Note sourde qui tombe.
        this.tone({ at: t2, f: 196, f2: 98, a: 0.01, d: 0.42, g: 0.22, send: 0.2 });
        this.tone({ at: t2, type: 'triangle', f: 147, f2: 73, a: 0.01, d: 0.3, g: 0.08, lp: 500 });
        this.noise({ at: t2, filter: 'lowpass', f: 420, d: 0.12, g: 0.14 });
      }
    });
  }

  /** Un écho se matérialise : nappe scintillante montante (~0,7 s). */
  echoMaterialize(): void {
    this.play((t) => {
      const v = vary(0.015);
      [440, 660, 880, 1320].forEach((f, i) => {
        this.tone({ at: t + i * 0.05, f: f * v, f2: f * v * 1.5, a: 0.32, d: 0.34, g: 0.05, send: 0.6, pan: i % 2 ? 0.4 : -0.4 });
      });
      this.noise({ at: t, filter: 'bandpass', f: 2000, f2: 7000, q: 2, a: 0.4, d: 0.3, g: 0.05, send: 0.6 });
      this.fm({ at: t + 0.5, f: 1760 * v, ratio: 3.5, index: 1.2, d: 0.22, g: 0.05, send: 0.6 });
    });
  }

  /** Tir d'un écho : blip doux et filtré. Limité à 12 par 100 ms. */
  echoShot(pan: number, gain: number): void {
    this.play((t) => {
      if (this.echoWinStart < 0 || t - this.echoWinStart >= 0.1 || t < this.echoWinStart) {
        this.echoWinStart = t;
        this.echoWinCount = 0;
      }
      if (this.echoWinCount >= 12) return;
      this.echoWinCount++;
      const g = clamp(fin(gain, 0), 0, 1);
      if (g <= 0.001) return;
      const p = clamp(fin(pan, 0), -1, 1);
      const v = vary();
      this.tone({ at: t, type: 'triangle', f: 620 * v, f2: 300, d: 0.07, g: 0.09 * g, lp: 1400, pan: p });
      this.noise({ at: t, filter: 'lowpass', f: 1800, d: 0.03, g: 0.04 * g, pan: p });
    });
  }

  /** Trois dernières secondes de la boucle : tic discret, n = 3, 2, 1 (de plus en plus aigu). */
  warnTick(n: number): void {
    this.play((t) => {
      const k = clamp(Math.round(fin(n, 3)), 1, 3);
      const f = [1319, 1047, 880][k - 1] ?? 880;
      this.tone({ at: t, f, d: 0.05, g: 0.08 });
      this.tone({ at: t, type: 'triangle', f: f / 2, d: 0.03, g: 0.03 });
      this.noise({ at: t, filter: 'highpass', f: 4500, d: 0.01, g: 0.03 });
    });
  }

  // ───────────────────────────── interface ─────────────────────────────

  buy(): void {
    this.play((t) => {
      const v = vary(0.01);
      this.fm({ at: t, f: 880 * v, ratio: 2, index: 0.8, d: 0.12, g: 0.12, send: 0.2 });
      this.fm({ at: t + 0.07, f: 1319 * v, ratio: 2, index: 0.8, d: 0.2, g: 0.12, send: 0.3 });
      this.noise({ at: t, filter: 'highpass', f: 4000, d: 0.02, g: 0.06 });
      this.tone({ at: t, f: 160, f2: 90, d: 0.07, g: 0.12 });
    });
  }

  deny(): void {
    this.play((t) => {
      for (let i = 0; i < 2; i++) {
        const at = t + i * 0.09;
        this.tone({ at, type: 'triangle', f: 180 - i * 30, f2: 130 - i * 20, d: 0.07, g: 0.16, lp: 600 });
        this.noise({ at, filter: 'lowpass', f: 500, d: 0.03, g: 0.06 });
      }
    });
  }

  uiHover(): void {
    this.play((t) => {
      this.tone({ at: t, f: 1400 * vary(), d: 0.025, g: 0.03 });
      this.noise({ at: t, filter: 'highpass', f: 6000, d: 0.008, g: 0.015 });
    });
  }

  uiOpen(): void {
    this.play((t) => {
      this.tone({ at: t, f: 420, f2: 720, d: 0.1, g: 0.09 });
      this.tone({ at: t, type: 'triangle', f: 840, f2: 1440, d: 0.07, g: 0.025 });
      this.noise({ at: t, filter: 'bandpass', f: 1500, f2: 3200, q: 1.5, d: 0.08, g: 0.05 });
    });
  }

  uiClose(): void {
    this.play((t) => {
      this.tone({ at: t, f: 720, f2: 400, d: 0.1, g: 0.09 });
      this.tone({ at: t, type: 'triangle', f: 1440, f2: 800, d: 0.07, g: 0.025 });
      this.noise({ at: t, filter: 'bandpass', f: 3000, f2: 1200, q: 1.5, d: 0.08, g: 0.05 });
    });
  }

  // ───────────────────────────── déplacement ─────────────────────────────

  jump(): void {
    this.play((t) => {
      this.tone({ at: t, f: 220 * vary(), f2: 420, d: 0.12, g: 0.1 });
      this.noise({ at: t, filter: 'lowpass', f: 900, d: 0.06, g: 0.06 });
    });
  }

  /** Atterrissage ; strength 0..1 selon la vitesse de chute. */
  land(strength: number): void {
    this.play((t) => {
      const s = clamp(fin(strength, 0.5), 0, 1);
      this.tone({ at: t, f: 120 * vary(), f2: 50, d: 0.1 + 0.1 * s, g: 0.1 + 0.3 * s });
      this.noise({ at: t, filter: 'lowpass', f: 500 + 600 * s, d: 0.07, g: 0.08 + 0.2 * s });
    });
  }

  /** Plateforme de saut : rebond élastique. */
  pad(): void {
    this.play((t) => {
      const v = vary();
      this.tone({ at: t, f: 200 * v, f2: 900, d: 0.28, g: 0.2, send: 0.25 });
      this.tone({ at: t, type: 'triangle', f: 400 * v, f2: 1800, d: 0.2, g: 0.06, lp: 3000 });
      this.noise({ at: t, filter: 'bandpass', f: 800, f2: 4000, q: 1.2, d: 0.2, g: 0.1, send: 0.25 });
    });
  }

  respawn(): void {
    this.play((t) => {
      this.tone({ at: t, f: 900, f2: 200, a: 0.01, d: 0.25, g: 0.14, send: 0.3 });
      this.noise({ at: t, filter: 'bandpass', f: 4000, f2: 600, q: 1.5, d: 0.25, g: 0.08, send: 0.3 });
      this.fm({ at: t + 0.26, f: 440, ratio: 2, index: 0.8, d: 0.25, g: 0.1, send: 0.4 });
      this.fm({ at: t + 0.34, f: 660, ratio: 2, index: 0.8, d: 0.35, g: 0.1, send: 0.4 });
    });
  }

  // ───────────────────────────── événements ─────────────────────────────

  /** Carillon : une géode dorée vient d'apparaître. */
  goldenSpawn(): void {
    this.play((t) => {
      [81, 85, 88, 93].forEach((n, i) => {
        const at = t + i * 0.09;
        this.fm({ at, f: midi(n), ratio: 3.5, index: 2, d: 0.9, g: 0.09, send: 0.55, pan: (i - 1.5) * 0.3 });
      });
      this.noise({ at: t, filter: 'highpass', f: 7000, a: 0.05, d: 0.4, g: 0.025, send: 0.6 });
      this.tone({ at: t, f: 220, d: 0.3, g: 0.06 });
    });
  }

  /** Nouvelle zone : grondement de pierre puis fanfare courte. */
  zoneUnlock(): void {
    this.play((t) => {
      // Pierre qui glisse.
      this.noise({ at: t, filter: 'lowpass', f: 120, f2: 320, a: 0.3, d: 0.9, g: 0.45, send: 0.3 });
      this.noise({ at: t, filter: 'bandpass', f: 700, f2: 300, q: 4, a: 0.2, d: 0.7, g: 0.08 });
      this.tone({ at: t, f: 55, f2: 40, a: 0.2, d: 1.0, g: 0.32, vib: { rate: 11, depth: 5 } });
      // Fanfare : ré – la – ré – fa♯, la dernière note tenue.
      const notes = [62, 69, 74, 78];
      notes.forEach((n, i) => {
        const at = t + 0.55 + i * 0.11;
        const last = i === notes.length - 1;
        const f = midi(n);
        this.tone({ at, type: 'triangle', f, a: 0.01, d: last ? 0.9 : 0.25, g: 0.14, lp: 2800, send: 0.45 });
        this.tone({ at, f: f / 2, a: 0.01, d: last ? 0.8 : 0.2, g: 0.08 });
      });
      this.noise({ at: t + 0.55, filter: 'highpass', f: 5000, d: 0.04, g: 0.05 });
    });
  }

  /** Objectif de tutoriel validé : deux notes claires. */
  objective(): void {
    this.play((t) => {
      this.fm({ at: t, f: 880, ratio: 2, index: 0.6, d: 0.2, g: 0.13, send: 0.35 });
      this.fm({ at: t + 0.12, f: 1319, ratio: 2, index: 0.6, d: 0.38, g: 0.13, send: 0.45 });
      this.tone({ at: t + 0.12, f: 659.5, d: 0.3, g: 0.05 });
      this.noise({ at: t, filter: 'highpass', f: 6000, d: 0.015, g: 0.04 });
    });
  }

  /** L'Effondrement : long, ample (~2,5 s). Tout tombe, puis un accord renaît. */
  prestige(): void {
    this.play((t) => {
      // Chute : sous-grave et souffle qui se referme.
      this.tone({ at: t, f: 80, f2: 28, a: 0.05, d: 2.2, g: 0.5 });
      this.noise({ at: t, filter: 'lowpass', f: 6000, f2: 80, a: 0.04, d: 2.2, g: 0.3, send: 0.5 });
      this.noise({ at: t, filter: 'bandpass', f: 2500, q: 0.6, d: 0.12, g: 0.25 });
      // Pluie de cristaux qui dégringolent.
      const fall = [93, 90, 86, 81, 78, 74, 69, 66, 62];
      fall.forEach((n, i) => {
        this.fm({
          at: t + 0.08 + i * 0.12,
          f: midi(n) * vary(0.01),
          ratio: 3.51,
          index: 2,
          d: 0.6,
          g: 0.085,
          send: 0.6,
          pan: (i % 2 ? 1 : -1) * 0.5,
        });
      });
      // Renaissance : accord de ré majeur qui enfle puis s'éteint dans la réverbe.
      [50, 57, 62, 66, 69].forEach((n, i) => {
        const f = midi(n);
        this.tone({ at: t + 1.5 + i * 0.03, f, a: 0.5, d: 0.75, g: 0.1, send: 0.6 });
        this.tone({ at: t + 1.5 + i * 0.03, type: 'triangle', f: f * 2, a: 0.55, d: 0.6, g: 0.025, lp: 3000, send: 0.6 });
      });
      this.noise({ at: t + 1.5, filter: 'bandpass', f: 1500, f2: 8000, q: 1.5, a: 0.5, d: 0.5, g: 0.05, send: 0.6 });
    });
  }

  // ───────────────────────────── musique générative ─────────────────────────────

  private stepDur(): number {
    return this.loopDur / STEPS;
  }

  private musicLevel(): number {
    // La musique reste volontairement en retrait derrière les SFX.
    return this.musicVol * 0.5;
  }

  /** Planificateur look-ahead : appelé toutes les 25 ms, planifie 120 ms à l'avance. */
  private schedule(): void {
    const gr = this.gr;
    if (!gr || !this.musicOn || this.paused || gr.ctx.state !== 'running') return;
    try {
      const now = gr.ctx.currentTime;
      const sd = this.stepDur();
      // Retard (onglet en arrière-plan, reprise après pause) : on saute les pas
      // manqués sans les jouer, pour garder la phase avec la boucle de jeu.
      while (this.nextStepTime < now - 0.02) {
        this.nextStepTime += sd;
        this.step = (this.step + 1) % STEPS;
      }
      while (this.nextStepTime < now + LOOKAHEAD) {
        this.playStep(this.step, this.nextStepTime, sd);
        this.lastStep = this.step;
        this.lastStepTime = this.nextStepTime;
        this.nextStepTime += sd;
        this.step = (this.step + 1) % STEPS;
      }
    } catch {
      /* la musique ne doit jamais casser le jeu */
    }
  }

  private playStep(step: number, at: number, sd: number): void {
    const gr = this.gr;
    if (!gr) return;
    // Nappe : un accord par demi-boucle (ou tout de suite s'il n'y en a pas en cours).
    if (step % 16 === 0 || at >= this.padEnd - 0.01) {
      const dur = (16 - (step % 16)) * sd;
      this.padChord(CHORDS[this.chordIdx % CHORDS.length] ?? [], at, dur);
      this.chordIdx = (this.chordIdx + 1) % CHORDS.length;
      this.padEnd = at + dur;
    }
    // Arpège pentatonique discret.
    let idx = ARP_PATTERN[step] ?? -1;
    if (idx >= 0 && Math.random() < 0.12) idx = -1; // respiration
    else if (idx < 0 && Math.random() < 0.06) idx = Math.floor(Math.random() * 5); // note fantôme
    if (idx < 0) return;
    const f = midi(ARP_SCALE[idx] ?? 62);
    const accent = step % 8 === 0 ? 1.3 : 1;
    const d = Math.min(0.9, Math.max(0.25, sd * 1.6));
    this.tone({ at, f, a: 0.008, d, g: 0.055 * accent, dest: gr.musicGate, pan: ((step % 4) - 1.5) * 0.25 });
    this.tone({ at, type: 'triangle', f: f * 2, a: 0.008, d: d * 0.5, g: 0.012 * accent, lp: 2600, dest: gr.musicGate });
  }

  /** Accord de nappe : sinus + triangle légèrement désaccordés, filtrés, fondus lentement. */
  private padChord(notes: readonly number[], at: number, dur: number): void {
    const gr = this.gr;
    if (!gr || notes.length === 0) return;
    const c = gr.ctx;
    const attack = Math.min(1.8, dur * 0.4);
    const release = Math.min(2.5, dur * 0.6);
    const end = at + dur + release;

    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.5;
    filter.frequency.setValueAtTime(450, at);
    filter.frequency.linearRampToValueAtTime(950, at + dur * 0.6);
    filter.frequency.linearRampToValueAtTime(450, end);

    const env = c.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.085, at + attack);
    env.gain.setValueAtTime(0.085, at + dur);
    env.gain.linearRampToValueAtTime(0, end);

    filter.connect(env);
    env.connect(gr.musicGate);

    for (const n of notes) {
      const f = midi(n);
      const a = c.createOscillator();
      a.type = 'sine';
      a.frequency.value = f;
      a.detune.value = -4;
      const b = c.createOscillator();
      b.type = 'triangle';
      b.frequency.value = f;
      b.detune.value = 5;
      const bg = c.createGain();
      bg.gain.value = 0.45;
      a.connect(filter);
      b.connect(bg);
      bg.connect(filter);
      a.start(at);
      b.start(at);
      a.stop(end + 0.05);
      b.stop(end + 0.05);
    }
  }

  // ───────────────────────────── briques de synthèse ─────────────────────────────

  /**
   * Exécute un SFX si le contexte tourne. Si le contexte est suspendu, on ne
   * planifie rien : sinon tous les sons s'empileraient et partiraient d'un coup à la reprise.
   */
  private play(fn: (t: number) => void): void {
    const gr = this.gr;
    if (!gr || this.paused || gr.ctx.state !== 'running') return;
    try {
      fn(gr.ctx.currentTime + 0.004);
    } catch {
      /* un son raté ne doit jamais remonter au jeu */
    }
  }

  /** Enveloppe exponentielle attaque/déclin. Renvoie le nœud de gain et l'instant de fin. */
  private envelope(c: AudioContext, at: number, a: number, d: number, peak: number): { node: GainNode; end: number } {
    const node = c.createGain();
    const att = Math.max(0.002, a);
    const end = at + att + Math.max(0.005, d);
    node.gain.setValueAtTime(EPS, at);
    node.gain.exponentialRampToValueAtTime(Math.max(peak, EPS * 2), at + att);
    node.gain.exponentialRampToValueAtTime(EPS, end);
    return { node, end };
  }

  /** Branche une voix vers son bus (avec panoramique éventuel) et vers la réverbe. */
  private route(gr: Graph, node: AudioNode, o: OutOpts): void {
    const c = gr.ctx;
    let out: AudioNode = node;
    if (o.pan !== undefined && o.pan !== 0 && typeof c.createStereoPanner === 'function') {
      const p = c.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      node.connect(p);
      out = p;
    }
    out.connect(o.dest ?? gr.sfxBus);
    if (o.send !== undefined && o.send > 0) {
      const s = c.createGain();
      s.gain.value = o.send;
      out.connect(s);
      s.connect(gr.reverb);
    }
  }

  /** Corps tonal : oscillateur + enveloppe, glissando / passe-bas / vibrato optionnels. */
  private tone(o: ToneOpts): void {
    const gr = this.gr;
    if (!gr || o.g <= 0) return;
    const c = gr.ctx;
    const { node: env, end } = this.envelope(c, o.at, o.a ?? 0.003, o.d, o.g);
    const osc = c.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(hz(o.f), o.at);
    if (o.f2 !== undefined) osc.frequency.exponentialRampToValueAtTime(hz(o.f2), end);
    if (o.vib) {
      const lfo = c.createOscillator();
      lfo.frequency.value = o.vib.rate;
      const depth = c.createGain();
      depth.gain.value = o.vib.depth;
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfo.start(o.at);
      lfo.stop(end + 0.03);
    }
    if (o.lp !== undefined) {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = hz(o.lp);
      osc.connect(lp);
      lp.connect(env);
    } else {
      osc.connect(env);
    }
    this.route(gr, env, o);
    osc.start(o.at);
    osc.stop(end + 0.03);
  }

  /** Transitoire ou souffle : bruit blanc partagé → filtre (éventuellement balayé) → enveloppe. */
  private noise(o: NoiseOpts): void {
    const gr = this.gr;
    if (!gr || o.g <= 0) return;
    const c = gr.ctx;
    const { node: env, end } = this.envelope(c, o.at, o.a ?? 0.002, o.d, o.g);
    const src = c.createBufferSource();
    src.buffer = gr.noise;
    src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = o.filter;
    filter.Q.value = o.q ?? 0.7;
    filter.frequency.setValueAtTime(hz(o.f), o.at);
    if (o.f2 !== undefined) filter.frequency.exponentialRampToValueAtTime(hz(o.f2), end);
    src.connect(filter);
    filter.connect(env);
    this.route(gr, env, o);
    // Départ à un endroit aléatoire du tampon : deux bruits ne sont jamais identiques.
    src.start(o.at, Math.random() * (gr.noise.duration - 0.1));
    src.stop(end + 0.03);
  }

  /** Cristal / cloche : FM à deux opérateurs, l'indice retombe pendant le déclin. */
  private fm(o: FmOpts): void {
    const gr = this.gr;
    if (!gr || o.g <= 0) return;
    const c = gr.ctx;
    const { node: env, end } = this.envelope(c, o.at, o.a ?? 0.002, o.d, o.g);
    const f = hz(o.f);
    const car = c.createOscillator();
    car.type = 'sine';
    car.frequency.value = f;
    const mod = c.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = hz(f * o.ratio);
    const depth = c.createGain();
    depth.gain.setValueAtTime(Math.max(1, f * o.ratio * o.index), o.at);
    depth.gain.exponentialRampToValueAtTime(1, o.at + Math.max(0.01, (end - o.at) * 0.7));
    mod.connect(depth);
    depth.connect(car.frequency);
    car.connect(env);
    this.route(gr, env, o);
    car.start(o.at);
    mod.start(o.at);
    car.stop(end + 0.03);
    mod.stop(end + 0.03);
  }

  /** Réponse impulsionnelle : bruit stéréo décroissant, adouci (aigus qui s'éteignent plus vite). */
  private makeImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const k = i / len;
        const white = Math.random() * 2 - 1;
        // Passe-bas à un pôle dont la coupure descend avec le temps : queue chaude.
        const coef = 0.55 - 0.4 * k;
        lp += coef * (white - lp);
        data[i] = lp * Math.pow(1 - k, 3);
      }
    }
    return buf;
  }
}

export const audio = new GameAudio();
