/**
 * Effets visuels poolés et instanciés : éclats (monnaie), débris de coque, traits de tir,
 * ondes de choc, chiffres volants. Aucune allocation en cours de jeu.
 */
import * as THREE from 'three';
import { PALETTE } from '../config';
import { fmt } from '../core/util';
import type { Engine } from '../render/engine';
import { groundAt } from './layout';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// ————————————————————————————————————————————————————————————————
// Éclats : jaillissent, rebondissent, puis sont aspirés en spirale vers le joueur.
// ————————————————————————————————————————————————————————————————

const MAX_SHARDS = 640;
const BOUNCE = 0, ATTRACT = 1, LOST = 2;

export class Shards {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private px = new Float32Array(MAX_SHARDS); private py = new Float32Array(MAX_SHARDS); private pz = new Float32Array(MAX_SHARDS);
  private vx = new Float32Array(MAX_SHARDS); private vy = new Float32Array(MAX_SHARDS); private vz = new Float32Array(MAX_SHARDS);
  private sx = new Float32Array(MAX_SHARDS); private sy = new Float32Array(MAX_SHARDS); private sz = new Float32Array(MAX_SHARDS);
  private ground = new Float32Array(MAX_SHARDS);
  private mode = new Uint8Array(MAX_SHARDS);
  private drop = new Int32Array(MAX_SHARDS);
  private t = new Float32Array(MAX_SHARDS);
  private dur = new Float32Array(MAX_SHARDS);
  private size = new Float32Array(MAX_SHARDS);
  private seed = new Float32Array(MAX_SHARDS);
  /** Appelé quand un éclat atteint le joueur (son + pulsation du compteur). */
  onArrive: (() => void) | null = null;

