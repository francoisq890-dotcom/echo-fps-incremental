/**
 * Bot « joueur moyen » pour la simulation d'équilibrage.
 *
 * Il joue VRAIMENT une boucle à travers `LoopRun` (mêmes échantillons à 20 Hz et mêmes tirs
 * quantifiés que le jeu en direct), sans aucun rendu. Ses limites sont celles d'un humain
 * ordinaire :
 *  - il marche à 80 % de la vitesse maximale, en ligne droite, sans collisions ;
 *  - il met 0,35 s à réagir à une nouvelle cible (apparition ou changement) ;
 *  - 75 % de ses tirs touchent (55 % sur les géodes mobiles), les autres partent à côté ;
 *  - il doit aller chercher les éclats tombés hors du rayon de son aimant ;
 *  - pour changer de zone, il passe par les vrais points de passage :
 *    pied de rampe → terrasse → pad (saut de `pad.time`) → anneau → pad → aiguille.
 *
 * Armes et éléments : avec le Fracasseur, le bot se rapproche à moins de ~12 m avant de tirer.
 * À chaque tir, il prend l'élément débloqué qui bat la géode visée ; sinon son élément par
 * défaut, sauf si la géode y résiste (il tire alors neutre).
 */
import { CFG, ELEM_BEATS, w2RateMult } from '../config';
import { mulberry32 } from '../core/util';
import { LoopRun, tickCount, type Recording } from '../echo/recording';
import { elemMult, shotKind, type LoopResult } from '../echo/loopsim';
import type { LoopParams } from '../echo/pattern';
import { derive, loopParams, type GameState } from '../economy/state';
import {
  ARENA_R, PADS, RING_R0, RING_R1, RING_TOP, SPIRE_R, SPIRE_TOP, START,
  TERRACE_ANGLES, TERRACE_DIST, TERRACE_R, TERRACE_TOP,
} from '../world/layout';

export interface BotOpts {
  /** Graine des tirages de précision (mulberry32). */
  seed: number;
  /** Stratégie : zone la plus lointaine visitée (bornée par la zone débloquée). */
  maxZone: number;
  /** Précision sur cible fixe (défaut 0,75). */
  accuracy?: number;
  /** Précision sur géode mobile (défaut 0,55). */
  mobileAccuracy?: number;
  /** Temps de réaction après apparition ou changement de cible (défaut 0,35 s). */
  reaction?: number;
  /** Part de la vitesse maximale utilisée (défaut 0,8). */
  speedFactor?: number;
  /** Distance maximale à laquelle le bot repère une géode (défaut 45 m). */
  viewRange?: number;
  /** Arme utilisée toute la boucle (0 Éclateur, 1 Fracasseur ; défaut 0). */
  weapon?: number;
  /** Élément tiré sur les géodes neutres (défaut : voir `defaultElem`). */
  elem?: number;
}

/** Distance de tir visée avec le Fracasseur (m). */
const W2_RANGE = 12;

/** Élément par défaut : le plus haut niveau débloqué (à égalité feu, puis foudre, puis glace). */
export function defaultElem(p: LoopParams): number {
  let best = 0, bestL = 0;
  for (const [e, l] of [[1, p.fire ?? 0], [3, p.volt ?? 0], [2, p.ice ?? 0]] as const) if (l > bestL) { bestL = l; best = e; }
  return best;
}

const elemLevel = (p: LoopParams, e: number) => (e === 1 ? p.fire ?? 0 : e === 2 ? p.ice ?? 0 : e === 3 ? p.volt ?? 0 : 1);

/** Élément à tirer sur une géode d'élément `ge`. */
export function pickElem(p: LoopParams, ge: number, fallback: number): number {
  if (ge > 0) {
    const counter = ELEM_BEATS.indexOf(ge);
    if (elemLevel(p, counter) > 0) return counter;
  }
  return fallback === ge && ge > 0 ? 0 : fallback;
}

