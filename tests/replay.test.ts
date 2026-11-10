/**
 * Tests du rejeu déterministe des échos.
 *
 * Un petit pilote joue une vraie boucle à travers LoopRun (visée de géodes actives, tirs à cadence
 * régulière, déplacement vers les éclats tombés), puis on vérifie que replay() redonne exactement
 * le même butin et les mêmes événements.
 */
import { describe, expect, it } from 'vitest';
import { CFG, UPGRADE_BY_ID } from '../src/config';
import type { LoopResult, SimEvent } from '../src/echo/loopsim';
import { buildPattern, type LoopParams } from '../src/echo/pattern';
import {
  LoopRun, decodeRecording, encodeRecording, poseAt, replay, shotCount, tickCount,
  type Pose, type Recording,
} from '../src/echo/recording';
import { derive, loopParams, newState } from '../src/economy/state';
import { START } from '../src/world/layout';

type V3 = { x: number; y: number; z: number };

const HZ = CFG.loop.sampleHz;
const EYE = CFG.player.eyeHeight;

/** Paramètres de boucle pour un état neuf doté des niveaux / perks donnés (niveaux bornés au max). */
function paramsFor(levels: Record<string, number> = {}, perks: Record<string, number> = {}): { params: LoopParams; fireRate: number } {
  const s = newState(0);
  for (const [id, n] of Object.entries(levels)) s.levels[id] = Math.min(UPGRADE_BY_ID[id].max, n);
  Object.assign(s.perks, perks);
  return { params: loopParams(s), fireRate: derive(s).fireRate };
}

/** Angles de visée de `from` vers `to`, convention de dirFrom : d = (-sin(yaw)·cos(pitch), sin(pitch), -cos(yaw)·cos(pitch)). */
function aim(from: V3, to: V3): { yaw: number; pitch: number } {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.asin(dy / len) };
}

/** Prend tous les échantillons dus à l'instant t, à la pose donnée. */
function tickDue(run: LoopRun, t: number, p: V3, yaw = 0, pitch = 0): void {
  while (run.ticks < run.ticksDue(t)) run.tick(p.x, p.y, p.z, yaw, pitch);
}

interface DriveOptions { shoot?: boolean; move?: boolean; fireRate?: number }
interface Driven { recording: Recording; result: LoopResult; events: SimEvent[] }

/**
 * Pilote : avance par pas de 10 ms (temps entiers en ms, donc aucune ambiguïté d'arrondi).
 * À chaque pas : échantillons dus, puis éventuellement un tir vers la géode active la plus proche,
 * puis déplacement (en vol libre : la simulation ne connaît pas le décor) vers l'éclat le plus ancien
 * pas encore aspiré.
 */
function drive(params: LoopParams, opts: DriveOptions = {}): Driven {
  const { shoot = true, move = true, fireRate = CFG.weapon.baseFireRate } = opts;
  const run = new LoopRun(params);
  const sim = run.sim;
  const pos: V3 = { x: START.x, y: START.y + EYE, z: START.z };
  let yaw = START.yaw, pitch = 0;
  const steps = Math.round(params.duration * 100);
  const shotEvery = Math.max(1, Math.round(100 / fireRate));
  const dt = 0.01;
  const g: V3 = { x: 0, y: 0, z: 0 };
  /** Éclats tombés et pas encore aspirés, dans l'ordre de chute. */
  const pending = new Map<number, V3>();
  let seen = 0;

  for (let i = 0; i <= steps; i++) {
    const t = i / 100;
    tickDue(run, t, pos, yaw, pitch);

    if (shoot && i > 0 && i % shotEvery === 0 && t < params.duration) {
      // Géode active la plus proche (à égalité : plus petit identifiant).
      let best = -1, bestD = Infinity;
      for (let id = 0; id < sim.specs.length; id++) {
        if (!sim.isActive(id)) continue;
        sim.pos(id, t, g);
        const d = Math.hypot(g.x - pos.x, g.y - pos.y, g.z - pos.z);
        if (d < bestD) { bestD = d; best = id; }
      }
      if (best >= 0) {
        sim.pos(best, t, g);
        ({ yaw, pitch } = aim(pos, g));
        run.shoot(t, pos.x, pos.y, pos.z, yaw, pitch);
      }
    }

    // Suivi des éclats à partir des événements de la simulation.
    for (; seen < sim.events.length; seen++) {
      const e = sim.events[seen];
      if (e.k === 'break') pending.set(e.drop, { x: e.x, y: e.y, z: e.z });
      else if (e.k === 'attract') pending.delete(e.drop);
    }

    if (move && pending.size > 0) {
      const target = pending.values().next().value as V3;
      const dx = target.x - pos.x, dy = target.y - pos.y, dz = target.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 0.5) {
        const stepLen = Math.min(d, CFG.player.speed * dt);
        pos.x += (dx / d) * stepLen;
        pos.y += (dy / d) * stepLen;
        pos.z += (dz / d) * stepLen;
      }
    }
  }
  const { recording, result } = run.finish();
  return { recording, result: { ...result }, events: sim.events.slice() };
}