  constructor() {
    const geo = new THREE.OctahedronGeometry(1, 0);
    geo.scale(0.55, 1, 0.55);
    // Couleur HDR : l'ambre des éclats est la seule couleur d'accent du jeu.
    const c = new THREE.Color(PALETTE.amber);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(c.r * 3.2, c.g * 2.4, c.b * 1.2) }), MAX_SHARDS);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  /** Fait jaillir les éclats d'une géode brisée. */
  burst(drop: number, x: number, y: number, z: number, value: number, zoneLevel: number): void {
    const count = Math.min(14, 3 + Math.floor(Math.log2(1 + value) * 1.4));
    const g = groundAt(x, z, y, zoneLevel, 0);
    for (let k = 0; k < count && this.n < MAX_SHARDS; k++) {
      const i = this.n++;
      const a = Math.random() * Math.PI * 2, sp = 2.5 + Math.random() * 4.5;
      this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      this.vx[i] = Math.cos(a) * sp; this.vy[i] = 3 + Math.random() * 5.5; this.vz[i] = Math.sin(a) * sp;
      // Au-dessus du vide : les éclats flottent sur place au lieu de tomber.
      this.ground[i] = isFinite(g) ? g + 0.16 : y - 0.6 - Math.random() * 0.6;
      this.mode[i] = BOUNCE;
      this.drop[i] = drop;
      this.t[i] = 0;
      this.size[i] = 0.13 + Math.random() * 0.08 + Math.min(0.12, value * 0.0004);
      this.seed[i] = Math.random() * 100;
    }
  }

  /** Le joueur est à portée : les éclats de ce lot partent vers lui et arrivent en `time` secondes. */
  attract(drop: number, time: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.drop[i] !== drop || this.mode[i] !== BOUNCE) continue;
      this.mode[i] = ATTRACT;
      this.t[i] = 0;
      this.dur[i] = Math.max(0.08, time * (0.72 + Math.random() * 0.28));
      this.sx[i] = this.px[i]; this.sy[i] = this.py[i]; this.sz[i] = this.pz[i];
    }
  }

  /** Fin de boucle : ce qui reste au sol est perdu. */
  loseAll(): void {
    for (let i = 0; i < this.n; i++) {
      if (this.mode[i] === BOUNCE) { this.mode[i] = LOST; this.t[i] = 0; }
    }
  }

  get count(): number { return this.n; }

  update(dt: number, time: number, target: THREE.Vector3): void {
    for (let i = this.n - 1; i >= 0; i--) {
      this.t[i] += dt;
      let scale = this.size[i];
      if (this.mode[i] === BOUNCE) {
        this.vy[i] -= 22 * dt;
        this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
        if (this.py[i] < this.ground[i]) {
          this.py[i] = this.ground[i];
          this.vy[i] = Math.abs(this.vy[i]) * 0.45;
          if (this.vy[i] < 1.2) this.vy[i] = 0;
          this.vx[i] *= 0.6; this.vz[i] *= 0.6;
        }
        scale *= Math.min(1, this.t[i] * 8);
      } else if (this.mode[i] === ATTRACT) {
        const u = Math.min(1, this.t[i] / this.dur[i]);
        const ease = u * u * (3 - 2 * u) * u; // départ lent, arrivée rapide
        const swirl = (1 - u) * (1 - u) * 1.3;
        const ang = this.seed[i] + u * 9;
        const tx = target.x, ty = target.y - 0.45, tz = target.z;
        this.px[i] = this.sx[i] + (tx - this.sx[i]) * ease + Math.cos(ang) * swirl * u * 4 * (1 - u);
        this.py[i] = this.sy[i] + (ty - this.sy[i]) * ease + Math.sin(u * Math.PI) * 0.9 + Math.sin(ang) * swirl * u * 2 * (1 - u);
        this.pz[i] = this.sz[i] + (tz - this.sz[i]) * ease + Math.sin(ang) * swirl * u * 4 * (1 - u);
        scale *= 1 - u * 0.55;
        if (u >= 1) { this.onArrive?.(); this.kill(i); continue; }
      } else {
        // Perdu : rétrécit et s'éteint.
        this.py[i] += dt * 0.6;
        scale *= Math.max(0, 1 - this.t[i] * 2.4);
        if (this.t[i] > 0.42) { this.kill(i); continue; }
      }
      const spin = time * 5 + this.seed[i];
      _q.setFromEuler(_e.set(spin * 0.7, spin, 0));
      _m.compose(_p.set(this.px[i], this.py[i], this.pz[i]), _q, _s.setScalar(scale));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private kill(i: number): void {
    const l = --this.n;
    if (i === l) return;
    this.px[i] = this.px[l]; this.py[i] = this.py[l]; this.pz[i] = this.pz[l];
    this.vx[i] = this.vx[l]; this.vy[i] = this.vy[l]; this.vz[i] = this.vz[l];
    this.sx[i] = this.sx[l]; this.sy[i] = this.sy[l]; this.sz[i] = this.sz[l];
    this.ground[i] = this.ground[l]; this.mode[i] = this.mode[l]; this.drop[i] = this.drop[l];
    this.t[i] = this.t[l]; this.dur[i] = this.dur[l]; this.size[i] = this.size[l]; this.seed[i] = this.seed[l];
    this.mesh.getMatrixAt(l, _m);
    this.mesh.setMatrixAt(i, _m);
  }
}

// ————————————————————————————————————————————————————————————————
// Débris de coque : petits tétraèdres qui volent en éclats.
// ————————————————————————————————————————————————————————————————

const MAX_DEBRIS = 360;

export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private p = new Float32Array(MAX_DEBRIS * 3);
  private v = new Float32Array(MAX_DEBRIS * 3);
  private life = new Float32Array(MAX_DEBRIS);
  private size = new Float32Array(MAX_DEBRIS);
  private seed = new Float32Array(MAX_DEBRIS);

  constructor() {
    this.mesh = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), MAX_DEBRIS);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.setColorAt(0, _c.set(0xffffff));
  }

  burst(x: number, y: number, z: number, color: number, count: number, power: number): void {
    for (let k = 0; k < count && this.n < MAX_DEBRIS; k++) {
      const i = this.n++;
      const a = Math.random() * Math.PI * 2, el = Math.random() * 2 - 0.6, sp = power * (0.5 + Math.random());
      this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
      this.v[i * 3] = Math.cos(a) * sp; this.v[i * 3 + 1] = el * sp + 2; this.v[i * 3 + 2] = Math.sin(a) * sp;
      this.life[i] = 0.55 + Math.random() * 0.5;
      this.size[i] = 0.1 + Math.random() * 0.2;
      this.seed[i] = Math.random() * 100;
      this.mesh.setColorAt(i, _c.set(color).multiplyScalar(0.8 + Math.random() * 0.4));
    }
    this.mesh.instanceColor!.needsUpdate = true;
  }

  update(dt: number): void {
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const l = --this.n;
        if (i !== l) {
          for (let k = 0; k < 3; k++) { this.p[i * 3 + k] = this.p[l * 3 + k]; this.v[i * 3 + k] = this.v[l * 3 + k]; }
          this.life[i] = this.life[l]; this.size[i] = this.size[l]; this.seed[i] = this.seed[l];
          this.mesh.getColorAt(l, _c); this.mesh.setColorAt(i, _c);
          this.mesh.instanceColor!.needsUpdate = true;
        }
        continue;
      }
      this.v[i * 3 + 1] -= 20 * dt;
      this.p[i * 3] += this.v[i * 3] * dt; this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt; this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
    }
    for (let i = 0; i < this.n; i++) {
      const r = this.seed[i] + this.life[i] * 9;
      _q.setFromEuler(_e.set(r, r * 1.3, r * 0.7));
      _m.compose(_p.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]), _q, _s.setScalar(this.size[i] * Math.min(1, this.life[i] * 3.5)));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ————————————————————————————————————————————————————————————————
