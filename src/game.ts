/**
 * Orchestrateur : relie la simulation de boucle, l'économie, le rendu, l'interface et le son.
 */
import * as THREE from 'three';
import { audio } from './audio/audio';
import { CFG, ELEM_BEATS, ELEM_CSS, ELEM_NAMES, ELEM_RGB, UPGRADES, UPGRADE_BY_ID, WEAPON_NAMES } from './config';
import { clamp, fmt, fmtRate, wrapAngle } from './core/util';
import { EchoRenderer } from './echo/echoRenderer';
import { shotKind, type SimEvent } from './echo/loopsim';
import { LoopRun, encodeRecording } from './echo/recording';
import { loadLocal, saveLocal, wipeLocal } from './economy/save';
import {
  applyOffline, buy, costOf, derive, doPrestige, earn, echoRate, elemUnlocked, fixLoadout, loopParams, lvl, newState, prestigePreview, weaponUnlocked,
  submitLoop, tickEchoes, totalRate, weakestIndex, type GameState, type LoopOutcome, type OfflineReport, type Stats,
} from './economy/state';
import { Player } from './player/controller';
import { Input } from './player/input';
import { Weapon } from './player/weapon';
import { Engine } from './render/engine';
import { Hud } from './ui/hud';
import { closeOverlay, showOffline, showPause, showPrestige, showTitle } from './ui/overlays';
import { SCREEN_H, SCREEN_W, SCREEN_Y, TerminalScreen, type TermAction } from './ui/terminal';
import { Arena } from './world/arena';
import { Debris, Floaters, Rings, Shards, Tracers } from './world/fx';
import { GEODE_LOOK, GEODE_NAME, GeodeRenderer } from './world/geodes';
import { PADS, START, TERMINAL, ZONE_NAMES } from './world/layout';

type Mode = 'title' | 'play' | 'paused' | 'modal';
type Phase = 'run' | 'rewind' | 'idle';

const DOCK = { x: TERMINAL.x, z: TERMINAL.z + 3.2 };
const EYE = CFG.player.eyeHeight;

interface Step { text: (g: Game) => string; hint: string; progress: (g: Game) => number; done: (g: Game) => boolean }

export class Game {
  readonly engine: Engine;
  readonly input: Input;
  readonly player = new Player();
  readonly weapon = new Weapon();
  readonly arena: Arena;
  readonly geodes = new GeodeRenderer();
  readonly shards = new Shards();
  readonly debris = new Debris();
  readonly tracers: Tracers;
  /** Un pool de traits de tir par élément (index = élément ; 0 = le pool neutre ci-dessus). */
  private elemTracers: Tracers[] = [];
  private weakHintT = 0;
  readonly rings = new Rings();
  readonly floaters: Floaters;
  readonly echoes: EchoRenderer;
  readonly terminal: TerminalScreen;
  readonly hud = new Hud();
  state: GameState;
  stats: Stats;
  mode: Mode = 'title';
  phase: Phase = 'idle';
  run: LoopRun | null = null;
  loopT = 0;
  time = 0;
  docked = false;
  /** Statistiques de performance (lues par les captures headless). */
  perf = { fps: 60, frameMs: 16, drawCalls: 0 };

