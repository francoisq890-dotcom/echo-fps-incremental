/**
 * Seconde arme (Fracasseur) et éléments (feu, glace, foudre) : règles de la simulation,
 * déterminisme du rejeu, compatibilité avec les anciens enregistrements.
 */
import { describe, expect, it } from 'vitest';
import { CFG, UPGRADE_BY_ID } from '../src/config';
import { FIRE, ICE, VOLT, LoopSim, elemMult, shotKind, type SimEvent } from '../src/echo/loopsim';
import { buildPattern, type LoopParams } from '../src/echo/pattern';
import { LoopRun, decodeRecording, encodeRecording, replay } from '../src/echo/recording';
import { deserialize, serialize } from '../src/economy/save';
import { buy, doPrestige, elemUnlocked, fixLoadout, loopParams, newState, perkChoices, weaponUnlocked } from '../src/economy/state';

const E = CFG.elements;

function params(over: Partial<LoopParams> = {}): LoopParams {
  return { ...loopParams(newState(0)), damage: 1, ...over };
}

/** Direction unitaire de l'origine vers une géode à l'instant t. */
function aim(sim: LoopSim, g: number, t: number, o: { x: number; y: number; z: number }) {
  const c = { x: 0, y: 0, z: 0 };
  sim.pos(g, t, c);
  const dx = c.x - o.x, dy = c.y - o.y, dz = c.z - o.z, l = Math.hypot(dx, dy, dz);
  return { x: dx / l, y: dy / l, z: dz / l, dist: l };
}

/** Première géode active (optionnellement d'un élément donné). */
function firstActive(sim: LoopSim, elem = -1): number {
  for (let g = 0; g < sim.specs.length; g++) if (sim.isActive(g) && (elem < 0 || sim.specs[g].elem === elem)) return g;
  return -1;
}

/** Origine placée à `dist` mètres d'une géode, sur l'axe X. */
function originNear(sim: LoopSim, g: number, dist: number) {
  const c = { x: 0, y: 0, z: 0 };
  sim.pos(g, 0, c);
  return { x: c.x + dist, y: c.y, z: c.z };
}

const hitsOn = (ev: SimEvent[], g: number) => ev.filter((e) => e.k === 'hit' && e.g === g) as Extract<SimEvent, { k: 'hit' }>[];

describe('elemMult : feu > glace > foudre > feu', () => {
  it('neutre contre tout, et tout contre neutre : ×1', () => {
    for (let e = 0; e <= 3; e++) { expect(elemMult(0, e)).toBe(1); expect(elemMult(e, 0)).toBe(1); }
  });
  it('faiblesses', () => {
    expect(elemMult(FIRE, ICE)).toBe(E.weak);
    expect(elemMult(ICE, VOLT)).toBe(E.weak);
    expect(elemMult(VOLT, FIRE)).toBe(E.weak);
  });
  it('même élément : résistance ; sens inverse : normal', () => {
    for (const e of [FIRE, ICE, VOLT]) expect(elemMult(e, e)).toBe(E.resist);
    expect(elemMult(ICE, FIRE)).toBe(1);
    expect(elemMult(VOLT, ICE)).toBe(1);
    expect(elemMult(FIRE, VOLT)).toBe(1);
  });
});

describe('pattern : géodes élémentaires', () => {
  it('aucun élément débloqué → aucune géode élémentaire, pattern identique à avant', () => {
    const base = buildPattern(params());
    expect(base.specs.every((s) => s.elem === 0)).toBe(true);
  });
  it('débloquer un élément ne déplace rien : mêmes positions, types et horaires', () => {
    const a = buildPattern(params()), b = buildPattern(params({ fire: 1, ice: 1, volt: 1, zone: 0 }));
    expect(b.specs.length).toBe(a.specs.length);
    b.specs.forEach((s, i) => {
      expect([s.type, s.x, s.y, s.z, s.at, s.anchor]).toEqual([a.specs[i].type, a.specs[i].x, a.specs[i].y, a.specs[i].z, a.specs[i].at, a.specs[i].anchor]);
    });
  });
  it('seuls les éléments débloqués apparaissent ; les géodes élémentaires valent et résistent plus', () => {
    const a = buildPattern(params({ zone: 3, density: 12 }));
    const b = buildPattern(params({ zone: 3, density: 12, ice: 2 }));
    const el = b.specs.filter((s) => s.elem !== 0);
    expect(el.length).toBeGreaterThan(0);
    expect(el.every((s) => s.elem === ICE)).toBe(true);
    for (const s of el) {
      expect(s.value).toBeCloseTo(a.specs[s.id].value * E.geodeValue, 9);
      expect(s.hp).toBeCloseTo(a.specs[s.id].hp * E.geodeHp, 9);
    }
    const all = buildPattern(params({ zone: 3, density: 12, fire: 1, ice: 1, volt: 1 }));
    expect(new Set(all.specs.map((s) => s.elem)).size).toBe(4);
    expect(all.specs.filter((s) => s.type === 'golden').every((s) => s.elem === 0)).toBe(true);
  });
});