/**
 * Remplace -0 par 0 dans une liste d'événements. En direct, une coordonnée quantifiée peut valoir -0
 * (Math.round(-0,004) = -0) alors que l'Int16Array du rejeu la relit en +0 : même nombre, mais
 * toEqual distingue les deux signes.
 */
function noNegZero(events: SimEvent[]): SimEvent[] {
  return events.map((e) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) {
      out[k] = Array.isArray(v) ? v.map((n: number) => n + 0) : typeof v === 'number' ? v + 0 : v;
    }
    return out as unknown as SimEvent;
  });
}

/** Jeux de paramètres couvrant les mécaniques : zones, ricochet, perforation, chaîne, types de géodes, densité… */
const CASES: { name: string; levels: Record<string, number>; perks?: Record<string, number> }[] = [
  { name: 'état neuf', levels: {} },
  { name: 'arme + densité + aimant', levels: { dmg: 5, rate: 3, density: 4, mrad: 3, mspd: 2 } },
  { name: 'terrasses, ricochet, mobiles', levels: { zone: 1, rico: 2, dmg: 8, mobile: 3, rate: 5 } },
  { name: 'passerelles, perforation, chaîne, explosives', levels: { zone: 2, pierce: 2, chain: 2, dmg: 10, explosive: 4, dur: 3 } },
  { name: 'aiguille, dorées, blindées, tout au max', levels: { zone: 3, golden: 6, armored: 6, dmg: 20, rico: 4, pierce: 3, chain: 5, density: 12, mrad: 10, mspd: 6, rate: 15 } },
  { name: 'mobiles + explosives + chaîne', levels: { mobile: 6, explosive: 6, chain: 3, dmg: 6, dur: 2, mrad: 5 } },
  { name: 'dorées + blindées en arène, boucle longue', levels: { golden: 6, armored: 6, dmg: 12, dur: 8, density: 6, mspd: 10 } },
  { name: 'perks (filon, combo, canon, aimant)', levels: { dmg: 4, density: 3, explosive: 2 }, perks: { gold: 2, combo: 1, dmg: 1, magnet: 2 } },
];

/** Les boucles sont jouées une seule fois et partagées entre les tests. */
const driven = new Map<string, Driven>();
function play(name: string): Driven {
  let d = driven.get(name);
  if (!d) {
    const c = CASES.find((x) => x.name === name)!;
    const { params, fireRate } = paramsFor(c.levels, c.perks);
    d = drive(params, { fireRate });
    driven.set(name, d);
  }
  return d;
}