export interface BotLoop {
  recording: Recording;
  result: LoopResult;
}

export interface BestLoop extends BotLoop {
  /** Stratégie retenue (zone maximale visitée). */
  strategy: number;
  /** Arme retenue. */
  weapon: number;
  params: LoopParams;
}

const TAU = Math.PI * 2;
/** Marge prise sur le rayon d'aimant pour décider qu'un éclat est « ramassable ». */
const MAGNET_MARGIN = 0.92;
/** Le bot s'approche un peu plus que nécessaire. */
const APPROACH = 0.85;
/** Poids vertical de la distance d'aimant (identique à LoopSim.sample). */
const DY_WEIGHT = 0.35;

type Area =
  | { kind: 'disc'; x: number; z: number; r: number; top: number }
  | { kind: 'ring'; r0: number; r1: number; top: number };

interface Leg { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; t0: number; t1: number }
interface Route { legs: Leg[]; total: number; area: Area }

const polar = (r: number, a: number) => ({ x: Math.sin(a) * r, z: Math.cos(a) * r });

/** Trajet imposé jusqu'à la zone visée, puis aire dans laquelle le bot se promène. */
function buildRoute(zone: number, speed: number): Route {
  const legs: Leg[] = [];
  let cx: number = START.x, cy: number = START.y, cz: number = START.z, ct = 0;
  const walk = (x: number, y: number, z: number) => {
    const d = Math.hypot(x - cx, z - cz);
    legs.push({ x0: cx, y0: cy, z0: cz, x1: x, y1: y, z1: z, t0: ct, t1: ct + d / speed });
    ct += d / speed; cx = x; cy = y; cz = z;
  };
  const jump = (x: number, y: number, z: number, time: number) => {
    legs.push({ x0: cx, y0: cy, z0: cz, x1: x, y1: y, z1: z, t0: ct, t1: ct + time });
    ct += time; cx = x; cy = y; cz = z;
  };
  if (zone <= 0) {
    return { legs, total: 0, area: { kind: 'disc', x: 0, z: 0, r: ARENA_R - 0.8, top: 0 } };
  }
  // Terrasse dont le pied de rampe est le plus proche du départ.
  let ti = 0, bestD = Infinity;
  TERRACE_ANGLES.forEach((a, i) => {
    const f = polar(ARENA_R - 1.2, a);
    const d = Math.hypot(f.x - START.x, f.z - START.z);
    if (d < bestD) { bestD = d; ti = i; }
  });
  const a = TERRACE_ANGLES[ti];
  const foot = polar(ARENA_R - 1.2, a);
  const top = polar(TERRACE_DIST - TERRACE_R + 0.6, a);
  walk(foot.x, 0, foot.z);
  walk(top.x, TERRACE_TOP, top.z);
  if (zone === 1) {
    const c = polar(TERRACE_DIST, a);
    return { legs, total: ct, area: { kind: 'disc', x: c.x, z: c.z, r: TERRACE_R - 0.5, top: TERRACE_TOP } };
  }
  const pad2 = PADS.filter((p) => p.zone === 2)[ti];
  walk(pad2.x, pad2.y, pad2.z);
  jump(pad2.tx, pad2.ty, pad2.tz, pad2.time);
  if (zone === 2) {
    return { legs, total: ct, area: { kind: 'ring', r0: RING_R0 + 0.5, r1: RING_R1 - 0.5, top: RING_TOP } };
  }
  // Le long de l'anneau jusqu'au pad de l'aiguille (par petits arcs).
  const pad3 = PADS.filter((p) => p.zone === 3)[ti];
  const b = Math.atan2(pad3.x, pad3.z);
  let delta = b - a;
  while (delta > Math.PI) delta -= TAU;
  while (delta < -Math.PI) delta += TAU;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (TAU / 48)));
  const rMid = (RING_R0 + RING_R1) / 2;
  for (let i = 1; i < steps; i++) {
    const p = polar(rMid, a + (delta * i) / steps);
    walk(p.x, RING_TOP, p.z);
  }
  walk(pad3.x, pad3.y, pad3.z);
  jump(pad3.tx, pad3.ty, pad3.tz, pad3.time);
  return { legs, total: ct, area: { kind: 'disc', x: 0, z: 0, r: SPIRE_R - 0.5, top: SPIRE_TOP } };
}

