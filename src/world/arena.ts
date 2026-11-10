/**
 * Géométrie visible de l'arène : île centrale, terrasses, passerelles, aiguille,
 * jump pads, anneau-minuteur de la boucle. Tout est procédural (low-poly, flat shading).
 */
import * as THREE from 'three';
import { PALETTE } from '../config';
import { mulberry32 } from '../core/util';
import type { Engine } from '../render/engine';
import {
  ANCHORS, ARENA_R, PADS, RING_R0, RING_R1, RING_TOP, SHAPES, SPIRE_R, SPIRE_TOP, START, TERRACE_R, TERRACE_TOP,
} from './layout';

const TIMER_SEGMENTS = 96;

/** Recalcule les UV d'une géométrie plane (dans le plan XZ après rotation) pour tuiler la texture au mètre. */
function planarUV(geo: THREE.BufferGeometry, tile: number): void {
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / tile, pos.getY(i) / tile);
  uv.needsUpdate = true;
}

/** Rocher inversé sous une plateforme : donne l'impression d'une île flottante. */
function underRock(r: number, depth: number, seed: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.ConeGeometry(r, depth, 9, 3, false);
  const rng = mulberry32(seed);
  const pos = geo.attributes.position;
  const seen = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(2)},${pos.getY(i).toFixed(2)},${pos.getZ(i).toFixed(2)}`;
    let k = seen.get(key);
    if (k === undefined) { k = 0.82 + rng() * 0.36; seen.set(key, k); }
    const y = pos.getY(i);
    // Ne pas déformer le haut (il doit rester collé à la plateforme).
    const f = y < -depth / 2 + 0.01 ? 1 : k;
    pos.setXYZ(i, pos.getX(i) * f, y, pos.getZ(i) * f);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = Math.PI;
  m.castShadow = true;
  return m;
}

export class Arena {
  readonly group = new THREE.Group();
  private zones: THREE.Group[] = [];
  private zoneReveal: number[] = [1, 0, 0, 0];
  private zoneTarget: number[] = [1, 0, 0, 0];
  private timer: THREE.InstancedMesh;
  private timerColor = new THREE.Color();
  private pads: { mesh: THREE.Mesh; zone: number }[] = [];
  private padMat: THREE.MeshBasicMaterial;
  private startRing: THREE.Mesh;
  private stone: THREE.MeshStandardMaterial;
  private stoneDark: THREE.MeshStandardMaterial;
  private floorMat: THREE.MeshStandardMaterial;
  private wallMat: THREE.MeshStandardMaterial;
  /** Déclenché quand une zone finit de surgir (pour la poussière et le son). */
  onZoneLanded: ((zone: number) => void) | null = null;

  constructor(engine: Engine) {
    const floorTex = engine.texture('floor.webp');
    const wallTex = engine.texture('wall.webp');
    this.floorMat = new THREE.MeshStandardMaterial({ map: floorTex, color: 0xf2dcc0, roughness: 0.92, metalness: 0 });
    this.wallMat = new THREE.MeshStandardMaterial({ map: wallTex, color: 0xd9b8a8, roughness: 0.95, flatShading: true });
    this.stone = new THREE.MeshStandardMaterial({ color: PALETTE.rose, roughness: 0.95, flatShading: true });
    this.stoneDark = new THREE.MeshStandardMaterial({ color: 0x7a4250, roughness: 1, flatShading: true });
    this.padMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.teal).multiplyScalar(1.5) });

    for (let z = 0; z < 4; z++) {
      const g = new THREE.Group();
      this.zones.push(g);
      this.group.add(g);
    }
    this.buildCentral();
    this.buildTerraces();
    this.buildRing();
    this.buildSpire();
    this.buildPads();
    this.buildPedestals();
    this.buildBackdrop();

    // ——— Minuteur diégétique : un anneau de dalles lumineuses qui s'éteignent autour de l'arène ———
    const seg = new THREE.BoxGeometry(0.62, 0.08, 0.34);
    this.timer = new THREE.InstancedMesh(seg, new THREE.MeshBasicMaterial({ color: 0xffffff }), TIMER_SEGMENTS);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < TIMER_SEGMENTS; i++) {
      const a = (i / TIMER_SEGMENTS) * Math.PI * 2;
      p.set(Math.sin(a) * (ARENA_R - 0.75), 0.05, Math.cos(a) * (ARENA_R - 0.75));
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, a);
      this.timer.setMatrixAt(i, m.compose(p, q, s));
      this.timer.setColorAt(i, this.timerColor.setRGB(1, 1, 1));
    }
    this.zones[0].add(this.timer);

    // Point de départ de chaque boucle.
    this.startRing = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.15, 24),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.teal).multiplyScalar(1.2), transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    this.startRing.rotation.x = -Math.PI / 2;
    this.startRing.position.set(START.x, 0.03, START.z);
    this.zones[0].add(this.startRing);

    for (let z = 1; z < 4; z++) this.zones[z].visible = false;
  }

  private disc(r: number, top: number, thick: number, taper: number, tile: number): THREE.Group {
    const g = new THREE.Group();
    const side = new THREE.Mesh(new THREE.CylinderGeometry(r, r * taper, thick, 28, 1, true), this.wallMat);
    side.position.y = top - thick / 2;
    side.castShadow = true;
    side.receiveShadow = true;
    const capGeo = new THREE.CircleGeometry(r, 28);
    planarUV(capGeo, tile);
    const cap = new THREE.Mesh(capGeo, this.floorMat);
    cap.rotation.x = -Math.PI / 2;
    cap.position.y = top;
    cap.receiveShadow = true;
    g.add(side, cap);
    return g;
  }

  private buildCentral(): void {
    const z0 = this.zones[0];
    z0.add(this.disc(ARENA_R, 0, 3.2, 0.9, 3.6));
    const rock = underRock(ARENA_R * 0.9, 20, 11, this.stoneDark);
    rock.position.y = -3.2 - 10;
    z0.add(rock);
    // Parapet bas et anneaux incrustés, comme sur la planche de DA.
    const rim = new THREE.Mesh(new THREE.TorusGeometry(ARENA_R - 0.15, 0.3, 5, 28), this.stone);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.06;
    rim.castShadow = true;
    z0.add(rim);
    for (const [r0, r1, c] of [[6.4, 6.75, 0xc27a5e], [12.2, 12.5, 0xc27a5e]] as const) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 48), new THREE.MeshStandardMaterial({ color: c, roughness: 1 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.012;
      ring.receiveShadow = true;
      z0.add(ring);
    }
  }

  private buildTerraces(): void {
    const z1 = this.zones[1];
    for (const s of SHAPES) {
      if (s.zone !== 1) continue;
      if (s.kind === 'disc') {
        const d = this.disc(s.r, s.top, 5.5, 0.82, 4);
        d.position.set(s.x, 0, s.z);
        z1.add(d);
        const rock = underRock(s.r * 0.8, 11, 31 + Math.round(s.x), this.stoneDark);
        rock.position.set(s.x, s.top - 5.5 - 5.5, s.z);
        z1.add(rock);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(s.r - 0.12, 0.22, 5, 18), this.stone);
        rim.rotation.x = Math.PI / 2;
        rim.position.set(s.x, s.top + 0.05, s.z);
        z1.add(rim);
      } else if (s.kind === 'ramp') {
        const dx = s.x1 - s.x0, dz = s.z1 - s.z0, dy = s.y1 - s.y0;
        const len = Math.hypot(dx, dz);
        const full = Math.hypot(len, dy);
        const geo = new THREE.BoxGeometry(s.width, 0.5, full);
        const ramp = new THREE.Mesh(geo, this.stone);
        ramp.position.set((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2 - 0.25, (s.z0 + s.z1) / 2);
        ramp.rotation.order = 'YXZ';
        ramp.rotation.y = Math.atan2(dx, dz);
        ramp.rotation.x = -Math.atan2(dy, len);
        ramp.castShadow = true;
        ramp.receiveShadow = true;
        z1.add(ramp);
        // Rebords de la rampe.
        for (const side of [-1, 1]) {
          const edge = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.75, full), this.stoneDark);
          edge.position.copy(ramp.position);
          edge.rotation.copy(ramp.rotation);
          edge.translateX(side * (s.width / 2 + 0.05));
          edge.translateY(0.15);
          edge.castShadow = true;
          z1.add(edge);
        }
      }
    }
  }

  private buildRing(): void {
    const z2 = this.zones[2];
    const topGeo = new THREE.RingGeometry(RING_R0, RING_R1, 64, 1);
    planarUV(topGeo, 4);
    const top = new THREE.Mesh(topGeo, this.floorMat);
    top.rotation.x = -Math.PI / 2;
    top.position.y = RING_TOP;
    top.receiveShadow = true;
    z2.add(top);
    for (const r of [RING_R0, RING_R1]) {
      const side = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1.2, 64, 1, true), this.wallMat);
      (side.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
      side.position.y = RING_TOP - 0.6;
      side.castShadow = true;
      z2.add(side);
    }
    const bottom = new THREE.Mesh(new THREE.RingGeometry(RING_R0, RING_R1, 64, 1), this.stoneDark);
    bottom.rotation.x = Math.PI / 2;
    bottom.position.y = RING_TOP - 1.2;
    z2.add(bottom);
    // Contreforts suspendus sous l'anneau.
    const rng = mulberry32(77);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.2;
      const rock = underRock(2.4 + rng() * 1.2, 6 + rng() * 5, 200 + i, this.stoneDark);
      const depth = (rock.geometry as THREE.ConeGeometry).parameters.height;
      rock.position.set(Math.sin(a) * (RING_R0 + 2), RING_TOP - 1.2 - depth / 2, Math.cos(a) * (RING_R0 + 2));
      z2.add(rock);
    }
  }

  private buildSpire(): void {
    const z3 = this.zones[3];
    const d = this.disc(SPIRE_R, SPIRE_TOP, 1.6, 0.86, 4);
    z3.add(d);
    const rock = underRock(SPIRE_R * 0.84, 7, 303, this.stoneDark);
    rock.position.y = SPIRE_TOP - 1.6 - 3.5;
    z3.add(rock);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(SPIRE_R - 0.12, 0.22, 5, 20), this.stone);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = SPIRE_TOP + 0.05;
    z3.add(rim);
  }

  private buildPads(): void {
    for (const p of PADS) {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.4, 0.16, 8), this.stoneDark);
      base.position.y = 0.08;
      const glow = new THREE.Mesh(new THREE.RingGeometry(0.55, 1.0, 8), this.padMat);
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.18;
      g.add(base, glow);
      g.position.set(p.x, p.y, p.z);
      // Le pad est posé sur la zone d'où l'on saute, mais n'apparaît que quand la destination existe.
      this.zones[p.zone].add(g);
      this.pads.push({ mesh: glow, zone: p.zone });
    }
  }

  private buildPedestals(): void {
    // Petit socle lumineux sous chaque géode de l'arène : on voit d'où elles surgissent.
    const geo = new THREE.CylinderGeometry(0.42, 0.6, 0.35, 6);
    for (const a of ANCHORS) {
      if (a.zone !== 0) continue;
      const m = new THREE.Mesh(geo, this.stoneDark);
      m.position.set(a.x, 0.17, a.z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.zones[0].add(m);
    }
  }

  private buildBackdrop(): void {
    // Rochers flottants lointains : profondeur et échelle.
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const mesh = new THREE.InstancedMesh(geo, this.stoneDark, 46);
    const rng = mulberry32(5);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), e = new THREE.Euler();
    for (let i = 0; i < 46; i++) {
      const a = rng() * Math.PI * 2, r = 58 + rng() * 120;
      p.set(Math.sin(a) * r, -30 + rng() * 60, Math.cos(a) * r);
      const k = 2 + rng() * 9;
      s.set(k * (0.7 + rng() * 0.8), k * (0.5 + rng() * 0.6), k * (0.7 + rng() * 0.8));
      q.setFromEuler(e.set(rng() * 3, rng() * 3, rng() * 3));
      mesh.setMatrixAt(i, m.compose(p, q, s));
    }
    this.group.add(mesh);
  }

  /** Affiche les zones débloquées. `animate` fait surgir les nouvelles depuis le vide. */
  setZoneLevel(level: number, animate: boolean): void {
    for (let z = 1; z < 4; z++) {
      const on = z <= level ? 1 : 0;
      this.zoneTarget[z] = on;
      if (!animate || !on) this.zoneReveal[z] = on;
      this.applyReveal(z);
    }
  }

  private applyReveal(z: number): void {
    const r = this.zoneReveal[z];
    const g = this.zones[z];
    g.visible = r > 0;
    // Sortie élastique depuis le bas.
    const e = 1 - Math.pow(1 - r, 3);
    g.position.y = (1 - e) * -40;
    g.rotation.y = (1 - e) * 0.5;
  }

  update(dt: number, time: number, loopProgress: number, running: boolean): void {
    for (let z = 1; z < 4; z++) {
      if (this.zoneReveal[z] < this.zoneTarget[z]) {
        this.zoneReveal[z] = Math.min(1, this.zoneReveal[z] + dt / 2.2);
        this.applyReveal(z);
        if (this.zoneReveal[z] >= 1) this.onZoneLanded?.(z);
      }
    }
    // Les dalles s'éteignent dans le sens horaire à mesure que la boucle avance.
    const c = this.timerColor;
    const lit = (1 - loopProgress) * TIMER_SEGMENTS;
    for (let i = 0; i < TIMER_SEGMENTS; i++) {
      const on = running ? Math.min(1, Math.max(0, lit - i)) : 0.5 + 0.5 * Math.sin(time * 6 - i * 0.2);
      const urgent = running && loopProgress > 0.75 ? 0.5 + 0.5 * Math.sin(time * 14) : 0;
      // Ambre vif quand allumée (HDR → bloom), pierre sombre quand éteinte.
      c.setRGB(0.16 + on * (2.4 + urgent), 0.1 + on * (1.25 - urgent * 0.4), 0.1 + on * 0.12);
      this.timer.setColorAt(i, c);
    }
    this.timer.instanceColor!.needsUpdate = true;
    const pulse = 1.1 + 0.5 * Math.sin(time * 4);
    this.padMat.color.set(PALETTE.teal).multiplyScalar(pulse);
    for (const p of this.pads) p.mesh.rotation.z = time * 0.8;
    this.startRing.scale.setScalar(1 + 0.06 * Math.sin(time * 3));
  }
}

export const _layoutRefs = { TERRACE_R, TERRACE_TOP };