  private rewindT = 0;
  private rewindFrom = new THREE.Vector3();
  private rewindYaw = 0;
  private pendingEcho: { id: number; rec: string; rate: number } | null = null;
  private fireCooldown = 0;
  private prevFire = false;
  private hitStop = 0;
  private trauma = 0;
  private fovKick = 0;
  private flash = 0;
  private muzzleLight = new THREE.PointLight(0xffc060, 0, 16, 2);
  private pickStreak = 0;
  private pickTimer = 0;
  private saveTimer = 0;
  private rateTimer = 0;
  private lastWarn = 0;
  private lastFrame = performance.now();
  private dockT = 0;
  private dockFrom = { x: 0, z: 0, yaw: 0, pitch: 0 };
  private aimedGeode = -1;
  private offlinePending: OfflineReport | null = null;
  private tut = { breaks: 0, watch: 0, betterLoop: false, zoneBreak: false, cooldown: 0 };
  private lostHints = 0;
  private pendingFlourish = 0;
  private pausedFrames = 0;
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private tmp = { x: 0, y: 0, z: 0 };
  private raycaster = new THREE.Raycaster();
  private frames = 0;
  private fpsT = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas);
    this.input = new Input(canvas, document.querySelector<HTMLElement>('#touch')!);
    const worldUi = document.querySelector<HTMLElement>('#world-ui')!;
    this.arena = new Arena(this.engine);
    this.tracers = new Tracers(96, new THREE.Color(3.2, 2.1, 0.7), 0.11);
    this.elemTracers = [this.tracers];
    for (let e = 1; e <= 3; e++) this.elemTracers.push(new Tracers(96, new THREE.Color(ELEM_RGB[e][0], ELEM_RGB[e][1], ELEM_RGB[e][2]), e === 3 ? 0.16 : 0.11));
    this.floaters = new Floaters(this.engine, worldUi);
    this.echoes = new EchoRenderer(this.engine, worldUi);
    this.terminal = new TerminalScreen(this.engine);
    this.terminal.touch = this.input.touch;
    const sc = this.engine.scene;
    for (let e = 1; e <= 3; e++) sc.add(this.elemTracers[e].mesh);
    sc.add(this.arena.group, this.geodes.group, this.shards.mesh, this.debris.mesh, this.tracers.mesh, this.rings.mesh,
      this.echoes.group, this.terminal.group, this.muzzleLight);
    this.engine.viewScene.add(this.weapon.group);

    // ——— Chargement et calcul hors ligne ———
    const now = Date.now();
    const loaded = loadLocal(now);
    this.state = loaded ?? newState(now);
    if (loaded) this.offlinePending = applyOffline(this.state, now);
    this.stats = derive(this.state);
    this.syncWorld(false);
    this.restoreEchoes();

    this.shards.onArrive = () => {
      this.pickStreak++;
      this.pickTimer = 0.7;
      audio.shardTick(this.pickStreak);
      this.hud.pulseWallet();
    };
    this.echoes.onShot = (pan, gain) => audio.echoShot(pan, gain);
    this.arena.onZoneLanded = (zone) => {
      this.trauma = Math.min(1, this.trauma + 0.6);
      this.hud.showBanner(`Nouvelle zone : ${ZONE_NAMES[zone]}`, `Ses géodes valent ×${CFG.geodes.zoneValue[zone]} — mais il faut y aller.`, 'great');
    };
    this.input.onFirstGesture = () => audio.init();
    this.input.onLockChange = (locked) => {
      if (!locked && this.mode === 'play' && !this.input.touch) this.pause();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.save(); if (this.mode === 'play') this.pause(); }
      else this.onReturn();
    });
    window.addEventListener('beforeunload', () => this.save());

    this.showTitleScreen();
    requestAnimationFrame(this.frame);
  }

  // ————————————————————————————————————————————————————————————————
  // États
  // ————————————————————————————————————————————————————————————————

  private showTitleScreen(): void {
    this.mode = 'title';
    this.hud.setVisible(false);
    showTitle(this.state.totalEarned > 0 || this.state.loops > 0, this.input.touch, () => this.begin(), () => {
      wipeLocal();
      this.loadState(newState());
      this.begin();
    });
  }

  private begin(): void {
    audio.init();
    this.applySettings();
    audio.startMusic();
    closeOverlay();
    this.hud.setVisible(true);
    this.hud.snapWallet(this.state.shards);
    if (this.offlinePending) {
      const rep = this.offlinePending;
      this.offlinePending = null;
      this.mode = 'modal';
      showOffline(rep, this.state, () => { closeOverlay(); this.resume(); });
      this.hud.snapWallet(this.state.shards - rep.gain);
      return;
    }
    this.resume();
  }

  private resume(): void {
    closeOverlay();
    this.mode = 'play';
    audio.setPaused(false);
    this.input.requestLock();
    if (this.phase === 'idle' && !this.docked) this.startLoop();
    this.lastFrame = performance.now();
  }

  pause(): void {
    if (this.mode !== 'play') return;
    this.mode = 'paused';
    this.input.releaseLock();
    this.save();
    showPause(this.state, {
      onResume: () => this.resume(),
      onSettings: () => this.applySettings(),
      // On rouvre le panneau sur le nouvel état (réglages, export et taux à jour).
      onImport: (s) => { this.loadState(s); this.save(); this.mode = 'play'; this.pause(); this.hud.toast('Sauvegarde importée.'); },
      onReset: () => { wipeLocal(); this.loadState(newState()); closeOverlay(); this.showTitleScreen(); },
    });
  }

  private onReturn(): void {
    // Onglet resté en arrière-plan : les images ne tournaient plus, on crédite l'absence.
    const rep = applyOffline(this.state, Date.now());
    this.lastFrame = performance.now();
    if (rep && this.mode !== 'title') {
      this.mode = 'modal';
      this.input.releaseLock();
      showOffline(rep, this.state, () => { closeOverlay(); this.resume(); });
    } else if (rep) this.offlinePending = rep;
  }

  private applySettings(): void {
    audio.setVolume(this.state.settings.volume, this.state.settings.music);
  }

  save(): void {
    saveLocal(this.state);
  }

  /** Remplace l'état courant (import, nouvelle partie) et reconstruit le monde. */
  loadState(s: GameState): void {
    this.state = s;
    this.stats = derive(s);
    this.offlinePending = null;
    this.pendingEcho = null;
    this.engine.rewind = 0;
    this.player.frozen = false;
    this.cancelLoop();
    this.undock(true);
    this.player.reset();
    this.player.yaw = START.yaw; this.player.pitch = 0;
    this.syncWorld(false);
    this.restoreEchoes();
    this.hud.snapWallet(s.shards);
    this.tut = { breaks: 0, watch: 0, betterLoop: false, zoneBreak: false, cooldown: 0 };
    this.applySettings();
    this.terminal.dirty = true;
  }

  private syncWorld(animate: boolean): void {
    this.stats = derive(this.state);
    this.arena.setZoneLevel(lvl(this.state, 'zone'), animate);
    this.weapon.setTier(this.stats.weaponTier, animate);
    fixLoadout(this.state);
    this.weapon.setWeapon(this.state.loadout.weapon, !animate);
    this.weapon.setElement(this.state.loadout.elem);
    this.refreshLoadout();
    audio.setLoopDuration(this.stats.duration + CFG.loop.rewindTime);
  }

  private restoreEchoes(): void {
    this.echoes.clear();
    const st = this.stats;
    this.state.echoes = this.state.echoes.filter((e, i) => this.echoes.add(e.id, e.rec, echoRate(this.state, e, st), i * 1.37, false));
  }

  // ————————————————————————————————————————————————————————————————
  // Boucle de jeu (les 12 secondes)
  // ————————————————————————————————————————————————————————————————

  private startLoop(): void {
    this.stats = derive(this.state);
    this.run = new LoopRun(loopParams(this.state));
    this.loopT = 0;
    this.phase = 'run';
    this.lastWarn = 0;
    this.fireCooldown = 0.12;
    this.player.frozen = false;
    audio.syncLoop();
    if (this.pendingEcho) {
      const p = this.pendingEcho;
      this.pendingEcho = null;
      if (this.echoes.add(p.id, p.rec, p.rate, 0, true)) {
        audio.echoMaterialize();
        this.rings.add(START.x, 1.1, START.z, 3.2, 0.9, 0.25, 0.9, 0.78);
        this.rings.add(START.x, 1.1, START.z, 1.6, 0.5, 0.25, 0.9, 0.78);
      }
    }
  }

  /** Abandonne la boucle en cours sans l'enregistrer (terminal, import…). */
  private cancelLoop(): void {
    if (this.run) {
      this.run = null;
      this.geodes.expireAll();
      this.shards.loseAll();
    }
    this.phase = 'idle';
    this.aimedGeode = -1;
    this.hud.setCombo(0, 0, 1);
  }

  private endLoop(): void {
    const run = this.run!;
    const { recording, result } = run.finish();
    this.consume(run.sim.events);
    this.run = null;
    const s = this.state;
    const outcome: LoopOutcome = submitLoop(s, result.shards, recording.params.duration, encodeRecording(recording));

    // ——— Le moment fort : flash, rembobinage, verdict ———
    this.flash = 0.9;
    this.trauma = Math.min(1, this.trauma + 0.35);
    audio.loopEnd(outcome.kind);
    this.geodes.expireAll();
    this.shards.loseAll();
    this.hud.setCombo(0, 0, 1);
    this.aimedGeode = -1;

    if (outcome.kind === 'added') {
      this.pendingEcho = { id: outcome.echo.id, rec: outcome.echo.rec, rate: outcome.rate };
      this.hud.showBanner(`Nouvel écho : +${fmtRate(outcome.rate)}/s`, `Il rejoue ta boucle (${fmt(result.shards * this.stats.globalMult)} éclats) pour toujours.`, 'good');
      if (s.tutorial >= 4) this.tut.betterLoop = true;
    } else if (outcome.kind === 'replaced') {
      this.pendingEcho = { id: outcome.echo.id, rec: outcome.echo.rec, rate: outcome.rate };
      this.echoes.dissolve(outcome.removedId);
      this.hud.showBanner(`Nouvel écho : +${fmtRate(outcome.rate)}/s`, `(remplace un écho à ${fmtRate(outcome.removedRate)}/s)`, 'great');
      this.tut.betterLoop = true;
    } else if (outcome.kind === 'discarded') {
      this.hud.showBanner(`Boucle jetée : +${fmtRate(outcome.rate)}/s`, `Ton écho le plus faible fait déjà +${fmtRate(outcome.weakestRate)}/s. Fais mieux pour le remplacer.`, 'bad');
    } else if (result.shots > 0 || s.tutorial <= 1) {
      this.hud.showBanner('Boucle vide', result.broken > 0 ? 'Approche-toi des éclats pour les ramasser avant la fin.' : 'Brise des géodes et ramasse leurs éclats pour créer un écho.', 'bad');
    }
    if (result.lost > 0 && this.lostHints < 3 && result.lost >= result.shards * 0.25) {
      this.lostHints++;
      this.hud.toast(`${fmt(result.lost)} éclats laissés au sol sont perdus : passe à moins de ${this.stats.magnetRadius.toFixed(0)} m pour les aspirer.`);
    }

    this.phase = 'rewind';
    this.rewindT = 0;
    this.rewindFrom.set(this.player.x, this.player.y, this.player.z);
    this.rewindYaw = this.player.yaw;
    this.player.frozen = true;
    this.save();
  }

  private updateLoop(dt: number): void {
    const p = this.player;
    if (this.phase === 'rewind') {
      this.rewindT += dt;
      const u = Math.min(1, this.rewindT / CFG.loop.rewindTime);
      const e = u * u * (3 - 2 * u);
      // Rembobinage : la caméra est ramenée au point de départ.
      p.x = this.rewindFrom.x + (START.x - this.rewindFrom.x) * e;
      p.y = this.rewindFrom.y + (START.y - this.rewindFrom.y) * e;
      p.z = this.rewindFrom.z + (START.z - this.rewindFrom.z) * e;
      p.eyeY = p.y + EYE;
      this.engine.rewind = Math.sin(u * Math.PI);
      if (u >= 1) {
        this.engine.rewind = 0;
        p.reset();
        if (this.docked) this.phase = 'idle';
        else this.startLoop();
      }
      return;
    }
    if (this.phase !== 'run' || !this.run) return;
    const run = this.run;
    this.loopT += dt;
    const duration = this.stats.duration;
    const t = Math.min(this.loopT, duration);

    // Échantillons à 20 Hz (quantifiés, puis donnés à la simulation).
    const due = run.ticksDue(t);
    while (run.ticks < due) run.tick(p.x, p.eyeY, p.z, p.yaw, p.pitch);

    // ——— Tir ———
    this.fireCooldown -= dt;
    const wantFire = this.input.fire || (this.input.autoFire && this.aimedGeode >= 0);
    if (wantFire && this.fireCooldown <= 0 && t < duration && !this.weapon.swapping) {
      const lo = this.state.loadout;
      const heavy = lo.weapon === 1;
      this.fireCooldown = 1 / (this.stats.fireRate * (heavy ? CFG.w2.fireRate : 1));
      run.shoot(t, p.x, p.eyeY, p.z, p.yaw, p.pitch, shotKind(lo.weapon, lo.elem));
      this.weapon.fire();
      audio.shot(heavy ? 4 : this.weapon.tier);
      if (heavy) { audio.blast(); this.fovKick = Math.max(this.fovKick, 0.7); }
      this.trauma = Math.min(1, this.trauma + (heavy ? 0.22 : 0.05));
      this.muzzleLight.intensity = heavy ? 14 : 7;
      const c = ELEM_RGB[lo.elem];
      this.muzzleLight.color.setRGB(c[0] / 3.6, c[1] / 3.6, c[2] / 3.6);
    }

    this.consume(run.sim.events);

    // Derniers instants : tic sonore à 3, 2, 1.
    const left = duration - t;
    const warn = Math.ceil(left);
    if (left <= 3 && warn !== this.lastWarn && warn >= 1) { this.lastWarn = warn; audio.warnTick(warn); }

    if (this.loopT >= duration) this.endLoop();
  }

  /** Traduit les événements de la simulation en retour visuel, sonore et en gains. */
  private consume(events: SimEvent[]): void {
    if (events.length === 0) return;
    const sim = this.run!.sim;
    const zoneLevel = lvl(this.state, 'zone');
    for (const ev of events) {
      switch (ev.k) {
        case 'spawn': {
          this.geodes.spawn(sim, ev.g, ev.t === 0);
          if (sim.specs[ev.g].type === 'golden') {
            audio.goldenSpawn();
            const s = sim.specs[ev.g];
            this.floaters.add(s.x, s.y + 1.2, s.z, 'DORÉE !', 't2', 1.4);
          }
          break;
        }
        case 'expire':
          this.geodes.expire(ev.g);
          break;
        case 'shot': {
          const m = this.muzzleWorld(this.v);
          this.elemTracers[ev.elem].addPath(m.x, m.y, m.z, ev.pts, ev.w === 1 ? 0.03 : 0.05 + this.weapon.tier * 0.012);
          break;
        }
        case 'arc':
          // Arc de foudre : il part de la géode touchée, pas du canon.
          this.elemTracers[3].addPath(ev.pts[0], ev.pts[1], ev.pts[2], ev.pts, 0.09);
          this.rings.add(ev.pts[ev.pts.length - 3], ev.pts[ev.pts.length - 2], ev.pts[ev.pts.length - 1], 1.5, 0.3, 0.9, 0.45, 1.5);
          break;
        case 'status':
          this.geodes.setStatus(ev.g, ev.s, ev.until - ev.t);
          break;
        case 'hit': {
          this.geodes.hit(ev.g, ev.stage);
          // Faiblesse ou résistance élémentaire : on le dit, sans inonder l'écran.
          if (ev.elem > 0 && this.weakHintT <= 0) {
            const ge = sim.specs[ev.g].elem;
            if (ge > 0 && ELEM_BEATS[ev.elem] === ge) { this.floaters.add(ev.x, ev.y + 0.9, ev.z, `FAIBLE ×${CFG.elements.weak}`, 'e' + ev.elem, 0.8); this.weakHintT = 0.35; }
            else if (ge === ev.elem) { this.floaters.add(ev.x, ev.y + 0.9, ev.z, 'résiste', 'resist', 0.8); this.weakHintT = 0.6; }
          }
          if (ev.elem > 0 && ev.stage === 2) this.rings.add(ev.x, ev.y, ev.z, 1.1, 0.25, ELEM_RGB[ev.elem][0] * 0.3, ELEM_RGB[ev.elem][1] * 0.3, ELEM_RGB[ev.elem][2] * 0.3);
          this.hud.hit(false);
          audio.hit(ev.stage);
          this.debris.burst(ev.x, ev.y, ev.z, GEODE_LOOK[sim.specs[ev.g].type].shell, 3, 3.5);
          this.trauma = Math.min(1, this.trauma + 0.05);
          break;
        }
        case 'break': {
          const spec = sim.specs[ev.g];
          const look = GEODE_LOOK[spec.type];
          const big = spec.type === 'armored' || spec.type === 'golden' || spec.zone >= 2;
          this.geodes.remove(ev.g);
          this.debris.burst(ev.x, ev.y, ev.z, look.shell, big ? 22 : 13, big ? 9 : 6.5);
          this.shards.burst(ev.drop, ev.x, ev.y, ev.z, ev.value, zoneLevel);
          this.rings.add(ev.x, ev.y, ev.z, big ? 3.6 : 2.3, 0.4, look.core[0] * 0.5, look.core[1] * 0.5, look.core[2] * 0.5);
          this.floaters.value(ev.x, ev.y + 0.6, ev.z, ev.value * this.stats.globalMult, ev.combo);
          audio.breakGeode(ev.combo, big);
          this.hud.hit(true);
          // Hit-stop bref, proportionnel à l'impact ; pas à chaque explosion d'une même chaîne.
          if (ev.cause === 'shot') this.hitStop = Math.max(this.hitStop, big ? 0.06 : 0.035);
          this.trauma = Math.min(1, this.trauma + (big ? 0.38 : 0.2));
          this.fovKick = Math.max(this.fovKick, big ? 1 : 0.5);
          this.tut.breaks++;
          if (spec.zone >= 1) this.tut.zoneBreak = true;
          const mult = 1 + CFG.combo.step * Math.min(ev.combo - 1, CFG.combo.maxSteps);
          this.hud.setCombo(ev.combo, 1, mult);
          break;
        }
        case 'blast':
          this.rings.add(ev.x, ev.y, ev.z, ev.r, 0.45, 1.0, 0.4, 0.1);
          audio.blast();
          this.trauma = Math.min(1, this.trauma + 0.3);
          break;
        case 'attract':
          this.shards.attract(ev.drop, ev.arrive - ev.t);
          break;
        case 'collect':
          earn(this.state, ev.value * this.stats.globalMult);
          break;
      }
    }
    events.length = 0;
  }

  // ————————————————————————————————————————————————————————————————
  // Terminal (interface diégétique)
  // ————————————————————————————————————————————————————————————————

  private nearTerminal(): boolean {
    const p = this.player;
    return p.y < 1 && Math.hypot(p.x - DOCK.x, p.z - DOCK.z) < 4.6 && p.z > TERMINAL.z + 0.6;
  }

  private dock(): void {
    if (this.docked) return;
    this.docked = true;
    if (this.phase === 'run') this.cancelLoop();
    const p = this.player;
    p.yaw = wrapAngle(p.yaw);
    this.input.uiMode = true;
    this.dockFrom = { x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch };
    this.dockT = 0;
    p.frozen = true;
    p.vx = p.vz = 0;
    this.weapon.setLowered(true);
    this.terminal.dirty = true;
    audio.uiOpen();
  }

  private undock(silent = false): void {
    if (!this.docked) return;
    this.docked = false;
    this.input.uiMode = false;
    this.player.lookClamp = null;
    this.player.frozen = this.phase === 'rewind';
    this.weapon.setLowered(false);
    this.terminal.setCursor(null);
    // L'arme revient à l'écran : c'est maintenant qu'on montre ce que l'achat a changé.
    if (this.pendingFlourish > 0) {
      if (this.pendingFlourish >= 1) this.hud.toast('Ton arme a changé de palier.');
      this.weapon.celebrate(this.pendingFlourish);
      this.pendingFlourish = 0;
    }
    if (!silent) {
      audio.uiClose();
      this.save();
      if (this.phase === 'idle' && this.mode === 'play') this.startLoop();
    }
  }

  private updateTerminal(dt: number): void {
    const p = this.player;
    // Au terminal, bouger suffit pour repartir : on ne reste jamais coincé devant l'écran.
    const wantsOut = this.docked && this.dockT >= 1 && (this.input.moveX !== 0 || this.input.moveY !== 0 || this.input.jumpPressed);
    if (this.input.interactPressed || wantsOut) {
      if (this.docked) this.undock();
      else if (this.nearTerminal() && this.phase !== 'rewind') this.dock();
    }
    if (!this.docked) return;
    if (this.dockT < 1) {
      this.dockT = Math.min(1, this.dockT + dt * 3.2);
      const e = 1 - Math.pow(1 - this.dockT, 3);
      p.x = this.dockFrom.x + (DOCK.x - this.dockFrom.x) * e;
      p.z = this.dockFrom.z + (DOCK.z - this.dockFrom.z) * e;
      p.yaw = this.dockFrom.yaw + wrapAngle(0 - this.dockFrom.yaw) * e;
      p.pitch = this.dockFrom.pitch + (0.27 - this.dockFrom.pitch) * e;
      if (this.dockT >= 1) p.lookClamp = { yaw0: 0, yawR: 0.72, pitchMin: -0.15, pitchMax: 0.72 };
      return;
    }
    // Le viseur (ou le doigt / la souris libre) devient le curseur de l'écran.
    const cam = this.engine.camera;
    let click = this.input.fire && !this.prevFire;
    if (this.input.tap && !this.input.locked) {
      this.raycaster.setFromCamera(new THREE.Vector2((this.input.tap.x / this.engine.width) * 2 - 1, -(this.input.tap.y / this.engine.height) * 2 + 1), cam);
      this.dir.copy(this.raycaster.ray.direction);
      click = true;
    } else {
      cam.getWorldDirection(this.dir);
    }
    let uv: { x: number; y: number } | null = null;
    if (this.dir.z < -1e-3) {
      const t = (TERMINAL.z - cam.position.z) / this.dir.z;
      const hx = cam.position.x + this.dir.x * t, hy = cam.position.y + this.dir.y * t;
      const u = (hx - (TERMINAL.x - SCREEN_W / 2)) / SCREEN_W, v = (hy - (SCREEN_Y - SCREEN_H / 2)) / SCREEN_H;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) uv = { x: u, y: v };
    }
    if (this.terminal.setCursor(uv)) audio.uiHover();
    if (click) {
      const action = this.terminal.click();
      if (action) this.termAction(action);
      else if (!this.input.locked && !this.input.touch) this.input.requestLock();
    }
  }

  termAction(action: TermAction): void {
    const s = this.state;
    if (action.type === 'tab') {
      this.terminal.tab = action.tab;
      this.terminal.dirty = true;
      audio.uiHover();
    } else if (action.type === 'buy') {
      const before = this.stats.weaponTier;
      if (buy(s, action.id)) {
        audio.buy();
        this.terminal.flash(action.id);
        this.flash = Math.max(this.flash, 0.12);
        this.syncWorld(true);
        this.pendingFlourish = Math.max(this.pendingFlourish, this.stats.weaponTier > before ? 1 : UPGRADE_BY_ID[action.id].family === 'weapon' ? 0.6 : 0);
        const u = UPGRADE_BY_ID[action.id];
        if (action.id === 'zone') audio.zoneUnlock();

        else if (u.family === 'arena' && lvl(s, action.id) === 1) this.hud.toast(`${u.name} : elles apparaîtront dès la prochaine boucle.`);
        if (lvl(s, action.id) === 1) {
          if (action.id === 'w2') { this.selectWeapon(1); this.hud.toast('Fracasseur débloqué : touches 1 et 2 (ou molette) pour changer d\'arme.'); }
          else if (u.family === 'element') { this.setElement(['', 'fire', 'ice', 'volt'].indexOf(action.id)); this.hud.toast(`${u.name} débloqué : touche R (ou clic droit) pour changer d'élément. Des géodes élémentaires vont apparaître.`); }
        }
        this.refreshLoadout();
        this.hud.snapWallet(s.shards);
        this.refreshRates();
      } else {
        audio.deny();
        this.terminal.deny(action.id);
      }
    } else if (action.type === 'prestige' && prestigePreview(s).available) {
      this.mode = 'modal';
      this.input.releaseLock();
      showPrestige(s, (perkId) => this.collapse(perkId), () => { closeOverlay(); this.resume(); });
    }
  }

  /** L'Effondrement : tout se condense en Fragments. */
  private collapse(perkId: string): void {
    if (!doPrestige(this.state, perkId)) return;
    closeOverlay();
    audio.prestige();
    this.flash = 1.6;
    this.trauma = 1;
    this.cancelLoop();
    this.undock(true);
    this.echoes.clear();
    this.pendingEcho = null;
    this.player.reset();
    this.syncWorld(false);
    this.hud.snapWallet(this.state.shards);
    this.save();
    this.resume();
    this.hud.showBanner(`Effondrement : ${fmt(this.state.fragments)} Fragments`, `Tous tes gains sont multipliés par ${this.stats.globalMult.toFixed(1).replace('.', ',')}. Reconstruis tes échos.`, 'great');
  }

  // ————————————————————————————————————————————————————————————————
  // Équipement : arme et élément en main
  // ————————————————————————————————————————————————————————————————

  private updateLoadoutInput(): void {
    const input = this.input;
    if (this.docked) return;
    // La molette envoie plusieurs crans d'un coup : on ignore ceux qui arrivent pendant l'échange.
    if (input.weaponPressed >= 0 && !(input.weaponPressed === 2 && this.weapon.swapping)) {
      const lo = this.state.loadout;
      const w = input.weaponPressed === 2 ? 1 - lo.weapon : input.weaponPressed;
      this.selectWeapon(w);
    }
    if (input.elemPressed) this.cycleElement();
  }

  selectWeapon(w: number): void {
    const lo = this.state.loadout;
    if (w === lo.weapon) return;
    if (!weaponUnlocked(this.state, w)) {
      audio.deny();
      this.hud.toast(`${WEAPON_NAMES[w]} : à débloquer au terminal (ARME).`);
      return;
    }
    lo.weapon = w;
    this.weapon.setWeapon(w);
    this.fireCooldown = Math.max(this.fireCooldown, 0.3);
    audio.uiOpen();
    this.refreshLoadout();
  }

  cycleElement(): void {
    const lo = this.state.loadout;
    let e = lo.elem;
    for (let i = 0; i < 4; i++) {
      e = (e + 1) % 4;
      if (elemUnlocked(this.state, e)) break;
    }
    if (e === lo.elem) {
      if (!elemUnlocked(this.state, 1) && !elemUnlocked(this.state, 2) && !elemUnlocked(this.state, 3)) {
        audio.deny();
        this.hud.toast('Aucun élément débloqué : terminal → ÉLÉMENTS.');
      }
      return;
    }
    this.setElement(e);
  }

  setElement(e: number): void {
    if (!elemUnlocked(this.state, e)) return;
    this.state.loadout.elem = e;
    this.weapon.setElement(e);
    audio.uiHover();
    this.flash = Math.max(this.flash, 0.05);
    this.refreshLoadout();
  }

  /** Bandeau d'équipement : visible dès qu'il y a un choix à faire. */
  private refreshLoadout(): void {
    const s = this.state, lo = s.loadout;
    const hasW2 = weaponUnlocked(s, 1);
    const elems = [1, 2, 3].filter((e) => elemUnlocked(s, e));
    document.querySelector('.btn-wpn')?.classList.toggle('hidden', !hasW2);
    document.querySelector('.btn-elem')?.classList.toggle('hidden', elems.length === 0);
    if (!hasW2 && elems.length === 0) { this.hud.loadout(''); return; }
    const touch = this.input.touch;
    let html = '';
    if (hasW2) {
      for (let w = 0; w < 2; w++) html += `<span class="chip${lo.weapon === w ? ' on' : ''}">${touch ? '' : `<kbd>${w + 1}</kbd>`}${WEAPON_NAMES[w]}</span>`;
    }
    if (elems.length > 0) {
      if (hasW2) html += '<span class="sep"></span>';
      html += `<span class="chip on">${touch ? '' : '<kbd>R</kbd>'}<i style="background:${ELEM_CSS[lo.elem]}"></i>${ELEM_NAMES[lo.elem]}</span>`;
    }
    this.hud.loadout(html);
  }

  private refreshRates(): void {
    const st = this.stats;
    for (const e of this.state.echoes) this.echoes.updateRate(e.id, echoRate(this.state, e, st));
  }

  // ————————————————————————————————————————————————————————————————
  // Tutoriel : objectifs courts affichés en haut
  // ————————————————————————————————————————————————————————————————

  private steps: Step[] = [
    { text: () => 'Brise 5 géodes', hint: 'Vise les roches flottantes, maintiens le clic, puis approche-toi des éclats pour les aspirer.', progress: (g) => g.tut.breaks / 5, done: (g) => g.tut.breaks >= 5 || g.state.echoes.length > 0 },
    { text: () => 'Termine ta première boucle', hint: 'L\'anneau autour du viseur se vide : à zéro, ta boucle est enregistrée.', progress: (g) => (g.phase === 'run' ? g.loopT / g.stats.duration : 0), done: (g) => g.state.echoes.length > 0 },
    { text: () => 'Regarde ton écho rejouer ta boucle', hint: 'La silhouette sarcelle refait tes gestes et te rapporte des éclats, même si tu ne fais rien.', progress: (g) => g.tut.watch / 8, done: (g) => g.tut.watch >= 8 || g.state.loops > 3 },
    { text: () => 'Achète une amélioration au terminal', hint: 'C\'est le grand écran devant le point de départ : approche-toi et appuie sur E.', progress: (g) => g.state.shards / g.cheapest(), done: (g) => Object.keys(g.state.levels).length > 0 },
    { text: () => 'Enregistre une meilleure boucle', hint: 'Une boucle qui récolte plus crée un écho plus fort.', progress: () => 0, done: (g) => g.tut.betterLoop || g.state.echoes.length >= 3 },
    { text: () => 'Fais tourner 3 échos en même temps', hint: 'Chaque boucle réussie ajoute un écho tant qu\'il reste un emplacement libre.', progress: (g) => g.state.echoes.length / 3, done: (g) => g.state.echoes.length >= 3 },
    { text: () => 'Débloque les Terrasses', hint: 'Terminal → ARÈNE → Expansion. Les géodes y valent ×4.', progress: (g) => g.state.shards / costOf(g.state, 'zone'), done: (g) => lvl(g.state, 'zone') >= 1 },
    { text: () => 'Brise une géode des Terrasses', hint: 'Monte par une des trois rampes au bord de l\'arène.', progress: () => 0, done: (g) => g.tut.zoneBreak || lvl(g.state, 'zone') >= 2 },
    { text: () => 'Atteins 8 échos', hint: 'Terminal → BOUCLE → Emplacements d\'échos.', progress: (g) => g.state.echoes.length / 8, done: (g) => g.state.echoes.length >= 8 },
    { text: () => 'Débloque les Passerelles', hint: 'Les jump pads des terrasses t\'y propulseront.', progress: (g) => g.state.shards / costOf(g.state, 'zone'), done: (g) => lvl(g.state, 'zone') >= 2 },
    { text: () => 'Déclenche l\'Effondrement', hint: 'Terminal → EFFONDREMENT : échange tes échos contre un multiplicateur permanent.', progress: (g) => prestigePreview(g.state).progress, done: (g) => g.state.prestiges >= 1 },
  ];

  cheapest(): number {
    let c = Infinity;
    for (const u of UPGRADES) if (lvl(this.state, u.id) < u.max) c = Math.min(c, costOf(this.state, u.id));
    return c;
  }

  private updateTutorial(dt: number): void {
    const s = this.state;
    if (s.tutorial === 2 && s.echoes.length > 0 && this.phase === 'run') this.tut.watch += dt;
    this.tut.cooldown -= dt;
    if (s.tutorial < this.steps.length && this.tut.cooldown <= 0 && this.steps[s.tutorial].done(this)) {
      s.tutorial++;
      this.tut.cooldown = 1.2;
      this.tut.betterLoop = false;
      this.hud.objectiveDone();
      audio.objective();
    }
    const step = this.steps[s.tutorial];
    if (step) this.hud.objective(step.text(this), step.hint, step.progress(this));
    else this.hud.objective('', '', 0);
  }

  // ————————————————————————————————————————————————————————————————
  // Image
  // ————————————————————————————————————————————————————————————————

  private muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    // L'arme est rendue avec sa propre caméra (FOV différent) : on retrouve le point du monde
    // qui se projette au même endroit de l'écran que la bouche du canon.
    const cam = this.engine.camera;
    out.copy(this.weapon.muzzleLocal).applyMatrix4(this.engine.viewCamera.projectionMatrix);
    out.set(out.x, out.y, 0.5).unproject(cam).sub(cam.position).normalize().multiplyScalar(1.0).add(cam.position);
    return out;
  }

  /** Géode sous le viseur (info-bulle, viseur actif, tir automatique tactile). */
  private updateAim(): void {
    this.aimedGeode = -1;
    if (this.phase !== 'run' || !this.run || this.docked) return;
    const sim = this.run.sim, cam = this.engine.camera;
    cam.getWorldDirection(this.dir);
    const o = cam.position, d = this.dir, c = this.tmp;
    let best = Infinity;
    for (let g = 0; g < sim.specs.length; g++) {
      if (!sim.isActive(g)) continue;
      sim.pos(g, this.loopT, c);
      const lx = c.x - o.x, ly = c.y - o.y, lz = c.z - o.z;
      const tca = lx * d.x + ly * d.y + lz * d.z;
      if (tca < 0 || tca > best) continue;
      const r = sim.specs[g].radius * 1.12;
      if (lx * lx + ly * ly + lz * lz - tca * tca <= r * r) { best = tca; this.aimedGeode = g; }
    }
  }

  private updateTooltip(): void {
    const p = this.player;
    if (this.docked) { this.hud.tip(this.input.touch ? 'Bouton <kbd>E</kbd> pour quitter le terminal' : '<kbd>E</kbd> ou une touche de déplacement pour quitter le terminal'); return; }
    if (this.aimedGeode >= 0 && this.run) {
      const sim = this.run.sim, spec = sim.specs[this.aimedGeode];
      const hp = Math.max(0, sim.hp[this.aimedGeode]);
      const f = (x: number) => (x % 1 === 0 ? x.toFixed(0) : x.toFixed(1).replace('.', ','));
      const ge = spec.elem ?? 0;
      const counter = ge > 0 ? ELEM_BEATS.indexOf(ge) : 0;
      const name = GEODE_NAME[spec.type] + (ge > 0 ? ` de ${ELEM_NAMES[ge].toLowerCase()}` : '');
      const weak = ge > 0 ? ` · <span style="color:${ELEM_CSS[counter]}">faible contre ${ELEM_NAMES[counter]}</span>` : '';
      this.hud.tip(`${name} · vaut <em>${fmt(Math.round(spec.value * sim.params.valueMult * this.stats.globalMult))}</em> éclats · ${f(hp)} / ${f(spec.hp)} PV${weak}`);
      return;
    }
    if (this.nearTerminal() && this.phase !== 'rewind') {
      const n = this.terminal.affordableCount(this.state);
      this.hud.tip(`<kbd>E</kbd> Ouvrir le terminal${n > 0 ? ` · <em>${n} amélioration${n > 1 ? 's' : ''} disponible${n > 1 ? 's' : ''}</em>` : ''}`);
      return;
    }
    const zone = lvl(this.state, 'zone');
    for (const pad of PADS) {
      if (pad.zone > zone || Math.abs(p.y - pad.y) > 1) continue;
      if (Math.hypot(p.x - pad.x, p.z - pad.z) < 4.5) { this.hud.tip(`Jump pad → ${ZONE_NAMES[pad.zone]} : marche dessus`); return; }
    }
    const cam = this.engine.camera;
    cam.getWorldDirection(this.dir);
    const e = this.echoes.aimed(cam.position, this.dir);
    if (e) { this.hud.tip(`Écho · rejoue une de tes boucles · <em>+${fmtRate(e.rate)}</em> éclats/s`); return; }
    this.hud.tip('');
  }

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const real = Math.max(0, Math.min(0.1, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.frames++; this.fpsT += real;
    if (this.fpsT >= 0.5) {
      this.perf.fps = this.frames / this.fpsT;
      this.perf.frameMs = (this.fpsT / this.frames) * 1000;
      this.frames = 0; this.fpsT = 0;
      if (this.mode === 'play' && !document.hidden) this.engine.adapt(this.perf.fps, 0.5);
    }
    this.step(real);
  };

  /** Avance le jeu de `real` secondes et rend une image. Public pour les captures headless. */
  step(real: number): void {
    const s = this.state;
    const input = this.input;
    input.poll();
    // Les échos produisent en continu, y compris en pause et sur l'écran titre.
    tickEchoes(s, real);
    s.playTime += real;

    let dt = Math.min(real, 0.05);
    if (this.hitStop > 0) { this.hitStop -= real; dt *= 0.06; }
    const cam = this.engine.camera;

    if (this.mode === 'play') {
      s.runTime += real;
      this.time += dt;
      if (input.pausePressed) { if (this.docked) this.undock(); else if (input.touch || !input.locked) this.pause(); }
      if (!this.docked && !input.locked && !input.touch && input.tap) input.requestLock();
      this.updateTerminal(dt);
      this.updateLoadoutInput();
      this.weakHintT -= dt;
      this.player.update(Math.min(real, 0.05), input, lvl(s, 'zone'), s.settings.sens, s.settings.invertY);
      for (const ev of this.player.events) {
        if (ev === 'jump') audio.jump();
        else if (ev === 'land') { audio.land(this.player.landImpact); this.trauma = Math.min(1, this.trauma + this.player.landImpact * 0.3); }
        else if (ev === 'pad') { audio.pad(); this.fovKick = 1.6; }
        else if (ev === 'fall') { audio.respawn(); this.flash = 0.7; this.hud.toast('Tombé dans le vide : retour au point de départ.'); }
      }
      this.player.events.length = 0;
      this.pushOutOfGeodes();
      this.placeCamera(dt);
      this.updateAim();
      this.updateLoop(dt);
      this.updateTutorial(dt);
      this.updateTooltip();
      this.prevFire = input.fire;
    } else if (this.mode === 'title') {
      this.time += dt;
      const a = this.time * 0.12 + 0.6;
      cam.position.set(Math.sin(a) * 27, 8.5, Math.cos(a) * 27);
      cam.lookAt(0, 2.2, 0);
    } else if (this.mode === 'modal') {
      this.time += dt * 0.25;
    }

    if (this.mode !== 'paused') {
      const running = this.phase === 'run';
      const simTime = running ? Math.min(this.loopT, this.stats.duration) : 0;
      this.arena.update(dt, this.time, running ? simTime / this.stats.duration : 0, running);
      this.geodes.update(dt, this.time, this.run ? this.run.sim : null, simTime);
      this.v.set(this.player.x, this.player.eyeY, this.player.z);
      this.shards.update(dt, this.time, this.v);
      this.debris.update(dt);
      for (const tr of this.elemTracers) tr.update(dt);
      this.rings.update(dt);
      this.floaters.update(dt);
      this.echoes.showLabels = this.mode === 'play';
      this.echoes.update(this.mode === 'modal' ? dt * 0.25 : dt, this.time, cam.position, this.player.yaw);
      this.terminal.update(dt, this.time, s, this.docked);
      const p = this.player;
      this.weapon.group.visible = this.mode === 'play';
      this.weapon.update(dt, this.time, input.lookX, input.lookY, p.bob, p.speed, p.landDip, !p.grounded);
      this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 90);
      if (this.muzzleLight.intensity > 0) this.muzzleLight.position.copy(this.muzzleWorld(this.v2));

      // ——— HUD ———
      this.pickTimer -= dt;
      if (this.pickTimer <= 0) this.pickStreak = 0;
      this.rateTimer -= real;
      if (this.rateTimer <= 0) { this.rateTimer = 1; this.stats = derive(s); this.refreshRates(); }
      const rate = totalRate(s, this.stats);
      this.hud.wallet(real, s.shards, rate, s.echoes.length, this.stats.slots);
      this.hud.loop(running ? simTime / this.stats.duration : 0, this.stats.duration - simTime, running, this.docked);
      if (this.run && running) {
        const sim = this.run.sim;
        const combo = sim.comboAt(simTime);
        this.hud.setCombo(combo, sim.comboTimeLeft(simTime) / this.stats.comboWindow, 1 + CFG.combo.step * Math.min(combo - 1, CFG.combo.maxSteps));
        let toBeat: number | null = null;
        if (s.echoes.length >= this.stats.slots && s.echoes.length > 0) {
          const w = s.echoes[weakestIndex(s)];
          toBeat = Math.floor((w.raw / w.duration) * this.stats.duration * this.stats.globalMult);
        }
        this.hud.loopTally(sim.result.shards * this.stats.globalMult, toBeat, s.tutorial >= 1);
      } else this.hud.loopTally(0, null, false);
      this.hud.onTarget(this.aimedGeode >= 0);
    }

    // ——— Post-traitement piloté par le jeu ———
    this.flash = Math.max(0, this.flash - real * 3.2);
    this.engine.flash = this.flash;
    this.fovKick = Math.max(0, this.fovKick - real * 4);
    const fov = this.engine.baseFov + this.fovKick * 3.5;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }

    this.saveTimer += real;
    if (this.saveTimer >= CFG.save.autosaveSeconds && this.mode !== 'title') { this.saveTimer = 0; this.save(); }

    // En pause plus rien ne bouge : on ne redessine que de temps en temps (redimensionnement).
    if (this.mode === 'paused' && this.pausedFrames++ % 12 !== 0) { input.endFrame(); return; }
    if (this.mode !== 'paused') this.pausedFrames = 0;
    this.engine.render(this.time);
    this.perf.drawCalls = this.engine.renderer.info.render.calls;
    this.engine.renderer.info.reset();
    input.endFrame();
  }

  /** Les géodes sont solides pour le joueur (rendu seulement : la simulation ne dépend que de sa position échantillonnée). */
  private pushOutOfGeodes(): void {
    if (this.phase !== 'run' || !this.run) return;
    const sim = this.run.sim, p = this.player, c = this.tmp;
    for (let g = 0; g < sim.specs.length; g++) {
      if (!sim.isActive(g)) continue;
      sim.pos(g, this.loopT, c);
      const r = sim.specs[g].radius + 0.55;
      if (c.y - r > p.y + 1.9 || c.y + r < p.y) continue;
      const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz);
      if (d < r && d > 1e-4) { p.x = c.x + (dx / d) * r; p.z = c.z + (dz / d) * r; }
    }
  }

  private placeCamera(dt: number): void {
    const p = this.player, cam = this.engine.camera;
    this.trauma = Math.max(0, this.trauma - dt * 1.9);
    // Secousse = trauma², appliquée à la caméra seulement (jamais au corps simulé).
    const shake = this.trauma * this.trauma * this.state.settings.shake;
    const t = this.time * 34;
    const walk = Math.min(1, p.speed / 7) * (p.grounded ? 1 : 0);
    cam.position.set(p.x, p.eyeY + Math.abs(Math.sin(p.bob)) * 0.045 * walk - p.landDip * 0.16, p.z);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(
      p.pitch + shake * 0.035 * Math.sin(t * 1.7),
      p.yaw + shake * 0.035 * Math.sin(t * 2.3 + 1),
      shake * 0.05 * Math.sin(t * 1.1 + 2) + Math.cos(p.bob) * 0.004 * walk,
    );
    cam.updateMatrixWorld();
  }
}

export const _unused = clamp;