/** Position (pieds) sur le trajet imposé à l'instant t. */
function routePos(route: Route, t: number, out: { x: number; y: number; z: number }): void {
  const legs = route.legs;
  if (legs.length === 0) { out.x = START.x; out.y = START.y; out.z = START.z; return; }
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    if (t <= l.t1 || i === legs.length - 1) {
      const span = l.t1 - l.t0;
      const f = span <= 1e-9 ? 1 : Math.max(0, Math.min(1, (t - l.t0) / span));
      out.x = l.x0 + (l.x1 - l.x0) * f;
      out.y = l.y0 + (l.y1 - l.y0) * f;
      out.z = l.z0 + (l.z1 - l.z0) * f;
      return;
    }
  }
}

/** Point de l'aire le plus proche de (x, z). */
function clampToArea(area: Area, x: number, z: number, out: { x: number; z: number }): void {
  if (area.kind === 'disc') {
    const dx = x - area.x, dz = z - area.z;
    const d = Math.hypot(dx, dz);
    if (d <= area.r || d < 1e-9) { out.x = x; out.z = z; return; }
    out.x = area.x + (dx / d) * area.r;
    out.z = area.z + (dz / d) * area.r;
    return;
  }
  const d = Math.hypot(x, z);
  if (d < 1e-9) { out.x = 0; out.z = area.r0; return; }
  const r = Math.max(area.r0, Math.min(area.r1, d));
  out.x = (x / d) * r;
  out.z = (z / d) * r;
}