describe('pilote de test', () => {
  it('couvre au moins 6 jeux de paramètres distincts', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(6);
    const keys = new Set(CASES.map((c) => JSON.stringify(paramsFor(c.levels, c.perks).params)));
    expect(keys.size).toBe(CASES.length);
  });

  for (const c of CASES) {
    it(`joue une vraie boucle : ${c.name}`, () => {
      const { recording, result, events } = play(c.name);
      // Le pilote tire, touche, casse et ramasse réellement : les tests de rejeu ne sont pas triviaux.
      expect(result.shots).toBeGreaterThan(10);
      expect(result.hits).toBeGreaterThan(result.shots * 0.5);
      expect(result.broken).toBeGreaterThan(0);
      expect(result.shards).toBeGreaterThan(0);
      expect(shotCount(recording)).toBeGreaterThanOrEqual(result.shots);
      expect(recording.samples.length).toBe(tickCount(recording.params.duration) * 5);
      expect(events.some((e) => e.k === 'collect')).toBe(true);
      // Butin = somme des éclats ramassés ; cassés = ramassés + perdus.
      const collected = events.reduce((a, e) => a + (e.k === 'collect' ? e.value : 0), 0);
      const dropped = events.reduce((a, e) => a + (e.k === 'break' ? e.value : 0), 0);
      expect(result.shards).toBe(collected);
      expect(result.shards + result.lost).toBe(dropped);
      expect(result.broken).toBe(events.filter((e) => e.k === 'break').length);
    });
  }

  it('les mécaniques avancées se déclenchent vraiment dans les boucles pilotées', () => {
    const blasts = (n: string) => play(n).events.filter((e) => e.k === 'blast').length;
    const byBlast = (n: string) => play(n).events.filter((e) => e.k === 'break' && e.cause === 'blast').length;
    expect(blasts('état neuf')).toBe(0);
    expect(blasts('passerelles, perforation, chaîne, explosives')).toBeGreaterThan(0);
    expect(blasts('mobiles + explosives + chaîne')).toBeGreaterThan(0);
    expect(byBlast('aiguille, dorées, blindées, tout au max') + byBlast('mobiles + explosives + chaîne')).toBeGreaterThan(0);
    // Ricochet : au moins un tir avec plus de deux points (origine, impact, rebond).
    const rico = play('terrasses, ricochet, mobiles').events.some((e) => e.k === 'shot' && e.hit && e.pts.length > 6);
    expect(rico).toBe(true);
    // Types de géodes présents dans les patterns concernés.
    const types = (n: string) => new Set(buildPattern(play(n).recording.params).specs.map((s) => s.type));
    expect(types('terrasses, ricochet, mobiles').has('mobile')).toBe(true);
    expect(types('mobiles + explosives + chaîne').has('explosive')).toBe(true);
    expect(types('aiguille, dorées, blindées, tout au max').has('armored')).toBe(true);
    expect(types('dorées + blindées en arène, boucle longue').has('golden')).toBe(true);
  });
});

describe('(a) replay redonne exactement le résultat du direct', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const live = play(c.name);
      const re = replay(live.recording);
      expect(re.result).toEqual(live.result);
      // Plus fort : la suite d'événements est identique à celle du direct.
      expect(noNegZero(re.events)).toEqual(noNegZero(live.events));
    });
  }
});

describe('(b) deux rejeux successifs sont identiques', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const rec = play(c.name).recording;
      const samples = Array.from(rec.samples), shots = Array.from(rec.shots), params = { ...rec.params };
      const a = replay(rec);
      const b = replay(rec);
      expect(b.result).toEqual(a.result);
      expect(b.events).toEqual(a.events);
      expect(b.events).not.toBe(a.events);
      // Le rejeu ne modifie pas l'enregistrement.
      expect(Array.from(rec.samples)).toEqual(samples);
      expect(Array.from(rec.shots)).toEqual(shots);
      expect(rec.params).toEqual(params);
    });
  }
});

describe('(c) encodeRecording → decodeRecording → replay', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const live = play(c.name);
      const text = encodeRecording(live.recording);
      expect(typeof text).toBe('string');
      const back = decodeRecording(text);
      expect(back.params).toEqual(live.recording.params);
      expect(Array.from(back.samples)).toEqual(Array.from(live.recording.samples));
      expect(Array.from(back.shots)).toEqual(Array.from(live.recording.shots));
      const re = replay(back);
      expect(re.result).toEqual(live.result);
      expect(noNegZero(re.events)).toEqual(noNegZero(live.events));
      // L'encodage est stable : ré-encoder redonne le même texte.
      expect(encodeRecording(back)).toBe(text);
    });
  }

  it('survit à un passage par JSON (comme dans la sauvegarde)', () => {
    const live = play('terrasses, ricochet, mobiles');
    const stored = JSON.parse(JSON.stringify({ rec: encodeRecording(live.recording) })).rec as string;
    expect(replay(decodeRecording(stored)).result).toEqual(live.result);
  });

  it('decodeRecording rejette un texte illisible', () => {
    expect(() => decodeRecording('n\'importe quoi')).toThrow();
    expect(() => decodeRecording('')).toThrow();
  });

  it('une boucle sans tir ni échantillon s\'encode et se rejoue', () => {
    const { params } = paramsFor();
    const { recording, result } = new LoopRun(params).finish();
    const back = decodeRecording(encodeRecording(recording));
    expect(back.samples.length).toBe(0);
    expect(back.shots.length).toBe(0);
    expect(replay(back).result).toEqual(result);
  });
});