describe('éléments dans la simulation', () => {
  it('un élément non débloqué se comporte comme un tir neutre', () => {
    const sim = new LoopSim(params());
    const g = firstActive(sim), o = originNear(sim, g, 5), d = aim(sim, g, 0.1, o);
    sim.shoot(0.1, o.x, o.y, o.z, d.x, d.y, d.z, shotKind(0, FIRE));
    const shot = sim.events.find((e) => e.k === 'shot') as Extract<SimEvent, { k: 'shot' }>;
    expect(shot.elem).toBe(0);
    expect(sim.events.some((e) => e.k === 'status')).toBe(false);
  });

  it('feu : la géode brûle par tics jusqu\'à la fin de la brûlure', () => {
    const p = params({ fire: 1, damage: 1 });
    const sim = new LoopSim(p);
    const g = sim.specs.findIndex((s, i) => sim.isActive(i) && s.elem === 0);
    const o = originNear(sim, g, 5), d = aim(sim, g, 0.1, o);
    const before = sim.hp[g];
    sim.shoot(0.1, o.x, o.y, o.z, d.x, d.y, d.z, shotKind(0, FIRE));
    expect(sim.hp[g]).toBeCloseTo(before - 1, 9);
    expect(sim.events.some((e) => e.k === 'status' && e.s === 'burn' && e.g === g)).toBe(true);
    sim.advance(0.1 + E.burnDuration + 0.5);
    const ticks = Math.floor(E.burnDuration / E.burnTick + 1e-9);
    const expected = before - 1 - ticks * E.burnBase;
    if (expected > 0) expect(sim.hp[g]).toBeCloseTo(expected, 6);
    else expect(sim.isActive(g)).toBe(false);
    // La brûlure s'arrête : plus aucun dégât ensuite.
    const hp = sim.hp[g];
    sim.advance(0.1 + E.burnDuration + 3);
    expect(sim.hp[g]).toBe(hp);
  });

  it('feu : une géode peut casser par brûlure, et ses éclats se ramassent', () => {
    const p = params({ fire: 5, damage: 2.4, magnetRadius: 50 });
    const sim = new LoopSim(p);
    const g = sim.specs.findIndex((s, i) => sim.isActive(i) && s.elem === 0 && s.hp === 3);
    const o = originNear(sim, g, 5), d = aim(sim, g, 0.1, o);
    sim.shoot(0.1, o.x, o.y, o.z, d.x, d.y, d.z, shotKind(0, FIRE));
    expect(sim.isActive(g)).toBe(true);
    sim.sample(3, o.x, o.y, o.z);
    const br = sim.events.find((e) => e.k === 'break' && e.g === g) as Extract<SimEvent, { k: 'break' }> | undefined;
    expect(br?.cause).toBe('burn');
    sim.sample(4, o.x, o.y, o.z);
    sim.advance(8);
    expect(sim.result.shards).toBeGreaterThan(0);
  });

  it('glace : la géode gelée subit plus de dégâts, puis redevient normale', () => {
    const p = params({ ice: 1, damage: 0.5 });
    const sim = new LoopSim(p);
    const g = sim.specs.findIndex((s, i) => sim.isActive(i) && s.elem === 0);
    const o = originNear(sim, g, 5);
    const shoot = (t: number, kind: number) => { const d = aim(sim, g, t, o); sim.shoot(t, o.x, o.y, o.z, d.x, d.y, d.z, kind); };
    shoot(0.1, shotKind(0, ICE));
    shoot(0.5, shotKind(0, 0));
    shoot(0.1 + E.brittleDuration + 0.5, shotKind(0, 0));
    const h = hitsOn(sim.events, g);
    expect(h[0].dmg).toBeCloseTo(0.5, 9);
    expect(h[1].dmg).toBeCloseTo(0.5 * (1 + E.brittleBase), 9);
    expect(h[2].dmg).toBeCloseTo(0.5, 9);
  });

  it('foudre : un arc frappe une géode voisine, sans cascade', () => {
    const p = params({ volt: 1, damage: 0.5, zone: 3, density: 12 });
    const sim = new LoopSim(p);
    sim.advance(4);
    // Cherche une géode active qui a une voisine à portée d'arc.
    const c = { x: 0, y: 0, z: 0 }, o2 = { x: 0, y: 0, z: 0 };
    let g = -1;
    for (let i = 0; i < sim.specs.length && g < 0; i++) {
      if (!sim.isActive(i)) continue;
      sim.pos(i, 4, c);
      for (let j = 0; j < sim.specs.length; j++) {
        if (j === i || !sim.isActive(j)) continue;
        sim.pos(j, 4, o2);
        if (Math.hypot(o2.x - c.x, o2.y - c.y, o2.z - c.z) < E.arcRange - 0.5) { g = i; break; }
      }
    }
    expect(g).toBeGreaterThanOrEqual(0);
    sim.pos(g, 4, c);
    const o = { x: c.x, y: c.y + 4, z: c.z };
    const d = aim(sim, g, 4, o);
    sim.events.length = 0;
    sim.shoot(4, o.x, o.y, o.z, d.x, d.y, d.z, shotKind(0, VOLT));
    const arcs = sim.events.filter((e) => e.k === 'arc') as Extract<SimEvent, { k: 'arc' }>[];
    expect(arcs.length).toBe(1);
    expect(arcs[0].pts.length).toBe(6); // un seul saut au niveau 1
    const hits = sim.events.filter((e) => e.k === 'hit' || e.k === 'break');
    expect(hits.length).toBe(2);
  });

  it('faiblesse et résistance s\'appliquent aux dégâts', () => {
    const p = params({ fire: 1, ice: 1, volt: 1, damage: 0.1, zone: 3, density: 12 });
    const sim = new LoopSim(p);
    sim.advance(5);
    const g = firstActive(sim, ICE);
    expect(g).toBeGreaterThanOrEqual(0);
    const o = originNear(sim, g, 1.5 + sim.specs[g].radius);
    const shoot = (t: number, e: number) => { const d = aim(sim, g, t, o); sim.shoot(t, o.x, o.y, o.z, d.x, d.y, d.z, shotKind(0, e)); };
    sim.events.length = 0;
    shoot(5.0, 0);
    shoot(5.01, FIRE);
    const h = hitsOn(sim.events, g);
    expect(h[0].mult).toBe(1);
    expect(h[1].mult).toBe(E.weak);
    // Glace sur glace : résiste (on vérifie sur une autre géode de glace, non gelée).
    const sim2 = new LoopSim(p);
    sim2.advance(5);
    const g2 = firstActive(sim2, ICE), o3 = originNear(sim2, g2, 1.5 + sim2.specs[g2].radius), d3 = aim(sim2, g2, 5, o3);
    sim2.events.length = 0;
    sim2.shoot(5, o3.x, o3.y, o3.z, d3.x, d3.y, d3.z, shotKind(0, ICE));
    expect(hitsOn(sim2.events, g2)[0].mult).toBe(E.resist);
  });
});

