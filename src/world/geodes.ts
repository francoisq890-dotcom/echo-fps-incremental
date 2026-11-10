/**
 * Rendu instancié des géodes : une coque de plaques rocheuses qui s'écartent à mesure
 * que la géode se fissure (3 états), autour d'un cœur de cristal lumineux.
 * Deux draw calls pour toutes les géodes.
 */
import * as THREE from 'three';
import type { GeodeType } from '../config';
import { mulberry32 } from '../core/util';
import type { LoopSim } from '../echo/loopsim';

const MAX = 96;

interface Look { shell: number; core: [number, number, number]; scale: number; baseCrack: number }

export const GEODE_LOOK: Record<GeodeType, Look> = {
  basic: { shell: 0xb9694c, core: [1.9, 1.05, 0.16], scale: 1, baseCrack: 0.1 },
  mobile: { shell: 0xe2b98d, core: [1.9, 1.15, 0.22], scale: 0.9, baseCrack: 0.16 },
  armored: { shell: 0x4a2a45, core: [1.7, 0.85, 0.15], scale: 1.2, baseCrack: 0.03 },
  golden: { shell: 0xf0b63c, core: [2.8, 1.8, 0.35], scale: 0.85, baseCrack: 0.22 },
  explosive: { shell: 0x7b2c26, core: [2.4, 0.5, 0.09], scale: 0.95, baseCrack: 0.14 },
};

export const GEODE_NAME: Record<GeodeType, string> = {
  basic: 'Géode', mobile: 'Géode mobile', armored: 'Géode blindée', golden: 'Géode dorée', explosive: 'Géode explosive',
};

function buildShell(): THREE.BufferGeometry {
  // Icosaèdre subdivisé, sommets bosselés (roche), puis chaque face devient une plaque indépendante.
  const src = new THREE.IcosahedronGeometry(1, 1).toNonIndexed();
  const pos = src.attributes.position;
  const rng = mulberry32(42);
  const bump = new Map<string, number>();
  const n = pos.count;
  const center = new Float32Array(n * 3);
  const rand = new Float32Array(n);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let b = bump.get(key);
    if (b === undefined) { b = 0.86 + rng() * 0.3; bump.set(key, b); }
    v.multiplyScalar(b);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  for (let f = 0; f < n / 3; f++) {
    const cx = (pos.getX(f * 3) + pos.getX(f * 3 + 1) + pos.getX(f * 3 + 2)) / 3;
    const cy = (pos.getY(f * 3) + pos.getY(f * 3 + 1) + pos.getY(f * 3 + 2)) / 3;
    const cz = (pos.getZ(f * 3) + pos.getZ(f * 3 + 1) + pos.getZ(f * 3 + 2)) / 3;
    const r = rng();
    for (let k = 0; k < 3; k++) {
      center.set([cx, cy, cz], (f * 3 + k) * 3);
      rand[f * 3 + k] = r;
    }
  }
  src.setAttribute('aCenter', new THREE.BufferAttribute(center, 3));
  src.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
  src.computeVertexNormals();
  return src;
}

function buildCore(): THREE.BufferGeometry {
  // Grappe de cristaux : octaèdres étirés qui pointent dans plusieurs directions.
  const rng = mulberry32(7);
  const parts: THREE.BufferGeometry[] = [];
  const dirs = [[0, 1, 0], [0.8, 0.5, 0.2], [-0.7, 0.55, 0.4], [0.1, 0.4, -0.9], [-0.3, -0.8, 0.5], [0.6, -0.6, -0.5], [-0.8, -0.2, -0.6], [0.2, -0.1, 0.95]];
  const up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(), q = new THREE.Quaternion(), m = new THREE.Matrix4();
  for (const dir of dirs) {
    const len = 0.5 + rng() * 0.32;
    const g = new THREE.OctahedronGeometry(1, 0);
    d.set(dir[0], dir[1], dir[2]).normalize();
    q.setFromUnitVectors(up, d);
    m.compose(d.clone().multiplyScalar(len * 0.45), q, new THREE.Vector3(0.2 + rng() * 0.1, len, 0.2 + rng() * 0.1));
    g.applyMatrix4(m);
    parts.push(g);
  }
  const total = parts.reduce((a, g) => a + g.attributes.position.count, 0);
  const out = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) { out.set(g.attributes.position.array as Float32Array, o); o += g.attributes.position.count * 3; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geo.computeVertexNormals();
  return geo;
}