describe('(d) buildPattern', () => {
  it('est déterministe : mêmes paramètres → même pattern', () => {
    for (const c of CASES) {
      const { params } = paramsFor(c.levels, c.perks);
      const a = buildPattern(params);
      const b = buildPattern({ ...params });
      expect(b).toEqual(a);
      expect(a.specs.length).toBeGreaterThan(0);
      // Identifiants = index, et chaque géode appartient à exactement une file de socle.
      a.specs.forEach((s, i) => expect(s.id).toBe(i));
      expect(a.queues.flat().sort((x, y) => x - y)).toEqual(a.specs.map((s) => s.id));
    }
  });

  it('change quand la zone change', () => {
    const { params } = paramsFor();
    const z0 = buildPattern(params);
    const z1 = buildPattern({ ...params, zone: params.zone + 1 });
    expect(z1).not.toEqual(z0);
    expect(z0.specs.every((s) => s.zone <= params.zone)).toBe(true);
    expect(z1.specs.some((s) => s.zone === params.zone + 1)).toBe(true);
    expect(z1.queues.length).toBeGreaterThan(z0.queues.length);
  });

  it('change quand la densité change (plus de géodes)', () => {
    const { params } = paramsFor();
    const d0 = buildPattern(params);
    const d1 = buildPattern({ ...params, density: params.density + 6 });
    expect(d1).not.toEqual(d0);
    expect(d1.specs.length).toBeGreaterThan(d0.specs.length);
  });

  it('change avec la graine, pas avec les paramètres d\'arme ou d\'aimant', () => {
    const { params } = paramsFor();
    const base = buildPattern(params);
    expect(buildPattern({ ...params, seed: params.seed + 1 })).not.toEqual(base);
    expect(buildPattern({ ...params, damage: params.damage * 3, rico: 2, pierce: 1, chain: 2, magnetRadius: 30 })).toEqual(base);
  });

  it('toutes les géodes sont programmées dans la durée de la boucle', () => {
    for (const c of CASES) {
      const { params } = paramsFor(c.levels, c.perks);
      for (const s of buildPattern(params).specs) {
        expect(s.at).toBeGreaterThanOrEqual(0);
        expect(s.at).toBeLessThan(params.duration);
        expect(s.hp).toBeGreaterThan(0);
        expect(s.value).toBeGreaterThan(0);
      }
    }
  });
});

describe('(e) un pilote qui ne tire pas ne récolte rien', () => {
  for (const name of ['état neuf', 'aiguille, dorées, blindées, tout au max']) {
    it(name, () => {
      const c = CASES.find((x) => x.name === name)!;
      const { params } = paramsFor(c.levels, c.perks);
      const d = drive(params, { shoot: false });
      expect(d.result).toEqual({ shards: 0, broken: 0, shots: 0, hits: 0, maxCombo: 0, lost: 0 });
      expect(shotCount(d.recording)).toBe(0);
      expect(d.events.every((e) => e.k === 'spawn' || e.k === 'expire')).toBe(true);
      expect(replay(d.recording).result).toEqual(d.result);
    });
  }
});

/**
 * Paramètres « un tir = une cassure » pour les scénarios construits à la main :
 * dégâts énormes, pas de ricochet / perforation / chaîne.
 */
function oneShotParams(extra: Partial<LoopParams> = {}): LoopParams {
  return { ...paramsFor().params, damage: 1e9, rico: 0, pierce: 0, chain: 0, ...extra };
}

/** Géodes actives à t = 0 (présentes dès le départ dans l'arène). */
function initialGeodes(run: LoopRun): number[] {
  return run.sim.specs.filter((s) => run.sim.isActive(s.id)).map((s) => s.id);
}