describe('Fracasseur', () => {
  it('verrouillé : le tir part comme un tir d\'Éclateur', () => {
    const sim = new LoopSim(params());
    const g = firstActive(sim), o = originNear(sim, g, 4), d = aim(sim, g, 0.1, o);
    sim.shoot(0.1, o.x, o.y, o.z, d.x, d.y, d.z, shotKind(1, 0));
    expect(sim.events.filter((e) => e.k === 'shot').length).toBe(1);
  });

  it('tire le bon nombre de plombs, un seul tir compté', () => {
    for (const lvl of [1, 3, 6]) {
      const sim = new LoopSim(params({ w2: lvl }));
      const g = firstActive(sim), o = originNear(sim, g, 4), d = aim(sim, g, 0.1, o);
      sim.shoot(0.1, o.x, o.y, o.z, d.x, d.y, d.z, shotKind(1, 0));
      const shots = sim.events.filter((e) => e.k === 'shot') as Extract<SimEvent, { k: 'shot' }>[];
      expect(shots.length).toBe(CFG.w2.pellets + CFG.w2.pelletsPerLevel * (lvl - 1));
      expect(shots.every((s) => s.w === 1)).toBe(true);
      expect(sim.result.shots).toBe(1);
      expect(sim.result.hits).toBe(1);
    }
  });

  it('de près il fait plus de dégâts qu\'un tir d\'Éclateur, de loin beaucoup moins', () => {
    const total = (dist: number, weapon: number) => {
      const sim = new LoopSim(params({ w2: 1, damage: 0.2 }));
      const g = sim.specs.findIndex((s, i) => sim.isActive(i) && s.type === 'basic');
      const o = originNear(sim, g, dist), d = aim(sim, g, 0.1, o);
      const before = sim.hp[g];
      sim.shoot(0.1, o.x, o.y, o.z, d.x, d.y, d.z, shotKind(weapon, 0));
      return before - sim.hp[g];
    };
    const close = total(2.5, 1), ray = total(2.5, 0), far = total(CFG.w2.falloffEnd + 6, 1);
    expect(close).toBeGreaterThan(ray * 1.5);
    expect(far).toBeLessThan(ray);
    expect(far).toBeLessThan(close * 0.3);
  });

  it('la gerbe est identique d\'un tir à l\'autre (pas de hasard)', () => {
    const run = () => {
      const sim = new LoopSim(params({ w2: 4 }));
      sim.shoot(0.1, 0, 1.6, 5, 0, 0, -1, shotKind(1, 0));
      return JSON.stringify(sim.events.filter((e) => e.k === 'shot'));
    };
    expect(run()).toBe(run());
  });
});

