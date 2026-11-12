/**
 * L'arme en vue FPS, modélisée en code d'après l'image de concept générée
 * (corps grès, plaques terracotta, poignée prune, bague sarcelle, cœur de cristal ambre).
 * Recul, balancement, flash de bouche, et pièces supplémentaires à chaque palier majeur.
 */
import * as THREE from 'three';
import { ELEM_RGB, PALETTE } from '../config';

export class Weapon {
  readonly group = new THREE.Group();
  private model = new THREE.Group();
  private core: THREE.Mesh;
  private coreMat: THREE.MeshBasicMaterial;
  private flash: THREE.Mesh;
  private flashMat: THREE.MeshBasicMaterial;
  private tiers: THREE.Group[] = [];
  private orbiters: THREE.Mesh[] = [];
  private ring2: THREE.Mesh | null = null;
  private recoil = 0;
  private recoilV = 0;
  private flashT = 0;
  private swayX = 0;
  private swayY = 0;
  private flourish = 0;
  private lower = 0;
  private lowerTarget = 0;
  private heat = 0;
  private bodies: THREE.Group[] = [];
  private core2: THREE.Mesh | null = null;
  private drum: THREE.Group | null = null;
  /** Arme affichée, arme demandée, progression de l'échange (0..1). */
  current = 0;
  private wanted = 0;
  private swap = 1;
  private coreRGB: [number, number, number] = [2.6, 1.5, 0.25];
  private flashRGB: [number, number, number] = [3.5, 2.2, 0.6];
  tier = 0;
  /** Position monde approximative de la bouche du canon (pour le départ des traits de tir). */
  readonly muzzleLocal = new THREE.Vector3(0.25, -0.2, -0.93);