describe('(f) aimant : un éclat hors de portée n\'est ramassé que si le joueur s\'approche', () => {
  /**
   * Casse une géode de l'arène depuis un point éloigné (à l'extérieur, dans l'axe centre → géode),
   * puis place le joueur selon `where(t, éclat)` pour chaque échantillon restant.
   */
  function scenario(where: (t: number, drop: V3, far: V3) => V3) {
    const params = oneShotParams();
    const run = new LoopRun(params);
    const target = initialGeodes(run)[0];
    expect(target).toBeDefined();
    const gp: V3 = { x: 0, y: 0, z: 0 };
    run.sim.pos(target, 0.1, gp);
    // Point de tir : à 4 rayons d'aimant de la géode, vers l'extérieur de l'arène.
    const dist = Math.max(20, params.magnetRadius * 4);
    const r = Math.hypot(gp.x, gp.z);
    const far: V3 = { x: gp.x * (1 + dist / r), y: gp.y, z: gp.z * (1 + dist / r) };

    tickDue(run, 0.1, far);
    const a = aim(far, gp);
    run.shoot(0.1, far.x, far.y, far.z, a.yaw, a.pitch);
    const brk = run.sim.events.find((e) => e.k === 'break');
    expect(brk).toBeDefined();
    if (!brk || brk.k !== 'break') throw new Error('la géode visée n\'a pas été cassée');
    expect(brk.g).toBe(target);
    const drop: V3 = { x: brk.x, y: brk.y, z: brk.z };
    expect(Math.hypot(drop.x - far.x, drop.z - far.z)).toBeGreaterThan(params.magnetRadius * 2);

    for (let k = run.ticks; k < tickCount(params.duration); k++) {
      const t = k / HZ;
      const p = where(t, drop, far);
      run.tick(p.x, p.y, p.z, a.yaw, a.pitch);
    }
    const { recording, result } = run.finish();
    return { params, recording, result: { ...result }, events: run.sim.events.slice(), value: brk.value };
  }

  it('le joueur reste loin : rien n\'est ramassé, l\'éclat est perdu', () => {
    const s = scenario((_t, _drop, far) => far);
    expect(s.value).toBeGreaterThan(0);
    expect(s.result.broken).toBe(1);
    expect(s.result.shards).toBe(0);
    expect(s.result.lost).toBe(s.value);
    expect(s.events.some((e) => e.k === 'attract' || e.k === 'collect')).toBe(false);
    expect(replay(s.recording).result).toEqual(s.result);
  });

  it('un échantillon ultérieur à portée : l\'éclat est aspiré puis ramassé', () => {
    const half = oneShotParams().duration / 2;
    const s = scenario((t, drop, far) => (t >= half ? drop : far));
    expect(s.result.broken).toBe(1);
    expect(s.result.shards).toBe(s.value);
    expect(s.result.lost).toBe(0);
    const attract = s.events.find((e) => e.k === 'attract');
    const collect = s.events.find((e) => e.k === 'collect');
    expect(attract).toBeDefined();
    expect(collect).toBeDefined();
    // Rien avant que le joueur n'arrive à portée.
    expect(attract!.t).toBeGreaterThanOrEqual(half - 1e-9);
    expect(attract!.t).toBeLessThan(half + 1.5 / HZ);
    expect(collect!.t).toBeGreaterThan(attract!.t);
    const re = replay(s.recording);
    expect(re.result).toEqual(s.result);
    expect(re.events).toEqual(s.events);
  });

  it('juste hors du rayon : rien ; juste dedans : ramassé', () => {
    const R = oneShotParams().magnetRadius;
    const half = oneShotParams().duration / 2;
    const out = scenario((t, drop, far) => (t >= half ? { x: drop.x + R + 0.5, y: drop.y, z: drop.z } : far));
    expect(out.result.shards).toBe(0);
    expect(out.result.lost).toBe(out.value);
    const inside = scenario((t, drop, far) => (t >= half ? { x: drop.x + R - 0.5, y: drop.y, z: drop.z } : far));
    expect(inside.result.shards).toBe(inside.value);
  });

  it('l\'éclat ne part pas avant le délai d\'aimant, même si le joueur est dessus', () => {
    const params = oneShotParams();
    const s = scenario((_t, drop) => drop);
    const attract = s.events.find((e) => e.k === 'attract')!;
    expect(attract).toBeDefined();
    expect(attract.t).toBeGreaterThanOrEqual(0.1 + params.magnetDelay - 1e-9);
    expect(s.result.shards).toBe(s.value);
  });

  it('arrivé à portée trop tard (dernier échantillon) : l\'éclat encore en vol est perdu ou ramassé, jamais les deux', () => {
    const params = oneShotParams();
    const lastT = (tickCount(params.duration) - 1) / HZ;
    const s = scenario((t, drop, far) => (t >= lastT - 1e-9 ? drop : far));
    expect(s.result.shards + s.result.lost).toBe(s.value);
    expect(replay(s.recording).result).toEqual(s.result);
  });
});

