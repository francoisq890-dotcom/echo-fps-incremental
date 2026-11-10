/**
 * Géométrie logique de l'arène : formes marchables, socles de géodes, jump pads.
 * Données pures (aucune dépendance Three.js) : utilisées par le contrôleur du joueur,
 * par le générateur de pattern et par le bot de simulation.
 */

export interface Vec3 { x: number; y: number; z: number }

export type Shape =
  | { kind: 'disc'; zone: number; x: number; z: number; r: number; top: number; thick: number; solid: boolean }
  | { kind: 'annulus'; zone: number; r0: number; r1: number; top: number; thick: number }
  | { kind: 'ramp'; zone: number; x0: number; z0: number; y0: number; x1: number; z1: number; y1: number; width: number };

export interface Anchor { zone: number; x: number; y: number; z: number }
export interface JumpPad { zone: number; x: number; y: number; z: number; tx: number; ty: number; tz: number; time: number }

export const ZONE_NAMES = ['Arène', 'Terrasses', 'Passerelles', 'Aiguille'];

export const START = { x: 0, y: 0, z: 5, yaw: 0 };
export const TERMINAL = { x: 0, y: 0, z: -8.5 };

const TAU = Math.PI * 2;
const polar = (r: number, a: number) => ({ x: Math.sin(a) * r, z: Math.cos(a) * r });

export const ARENA_R = 15;
export const TERRACE_R = 5.2;
export const TERRACE_DIST = 25;
export const TERRACE_TOP = 3.5;
export const TERRACE_ANGLES = [TAU * 0.25, TAU * 0.25 + TAU / 3, TAU * 0.25 + (2 * TAU) / 3];
export const RING_R0 = 32;
export const RING_R1 = 36;
export const RING_TOP = 8;
export const SPIRE_R = 6.5;
export const SPIRE_TOP = 15;

export const SHAPES: Shape[] = [];
export const ANCHORS: Anchor[] = [];
export const PADS: JumpPad[] = [];

// ——— Zone 0 : arène centrale ———
SHAPES.push({ kind: 'disc', zone: 0, x: 0, z: 0, r: ARENA_R, top: 0, thick: 4, solid: false });
for (let i = 0; i < 8; i++) {
  // Anneau extérieur, en laissant libre l'axe du terminal (-z).
  const a = Math.PI + TAU * ((i + 0.5) / 8) * 0.86 + TAU * 0.07;
  const p = polar(11.2, a);
  ANCHORS.push({ zone: 0, x: p.x, y: i % 2 ? 2.5 : 1.6, z: p.z });
}
ANCHORS.push({ zone: 0, x: -4.2, y: 1.9, z: -1.5 }, { zone: 0, x: 4.2, y: 1.9, z: -1.5 });

// ——— Zone 1 : trois terrasses reliées par des rampes ———
TERRACE_ANGLES.forEach((a, i) => {
  const c = polar(TERRACE_DIST, a);
  SHAPES.push({ kind: 'disc', zone: 1, x: c.x, z: c.z, r: TERRACE_R, top: TERRACE_TOP, thick: 9, solid: true });
  const r0 = polar(ARENA_R - 1.2, a);
  const r1 = polar(TERRACE_DIST - TERRACE_R + 0.6, a);
  SHAPES.push({ kind: 'ramp', zone: 1, x0: r0.x, z0: r0.z, y0: 0, x1: r1.x, z1: r1.z, y1: TERRACE_TOP, width: 3.6 });
  for (let k = 0; k < 3; k++) {
    const b = a + (k - 1) * 0.95;
    const p = polar(TERRACE_R + 2.4, b);
    ANCHORS.push({ zone: 1, x: c.x + p.x, y: TERRACE_TOP + 1.7 + (k === 1 ? 1.4 : 0), z: c.z + p.z });
  }
  ANCHORS.push({ zone: 1, x: c.x, y: TERRACE_TOP + 5.2, z: c.z });
  // Jump pad terrasse → passerelles.
  const pad = polar(TERRACE_DIST + 2.2, a);
  const land = polar((RING_R0 + RING_R1) / 2, a);
  PADS.push({ zone: 2, x: pad.x, y: TERRACE_TOP, z: pad.z, tx: land.x, ty: RING_TOP, tz: land.z, time: 1.25 });
  void i;
});

