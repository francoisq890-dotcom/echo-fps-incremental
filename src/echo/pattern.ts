/**
 * Pattern déterministe des géodes d'une boucle.
 * Mêmes paramètres ⇒ même pattern : c'est ce qui rend le rendement d'un écho reproductible.
 */
import { CFG, type GeodeType } from '../config';
import { mulberry32 } from '../core/util';
import { ANCHORS } from '../world/layout';

/** Instantané de tout ce qui influence le résultat d'une boucle. Stocké avec chaque enregistrement. */
export interface LoopParams {
  seed: number;
  duration: number;
  zone: number;
  density: number;
  mobile: number;
  armored: number;
  golden: number;
  explosive: number;
  damage: number;
  rico: number;
  pierce: number;
  chain: number;
  magnetRadius: number;
  magnetSpeed: number;
  magnetDelay: number;
  comboWindow: number;
  valueMult: number;
}

export interface GeodeSpec {
  id: number;
  type: GeodeType;
  zone: number;
  anchor: number;
  x: number;
  y: number;
  z: number;
  /** Heure programmée d'apparition (elle attend aussi que la précédente du socle soit cassée). */
  at: number;
  hp: number;
  value: number;
  radius: number;
  /** Durée de vie (dorées) ; Infinity sinon. */
  life: number;
  orbitR: number;
  orbitSpeed: number;
  orbitPhase: number;
}

export interface Pattern {
  specs: GeodeSpec[];
  /** Pour chaque socle utilisé : ids des géodes, dans l'ordre d'apparition. */
  queues: number[][];
}

export function buildPattern(p: LoopParams): Pattern {
  const rng = mulberry32(p.seed * 7919 + p.zone * 131 + Math.round(p.duration * 10));
  const G = CFG.geodes;
  const specs: GeodeSpec[] = [];
  const queues: number[][] = [];
  const interval = G.queueInterval / (1 + G.densityPerLevel * p.density);
  const w = {
    golden: G.weightPerLevel.golden * p.golden,
    armored: G.weightPerLevel.armored * p.armored,
    explosive: G.weightPerLevel.explosive * p.explosive,
    mobile: G.weightPerLevel.mobile * p.mobile,
  };
  const lvl: Record<GeodeType, number> = {
    basic: 1, mobile: p.mobile, armored: p.armored, golden: p.golden, explosive: p.explosive,
  };

  let instant = 0;
  ANCHORS.forEach((a, ai) => {
    if (a.zone > p.zone) return;
    const queue: number[] = [];
    // Quatre géodes de l'arène sont là dès le départ : on tire tout de suite.
    let at = a.zone === 0 && instant < 4 ? (instant++, 0) : 0.3 + rng() * 2.2;
    let first = true;
    while (at < p.duration - 0.9) {
      const r = rng();
      let type: GeodeType = 'basic';
      if (!first || a.zone > 0) {
        if (r < w.golden) type = 'golden';
        else if (r < w.golden + w.armored) type = 'armored';
        else if (r < w.golden + w.armored + w.explosive) type = 'explosive';
        else if (r < w.golden + w.armored + w.explosive + w.mobile) type = 'mobile';
      }
      const def = G.types[type];
      const dir = rng() < 0.5 ? -1 : 1;
      const spec: GeodeSpec = {
        id: specs.length,
        type,
        zone: a.zone,
        anchor: ai,
        x: a.x, y: a.y, z: a.z,
        at,
        hp: def.hp * G.zoneHp[a.zone],
        value: def.value * G.zoneValue[a.zone] * (1 + G.valuePerTypeLevel * Math.max(0, lvl[type] - 1)),
        radius: def.radius,
        life: type === 'golden' ? G.goldenLifetime : Infinity,
        orbitR: type === 'mobile' ? 1.7 : 0,
        orbitSpeed: type === 'mobile' ? dir * (1.6 + rng() * 0.6) : 0,
        orbitPhase: rng() * Math.PI * 2,
      };
      specs.push(spec);
      queue.push(spec.id);
      at += interval * (0.8 + rng() * 0.4);
      first = false;
    }
    queues.push(queue);
  });
  return { specs, queues };
}

/** Position d'une géode à l'instant t de la boucle (les mobiles orbitent autour de leur socle). */
export function geodePos(s: GeodeSpec, t: number, out: { x: number; y: number; z: number }): void {
  if (s.orbitR === 0) {
    out.x = s.x; out.y = s.y; out.z = s.z;
    return;
  }
  const th = s.orbitPhase + s.orbitSpeed * t;
  out.x = s.x + Math.cos(th) * s.orbitR;
  out.y = s.y + Math.sin(th * 2) * 0.45;
  out.z = s.z + Math.sin(th) * s.orbitR;
}