describe('(g) combo', () => {
  /** Casse deux géodes de l'arène, la seconde `gap` secondes après la première. Retourne les cassures. */
  function twoBreaks(gap: number, extra: Partial<LoopParams> = {}) {
    // valueMult élevé : l'arrondi à l'entier ne masque pas le bonus de combo, quelle que soit la valeur de base.
    const params = oneShotParams({ valueMult: 1000, ...extra });
    const run = new LoopRun(params);
    const [g1, g2] = initialGeodes(run);
    expect(g2).toBeDefined();
    const gp: V3 = { x: 0, y: 0, z: 0 };
    const shootAt = (id: number, t: number) => {
      run.sim.pos(id, t, gp);
      // À 3 m de la géode, côté centre de l'arène : aucune autre géode sur la ligne de tir.
      const r = Math.hypot(gp.x, gp.z);
      const from: V3 = { x: gp.x * (1 - 3 / r), y: gp.y, z: gp.z * (1 - 3 / r) };
      tickDue(run, t, from);
      const a = aim(from, gp);
      run.shoot(t, from.x, from.y, from.z, a.yaw, a.pitch);
    };
    shootAt(g1, 0.1);
    shootAt(g2, 0.1 + gap);
    const { recording, result } = run.finish();
    const breaks = run.sim.events.filter((e): e is Extract<SimEvent, { k: 'break' }> => e.k === 'break');
    expect(breaks.map((b) => b.g)).toEqual([g1, g2]);
    return { params, recording, result: { ...result }, breaks, spec2: run.sim.specs[g2] };
  }

  it('deux cassures rapprochées : la seconde vaut plus', () => {
    const window = oneShotParams().comboWindow;
    expect(0.1 + window + 1).toBeLessThan(oneShotParams().duration);
    const quick = twoBreaks(Math.min(0.1, window / 2));
    const slow = twoBreaks(window + 0.5);

    expect(quick.breaks[0].combo).toBe(1);
    expect(quick.breaks[1].combo).toBe(2);
    expect(quick.result.maxCombo).toBe(2);
    expect(slow.breaks[0].combo).toBe(1);
    expect(slow.breaks[1].combo).toBe(1);
    expect(slow.result.maxCombo).toBe(1);

    // Même géode, même valeur de base : seul le combo fait la différence.
    expect(quick.breaks[1].g).toBe(slow.breaks[1].g);
    expect(quick.breaks[1].value).toBeGreaterThan(slow.breaks[1].value);
    const base = quick.spec2.value * quick.params.valueMult;
    expect(slow.breaks[1].value).toBe(Math.max(1, Math.round(base)));
    expect(quick.breaks[1].value).toBe(Math.max(1, Math.round(base * (1 + CFG.combo.step))));
    // La première cassure n'est pas bonifiée.
    expect(quick.breaks[0].value).toBe(slow.breaks[0].value);
  });

  it('la fenêtre de combo est inclusive à sa limite et s\'allonge avec comboWindow', () => {
    const window = oneShotParams().comboWindow;
    // Sans allongement, 0,5 s après la fenêtre : combo perdu ; avec une fenêtre plus longue : conservé.
    expect(twoBreaks(window + 0.5).breaks[1].combo).toBe(1);
    expect(twoBreaks(window + 0.5, { comboWindow: window + 1 }).breaks[1].combo).toBe(2);
  });

  it('le rejeu conserve les combos', () => {
    const quick = twoBreaks(0.1);
    const re = replay(quick.recording);
    expect(re.result).toEqual(quick.result);
    expect(re.events.filter((e) => e.k === 'break')).toEqual(quick.breaks);
  });

  it('dans une boucle pilotée, le combo dépasse 1 et bonifie le butin', () => {
    const d = play('arme + densité + aimant');
    expect(d.result.maxCombo).toBeGreaterThan(1);
    const maxSeen = Math.max(...d.events.map((e) => (e.k === 'break' ? e.combo : 0)));
    expect(d.result.maxCombo).toBe(maxSeen);
  });
});