// Traits de tir : boîtes étirées entre deux points, qui s'affinent en s'éteignant.
// ————————————————————————————————————————————————————————————————

export class Tracers {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private a: Float32Array; private b: Float32Array; private life: Float32Array; private w: Float32Array;

  constructor(private max: number, color: THREE.Color, private duration: number, opacity = 1) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, 0.5); // l'origine est à une extrémité : on étire le long de +Z
    const mat = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.a = new Float32Array(max * 3); this.b = new Float32Array(max * 3);
    this.life = new Float32Array(max); this.w = new Float32Array(max);
  }

  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number): void {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.a.set([ax, ay, az], i * 3); this.b.set([bx, by, bz], i * 3);
    this.life[i] = 1; this.w[i] = width;
  }

  /** Ajoute une polyligne (tir + ricochets) à partir d'un point de départ visuel (bouche du canon). */
  addPath(startX: number, startY: number, startZ: number, pts: number[], width: number): void {
    let x = startX, y = startY, z = startZ;
    for (let k = 3; k < pts.length; k += 3) {
      this.add(x, y, z, pts[k], pts[k + 1], pts[k + 2], width);
      x = pts[k]; y = pts[k + 1]; z = pts[k + 2];
    }
  }

  update(dt: number): void {
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] -= dt / this.duration;
      if (this.life[i] <= 0) {
        const l = --this.n;
        if (i !== l) {
          for (let k = 0; k < 3; k++) { this.a[i * 3 + k] = this.a[l * 3 + k]; this.b[i * 3 + k] = this.b[l * 3 + k]; }
          this.life[i] = this.life[l]; this.w[i] = this.w[l];
        }
      }
    }
    for (let i = 0; i < this.n; i++) {
      _a.fromArray(this.a, i * 3); _b.fromArray(this.b, i * 3);
      const len = _a.distanceTo(_b);
      // Le trait se raccourcit depuis l'origine : il « file » vers la cible.
      const u = 1 - this.life[i];
      _p.copy(_a).lerp(_b, u * 0.7);
      _m.lookAt(_b, _a, UP);
      _q.setFromRotationMatrix(_m);
      const w = this.w[i] * this.life[i];
      _m.compose(_p, _q, _s.set(w, w, len * (1 - u * 0.7)));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ————————————————————————————————————————————————————————————————
// Ondes de choc / halos : sphères creuses qui gonflent et s'effacent.
// ————————————————————————————————————————————————————————————————

const MAX_RINGS = 48;

export class Rings {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private p = new Float32Array(MAX_RINGS * 3);
  private life = new Float32Array(MAX_RINGS);
  private dur = new Float32Array(MAX_RINGS);
  private r = new Float32Array(MAX_RINGS);
  private col = new Float32Array(MAX_RINGS * 3);

  constructor() {
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV; varying vec3 vCol;
        void main() {
          vCol = instanceColor;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV; varying vec3 vCol;
        void main() {
          float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
          gl_FragColor = vec4(vCol * pow(f, 2.5), 1.0);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_RINGS);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.setColorAt(0, _c.set(0xffffff));
  }

  add(x: number, y: number, z: number, radius: number, duration: number, r: number, g: number, b: number): void {
    if (this.n >= MAX_RINGS) return;
    const i = this.n++;
    this.p.set([x, y, z], i * 3);
    this.life[i] = 0; this.dur[i] = duration; this.r[i] = radius;
    this.col.set([r, g, b], i * 3);
  }

  update(dt: number): void {
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] += dt / this.dur[i];
      if (this.life[i] >= 1) {
        const l = --this.n;
        if (i !== l) {
          for (let k = 0; k < 3; k++) { this.p[i * 3 + k] = this.p[l * 3 + k]; this.col[i * 3 + k] = this.col[l * 3 + k]; }
          this.life[i] = this.life[l]; this.dur[i] = this.dur[l]; this.r[i] = this.r[l];
        }
      }
    }
    for (let i = 0; i < this.n; i++) {
      const u = this.life[i];
      const k = this.r[i] * (1 - Math.pow(1 - u, 3));
      const fade = (1 - u) * (1 - u);
      _m.compose(_p.fromArray(this.p, i * 3), _q.identity(), _s.setScalar(Math.max(0.01, k)));
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, _c.setRGB(this.col[i * 3] * fade, this.col[i * 3 + 1] * fade, this.col[i * 3 + 2] * fade));
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}

// ————————————————————————————————————————————————————————————————
// Chiffres volants (DOM, poolés) : colorés et dimensionnés selon la valeur.
// ————————————————————————————————————————————————————————————————

const MAX_FLOATERS = 40;

interface Floater { el: HTMLDivElement; x: number; y: number; z: number; t: number; dur: number; active: boolean; drift: number }

export class Floaters {
  private pool: Floater[] = [];
  private next = 0;
  private scr = { x: 0, y: 0 };

  constructor(private engine: Engine, root: HTMLElement) {
    for (let i = 0; i < MAX_FLOATERS; i++) {
      const el = document.createElement('div');
      el.className = 'floater';
      el.style.display = 'none';
      root.appendChild(el);
      this.pool.push({ el, x: 0, y: 0, z: 0, t: 0, dur: 1, active: false, drift: 0 });
    }
  }

  /** Classe CSS selon la valeur (rapportée à ce que rapporte une géode simple). */
  static tier(value: number): string {
    return value >= 5000 ? 't4' : value >= 500 ? 't3' : value >= 50 ? 't2' : value >= 10 ? 't1' : 't0';
  }

  add(x: number, y: number, z: number, text: string, cls: string, dur = 1.0): void {
    const f = this.pool[this.next];
    this.next = (this.next + 1) % MAX_FLOATERS;
    f.x = x; f.y = y; f.z = z; f.t = 0; f.dur = dur; f.active = true;
    f.drift = (Math.random() - 0.5) * 40;
    f.el.textContent = text;
    f.el.className = 'floater ' + cls;
    f.el.style.display = 'block';
  }

  value(x: number, y: number, z: number, value: number, combo: number): void {
    this.add(x, y, z, '+' + fmt(value) + (combo >= 3 ? `  ×${combo}` : ''), Floaters.tier(value), 1.05);
  }

  update(dt: number): void {
    for (const f of this.pool) {
      if (!f.active) continue;
      f.t += dt;
      const u = f.t / f.dur;
      if (u >= 1) { f.active = false; f.el.style.display = 'none'; continue; }
      const ok = this.engine.project(f.x, f.y + u * 1.4, f.z, this.scr);
      if (!ok) { f.el.style.opacity = '0'; continue; }
      // « Pop » d'entrée puis montée douce et fondu.
      const pop = u < 0.14 ? 0.6 + (u / 0.14) * 0.65 : 1.25 - Math.min(1, (u - 0.14) / 0.2) * 0.25;
      f.el.style.opacity = String(u > 0.65 ? 1 - (u - 0.65) / 0.35 : 1);
      f.el.style.transform = `translate3d(${(this.scr.x + f.drift * u).toFixed(1)}px, ${this.scr.y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${pop.toFixed(3)})`;
    }
  }
}
