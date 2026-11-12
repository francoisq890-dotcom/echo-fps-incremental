/**
 * Simulation pure et déterministe d'une boucle.
 *
 * Le jeu en direct ET le rejeu d'un écho passent par cette classe, alimentée avec les mêmes
 * données quantifiées (échantillons de position à 20 Hz + tirs horodatés). Un enregistrement
 * donne donc toujours exactement le même butin.
 *
 * Aucune dépendance au rendu : la simulation émet des événements que l'affichage consomme.
 */
import { CFG } from '../config';
import { buildPattern, geodePos, type GeodeSpec, type LoopParams, type Pattern } from './pattern';

/** Éléments : 0 = neutre, 1 = feu, 2 = glace, 3 = foudre. */
export type Elem = 0 | 1 | 2 | 3;
export const FIRE = 1, ICE = 2, VOLT = 3;

/** Un tir encode son arme (bits 0-1) et son élément (bits 2-3). */
export const shotKind = (weapon: number, elem: number) => (weapon & 3) | ((elem & 3) << 2);

/**
 * Multiplicateur de dégâts d'un élément de tir contre l'élément d'une géode.
 * Le feu fait fondre la glace, la glace isole la foudre, la foudre souffle le feu.
 * Même élément : la géode résiste.
 */
export function elemMult(shot: number, geode: number): number {
  if (shot === 0 || geode === 0) return 1;
  if (shot === geode) return CFG.elements.resist;
  const beats = shot === FIRE ? ICE : shot === ICE ? VOLT : FIRE;
  return geode === beats ? CFG.elements.weak : 1;
}

export type Cause = 'shot' | 'blast' | 'burn' | 'arc';

export type SimEvent =
  | { k: 'spawn'; t: number; g: number }
  | { k: 'expire'; t: number; g: number }
  | { k: 'shot'; t: number; pts: number[]; hit: boolean; elem: number; w: number }
  | { k: 'hit'; t: number; g: number; x: number; y: number; z: number; dmg: number; stage: number; elem: number; mult: number }
  | { k: 'break'; t: number; g: number; x: number; y: number; z: number; value: number; combo: number; cause: Cause; drop: number }
  | { k: 'blast'; t: number; x: number; y: number; z: number; r: number }
  | { k: 'arc'; t: number; pts: number[] }
  | { k: 'status'; t: number; g: number; s: 'burn' | 'brittle'; until: number }
  | { k: 'attract'; t: number; drop: number; arrive: number }
  | { k: 'collect'; t: number; drop: number; value: number };

export interface LoopResult {
  /** Éclats bruts récoltés (avant multiplicateurs globaux). */
  shards: number;
  broken: number;
  shots: number;
  hits: number;
  maxCombo: number;
  /** Éclats tombés mais jamais ramassés. */
  lost: number;
}

interface Drop { x: number; y: number; z: number; value: number; t: number; arrive: number; done: boolean }

const PENDING = 0, ACTIVE = 1, BROKEN = 2, EXPIRED = 3;

export class LoopSim {
  readonly pattern: Pattern;
  readonly specs: GeodeSpec[];
  readonly state: Uint8Array;
  readonly hp: Float64Array;
  readonly spawnedAt: Float64Array;
  readonly endedAt: Float64Array;
  /** Brûlure : prochain tic, fin, dégâts par tic. */
  readonly burnNext: Float64Array;
  readonly burnUntil: Float64Array;
  readonly burnDmg: Float64Array;
  /** Gel : la géode est fragile (dégâts subis augmentés) jusqu'à cet instant. */
  readonly brittleUntil: Float64Array;
  private burning = 0;
  private ptr: number[];
  private drops: Drop[] = [];
  private combo = 0;
  private lastBreak = -Infinity;
  private pendingArrivals = 0;
  private fire: number;
  private ice: number;
  private volt: number;
  time = 0;
  events: SimEvent[] = [];
  result: LoopResult = { shards: 0, broken: 0, shots: 0, hits: 0, maxCombo: 0, lost: 0 };
  private tmp = { x: 0, y: 0, z: 0 };
  private tmp2 = { x: 0, y: 0, z: 0 };