// ——— Zone 2 : anneau de passerelles ———
SHAPES.push({ kind: 'annulus', zone: 2, r0: RING_R0, r1: RING_R1, top: RING_TOP, thick: 1.2 });
for (let i = 0; i < 12; i++) {
  const a = TAU * (i / 12) + 0.13;
  const outer = i % 2 === 0;
  const p = polar(outer ? RING_R1 + 2.6 : RING_R0 - 3.2, a);
  ANCHORS.push({ zone: 2, x: p.x, y: RING_TOP + (outer ? 2.0 : 3.4), z: p.z });
}
// Jump pads anneau → aiguille (entre les terrasses).
TERRACE_ANGLES.forEach((a) => {
  const b = a + TAU / 6;
  const pad = polar(RING_R0 + 1.2, b);
  const land = polar(SPIRE_R - 2, b);
  PADS.push({ zone: 3, x: pad.x, y: RING_TOP, z: pad.z, tx: land.x, ty: SPIRE_TOP, tz: land.z, time: 1.7 });
});

// ——— Zone 3 : l'Aiguille, île flottante centrale ———
SHAPES.push({ kind: 'disc', zone: 3, x: 0, z: 0, r: SPIRE_R, top: SPIRE_TOP, thick: 1.6, solid: false });
for (let i = 0; i < 7; i++) {
  const a = TAU * (i / 7);
  const p = polar(SPIRE_R + 3.2, a);
  ANCHORS.push({ zone: 3, x: p.x, y: SPIRE_TOP + 2 + (i % 3) * 1.3, z: p.z });
}
ANCHORS.push({ zone: 3, x: 0, y: SPIRE_TOP + 6.5, z: 0 });

/** Hauteur d'une forme sous (x, z), ou null si le point est hors de la forme. */
export function shapeHeight(s: Shape, x: number, z: number): number | null {
  if (s.kind === 'disc') {
    const dx = x - s.x, dz = z - s.z;
    return dx * dx + dz * dz <= s.r * s.r ? s.top : null;
  }
  if (s.kind === 'annulus') {
    const d2 = x * x + z * z;
    return d2 >= s.r0 * s.r0 && d2 <= s.r1 * s.r1 ? s.top : null;
  }
  const ax = s.x1 - s.x0, az = s.z1 - s.z0;
  const len2 = ax * ax + az * az;
  const t = ((x - s.x0) * ax + (z - s.z0) * az) / len2;
  if (t < 0 || t > 1) return null;
  const px = s.x0 + ax * t, pz = s.z0 + az * t;
  const dx = x - px, dz = z - pz;
  if (dx * dx + dz * dz > (s.width / 2) * (s.width / 2)) return null;
  return s.y0 + (s.y1 - s.y0) * t;
}

/**
 * Sol le plus haut sous (x, z) atteignable depuis `feetY` (on monte au plus `step`).
 * Retourne -Infinity au-dessus du vide.
 */
export function groundAt(x: number, z: number, feetY: number, zoneLevel: number, step = 0.6): number {
  let best = -Infinity;
  for (const s of SHAPES) {
    if (s.zone > zoneLevel) continue;
    const h = shapeHeight(s, x, z);
    if (h !== null && h <= feetY + step && h > best) best = h;
  }
  return best;
}

/** Repousse le joueur hors des colonnes pleines (terrasses) quand il est en dessous de leur sommet. */
export function resolveSolids(pos: Vec3, radius: number, zoneLevel: number, step = 0.6): void {
  for (const s of SHAPES) {
    if (s.kind !== 'disc' || !s.solid || s.zone > zoneLevel) continue;
    if (pos.y >= s.top - step) continue;
    const dx = pos.x - s.x, dz = pos.z - s.z;
    const d = Math.hypot(dx, dz);
    const min = s.r + radius;
    if (d < min && d > 1e-4) {
      // Laisser passer le long de la rampe (qui recouvre le bord de la terrasse).
      if (groundAt(pos.x, pos.z, pos.y, zoneLevel, step) > pos.y - 0.05 && groundAt(pos.x, pos.z, pos.y, zoneLevel, step) > 0.3) continue;
      pos.x = s.x + (dx / d) * min;
      pos.z = s.z + (dz / d) * min;
    }
  }
}

export function anchorsForZone(zoneLevel: number): Anchor[] {
  return ANCHORS.filter((a) => a.zone <= zoneLevel);
}