describe('rejeu déterministe avec armes et éléments', () => {
  function play(p: LoopParams) {
    const run = new LoopRun(p);
    const sim = run.sim, c = { x: 0, y: 0, z: 0 };
    let nextShot = 0.2, k = 0, x = 0, z = 5;
    const n = Math.floor(p.duration * CFG.loop.sampleHz) + 1;
    for (let i = 0; i < n; i++) {
      const t = i / CFG.loop.sampleHz;
      let best = -1, bd = 1e9;
      for (let g = 0; g < sim.specs.length; g++) {
        if (!sim.isActive(g) || sim.specs[g].zone > 0) continue;
        sim.pos(g, t, c);
        const d = Math.hypot(c.x - x, c.z - z);
        if (d < bd) { bd = d; best = g; }
      }
      let yaw = 0, pitch = 0;
      if (best >= 0) {
        sim.pos(best, t, c);
        // Avance vers la cible (le Fracasseur veut être près), puis vise.
        const dx = c.x - x, dz = c.z - z, l = Math.hypot(dx, dz);
        if (l > 3) { x += (dx / l) * 0.3; z += (dz / l) * 0.3; }
        yaw = Math.atan2(-(c.x - x), -(c.z - z));
        pitch = Math.atan2(c.y - 1.6, Math.hypot(c.x - x, c.z - z));
      }
      run.tick(x, 1.6, z, yaw, pitch);
      if (best >= 0 && t >= nextShot && t < p.duration - 0.05) {
        // Alterne armes et éléments pour tout exercer.
        run.shoot(t + 0.013, x, 1.6, z, yaw, pitch, shotKind(k % 2, k % 4));
        k++;
        nextShot = t + 0.22;
      }
    }
    return run.finish();
  }

  const SETS: Partial<LoopParams>[] = [
    { w2: 1, fire: 1 },
    { w2: 6, fire: 5, ice: 5, volt: 5, damage: 3 },
    { w2: 3, ice: 2, volt: 4, chain: 2, rico: 2, pierce: 1, explosive: 4, mobile: 4, density: 8, damage: 2 },
    { fire: 3, volt: 1, golden: 6, armored: 4, damage: 6 },
  ];

  it.each(SETS.map((s, i) => [i, s] as const))('jeu de paramètres %i : direct = rejeu, y compris après encodage', (_i, over) => {
    const { recording, result } = play(params(over));
    expect(recording.params.fmt).toBe(2);
    expect(result.shots).toBeGreaterThan(10);
    expect(result.broken).toBeGreaterThan(0);
    const a = replay(recording), b = replay(decodeRecording(encodeRecording(recording)));
    expect(a.result).toEqual(result);
    expect(b.result).toEqual(result);
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
  });

  it('les éléments changent vraiment le résultat (le 7e champ est bien rejoué)', () => {
    const { recording, result } = play(params({ w2: 6, fire: 5, ice: 5, volt: 5, damage: 3 }));
    const neutral = { ...recording, shots: recording.shots.map((v, i) => (i % 7 === 6 ? 0 : v)) };
    expect(replay(neutral).result).not.toEqual(result);
  });

  it('ancien enregistrement (6 champs par tir, sans fmt) : toujours lisible, même butin', () => {
    // On fabrique un enregistrement à l'ancien format : tirs neutres d'Éclateur, sans le champ « nature ».
    const p = params();
    const run = new LoopRun(p);
    const sim = run.sim, c = { x: 0, y: 0, z: 0 };
    for (let i = 0; i <= p.duration * 20; i++) {
      const t = i / 20, g = firstActive(sim);
      let yaw = 0, pitch = 0;
      if (g >= 0) { sim.pos(g, t, c); yaw = Math.atan2(-c.x, -(c.z - 5)); pitch = Math.atan2(c.y - 1.6, Math.hypot(c.x, c.z - 5)); }
      run.tick(c.x * 0.5, 1.6, 5 + (c.z - 5) * 0.5, yaw, pitch);
      if (g >= 0 && i % 5 === 2 && t < p.duration - 0.1) run.shoot(t + 0.01, 0, 1.6, 5, yaw, pitch);
    }
    const { recording, result } = run.finish();
    const old6 = new Int16Array((recording.shots.length / 7) * 6);
    for (let s = 0; s < recording.shots.length / 7; s++) for (let k = 0; k < 6; k++) old6[s * 6 + k] = recording.shots[s * 7 + k];
    const oldParams = { ...recording.params } as LoopParams;
    delete oldParams.fmt; delete oldParams.w2; delete oldParams.fire; delete oldParams.ice; delete oldParams.volt;
    const legacy = { params: oldParams, samples: recording.samples, shots: old6 };
    expect(result.shards).toBeGreaterThan(0);
    expect(replay(legacy).result).toEqual(result);
    expect(replay(decodeRecording(encodeRecording(legacy))).result).toEqual(result);
  });
});