  constructor(readonly params: LoopParams) {
    this.pattern = buildPattern(params);
    this.specs = this.pattern.specs;
    const n = this.specs.length;
    this.state = new Uint8Array(n);
    this.hp = new Float64Array(n);
    this.spawnedAt = new Float64Array(n).fill(-1);
    this.endedAt = new Float64Array(n).fill(-1);
    this.burnNext = new Float64Array(n).fill(Infinity);
    this.burnUntil = new Float64Array(n).fill(-1);
    this.burnDmg = new Float64Array(n);
    this.brittleUntil = new Float64Array(n).fill(-1);
    this.ptr = this.pattern.queues.map(() => 0);
    this.fire = params.fire ?? 0;
    this.ice = params.ice ?? 0;
    this.volt = params.volt ?? 0;
    this.advance(0);
  }

  isActive(g: number): boolean { return this.state[g] === ACTIVE; }

  pos(g: number, t: number, out: { x: number; y: number; z: number }): void {
    geodePos(this.specs[g], t, out);
  }

  /** Fait avancer l'horloge : brûlures, apparitions, expirations des dorées, arrivées d'éclats. */
  advance(t: number): void {
    if (t > this.params.duration) t = this.params.duration;
    if (t < this.time) t = this.time;

    // ——— Brûlures : tics dans l'ordre chronologique (puis par id), jusqu'à t ———
    while (this.burning > 0) {
      let g = -1, when = Infinity;
      for (let i = 0; i < this.specs.length; i++) {
        if (this.burnNext[i] < when) { when = this.burnNext[i]; g = i; }
      }
      if (g < 0 || when > t) break;
      if (this.state[g] !== ACTIVE) { this.burnNext[g] = Infinity; this.burning--; continue; }
      const next = when + CFG.elements.burnTick;
      if (next > this.burnUntil[g] + 1e-9) { this.burnNext[g] = Infinity; this.burning--; }
      else this.burnNext[g] = next;
      geodePos(this.specs[g], when, this.tmp);
      this.damage(g, this.burnDmg[g], when, this.tmp.x, this.tmp.y, this.tmp.z, 'burn', FIRE, false);
    }

    const queues = this.pattern.queues;
    for (let q = 0; q < queues.length; q++) {
      const queue = queues[q];
      for (;;) {
        const i = this.ptr[q];
        if (i >= queue.length) break;
        const g = queue[i];
        const s = this.specs[g];
        if (this.state[g] === PENDING) {
          let when = s.at;
          if (i > 0) when = Math.max(when, this.endedAt[queue[i - 1]] + CFG.geodes.respawnDelay);
          if (when > t || when >= this.params.duration) break;
          this.state[g] = ACTIVE;
          this.hp[g] = s.hp;
          this.spawnedAt[g] = when;
          this.events.push({ k: 'spawn', t: when, g });
        }
        if (this.state[g] === ACTIVE) {
          const end = this.spawnedAt[g] + s.life;
          if (end <= t) {
            this.state[g] = EXPIRED;
            this.endedAt[g] = end;
            this.events.push({ k: 'expire', t: end, g });
            this.ptr[q] = i + 1;
            continue;
          }
          break;
        }
        // Cassée ou expirée : passer à la suivante du socle.
        this.ptr[q] = i + 1;
      }
    }
    if (this.pendingArrivals > 0) {
      for (let d = 0; d < this.drops.length; d++) {
        const drop = this.drops[d];
        if (!drop.done && drop.arrive >= 0 && drop.arrive <= t) {
          drop.done = true;
          this.pendingArrivals--;
          this.result.shards += drop.value;
          this.events.push({ k: 'collect', t: drop.arrive, drop: d, value: drop.value });
        }
      }
    }
    this.time = t;
  }