describe('(h) poseAt', () => {
  /** Enregistrement à partir d'une liste de poses (une par échantillon). */
  function recOf(poses: Pose[]): Recording {
    const run = new LoopRun(paramsFor().params);
    for (const p of poses) run.tick(p.x, p.y, p.z, p.yaw, p.pitch);
    return run.finish().recording;
  }
  const out: Pose = { x: 9, y: 9, z: 9, yaw: 9, pitch: 9 };
  // Valeurs multiples du pas de quantification (2 cm, 0,1 mrad) : pas d'erreur d'arrondi à tolérer.
  const A: Pose = { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 };
  const B: Pose = { x: 2, y: 2.4, z: -4, yaw: 0.4, pitch: -0.2 };
  const C: Pose = { x: 2, y: 2.4, z: -6, yaw: 0.4, pitch: 0.3 };

  it('redonne les échantillons aux instants d\'échantillonnage', () => {
    const rec = recOf([A, B, C]);
    [A, B, C].forEach((p, k) => {
      poseAt(rec, k / HZ, out);
      expect(out.x).toBeCloseTo(p.x, 6);
      expect(out.y).toBeCloseTo(p.y, 6);
      expect(out.z).toBeCloseTo(p.z, 6);
      expect(out.yaw).toBeCloseTo(p.yaw, 6);
      expect(out.pitch).toBeCloseTo(p.pitch, 6);
    });
  });

  it('interpole linéairement entre deux échantillons', () => {
    const rec = recOf([A, B, C]);
    for (const a of [0.25, 0.5, 0.75]) {
      poseAt(rec, a / HZ, out);
      expect(out.x).toBeCloseTo(A.x + (B.x - A.x) * a, 6);
      expect(out.y).toBeCloseTo(A.y + (B.y - A.y) * a, 6);
      expect(out.z).toBeCloseTo(A.z + (B.z - A.z) * a, 6);
      expect(out.yaw).toBeCloseTo(A.yaw + (B.yaw - A.yaw) * a, 6);
      expect(out.pitch).toBeCloseTo(A.pitch + (B.pitch - A.pitch) * a, 6);
    }
    poseAt(rec, 1.5 / HZ, out);
    expect(out.x).toBeCloseTo(2, 6);
    expect(out.z).toBeCloseTo(-5, 6);
    expect(out.pitch).toBeCloseTo(0.05, 6);
  });

  it('se fige sur le premier / dernier échantillon hors de la plage', () => {
    const rec = recOf([A, B, C]);
    poseAt(rec, -3, out);
    expect(out).toEqual({ x: A.x, y: A.y, z: A.z, yaw: A.yaw, pitch: A.pitch });
    poseAt(rec, 999, out);
    expect(out.x).toBeCloseTo(C.x, 6);
    expect(out.z).toBeCloseTo(C.z, 6);
    expect(out.pitch).toBeCloseTo(C.pitch, 6);
  });

  it('interpole le lacet par le plus court chemin (passage par ±π)', () => {
    const rec = recOf([{ ...A, yaw: 3.1 }, { ...A, yaw: -3.1 }]);
    poseAt(rec, 0.5 / HZ, out);
    // Le milieu est du côté de π, pas de 0.
    expect(Math.abs(Math.cos(out.yaw) - Math.cos(Math.PI))).toBeLessThan(1e-6);
    poseAt(rec, 0.25 / HZ, out);
    expect(Math.cos(out.yaw)).toBeLessThan(Math.cos(3.1) + 1e-9);
  });

  it('enregistrement vide → pose nulle', () => {
    const rec = recOf([]);
    poseAt(rec, 1, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  });

  it('suit la trajectoire d\'une boucle pilotée', () => {
    const rec = play('état neuf').recording;
    const n = rec.samples.length / 5;
    const p0: Pose = { ...out }, p1: Pose = { ...out }, mid: Pose = { ...out };
    for (const k of [0, 10, Math.floor(n / 2), n - 2]) {
      poseAt(rec, k / HZ, p0);
      poseAt(rec, (k + 1) / HZ, p1);
      poseAt(rec, (k + 0.5) / HZ, mid);
      expect(mid.x).toBeCloseTo((p0.x + p1.x) / 2, 6);
      expect(mid.y).toBeCloseTo((p0.y + p1.y) / 2, 6);
      expect(mid.z).toBeCloseTo((p0.z + p1.z) / 2, 6);
    }
    poseAt(rec, 0, p0);
    expect(p0.x).toBeCloseTo(START.x, 1);
    expect(p0.y).toBeCloseTo(START.y + EYE, 1);
    expect(p0.z).toBeCloseTo(START.z, 1);
  });
});