describe('économie : déblocage et équipement', () => {
  it('arme et éléments verrouillés au départ, débloqués par l\'achat', () => {
    const s = newState(0);
    expect(weaponUnlocked(s, 0)).toBe(true);
    expect(weaponUnlocked(s, 1)).toBe(false);
    expect([0, 1, 2, 3].map((e) => elemUnlocked(s, e))).toEqual([true, false, false, false]);
    s.shards = 1e9;
    expect(buy(s, 'w2')).toBe(true);
    expect(buy(s, 'ice')).toBe(true);
    expect(weaponUnlocked(s, 1)).toBe(true);
    expect(elemUnlocked(s, 2)).toBe(true);
    expect(elemUnlocked(s, 1)).toBe(false);
    const p = loopParams(s);
    expect([p.fmt, p.w2, p.fire, p.ice, p.volt]).toEqual([2, 1, 0, 1, 0]);
  });

  it('fixLoadout ramène sur du débloqué ; la sauvegarde garde l\'équipement valide', () => {
    const s = newState(0);
    s.loadout = { weapon: 1, elem: 3 };
    fixLoadout(s);
    expect(s.loadout).toEqual({ weapon: 0, elem: 0 });
    s.shards = 1e9;
    buy(s, 'w2'); buy(s, 'volt');
    s.loadout = { weapon: 1, elem: 3 };
    expect(deserialize(serialize(s), 0).loadout).toEqual({ weapon: 1, elem: 3 });
    // Sauvegarde trafiquée : équipement non débloqué ou hors bornes.
    const raw = JSON.parse(serialize(newState(0)));
    raw.loadout = { weapon: 7, elem: 2 };
    expect(deserialize(JSON.stringify(raw), 0).loadout).toEqual({ weapon: 0, elem: 0 });
    // Ancienne sauvegarde sans le champ.
    delete raw.loadout;
    expect(deserialize(JSON.stringify(raw), 0).loadout).toEqual({ weapon: 0, elem: 0 });
  });

  it('l\'Effondrement remet l\'équipement à zéro avec les améliorations', () => {
    const s = newState(0);
    s.shards = 1e12;
    buy(s, 'w2'); buy(s, 'fire');
    s.loadout = { weapon: 1, elem: 1 };
    s.runEarned = 1e15;
    expect(doPrestige(s, perkChoices(s)[0].id)).toBe(true);
    expect(s.loadout).toEqual({ weapon: 0, elem: 0 });
    expect(weaponUnlocked(s, 1)).toBe(false);
  });

  it('les nouvelles améliorations existent avec un coût croissant', () => {
    for (const id of ['w2', 'fire', 'ice', 'volt']) {
      const u = UPGRADE_BY_ID[id];
      expect(u).toBeDefined();
      expect(u.growth).toBeGreaterThan(1);
      expect(u.fx(0)).toBe('verrouillé');
      expect(u.fx(1)).not.toBe('verrouillé');
    }
  });
});