  /** Échantillon de position du joueur (à 20 Hz) : déclenche l'aspiration des éclats à portée. */
  sample(t: number, x: number, y: number, z: number): void {
    this.advance(t);
    if (t >= this.params.duration) return;
    const p = this.params;
    for (let d = 0; d < this.drops.length; d++) {
      const drop = this.drops[d];
      if (drop.arrive >= 0 || t < drop.t + p.magnetDelay) continue;
      const dx = drop.x - x, dz = drop.z - z, dy = (drop.y - y) * 0.35;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist <= p.magnetRadius) {
        drop.arrive = t + Math.max(0.12, dist / p.magnetSpeed);
        this.pendingArrivals++;
        this.events.push({ k: 'attract', t, drop: d, arrive: drop.arrive });
      }
    }
  }

  /**
   * Tir : origine + direction (unitaire) + nature du tir (arme et élément, voir `shotKind`).
   * Arme 0, l'Éclateur : un rayon précis (perforation, ricochets).
   * Arme 1, le Fracasseur : une gerbe de plombs en cône, dévastatrice de près, faible de loin.
   */
  shoot(t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, kind = 0): void {
    this.advance(t);
    if (t >= this.params.duration) return;
    const p = this.params;
    const weapon = kind & 3;
    let elem = (kind >> 2) & 3;
    // Un élément non débloqué au moment de l'enregistrement ne fait rien.
    if ((elem === FIRE && this.fire <= 0) || (elem === ICE && this.ice <= 0) || (elem === VOLT && this.volt <= 0)) elem = 0;
    this.result.shots++;

    if (weapon === 1 && (p.w2 ?? 0) > 0) {
      const W = CFG.w2;
      const n = W.pellets + W.pelletsPerLevel * ((p.w2 ?? 1) - 1);
      // Base orthonormée autour de la direction de visée.
      let rx = dz, ry = 0, rz = -dx;
      let rl = Math.hypot(rx, rz);
      if (rl < 1e-6) { rx = 1; rz = 0; rl = 1; }
      rx /= rl; rz /= rl;
      const ux = ry * dz - rz * dy, uy = rz * dx - rx * dz, uz = rx * dy - ry * dx;
      let any = false;
      for (let i = 0; i < n; i++) {
        // Répartition fixe en spirale (angle d'or) : même gerbe à chaque tir, donc rejouable.
        const r = W.spread * Math.sqrt((i + 0.5) / n), a = i * 2.39996323;
        const cx = Math.cos(a) * r, cy = Math.sin(a) * r;
        let px = dx + rx * cx + ux * cy, py = dy + ry * cx + uy * cy, pz = dz + rz * cx + uz * cy;
        const pl = Math.hypot(px, py, pz);
        px /= pl; py /= pl; pz /= pl;
        if (this.castRay(t, ox, oy, oz, px, py, pz, p.damage * W.damage, elem, 1, false)) any = true;
      }
      if (any) this.result.hits++;
      return;
    }
    if (this.castRay(t, ox, oy, oz, dx, dy, dz, p.damage, elem, 0, true)) this.result.hits++;
  }

  /** Un rayon : perforation, ricochets (arme 0), arcs de foudre. Retourne vrai s'il touche. */
  private castRay(t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    baseDmg: number, elem: number, w: number, rico: boolean): boolean {
    const p = this.params;
    const pts: number[] = [ox, oy, oz];
    const c = this.tmp;

    // Toutes les géodes actives traversées par le rayon, triées par distance.
    const cand: { g: number; d: number }[] = [];
    for (let g = 0; g < this.specs.length; g++) {
      if (this.state[g] !== ACTIVE) continue;
      const s = this.specs[g];
      geodePos(s, t, c);
      const lx = c.x - ox, ly = c.y - oy, lz = c.z - oz;
      const tca = lx * dx + ly * dy + lz * dz;
      if (tca < 0 || tca > CFG.weapon.range) continue;
      const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
      const r = s.radius * 1.12;
      if (d2 > r * r) continue;
      cand.push({ g, d: tca - Math.sqrt(r * r - d2) });
    }
    cand.sort((a, b) => a.d - b.d || a.g - b.g);
    const primary = cand.slice(0, 1 + p.pierce);

    if (primary.length === 0) {
      const far = w === 1 ? CFG.w2.falloffEnd : 70;
      pts.push(ox + dx * far, oy + dy * far, oz + dz * far);
      this.events.push({ k: 'shot', t, pts, hit: false, elem, w });
      return false;
    }
    const touched = new Set<number>();
    let last = -1, lastDmg = baseDmg;
    for (const h of primary) {
      if (this.state[h.g] !== ACTIVE) continue; // déjà détruite par une explosion du même tir
      const hx = ox + dx * h.d, hy = oy + dy * h.d, hz = oz + dz * h.d;
      pts.push(hx, hy, hz);
      touched.add(h.g);
      last = h.g;
      let dmg = baseDmg;
      if (w === 1) {
        // Le Fracasseur perd sa force avec la distance.
        const W = CFG.w2;
        const k = Math.min(1, Math.max(0, (h.d - W.falloffStart) / (W.falloffEnd - W.falloffStart)));
        dmg *= 1 - k * (1 - W.falloffMin);
      }
      lastDmg = dmg;
      this.damage(h.g, dmg, t, hx, hy, hz, 'shot', elem, true);
    }
    // Ricochets : de proche en proche vers la géode active la plus proche.
    if (rico) {
      let dmg = baseDmg;
      for (let b = 0; b < p.rico && last >= 0; b++) {
        geodePos(this.specs[last], t, c);
        let best = -1, bestD = CFG.weapon.ricochetRange;
        const o = this.tmp2;
        for (let g = 0; g < this.specs.length; g++) {
          if (this.state[g] !== ACTIVE || touched.has(g)) continue;
          geodePos(this.specs[g], t, o);
          const d = Math.hypot(o.x - c.x, o.y - c.y, o.z - c.z);
          if (d < bestD) { bestD = d; best = g; }
        }
        if (best < 0) break;
        dmg *= CFG.weapon.ricochetFalloff;
        geodePos(this.specs[best], t, o);
        pts.push(o.x, o.y, o.z);
        touched.add(best);
        last = best;
        this.damage(best, dmg, t, o.x, o.y, o.z, 'shot', elem, true);
      }
    }
    this.events.push({ k: 'shot', t, pts, hit: true, elem, w });

    // Foudre : un arc saute de la dernière géode touchée vers ses voisines.
    if (elem === VOLT && last >= 0) {
      const E = CFG.elements;
      const arcs = E.arcCount + Math.floor((this.volt - 1) / 2);
      const arcDmg = lastDmg * (E.arcBase + E.arcPerLevel * (this.volt - 1));
      const apts: number[] = [];
      geodePos(this.specs[last], t, c);
      apts.push(c.x, c.y, c.z);
      let from = last;
      for (let a = 0; a < arcs; a++) {
        geodePos(this.specs[from], t, c);
        let best = -1, bestD = E.arcRange;
        const o = this.tmp2;
        for (let g = 0; g < this.specs.length; g++) {
          if (this.state[g] !== ACTIVE || touched.has(g)) continue;
          geodePos(this.specs[g], t, o);
          const d = Math.hypot(o.x - c.x, o.y - c.y, o.z - c.z);
          if (d < bestD) { bestD = d; best = g; }
        }
        if (best < 0) break;
        geodePos(this.specs[best], t, o);
        apts.push(o.x, o.y, o.z);
        touched.add(best);
        from = best;
        // Un arc ne déclenche pas d'autres arcs (pas de cascade infinie).
        this.damage(best, arcDmg, t, o.x, o.y, o.z, 'arc', VOLT, false);
      }
      if (apts.length > 3) this.events.push({ k: 'arc', t, pts: apts });
    }
    return true;
  }

  /**
   * Applique des dégâts (et leurs suites : statuts, cassure, explosions en chaîne).
   * `status` : le coup pose-t-il l'effet de son élément (brûlure, gel) ?
   */
  private damage(g0: number, dmg0: number, t: number, hx: number, hy: number, hz: number, cause0: Cause, elem0: number, status: boolean): void {
    const p = this.params;
    const E = CFG.elements;
    // File d'attente explicite : les explosions s'enchaînent sans récursion.
    const queue: { g: number; dmg: number; x: number; y: number; z: number; cause: Cause; elem: number }[] = [
      { g: g0, dmg: dmg0, x: hx, y: hy, z: hz, cause: cause0, elem: elem0 },
    ];
    const c = { x: 0, y: 0, z: 0 };
    const o = { x: 0, y: 0, z: 0 };
    for (let qi = 0; qi < queue.length; qi++) {
      const { g, x, y, z, cause, elem } = queue[qi];
      if (this.state[g] !== ACTIVE) continue;
      const s = this.specs[g];
      let mult = elemMult(elem, s.elem ?? 0);
      // Géode gelée : fragile, tous les dégâts sont amplifiés.
      if (this.brittleUntil[g] > t) mult *= 1 + E.brittleBase + E.brittlePerLevel * Math.max(0, this.ice - 1);
      const dmg = queue[qi].dmg * mult;
      this.hp[g] -= dmg;
      if (this.hp[g] > 1e-9) {
        const ratio = this.hp[g] / s.hp;
        if (cause !== 'burn') this.events.push({ k: 'hit', t, g, x, y, z, dmg, stage: ratio > 0.66 ? 0 : ratio > 0.33 ? 1 : 2, elem, mult });
        if (status && qi === 0 && (cause === 'shot')) {
          if (elem === FIRE) {
            const tick = queue[qi].dmg * (E.burnBase + E.burnPerLevel * (this.fire - 1));
            if (this.burnNext[g] === Infinity) { this.burning++; this.burnNext[g] = t + E.burnTick; }
            this.burnUntil[g] = t + E.burnDuration;
            if (tick > this.burnDmg[g]) this.burnDmg[g] = tick;
            this.events.push({ k: 'status', t, g, s: 'burn', until: this.burnUntil[g] });
          } else if (elem === ICE) {
            this.brittleUntil[g] = t + E.brittleDuration;
            this.events.push({ k: 'status', t, g, s: 'brittle', until: this.brittleUntil[g] });
          }
        }
        continue;
      }
      // ——— Cassure ———
      this.state[g] = BROKEN;
      this.endedAt[g] = t;
      if (this.burnNext[g] !== Infinity) { this.burnNext[g] = Infinity; this.burning--; }
      geodePos(s, t, c);
      this.combo = t - this.lastBreak <= p.comboWindow ? this.combo + 1 : 1;
      this.lastBreak = t;
      if (this.combo > this.result.maxCombo) this.result.maxCombo = this.combo;
      const comboMult = 1 + CFG.combo.step * Math.min(this.combo - 1, CFG.combo.maxSteps);
      const value = Math.max(1, Math.round(s.value * comboMult * p.valueMult));
      this.result.broken++;
      const drop = this.drops.length;
      this.drops.push({ x: c.x, y: c.y, z: c.z, value, t, arrive: -1, done: false });
      this.events.push({ k: 'break', t, g, x: c.x, y: c.y, z: c.z, value, combo: this.combo, cause, drop });

      let blastDmg = 0, blastR = 0;
      if (p.chain > 0) {
        blastDmg = p.damage * CFG.weapon.chainDamagePerLevel * p.chain;
        blastR = CFG.weapon.chainRadiusBase + CFG.weapon.chainRadiusPerLevel * p.chain;
      }
      if (s.type === 'explosive') {
        blastDmg = Math.max(blastDmg, CFG.geodes.explosiveDamage * CFG.geodes.zoneHp[s.zone]);
        blastR = Math.max(blastR, CFG.geodes.explosiveRadius);
      }
      if (blastR > 0) {
        this.events.push({ k: 'blast', t, x: c.x, y: c.y, z: c.z, r: blastR });
        for (let h = 0; h < this.specs.length; h++) {
          if (h === g || this.state[h] !== ACTIVE) continue;
          geodePos(this.specs[h], t, o);
          if (Math.hypot(o.x - c.x, o.y - c.y, o.z - c.z) <= blastR) {
            // Les explosions sont neutres : elles ignorent faiblesses et résistances.
            queue.push({ g: h, dmg: blastDmg, x: o.x, y: o.y, z: o.z, cause: 'blast', elem: 0 });
          }
        }
      }
    }
  }

  /** Termine la boucle : les éclats encore en vol arrivent, le reste est perdu. */
  finish(): LoopResult {
    this.advance(this.params.duration);
    for (const d of this.drops) if (!d.done) this.result.lost += d.value;
    return this.result;
  }

  dropInfo(i: number): Readonly<Drop> { return this.drops[i]; }

  /** Combo en cours à l'instant t (0 si la fenêtre est passée). */
  comboAt(t: number): number {
    return t - this.lastBreak <= this.params.comboWindow ? this.combo : 0;
  }
  comboTimeLeft(t: number): number {
    return Math.max(0, this.params.comboWindow - (t - this.lastBreak));
  }
}