/** Distance au sens de l'aimant (la verticale compte moins), œil → éclat. */
function magnetDist(ex: number, ey: number, ez: number, px: number, py: number, pz: number): number {
  const dx = px - ex, dz = pz - ez, dy = (py - ey) * DY_WEIGHT;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

interface PendingDrop { x: number; y: number; z: number; value: number; t: number }

/**
 * Joue une boucle complète et retourne l'enregistrement et son résultat.
 * `stats` : seule la cadence de tir est lue (les autres valeurs sont déjà dans `params`).
 */
export function playLoop(params: LoopParams, stats: { fireRate: number }, opts: BotOpts): BotLoop {
  const acc = opts.accuracy ?? 0.75;
  const accMobile = opts.mobileAccuracy ?? 0.55;
  const reaction = opts.reaction ?? 0.35;
  const speed = CFG.player.speed * (opts.speedFactor ?? 0.8);
  const viewRange = opts.viewRange ?? 45;
  const eye = CFG.player.eyeHeight;
  const rng = mulberry32(opts.seed);

  const run = new LoopRun(params);
  const sim = run.sim;
  const route = buildRoute(Math.max(0, Math.min(opts.maxZone, params.zone, 3)), speed);
  const area = route.area;
  const routeEnd = { x: 0, y: 0, z: 0 };
  routePos(route, route.total, routeEnd);

  const R = params.magnetRadius * MAGNET_MARGIN;
  const duration = params.duration;
  const tickMs = 1000 / CFG.loop.sampleHz;
  const dt = 1 / CFG.loop.sampleHz;
  const n = tickCount(duration);
  const weapon = opts.weapon === 1 && (params.w2 ?? 0) > 0 ? 1 : 0;
  const fallbackElem = opts.elem ?? defaultElem(params);
  const cooldownMs = 1000 / (stats.fireRate * (weapon === 1 ? w2RateMult(params.w2 ?? 1) : 1));
  const W2 = CFG.w2;
  const pellets = W2.pellets + W2.pelletsPerLevel * Math.max(0, (params.w2 ?? 1) - 1);
  /** Dégâts moyens d'un tir qui touche, à la distance `dist`, sur la géode `g`. */
  const shotDamage = (g: number, dist: number): number => {
    const s = sim.specs[g];
    const e = pickElem(params, s.elem ?? 0, fallbackElem);
    let d = params.damage * elemMult(e, s.elem ?? 0);
    // Bonus moyens des effets : brûlure qui s'ajoute, gel qui amplifie les tirs suivants.
    if (e === 1) d *= 1 + 0.5 * (CFG.elements.burnBase + CFG.elements.burnPerLevel * ((params.fire ?? 1) - 1)) / CFG.elements.burnTick * 0.3;
    if (e === 2) d *= 1 + 0.6 * (CFG.elements.brittleBase + CFG.elements.brittlePerLevel * ((params.ice ?? 1) - 1));
    if (weapon === 0) return d;
    const k = Math.min(1, Math.max(0, (dist - W2.falloffStart) / (W2.falloffEnd - W2.falloffStart)));
    const ang = Math.atan2(s.radius * 1.12, Math.max(0.5, dist));
    const frac = ang >= W2.spread ? 1 : (ang / W2.spread) ** 2;
    return d * W2.damage * pellets * Math.max(1 / pellets, frac) * (1 - k * (1 - W2.falloffMin));
  };

  const pos = { x: START.x, y: START.y, z: START.z }; // pieds
  let yaw = START.yaw, pitch = 0;
  let target = -1;
  let acquiredAt = 0;
  let nextShotMs = 0;
  let evPtr = 0;
  const drops = new Map<number, PendingDrop>();
  const P = { x: 0, y: 0, z: 0 };
  const q = { x: 0, y: 0, z: 0 };
  const c2 = { x: 0, z: 0 };

  /** Rayon horizontal dans lequel il faut se trouver (dans l'aire) pour aspirer un éclat à la hauteur py. */
  const needH = (py: number): number => {
    const dy = (py - area.top - eye) * DY_WEIGHT;
    const h2 = R * R - dy * dy;
    return h2 > 0 ? Math.sqrt(h2) : 0;
  };
  /** L'éclat en (px, py, pz) est-il ramassable depuis l'aire finale ? */
  const reachableInArea = (px: number, py: number, pz: number): boolean => {
    clampToArea(area, px, pz, c2);
    return magnetDist(c2.x, area.top + eye, c2.z, px, py, pz) <= R;
  };

  /**
   * Intérêt d'une géode : valeur / temps estimé pour la casser (plus la moitié du temps
   * d'attente ou de marche avant de pouvoir ramasser). −1 si elle est hors de vue ou si
   * ses éclats seraient perdus.
   */
  const score = (g: number, t: number): number => {
    if (!sim.isActive(g)) return -1;
    const s = sim.specs[g];
    sim.pos(g, t, P);
    if (Math.hypot(P.x - pos.x, P.y - pos.y - eye, P.z - pos.z) > viewRange) return -1;
    const a = s.type === 'mobile' ? accMobile : acc;
    const here = Math.hypot(P.x - pos.x, P.y - pos.y - eye, P.z - pos.z);
    // Fracasseur : le temps d'aller au contact compte dans le coût de la cible.
    const approach = weapon === 1 && t >= route.total ? Math.max(0, here - W2_RANGE) / speed : 0;
    const fireDist = weapon === 1 && t >= route.total ? Math.min(here, W2_RANGE) : here;
    const shots = Math.max(1, Math.ceil(sim.hp[g] / shotDamage(g, fireDist) - 1e-9));
    const rate = stats.fireRate * (weapon === 1 ? w2RateMult(params.w2 ?? 1) : 1);
    const kill = approach + shots / (rate * a) + (g === target ? 0 : reaction);
    const ready = t + kill + params.magnetDelay;
    const inTransit = t < route.total;
    let collectAt = -1;
    if (inTransit) {
      // L'éclat tombera-t-il sur le chemin restant ?
      for (let tt = ready; tt <= route.total; tt += 0.1) {
        routePos(route, tt, q);
        if (magnetDist(q.x, q.y + eye, q.z, P.x, P.y, P.z) <= R) { collectAt = tt; break; }
      }
    }
    if (collectAt < 0) {
      if (!reachableInArea(P.x, P.y, P.z)) return -1;
      const fx = inTransit ? routeEnd.x : pos.x, fz = inTransit ? routeEnd.z : pos.z;
      const from = inTransit ? route.total : t;
      const travel = Math.max(0, Math.hypot(P.x - fx, P.z - fz) - needH(P.y)) / speed;
      collectAt = Math.max(from + travel, ready);
    }
    if (collectAt + 0.25 > duration) return -1;
    const wait = Math.max(0, collectAt - (t + kill));
    return s.value / (kill + 0.5 * wait);
  };

  for (let k = 0; k < n; k++) {
    const t = k / CFG.loop.sampleHz;
    const inTransit = t < route.total;
    if (inTransit) routePos(route, t, pos);
    else if (route.total > 0 && t - dt < route.total) { pos.x = routeEnd.x; pos.y = routeEnd.y; pos.z = routeEnd.z; }
    run.tick(pos.x, pos.y + eye, pos.z, yaw, pitch);

    // Ce que le bot « voit » : les cassures (positions des éclats) et les aspirations.
    const ev = sim.events;
    for (; evPtr < ev.length; evPtr++) {
      const e = ev[evPtr];
      if (e.k === 'break') drops.set(e.drop, { x: e.x, y: e.y, z: e.z, value: e.value, t: e.t });
      else if (e.k === 'attract') drops.delete(e.drop);
    }
    if (t >= duration) break;

    // ——— Choix de la cible ———
    if (target >= 0 && score(target, t) < 0) target = -1;
    if (target < 0) {
      let best = -1, bestScore = 0;
      for (let g = 0; g < sim.specs.length; g++) {
        const sc = score(g, t);
        if (sc > bestScore) { bestScore = sc; best = g; }
      }
      if (best >= 0) { target = best; acquiredAt = t; }
    }

    // ——— Déplacement (hors trajet imposé) : d'abord les éclats tombés, sinon vers la cible ———
    let vx = 0, vz = 0;
    if (!inTransit) {
      let destX = 0, destZ = 0, destDist = -1;
      for (const [id, d] of drops) {
        if (!reachableInArea(d.x, d.y, d.z)) { drops.delete(id); continue; }
        const dist = Math.max(0, Math.hypot(d.x - pos.x, d.z - pos.z) - needH(d.y) * APPROACH);
        if (t + dist / speed + 0.15 > duration) continue;
        if (destDist < 0 || dist < destDist) { destDist = dist; destX = d.x; destZ = d.z; }
      }
      if (destDist < 0 && target >= 0) {
        sim.pos(target, t, P);
        const keep = weapon === 1 ? Math.min(needH(P.y) * APPROACH, W2_RANGE * 0.8) : needH(P.y) * APPROACH;
        destDist = Math.max(0, Math.hypot(P.x - pos.x, P.z - pos.z) - keep);
        destX = P.x; destZ = P.z;
      }
      if (destDist > 1e-6) {
        const step = Math.min(speed * dt, destDist);
        let dx = destX - pos.x, dz = destZ - pos.z;
        if (area.kind === 'ring') {
          // Sur l'anneau, on avance le long de l'arc plutôt qu'à travers le vide.
          const rNow = Math.hypot(pos.x, pos.z);
          let dA = Math.atan2(destX, destZ) - Math.atan2(pos.x, pos.z);
          while (dA > Math.PI) dA -= TAU;
          while (dA < -Math.PI) dA += TAU;
          if (Math.abs(dA) * rNow > 3) {
            const sgn = dA > 0 ? 1 : -1;
            // Tangente dans le sens des angles croissants (x = sin a, z = cos a).
            dx = (pos.z / rNow) * sgn;
            dz = (-pos.x / rNow) * sgn;
          }
        }
        const len = Math.hypot(dx, dz);
        if (len > 1e-9) {
          clampToArea(area, pos.x + (dx / len) * step, pos.z + (dz / len) * step, c2);
          vx = (c2.x - pos.x) / dt;
          vz = (c2.z - pos.z) / dt;
        }
      }
    }

    // ——— Tir (au plus un par échantillon : la cadence maximale reste sous 20 tirs/s) ———
    if (target >= 0) {
      const earliest = Math.max(
        t, nextShotMs / 1000, acquiredAt + reaction, sim.spawnedAt[target] + reaction,
      );
      const sMs = Math.ceil(earliest * 1000 - 1e-6);
      if (sMs < (k + 1) * tickMs && sMs < duration * 1000) {
        const s = sMs / 1000;
        let ox: number, oy: number, oz: number;
        if (inTransit) { routePos(route, s, q); ox = q.x; oy = q.y + eye; oz = q.z; }
        else { ox = pos.x + vx * (s - t); oy = pos.y + eye; oz = pos.z + vz * (s - t); }
        // Viser depuis la position telle qu'elle sera quantifiée (2 cm).
        ox = Math.round(ox * 50) / 50; oy = Math.round(oy * 50) / 50; oz = Math.round(oz * 50) / 50;
        sim.pos(target, s, P);
        const dx = P.x - ox, dy = P.y - oy, dz = P.z - oz;
        const dist = Math.hypot(dx, dy, dz);
        yaw = Math.atan2(-dx, -dz);
        pitch = Math.asin(Math.max(-1, Math.min(1, dy / dist)));
        const spec = sim.specs[target];
        const hitChance = spec.type === 'mobile' ? accMobile : acc;
        if (rng() >= hitChance) {
          // Tir raté : il part à côté, juste au-delà du bord de la géode.
          const off = Math.atan2(spec.radius * 1.12, dist) + 0.02 + 0.06 * rng();
          const phi = rng() * TAU;
          yaw += (Math.cos(phi) * off) / Math.max(0.2, Math.cos(pitch));
          pitch = Math.max(-1.5, Math.min(1.5, pitch + Math.sin(phi) * off));
        }
        run.shoot(s, ox, oy, oz, yaw, pitch, shotKind(weapon, pickElem(params, spec.elem ?? 0, fallbackElem)));
        nextShotMs = sMs + cooldownMs;
      }
    }

    // ——— Avance ———
    if (!inTransit) {
      pos.x += vx * dt;
      pos.z += vz * dt;
      pos.y = area.top;
    }
  }
  return run.finish();
}

/**
 * Meilleure boucle possible pour l'état donné : le bot essaie chaque stratégie débloquée
 * (rester dans l'arène, aller aux terrasses, aux passerelles, à l'aiguille) et garde la
 * plus rentable — un joueur optimise son trajet.
 */
export function bestLoop(state: GameState, seed: number): BestLoop {
  const params = loopParams(state);
  const stats = derive(state);
  let best: BestLoop | null = null;
  const weapons = (params.w2 ?? 0) > 0 ? [0, 1] : [0];
  for (const w of weapons) {
    for (let z = 0; z <= Math.min(params.zone, 3); z++) {
      const r = playLoop(params, stats, { seed: seed * 31 + z, maxZone: z, weapon: w });
      if (!best || r.result.shards > best.result.shards) best = { ...r, strategy: z, weapon: w, params };
    }
  }
  return best!;
}
