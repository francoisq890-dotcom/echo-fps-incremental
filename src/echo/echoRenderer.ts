/**
 * Affichage des échos : silhouettes translucides instanciées qui rejouent un enregistrement.
 *
 * Aucune physique : pose interpolée depuis les échantillons à 20 Hz, tirs et cassures rejoués
 * depuis la liste d'événements calculée une fois par `replay()`.
 * 4 draw calls pour tous les corps, 1 pour leurs tirs, 1 pour leurs géodes fantômes.
 */
import * as THREE from 'three';
import { CFG, PALETTE } from '../config';
import { fmtRate } from '../core/util';
import type { Engine } from '../render/engine';
import { Tracers } from '../world/fx';
import type { SimEvent } from './loopsim';
import { decodeRecording, poseAt, replay, type Pose, type Recording } from './recording';

const MAX_ECHOES = CFG.echo.maxSlots + 4;
const MAX_GHOSTS = 128;
const EYE = CFG.player.eyeHeight;

interface Echo {
  id: number;
  rec: Recording;
  events: SimEvent[];
  duration: number;
  t: number;
  ev: number;
  /** 0 → 1 : matérialisation. */
  appear: number;
  /** ≥ 0 : en train de se dissoudre (remplacé). */
  vanish: number;
  stride: number;
  lastX: number; lastZ: number;
  speed: number;
  recoil: number;
  pulse: number;
  rate: number;
  label: HTMLDivElement;
  pose: Pose;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, taper = 1): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (taper !== 1) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) { p.setX(i, p.getX(i) * taper); p.setZ(i, p.getZ(i) * taper); }
  }
  g.translate(x, y, z);
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((g) => g.toNonIndexed());
  const total = flat.reduce((a, g) => a + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of flat) {
    pos.set(g.attributes.position.array as Float32Array, o);
    nor.set(g.attributes.normal.array as Float32Array, o);
    o += g.attributes.position.count * 3;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

/** Matériau des échos : sarcelle translucide, bord plus lumineux, lisible même à 40 copies. */
function echoMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color(PALETTE.teal) }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float iAlpha;
      varying vec3 vN; varying vec3 vV; varying float vAlpha; varying float vY;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vec4 mv = viewMatrix * wp;
        vN = normalize(mat3(viewMatrix) * mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vV = normalize(-mv.xyz);
        vAlpha = iAlpha;
        vY = wp.y;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime;
      varying vec3 vN; varying vec3 vV; varying float vAlpha; varying float vY;
      void main() {
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float rim = pow(f, 2.0);
        float scan = 0.88 + 0.12 * sin(vY * 38.0 - uTime * 5.0);
        // Couleur maintenue sous le seuil du bloom : les échos ne saturent jamais l'écran.
        vec3 col = uColor * (0.72 + 0.5 * rim) * scan;
        gl_FragColor = vec4(col, (0.4 + 0.45 * rim) * vAlpha);
      }`,
  });
}

export class EchoRenderer {
  readonly group = new THREE.Group();
  private echoes: Echo[] = [];
  private upper: THREE.InstancedMesh;
  private armL: THREE.InstancedMesh;
  private legL: THREE.InstancedMesh;
  private legR: THREE.InstancedMesh;
  private alphas: THREE.InstancedBufferAttribute[] = [];
  private mat: THREE.ShaderMaterial;
  private tracers: Tracers;
  private ghosts: THREE.InstancedMesh;
  private ghostN = 0;
  private ghostP = new Float32Array(MAX_GHOSTS * 3);
  private ghostLife = new Float32Array(MAX_GHOSTS);
  private ghostSize = new Float32Array(MAX_GHOSTS);
  private ghostBurst = new Uint8Array(MAX_GHOSTS);
  private labelRoot: HTMLElement;
  private m = new THREE.Matrix4();
  private m2 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private c = new THREE.Color();
  private scr = { x: 0, y: 0 };
  /** Son d'un tir d'écho (pan, gain). */
  onShot: ((pan: number, gain: number) => void) | null = null;
  showLabels = true;
  /** Portée des étiquettes : réduite quand les échos sont nombreux, pour rester lisible. */
  private labelRange = 30;

  constructor(private engine: Engine, labelRoot: HTMLElement) {
    this.labelRoot = labelRoot;
    this.mat = echoMaterial();
    // Repère local : pieds à l'origine, regard vers -Z.
    const upperGeo = merge([
      box(0.5, 0.62, 0.28, 0, 1.18, 0, 0.72), // torse
      box(0.3, 0.32, 0.3, 0, 1.68, 0), // tête
      box(0.14, 0.14, 0.52, 0.27, 1.34, -0.24), // bras droit tendu
      box(0.1, 0.16, 0.42, 0.27, 1.37, -0.62), // arme
    ]);
    const armGeo = box(0.13, 0.52, 0.13, 0, -0.24, 0, 0.8); // pivot à l'épaule
    const legGeo = box(0.17, 0.86, 0.19, 0, -0.43, 0, 0.72); // pivot à la hanche
    const make = (geo: THREE.BufferGeometry) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ECHOES), 1);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iAlpha', a);
      this.alphas.push(a);
      const mesh = new THREE.InstancedMesh(geo, this.mat, MAX_ECHOES);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.renderOrder = 5;
      this.group.add(mesh);
      return mesh;
    };
    this.upper = make(upperGeo);
    this.armL = make(armGeo);
    this.legL = make(legGeo);
    this.legR = make(legGeo.clone());

    this.tracers = new Tracers(320, new THREE.Color(PALETTE.teal).multiplyScalar(1.05), 0.2, 0.7);
    this.tracers.mesh.renderOrder = 6;
    this.group.add(this.tracers.mesh);

    // Géodes fantômes : la « phase » propre à chaque écho, visible seulement quand il les touche.
    const gm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, wireframe: true, blending: THREE.AdditiveBlending });
    this.ghosts = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), gm, MAX_GHOSTS);
    this.ghosts.frustumCulled = false;
    this.ghosts.count = 0;
    this.ghosts.setColorAt(0, this.c.set(PALETTE.teal));
    this.ghosts.renderOrder = 6;
    this.group.add(this.ghosts);
  }

  get count(): number { return this.echoes.filter((e) => e.vanish < 0).length; }

  has(id: number): boolean { return this.echoes.some((e) => e.id === id && e.vanish < 0); }

  /** Ajoute un écho à partir de son enregistrement encodé. `phase` décale son départ. */
  add(id: number, encoded: string, rate: number, phase = 0, materialize = true): boolean {
    let rec: Recording;
    try { rec = decodeRecording(encoded); } catch { return false; }
    const { events } = replay(rec);
    const label = document.createElement('div');
    label.className = 'echo-label';
    this.labelRoot.appendChild(label);
    const duration = rec.params.duration;
    const echo: Echo = {
      id, rec, events, duration, t: ((phase % duration) + duration) % duration, ev: 0,
      appear: materialize ? 0 : 1, vanish: -1, stride: 0, lastX: 0, lastZ: 0, speed: 0, recoil: 0, pulse: 0, rate, label,
      pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 },
    };
    poseAt(rec, echo.t, echo.pose);
    echo.lastX = echo.pose.x; echo.lastZ = echo.pose.z;
    while (echo.ev < events.length && events[echo.ev].t < echo.t) echo.ev++;
    this.setRate(echo, rate);
    this.echoes.push(echo);
    return true;
  }

  private setRate(e: Echo, rate: number): void {
    e.rate = rate;
    e.label.textContent = `+${fmtRate(rate)}/s`;
  }

  updateRate(id: number, rate: number): void {
    const e = this.echoes.find((x) => x.id === id);
    if (e && Math.abs(e.rate - rate) > 1e-9) this.setRate(e, rate);
  }

  /** Dissout un écho (remplacé par une meilleure boucle). */
  dissolve(id: number): void {
    const e = this.echoes.find((x) => x.id === id && x.vanish < 0);
    if (e) e.vanish = 0;
  }

  clear(): void {
    for (const e of this.echoes) e.label.remove();
    this.echoes.length = 0;
  }

  /** Remet tous les échos de même durée au début de leur boucle (ils tirent en rythme avec le joueur). */
  syncAll(duration: number): void {
    for (const e of this.echoes) if (Math.abs(e.duration - duration) < 1e-6) { e.t = 0; e.ev = 0; }
  }

  /** Position (pieds) d'un écho, pour les effets et le tutoriel. */
  positionOf(id: number, out: THREE.Vector3): boolean {
    const e = this.echoes.find((x) => x.id === id);
    if (!e) return false;
    out.set(e.pose.x, e.pose.y - EYE, e.pose.z);
    return true;
  }

  /** L'écho le plus proche de l'axe de visée (info-bulle). */
  aimed(origin: THREE.Vector3, dir: THREE.Vector3): { id: number; rate: number; dist: number } | null {
    let best: Echo | null = null, bestD = 40;
    for (const e of this.echoes) {
      if (e.vanish >= 0) continue;
      const lx = e.pose.x - origin.x, ly = e.pose.y - 0.5 - origin.y, lz = e.pose.z - origin.z;
      const tca = lx * dir.x + ly * dir.y + lz * dir.z;
      if (tca < 1 || tca > bestD) continue;
      const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
      if (d2 < 0.55) { best = e; bestD = tca; }
    }
    return best ? { id: best.id, rate: best.rate, dist: bestD } : null;
  }

  private ghost(x: number, y: number, z: number, size: number, burst: boolean): void {
    if (this.ghostN >= MAX_GHOSTS) return;
    const i = this.ghostN++;
    this.ghostP.set([x, y, z], i * 3);
    this.ghostLife[i] = 1; this.ghostSize[i] = size; this.ghostBurst[i] = burst ? 1 : 0;
  }

  update(dt: number, time: number, cam: THREE.Vector3, camYaw: number): void {
    this.mat.uniforms.uTime.value = time;
    this.labelRange = this.echoes.length > 24 ? 11 : this.echoes.length > 10 ? 17 : 30;
    const { m, m2, q, p, s, e } = this;
    const right = { x: Math.cos(camYaw), z: -Math.sin(camYaw) };
    let n = 0;
    for (let i = this.echoes.length - 1; i >= 0; i--) {
      const ec = this.echoes[i];
      if (ec.vanish >= 0) {
        ec.vanish += dt * 1.6;
        if (ec.vanish >= 1) { ec.label.remove(); this.echoes.splice(i, 1); continue; }
      }
    }
    for (const ec of this.echoes) {
      ec.appear = Math.min(1, ec.appear + dt * 1.3);
      ec.t += dt;
      if (ec.t >= ec.duration) { ec.t -= ec.duration; ec.ev = 0; ec.pulse = 1; }
      poseAt(ec.rec, ec.t, ec.pose);
      const po = ec.pose;

      // ——— Événements de sa boucle : tirs et cassures dans sa propre phase ———
      const evs = ec.events;
      while (ec.ev < evs.length && evs[ec.ev].t <= ec.t) {
        const ev = evs[ec.ev++];
        if (ec.vanish >= 0 || ec.appear < 1) continue;
        if (ev.k === 'shot') {
          const sx = po.x - Math.sin(po.yaw) * 0.6 + Math.cos(po.yaw) * 0.27;
          const sz = po.z - Math.cos(po.yaw) * 0.6 - Math.sin(po.yaw) * 0.27;
          this.tracers.addPath(sx, po.y - 0.22, sz, ev.pts, 0.07);
          ec.recoil = 1;
          if (this.onShot) {
            const dx = po.x - cam.x, dz = po.z - cam.z;
            const dist = Math.hypot(dx, dz, po.y - cam.y);
            if (dist < 45) this.onShot(Math.max(-1, Math.min(1, (dx * right.x + dz * right.z) / (dist + 1))), 1 / (1 + dist * 0.12));
          }
        } else if (ev.k === 'hit') {
          this.ghost(ev.x, ev.y, ev.z, 0.32, false);
        } else if (ev.k === 'break') {
          this.ghost(ev.x, ev.y, ev.z, 0.7, true);
          ec.pulse = 1;
        }
      }

      // ——— Corps : course procédurale pilotée par la distance parcourue ———
      const dx = po.x - ec.lastX, dz = po.z - ec.lastZ;
      const step = Math.hypot(dx, dz);
      ec.lastX = po.x; ec.lastZ = po.z;
      const sp = dt > 0 ? Math.min(12, step / dt) : 0;
      ec.speed += (sp - ec.speed) * Math.min(1, dt * 10);
      ec.stride += Math.min(step, 1) * 2.6;
      ec.recoil = Math.max(0, ec.recoil - dt * 9);
      ec.pulse = Math.max(0, ec.pulse - dt * 2.5);
      const swing = Math.sin(ec.stride) * Math.min(1, ec.speed / 4) * 0.85;
      const feetY = po.y - EYE;

      // Fondu si l'écho traverse la caméra (il ne doit jamais boucher la vue).
      const cd = Math.hypot(po.x - cam.x, po.y - cam.y, po.z - cam.z);
      const near = Math.min(1, Math.max(0, (cd - 1.4) / 3.2));
      const vanish = ec.vanish >= 0 ? 1 - ec.vanish : 1;
      const alpha = ec.appear * near * vanish * (1 + ec.pulse * 0.6);
      // Matérialisation : étiré vers le haut puis qui se tasse ; dissolution : s'élève.
      const stretch = 1 + (1 - ec.appear) * (1 - ec.appear) * 2.2;
      const squeeze = 0.35 + 0.65 * ec.appear;
      const rise = ec.vanish >= 0 ? ec.vanish * 2.2 : 0;

      q.setFromEuler(e.set(0, po.yaw, 0));
      s.set(squeeze, stretch, squeeze);
      m.compose(p.set(po.x, feetY + rise, po.z), q, s);

      // Haut du corps : penche avec la visée et recule au tir.
      m2.makeRotationX(po.pitch * 0.5 + ec.recoil * 0.06).setPosition(0, 0.05 * Math.abs(swing), 0.03 * ec.recoil);
      // Pivot du buste autour des hanches (y ≈ 0,9).
      m2.multiplyMatrices(new THREE.Matrix4().makeTranslation(0, 0.9, 0), m2).multiply(new THREE.Matrix4().makeTranslation(0, -0.9, 0));
      this.upper.setMatrixAt(n, m2.premultiply(m));
      m2.makeRotationX(-swing * 0.9).setPosition(-0.31, 1.44, 0);
      this.armL.setMatrixAt(n, m2.premultiply(m));
      m2.makeRotationX(swing).setPosition(-0.13, 0.88, 0);
      this.legL.setMatrixAt(n, m2.premultiply(m));
      m2.makeRotationX(-swing).setPosition(0.13, 0.88, 0);
      this.legR.setMatrixAt(n, m2.premultiply(m));
      for (const a of this.alphas) a.setX(n, alpha);
      n++;

      // ——— Étiquette discrète « +X/s » ———
      const lb = ec.label.style;
      if (this.showLabels && cd < this.labelRange && cd > 2 && ec.vanish < 0 && this.engine.project(po.x, feetY + 2.15, po.z, this.scr)) {
        lb.display = 'block';
        lb.opacity = String(Math.min(1, ec.appear * (1.2 - cd / this.labelRange)) * (0.55 + ec.pulse * 0.45));
        lb.transform = `translate3d(${this.scr.x.toFixed(1)}px, ${this.scr.y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${(1 + ec.pulse * 0.25).toFixed(3)})`;
      } else if (lb.display !== 'none') lb.display = 'none';
    }
    for (const mesh of [this.upper, this.armL, this.legL, this.legR]) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const a of this.alphas) a.needsUpdate = true;

    this.tracers.update(dt);

    // Géodes fantômes.
    for (let i = this.ghostN - 1; i >= 0; i--) {
      this.ghostLife[i] -= dt * (this.ghostBurst[i] ? 3.4 : 7);
      if (this.ghostLife[i] <= 0) {
        const l = --this.ghostN;
        if (i !== l) {
          for (let k = 0; k < 3; k++) this.ghostP[i * 3 + k] = this.ghostP[l * 3 + k];
          this.ghostLife[i] = this.ghostLife[l]; this.ghostSize[i] = this.ghostSize[l]; this.ghostBurst[i] = this.ghostBurst[l];
        }
      }
    }
    const teal = this.c;
    for (let i = 0; i < this.ghostN; i++) {
      const life = this.ghostLife[i];
      const k = this.ghostSize[i] * (this.ghostBurst[i] ? 0.8 + (1 - life) * 0.9 : 0.9);
      m.compose(p.fromArray(this.ghostP, i * 3), q.identity(), s.setScalar(k));
      this.ghosts.setMatrixAt(i, m);
      teal.set(PALETTE.teal).multiplyScalar(life * 0.4);
      this.ghosts.setColorAt(i, teal);
    }
    this.ghosts.count = this.ghostN;
    this.ghosts.instanceMatrix.needsUpdate = true;
    this.ghosts.instanceColor!.needsUpdate = true;
  }
}