interface Slot {
  g: number; // id de la géode dans la simulation, -1 si libre
  type: GeodeType;
  crack: number;
  crackTarget: number;
  flash: number;
  punch: number;
  appear: number;
  leaving: number; // > 0 : disparition (expiration), -1 sinon
  spin: number;
  spinSpeed: number;
  x: number; y: number; z: number;
  radius: number;
}

export class GeodeRenderer {
  readonly group = new THREE.Group();
  private shell: THREE.InstancedMesh;
  private core: THREE.InstancedMesh;
  private aCrack: THREE.InstancedBufferAttribute;
  private aFlash: THREE.InstancedBufferAttribute;
  private slots: Slot[] = [];
  private byGeode = new Map<number, number>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  private tmp = { x: 0, y: 0, z: 0 };

  constructor() {
    const shellGeo = buildShell();
    this.aCrack = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    this.aFlash = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    this.aCrack.setUsage(THREE.DynamicDrawUsage);
    this.aFlash.setUsage(THREE.DynamicDrawUsage);
    shellGeo.setAttribute('iCrack', this.aCrack);
    shellGeo.setAttribute('iFlash', this.aFlash);

    const shellMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05, flatShading: true, side: THREE.DoubleSide });
    shellMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 aCenter; attribute float aRand; attribute float iCrack; attribute float iFlash;
          varying float vFlash; varying float vOpen;`)
        .replace('#include <begin_vertex>', `
          // Les plaques dont le tirage est sous le niveau de fissure se rétractent et s'écartent.
          float open = smoothstep(aRand - 0.04, aRand + 0.04, iCrack);
          vec3 shrunk = aCenter + (position - aCenter) * mix(0.93, 0.4, open) + normalize(aCenter) * open * 0.2;
          vec3 transformed = shrunk;
          vFlash = iFlash; vOpen = open;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vFlash; varying float vOpen;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          // L'intérieur des plaques ouvertes est éclairé par le cœur ; flash blanc chaud à l'impact.
          totalEmissiveRadiance += vec3(1.0, 0.55, 0.12) * (gl_FrontFacing ? vOpen * 0.25 : 0.9);
          totalEmissiveRadiance += vec3(0.8, 0.62, 0.4) * vFlash;`);
    };
    this.shell = new THREE.InstancedMesh(shellGeo, shellMat, MAX);
    this.shell.castShadow = true;
    this.shell.frustumCulled = false;
    this.shell.count = 0;

    this.core = new THREE.InstancedMesh(buildCore(), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX);
    this.core.frustumCulled = false;
    this.core.count = 0;
    // Initialise les couleurs d'instance (créent les attributs).
    this.shell.setColorAt(0, this.c.set(0xffffff));
    this.core.setColorAt(0, this.c);
    this.group.add(this.shell, this.core);
  }

  reset(): void {
    this.slots.length = 0;
    this.byGeode.clear();
  }

  spawn(sim: LoopSim, g: number, instant = false): void {
    const spec = sim.specs[g];
    const look = GEODE_LOOK[spec.type];
    if (this.slots.length >= MAX) return;
    this.byGeode.set(g, this.slots.length);
    this.slots.push({
      g, type: spec.type, crack: look.baseCrack, crackTarget: look.baseCrack, flash: 0, punch: 0,
      appear: instant ? 1 : 0, leaving: -1, spin: g * 1.7, spinSpeed: 0.25 + (g % 5) * 0.07, x: spec.x, y: spec.y, z: spec.z, radius: spec.radius,
    });
  }

  hit(g: number, stage: number): void {
    const i = this.byGeode.get(g);
    if (i === undefined) return;
    const s = this.slots[i];
    const look = GEODE_LOOK[s.type];
    s.crackTarget = Math.max(s.crackTarget, look.baseCrack + [0.08, 0.36, 0.62][stage]);
    s.flash = 1;
    s.punch = 1;
  }

  /** Retire immédiatement (cassure : les débris prennent le relais). */
  remove(g: number): void {
    const i = this.byGeode.get(g);
    if (i === undefined) return;
    const last = this.slots.pop()!;
    this.byGeode.delete(g);
    if (i < this.slots.length) {
      this.slots[i] = last;
      this.byGeode.set(last.g, i);
    }
  }

  /** Disparition douce (géode dorée expirée, fin de boucle). */
  expire(g: number): void {
    const i = this.byGeode.get(g);
    if (i !== undefined && this.slots[i].leaving < 0) this.slots[i].leaving = 1;
  }

  private ghostId = -1;
  /** Fin de boucle : tout disparaît en douceur. Les ids sont libérés pour la boucle suivante. */
  expireAll(): void {
    this.byGeode.clear();
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.leaving < 0) s.leaving = 1;
      s.g = this.ghostId--;
      this.byGeode.set(s.g, i);
    }
  }

  has(g: number): boolean { return this.byGeode.has(g); }

  position(g: number, out: { x: number; y: number; z: number }): boolean {
    const i = this.byGeode.get(g);
    if (i === undefined) return false;
    out.x = this.slots[i].x; out.y = this.slots[i].y; out.z = this.slots[i].z;
    return true;
  }

  update(dt: number, time: number, sim: LoopSim | null, simTime: number): void {
    const { m, q, e, p, s, c, tmp } = this;
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const sl = this.slots[i];
      if (sl.leaving >= 0) {
        sl.leaving -= dt * 3.2;
        if (sl.leaving <= 0) { this.remove(sl.g); continue; }
      }
    }
    const n = this.slots.length;
    for (let i = 0; i < n; i++) {
      const sl = this.slots[i];
      const look = GEODE_LOOK[sl.type];
      if (sim && sl.leaving < 0 && sl.g >= 0 && sl.g < sim.specs.length) {
        sim.pos(sl.g, simTime, tmp);
        sl.x = tmp.x; sl.y = tmp.y; sl.z = tmp.z;
      }
      sl.appear = Math.min(1, sl.appear + dt * 3.6);
      sl.crack += (sl.crackTarget - sl.crack) * Math.min(1, dt * 14);
      sl.flash = Math.max(0, sl.flash - dt * 7);
      sl.punch = Math.max(0, sl.punch - dt * 6.5);
      sl.spin += dt * sl.spinSpeed;
      // Apparition avec dépassement (« pop »), coup de poing d'échelle à l'impact.
      const a = sl.appear;
      const pop = a < 1 ? 1 + 2.7 * Math.pow(a - 1, 3) + 1.7 * Math.pow(a - 1, 2) : 1;
      const leave = sl.leaving >= 0 ? sl.leaving : 1;
      const k = sl.radius * pop * leave * (1 + 0.16 * Math.sin(sl.punch * Math.PI) * sl.punch);
      const bob = Math.sin(time * 1.6 + sl.g) * 0.07;
      const shake = sl.punch * 0.06;
      p.set(sl.x + Math.sin(time * 70 + sl.g) * shake, sl.y + bob, sl.z + Math.cos(time * 63 + sl.g) * shake);
      q.setFromEuler(e.set(sl.spin * 0.6, sl.spin, 0.3));
      s.set(k, k, k);
      this.shell.setMatrixAt(i, m.compose(p, q, s));
      this.shell.setColorAt(i, c.set(look.shell));
      const pulse = sl.type === 'explosive' ? 0.7 + 0.5 * Math.sin(time * 9 + sl.g) : sl.type === 'golden' ? 0.9 + 0.25 * Math.sin(time * 12) : 0.92 + 0.08 * Math.sin(time * 3 + sl.g);
      const glow = pulse * (0.75 + sl.crack * 0.9) + sl.flash * 0.7;
      s.setScalar(k * (0.74 + sl.crack * 0.12));
      this.core.setMatrixAt(i, m.compose(p, q, s));
      this.core.setColorAt(i, c.setRGB(look.core[0] * glow, look.core[1] * glow, look.core[2] * glow));
      this.aCrack.setX(i, sl.crack);
      this.aFlash.setX(i, sl.flash);
    }
    this.shell.count = this.core.count = n;
    this.shell.instanceMatrix.needsUpdate = true;
    this.core.instanceMatrix.needsUpdate = true;
    if (this.shell.instanceColor) this.shell.instanceColor.needsUpdate = true;
    if (this.core.instanceColor) this.core.instanceColor.needsUpdate = true;
    this.aCrack.needsUpdate = true;
    this.aFlash.needsUpdate = true;
  }
}