  constructor() {
    const sand = new THREE.MeshStandardMaterial({ color: PALETTE.sand, roughness: 0.7, flatShading: true });
    const terra = new THREE.MeshStandardMaterial({ color: PALETTE.terracotta, roughness: 0.75, flatShading: true });
    const plum = new THREE.MeshStandardMaterial({ color: 0x5a2848, roughness: 0.8, flatShading: true });
    const teal = new THREE.MeshStandardMaterial({ color: 0x2f8f86, roughness: 0.5, metalness: 0.2, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x241420, roughness: 1 });
    this.coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 1.5, 0.25) });

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.model) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    const oct = (r: number, len: number) => {
      const g = new THREE.CylinderGeometry(r, r, len, 8, 1);
      g.rotateX(Math.PI / 2);
      g.rotateZ(Math.PI / 8);
      return g;
    };

    // Canon avant (gros tube octogonal) + chambre arrière, séparés par le cœur de cristal apparent.
    add(oct(0.135, 0.42), sand, 0, 0, -0.5);
    add(oct(0.12, 0.2), sand, 0, 0, 0.02);
    add(new THREE.BoxGeometry(0.08, 0.05, 0.26), sand, 0, 0.115, -0.2); // pont supérieur
    add(new THREE.BoxGeometry(0.1, 0.06, 0.3), sand, 0, -0.12, -0.2); // pont inférieur
    add(oct(0.105, 0.05), dark, 0, 0, -0.705); // âme du canon
    const ring = add(new THREE.TorusGeometry(0.125, 0.035, 5, 8), teal, 0, 0, -0.72);
    ring.rotation.z = Math.PI / 8;
    // Plaques terracotta.
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(0.02, 0.1, 0.15), terra, side * 0.135, 0.01, -0.6);
      add(new THREE.BoxGeometry(0.02, 0.1, 0.13), terra, side * 0.135, 0.01, -0.42);
      add(new THREE.BoxGeometry(0.02, 0.08, 0.1), terra, side * 0.12, 0.01, 0.03);
    }
    add(new THREE.BoxGeometry(0.16, 0.07, 0.3), terra, 0, -0.165, -0.48); // carénage bas
    add(new THREE.BoxGeometry(0.05, 0.05, 0.06), sand, 0, 0.15, -0.62); // guidon
    add(new THREE.BoxGeometry(0.05, 0.06, 0.05), sand, 0, 0.14, 0.08); // hausse
    // Poignée et pontet.
    const grip = add(new THREE.BoxGeometry(0.1, 0.3, 0.13), plum, 0, -0.26, 0.08);
    grip.rotation.x = -0.3;
    add(new THREE.BoxGeometry(0.11, 0.03, 0.15), sand, 0, -0.41, 0.125).rotation.x = -0.3;
    add(new THREE.BoxGeometry(0.03, 0.025, 0.16), sand, 0, -0.2, -0.1);
    add(new THREE.BoxGeometry(0.03, 0.07, 0.03), teal, 0, -0.16, -0.05);
    // Cœur de cristal (HDR : il rayonne dans le bloom).
    this.core = add(new THREE.IcosahedronGeometry(0.085, 0), this.coreMat, 0, 0, -0.2);

    // ——— Paliers : chaque palier majeur ajoute des pièces visibles ———
    const t1 = new THREE.Group(); // ailettes latérales
    for (const side of [-1, 1]) {
      const fin = add(new THREE.BoxGeometry(0.015, 0.07, 0.3), terra, side * 0.165, 0.08, -0.3, t1);
      fin.rotation.z = side * -0.5;
    }
    const t2 = new THREE.Group(); // canon rallongé + seconde bague
    add(oct(0.1, 0.22), sand, 0, 0, -0.84, t2);
    this.ring2 = add(new THREE.TorusGeometry(0.115, 0.03, 5, 8), teal, 0, 0, -0.95, t2);
    const t3 = new THREE.Group(); // cristaux en orbite autour du cœur
    for (let i = 0; i < 3; i++) {
      const o = new THREE.Mesh(new THREE.OctahedronGeometry(0.035, 0), this.coreMat);
      t3.add(o);
      this.orbiters.push(o);
    }
    const t4 = new THREE.Group(); // couronne de cristaux sur le dessus
    for (const [x, z, s] of [[0, -0.36, 1], [-0.05, -0.28, 0.7], [0.05, -0.44, 0.75]] as const) {
      const c = add(new THREE.OctahedronGeometry(0.045, 0), this.coreMat, x, 0.19, z, t4);
      c.scale.set(s, s * 2.2, s);
    }
    this.tiers = [t1, t2, t3, t4];
    for (const t of this.tiers) { t.visible = false; this.model.add(t); }

    // Flash de bouche : deux plans croisés, additifs.
    this.flashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.5, 2.2, 0.6), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const star = new THREE.Shape();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2, r = i % 2 ? 0.05 : 0.15;
      if (i === 0) star.moveTo(Math.cos(a) * r, Math.sin(a) * r); else star.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    this.flash = add(new THREE.ShapeGeometry(star), this.flashMat, 0, 0, -0.8);

    // Tout ce qui précède forme l'Éclateur ; le flash reste commun aux deux armes.
    const body1 = new THREE.Group();
    for (const child of [...this.model.children]) if (child !== this.flash) body1.add(child);
    this.model.add(body1);

    // ——— Le Fracasseur : large, trapu, deux gros canons côte à côte et un barillet de cristaux ———
    const body2 = new THREE.Group();
    for (const side of [-1, 1]) {
      add(oct(0.115, 0.5), sand, side * 0.105, 0, -0.42, body2);
      add(oct(0.09, 0.06), dark, side * 0.105, 0, -0.67, body2);
      const r = add(new THREE.TorusGeometry(0.118, 0.03, 5, 8), terra, side * 0.105, 0, -0.64, body2);
      r.rotation.z = Math.PI / 8;
      add(new THREE.BoxGeometry(0.02, 0.12, 0.34), terra, side * 0.225, 0, -0.38, body2);
    }
    add(new THREE.BoxGeometry(0.34, 0.17, 0.22), sand, 0, -0.01, 0.02, body2); // boîte de culasse
    add(new THREE.BoxGeometry(0.36, 0.04, 0.14), terra, 0, 0.09, 0.02, body2);
    add(new THREE.BoxGeometry(0.34, 0.09, 0.36), terra, 0, -0.14, -0.34, body2); // garde-main
    add(new THREE.BoxGeometry(0.06, 0.06, 0.5), teal, 0, 0.125, -0.4, body2); // rail de visée
    const grip2 = add(new THREE.BoxGeometry(0.11, 0.3, 0.14), plum, 0, -0.27, 0.1, body2);
    grip2.rotation.x = -0.3;
    add(new THREE.BoxGeometry(0.12, 0.03, 0.16), sand, 0, -0.42, 0.145, body2).rotation.x = -0.3;
    // Barillet : quatre cristaux qui tournent d'un cran à chaque tir.
    this.drum = new THREE.Group();
    this.drum.position.set(0, 0.16, -0.12);
    this.drum.scale.setScalar(0.75);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.05, 0), this.coreMat);
      c.position.set(Math.cos(a) * 0.09, 0, Math.sin(a) * 0.09);
      c.scale.y = 1.6;
      this.drum.add(c);
    }
    body2.add(this.drum);
    this.core2 = add(new THREE.IcosahedronGeometry(0.075, 0), this.coreMat, 0, 0, -0.2, body2);
    // Plus trapu que l'Éclateur : on le décale vers le bas et la droite pour dégager la vue et montrer les deux canons.
    body2.position.set(0.02, -0.02, -0.05);
    body2.rotation.y = 0.34;
    body2.scale.setScalar(0.82);
    body2.visible = false;
    this.model.add(body2);
    this.bodies = [body1, body2];

    this.model.scale.setScalar(0.4);
    this.model.rotation.y = 0.04;
    this.group.add(this.model);
  }

  setTier(tier: number, animate: boolean): void {
    if (tier === this.tier && this.tiers.every((t, i) => t.visible === i < tier)) return;
    this.tier = tier;
    this.tiers.forEach((t, i) => (t.visible = i < tier));
    this.placeMuzzle();
    if (animate) this.flourish = 1;
  }

  private placeMuzzle(): void {
    if (this.current === 1) { this.muzzleLocal.z = -0.92; this.flash.position.z = -0.74; }
    else { this.muzzleLocal.z = this.tier >= 2 ? -1.03 : -0.93; this.flash.position.z = this.tier >= 2 ? -1.02 : -0.8; }
  }

  /** Change d'arme : l'ancienne s'abaisse, la nouvelle remonte. `instant` saute l'animation. */
  setWeapon(w: number, instant = false): void {
    if (w === this.wanted && !instant) return;
    this.wanted = w;
    if (instant) { this.current = w; this.swap = 1; this.showCurrent(); }
    else if (this.swap >= 1) this.swap = 0;
  }

  private showCurrent(): void {
    this.bodies.forEach((b, i) => (b.visible = i === this.current));
    this.placeMuzzle();
  }

  /** Vrai pendant l'échange : on ne peut pas tirer. */
  get swapping(): boolean { return this.swap < 1; }

  /** L'élément en main colore le cœur de cristal et le flash de bouche. */
  setElement(e: number): void {
    const c = ELEM_RGB[e] ?? ELEM_RGB[0];
    this.coreRGB = e === 0 ? [2.6, 1.5, 0.25] : [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8];
    this.flashRGB = e === 0 ? [3.5, 2.2, 0.6] : [c[0], c[1], c[2]];
    this.flashMat.color.setRGB(this.flashRGB[0], this.flashRGB[1], this.flashRGB[2]);
    this.heat = 1;
  }

  /** Petite animation de satisfaction après un achat. */
  celebrate(amount = 0.6): void { this.flourish = Math.max(this.flourish, amount); }

  fire(): void {
    const heavy = this.current === 1;
    this.recoilV += heavy ? 8.5 : 3.2 + this.tier * 0.3;
    this.flashT = heavy ? 1.6 : 1;
    if (heavy && this.drum) this.drum.rotation.y += Math.PI / 2;
    this.heat = Math.min(1, this.heat + 0.25);
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar((heavy ? 1.9 : 0.8) + Math.random() * 0.5 + this.tier * 0.12);
  }

  setLowered(on: boolean): void { this.lowerTarget = on ? 1 : 0; }

  update(dt: number, time: number, lookDX: number, lookDY: number, bob: number, speed: number, landDip: number, airborne: boolean): void {
    // Recul : ressort amorti.
    this.recoilV += (-this.recoil * 190 - this.recoilV * 20) * dt;
    this.recoil += this.recoilV * dt;
    this.flashT = Math.max(0, this.flashT - dt * 22);
    this.heat = Math.max(0, this.heat - dt * 1.2);
    this.flourish = Math.max(0, this.flourish - dt * 1.5);
    // Échange d'arme : on descend, on change de modèle au point bas, on remonte.
    let swapLower = 0;
    if (this.swap < 1) {
      const before = this.swap;
      this.swap = Math.min(1, this.swap + dt * 3.6);
      if (before < 0.5 && this.swap >= 0.5) { this.current = this.wanted; this.showCurrent(); }
      if (this.swap >= 1 && this.current !== this.wanted) this.swap = 0;
      swapLower = Math.sin(this.swap * Math.PI);
    }
    const lowerAll = Math.max(this.lowerTarget, swapLower * 0.8);
    this.lower += (lowerAll - this.lower) * Math.min(1, dt * (this.swap < 1 ? 22 : 9));
    // Balancement : l'arme traîne légèrement derrière la visée.
    this.swayX += (-lookDX * 0.0009 - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (lookDY * 0.0009 - this.swayY) * Math.min(1, dt * 9);
    const walk = Math.min(1, speed / 7);
    const m = this.model;
    const r = this.recoil;
    m.position.set(
      0.25 + this.swayX + Math.cos(bob) * 0.012 * walk,
      -0.2 + this.swayY - Math.abs(Math.sin(bob)) * 0.016 * walk - landDip * 0.07 - this.lower * 0.7 + (airborne ? 0.012 : 0),
      -0.64 + r * 0.9,
    );
    const f = this.flourish;
    m.rotation.set(
      r * 1.1 + this.swayY * 1.5 + this.lower * 0.9 - Math.sin(f * Math.PI) * 0.35,
      0.04 + this.swayX * 2.2,
      this.swayX * -1.2 + Math.sin(f * Math.PI * 2) * 0.5 * f,
    );
    const glow = 0.8 + this.heat * 0.5 + 0.08 * Math.sin(time * 5) + f * 1.2;
    this.coreMat.color.setRGB(this.coreRGB[0] * glow, this.coreRGB[1] * glow, this.coreRGB[2] * glow);
    if (this.core2) this.core2.rotation.set(time * 1.1, time * 0.8, 0);
    this.core.rotation.set(time * 0.9, time * 1.3, 0);
    this.core.scale.setScalar(1 + this.heat * 0.25 + f * 0.4);
    this.flashMat.opacity = this.flashT;
    for (let i = 0; i < this.orbiters.length; i++) {
      const a = time * (2.4 + this.heat * 6) + (i / 3) * Math.PI * 2;
      this.orbiters[i].position.set(Math.cos(a) * 0.15, Math.sin(a) * 0.15, -0.2);
      this.orbiters[i].rotation.set(a, a * 1.3, 0);
    }
    if (this.ring2) this.ring2.rotation.z = time * 2;
  }
}
