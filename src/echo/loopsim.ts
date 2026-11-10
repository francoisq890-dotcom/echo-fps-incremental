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

export type SimEvent =
  | { k: 'spawn'; t: number; g: number }
  | { k: 'expire'; t: number; g: number }
  | { k: 'shot'; t: number; pts: number[]; hit: boolean }
  | { k: 'hit'; t: number; g: number; x: number; y: number; z: number; dmg: number; stage: number }
  | { k: 'break'; t: number; g: number; x: number; y: number; z: number; value: number; combo: number; cause: 'shot' | 'blast'; drop: number }
  | { k: 'blast'; t: number; x: number; y: number; z: number; r: number }
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
  private ptr: number[];
  private drops: Drop[] = [];
  private combo = 0;
  private lastBreak = -Infinity;
  private pendingArrivals = 0;
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
    this.ptr = this.pattern.queues.map(() => 0);
    this.advance(0);
  }

  isActive(g: number): boolean { return this.state[g] === ACTIVE; }

  pos(g: number, t: number, out: { x: number; y: number; z: number }): void {
    geodePos(this.specs[g], t, out);
  }

  /** Fait avancer l'horloge : apparitions, expirations des dorées, arrivées d'éclats. */
  advance(t: number): void {
    if (t > this.params.duration) t = this.params.duration;
    if (t < this.time) t = this.time;
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

  /** Tir : origine + direction (unitaire). Gère perforation, ricochets et explosions en chaîne. */
  shoot(t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
    this.advance(t);
    if (t >= this.params.duration) return;
    const p = this.params;
    this.result.shots++;
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
      pts.push(ox + dx * 70, oy + dy * 70, oz + dz * 70);
      this.events.push({ k: 'shot', t, pts, hit: false });
      return;
    }
    this.result.hits++;
    const touched = new Set<number>();
    let last = -1;
    for (const h of primary) {
      if (this.state[h.g] !== ACTIVE) continue; // déjà détruite par une explosion du même tir
      const hx = ox + dx * h.d, hy = oy + dy * h.d, hz = oz + dz * h.d;
      pts.push(hx, hy, hz);
      touched.add(h.g);
      last = h.g;
      this.damage(h.g, p.damage, t, hx, hy, hz, 'shot');
    }
    // Ricochets : de proche en proche vers la géode active la plus proche.
    let dmg = p.damage;
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
      this.damage(best, dmg, t, o.x, o.y, o.z, 'shot');
    }
    this.events.push({ k: 'shot', t, pts, hit: true });
  }

  private damage(g0: number, dmg0: number, t: number, hx: number, hy: number, hz: number, cause0: 'shot' | 'blast'): void {
    const p = this.params;
    // File d'attente explicite : les explosions s'enchaînent sans récursion.
    const queue: { g: number; dmg: number; x: number; y: number; z: number; cause: 'shot' | 'blast' }[] = [
      { g: g0, dmg: dmg0, x: hx, y: hy, z: hz, cause: cause0 },
    ];
    const c = { x: 0, y: 0, z: 0 };
    const o = { x: 0, y: 0, z: 0 };
    for (let qi = 0; qi < queue.length; qi++) {
      const { g, dmg, x, y, z, cause } = queue[qi];
      if (this.state[g] !== ACTIVE) continue;
      const s = this.specs[g];
      this.hp[g] -= dmg;
      if (this.hp[g] > 1e-9) {
        const ratio = this.hp[g] / s.hp;
        this.events.push({ k: 'hit', t, g, x, y, z, dmg, stage: ratio > 0.66 ? 0 : ratio > 0.33 ? 1 : 2 });
        continue;
      }
      // ——— Cassure ———
      this.state[g] = BROKEN;
      this.endedAt[g] = t;
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
            queue.push({ g: h, dmg: blastDmg, x: o.x, y: o.y, z: o.z, cause: 'blast' });
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
