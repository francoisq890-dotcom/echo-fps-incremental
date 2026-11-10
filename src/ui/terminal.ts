/**
 * Terminal d'améliorations : une interface diégétique.
 * L'écran est une texture canvas posée sur un hologramme DANS l'arène ; on vise une ligne
 * avec le viseur et on clique (on « tire ») pour acheter. Pas de panneau plaqué sur l'écran.
 */
import * as THREE from 'three';
import { FAMILIES, UPGRADES, UPGRADE_BY_ID, type UpgradeDef } from '../config';
import { fmt, fmtRate } from '../core/util';
import { buyBlock, costOf, derive, lvl, prestigePreview, totalRate, type GameState } from '../economy/state';
import type { Engine } from '../render/engine';
import { TERMINAL } from '../world/layout';

const W = 1536, H = 864;
export const SCREEN_W = 4.7, SCREEN_H = (SCREEN_W * H) / W;
export const SCREEN_Y = 2.5;
const FONT = '"Bahnschrift", "DIN Alternate", "Avenir Next Condensed", "Segoe UI", system-ui, sans-serif';

const C = {
  bg0: '#1d0f22', bg1: '#2e1832', line: 'rgba(247,227,184,0.16)', cream: '#f7e3b8', dim: 'rgba(247,227,184,0.55)',
  faint: 'rgba(247,227,184,0.28)', amber: '#ffb81f', terra: '#c9694a', rose: '#d49278', teal: '#3fc9b0', plum: '#2b1830',
};

export type TermAction = { type: 'buy'; id: string } | { type: 'tab'; tab: number } | { type: 'prestige' };
interface Region { x: number; y: number; w: number; h: number; action: TermAction; upgrade?: UpgradeDef }

export class TerminalScreen {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private icons: HTMLImageElement | null = null;
  private regions: Region[] = [];
  private hover: Region | null = null;
  private cursor: { x: number; y: number } | null = null;
  private flashId = '';
  private flashT = 0;
  private denyId = '';
  private denyT = 0;
  private lastDraw = -1;
  private halo: THREE.Mesh;
  tab = 0;
  dirty = true;

  constructor(engine: Engine) {
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    const img = new Image();
    img.onload = () => { this.icons = img; this.dirty = true; };
    img.src = `${import.meta.env.BASE_URL}assets/icons.webp`;

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(SCREEN_W, SCREEN_H),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, opacity: 0.96, toneMapped: false, fog: false }),
    );
    this.mesh.position.set(0, SCREEN_Y, 0);
    this.group.add(this.mesh);

    // Socle de pierre et projecteur.
    const stone = new THREE.MeshStandardMaterial({ color: 0x7a4250, roughness: 1, flatShading: true });
    const sand = new THREE.MeshStandardMaterial({ color: 0xd49278, roughness: 0.9, flatShading: true });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.9, 0.5, 8), stone);
    base.position.y = 0.25; base.scale.z = 0.4;
    const lip = new THREE.Mesh(new THREE.BoxGeometry(SCREEN_W + 0.2, 0.18, 0.5), sand);
    lip.position.y = SCREEN_Y - SCREEN_H / 2 - 0.2;
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.28, SCREEN_Y - SCREEN_H / 2 - 0.1, 0.34), stone);
      post.position.set(side * (SCREEN_W / 2 - 0.3), (SCREEN_Y - SCREEN_H / 2 - 0.1) / 2, 0);
      post.castShadow = true;
      this.group.add(post);
      const horn = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.4, 0.25) }));
      horn.scale.y = 2;
      horn.position.set(side * (SCREEN_W / 2 + 0.25), SCREEN_Y + SCREEN_H / 2 - 0.1, 0);
      this.group.add(horn);
    }
    base.castShadow = lip.castShadow = true;
    base.receiveShadow = true;
    this.group.add(base, lip);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W + 0.3, SCREEN_H + 0.3), new THREE.MeshBasicMaterial({ color: 0x1d0f22, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    back.position.set(0, SCREEN_Y, -0.04);
    this.group.add(back);
    // Halo d'appel quand un achat est possible.
    this.halo = new THREE.Mesh(new THREE.RingGeometry(3.0, 3.25, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.3, 0.2), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    this.halo.rotation.x = -Math.PI / 2;
    this.halo.position.set(0, 0.05, 2.6);
    this.group.add(this.halo);

    this.group.position.set(TERMINAL.x, TERMINAL.y, TERMINAL.z);
  }

  /** Curseur en coordonnées UV de l'écran (0..1), ou null si le viseur n'est pas dessus. */
  setCursor(uv: { x: number; y: number } | null): boolean {
    const prev = this.hover;
    if (!uv) { this.cursor = null; this.hover = null; }
    else {
      this.cursor = { x: uv.x * W, y: (1 - uv.y) * H };
      this.hover = this.regions.find((r) => this.cursor!.x >= r.x && this.cursor!.x <= r.x + r.w && this.cursor!.y >= r.y && this.cursor!.y <= r.y + r.h) ?? null;
    }
    this.dirty = true;
    return this.hover !== prev && this.hover !== null;
  }

  click(): TermAction | null {
    return this.hover ? this.hover.action : null;
  }

  flash(id: string): void { this.flashId = id; this.flashT = 1; this.dirty = true; }
  deny(id: string): void { this.denyId = id; this.denyT = 1; this.dirty = true; }

  affordableCount(s: GameState): number {
    let n = 0;
    for (const u of UPGRADES) if (buyBlock(s, u.id) === null) n++;
    return n;
  }

  update(dt: number, time: number, s: GameState, docked: boolean): void {
    this.flashT = Math.max(0, this.flashT - dt * 2.5);
    this.denyT = Math.max(0, this.denyT - dt * 3);
    const afford = this.affordableCount(s);
    (this.halo.material as THREE.MeshBasicMaterial).opacity = !docked && afford > 0 ? 0.35 + 0.3 * Math.sin(time * 4) : 0;
    this.halo.scale.setScalar(1 + 0.04 * Math.sin(time * 4));
    const interval = docked ? 0.1 : 0.6;
    if (this.flashT > 0 || this.denyT > 0 || (this.dirty && time - this.lastDraw > 0.033) || time - this.lastDraw > interval) {
      this.draw(s, docked, time, afford);
      this.lastDraw = time;
      this.dirty = false;
    }
  }

  private icon(index: number, x: number, y: number, size: number, alpha = 1): void {
    const g = this.ctx;
    if (!this.icons) return;
    g.save();
    g.globalAlpha = alpha;
    g.beginPath();
    g.roundRect(x, y, size, size, size * 0.18);
    g.clip();
    // Atlas 5 × 4, cellules de 128 px ; léger zoom pour rogner les marges.
    g.drawImage(this.icons, (index % 5) * 128 + 6, Math.floor(index / 5) * 128 + 6, 116, 116, x, y, size, size);
    g.restore();
  }

  private wrap(text: string, x: number, y: number, maxW: number, lh: number): number {
    const g = this.ctx;
    let line = '';
    for (const word of text.split(' ')) {
      const test = line ? line + ' ' + word : word;
      if (g.measureText(test).width > maxW && line) { g.fillText(line, x, y); y += lh; line = word; }
      else line = test;
    }
    if (line) { g.fillText(line, x, y); y += lh; }
    return y;
  }

  private draw(s: GameState, docked: boolean, time: number, afford: number): void {
    const g = this.ctx;
    this.regions = [];
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, C.bg1); grad.addColorStop(1, C.bg0);
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = C.rose; g.lineWidth = 4;
    g.strokeRect(10, 10, W - 20, H - 20);
    g.textBaseline = 'alphabetic';

    // ——— En-tête : solde et production ———
    g.fillStyle = C.dim; g.font = `600 22px ${FONT}`; g.textAlign = 'left';
    g.fillText('TERMINAL · AMÉLIORATIONS', 44, 58);
    this.icon(18, W - 420, 26, 54);
    g.fillStyle = C.amber; g.font = `700 46px ${FONT}`;
    g.fillText(fmt(Math.floor(s.shards)), W - 352, 70);
    const wAmt = g.measureText(fmt(Math.floor(s.shards))).width;
    g.fillStyle = C.dim; g.font = `500 22px ${FONT}`;
    g.fillText(`éclats  ·  +${fmtRate(totalRate(s))}/s`, W - 340 + wAmt, 68);

    // ——— Onglets ———
    const tabs = [...FAMILIES.map((f) => f.name), 'EFFONDREMENT'];
    const tw = 236, th = 58, ty = 92;
    tabs.forEach((name, i) => {
      const x = 44 + i * (tw + 10);
      const r: Region = { x, y: ty, w: tw, h: th, action: { type: 'tab', tab: i } };
      this.regions.push(r);
      const active = i === this.tab, hov = this.hover?.action.type === 'tab' && (this.hover.action as { tab: number }).tab === i;
      g.fillStyle = active ? C.cream : hov ? 'rgba(247,227,184,0.22)' : 'rgba(247,227,184,0.08)';
      g.beginPath(); g.roundRect(x, ty, tw, th, 10); g.fill();
      g.fillStyle = active ? C.plum : C.cream;
      g.font = `700 24px ${FONT}`; g.textAlign = 'center';
      g.fillText(name, x + tw / 2, ty + 38);
      // Pastille : nombre d'achats possibles dans la famille.
      if (i < FAMILIES.length) {
        const n = UPGRADES.filter((u) => u.family === FAMILIES[i].id && buyBlock(s, u.id) === null).length;
        if (n > 0) {
          g.fillStyle = C.amber; g.beginPath(); g.arc(x + tw - 20, ty + 16, 13, 0, Math.PI * 2); g.fill();
          g.fillStyle = C.plum; g.font = `700 17px ${FONT}`; g.fillText(String(n), x + tw - 20, ty + 22);
        }
      } else if (prestigePreview(s).available) {
        g.fillStyle = C.amber; g.beginPath(); g.arc(x + tw - 20, ty + 16, 13, 0, Math.PI * 2); g.fill();
        g.fillStyle = C.plum; g.font = `700 17px ${FONT}`; g.fillText('!', x + tw - 20, ty + 22);
      }
    });
    g.textAlign = 'left';

    if (this.tab < FAMILIES.length) this.drawFamily(s, time);
    else this.drawPrestige(s);

    // ——— Pied : mode d'emploi ———
    g.fillStyle = C.faint; g.font = `500 20px ${FONT}`; g.textAlign = 'left';
    g.fillText('Vise une ligne et clique pour acheter  ·  E pour quitter le terminal', 44, H - 30);

    // ——— Curseur ———
    if (docked && this.cursor) {
      g.strokeStyle = C.cream; g.lineWidth = 3;
      g.beginPath(); g.arc(this.cursor.x, this.cursor.y, 9, 0, Math.PI * 2); g.stroke();
      g.fillStyle = C.cream; g.beginPath(); g.arc(this.cursor.x, this.cursor.y, 2.5, 0, Math.PI * 2); g.fill();
    }

    // ——— Veille : vu de loin, l'écran invite à approcher ———
    if (!docked) {
      g.fillStyle = 'rgba(29,15,34,0.78)';
      g.fillRect(14, 14, W - 28, H - 28);
      g.textAlign = 'center';
      g.fillStyle = C.cream; g.font = `700 120px ${FONT}`;
      g.fillText('TERMINAL', W / 2, H / 2 - 40);
      g.font = `600 44px ${FONT}`;
      if (afford > 0) {
        g.fillStyle = C.amber;
        g.fillText(`${afford} amélioration${afford > 1 ? 's' : ''} disponible${afford > 1 ? 's' : ''}`, W / 2, H / 2 + 50);
      } else {
        g.fillStyle = C.dim;
        g.fillText('Récolte des éclats pour améliorer', W / 2, H / 2 + 50);
      }
      g.fillStyle = C.dim; g.font = `500 34px ${FONT}`;
      g.fillText('Approche et appuie sur  E', W / 2, H / 2 + 130);
      g.textAlign = 'left';
    }
    this.tex.needsUpdate = true;
  }

  private drawFamily(s: GameState, _time: number): void {
    const g = this.ctx;
    const fam = FAMILIES[this.tab].id;
    const list = UPGRADES.filter((u) => u.family === fam);
    const x0 = 44, y0 = 172, rowW = 960, rowH = 98, gap = 8;
    list.forEach((u, i) => {
      const y = y0 + i * (rowH + gap);
      const level = lvl(s, u.id), block = buyBlock(s, u.id), cost = costOf(s, u.id);
      const r: Region = { x: x0, y, w: rowW, h: rowH, action: { type: 'buy', id: u.id }, upgrade: u };
      this.regions.push(r);
      const hov = this.hover?.upgrade === u;
      const flash = this.flashId === u.id ? this.flashT : 0;
      const deny = this.denyId === u.id ? this.denyT : 0;
      g.save();
      g.translate(deny > 0 ? Math.sin(deny * 30) * 7 * deny : 0, 0);
      g.fillStyle = hov ? 'rgba(247,227,184,0.17)' : 'rgba(247,227,184,0.07)';
      g.beginPath(); g.roundRect(x0, y, rowW, rowH, 12); g.fill();
      if (hov) { g.strokeStyle = block === null ? C.amber : C.faint; g.lineWidth = 3; g.stroke(); }
      if (flash > 0) { g.fillStyle = `rgba(255,184,31,${flash * 0.55})`; g.beginPath(); g.roundRect(x0, y, rowW, rowH, 12); g.fill(); }
      this.icon(u.icon, x0 + 10, y + 9, 80, block === 'locked' ? 0.4 : 1);
      g.fillStyle = C.cream; g.font = `700 30px ${FONT}`;
      g.fillText(u.name, x0 + 108, y + 40);
      const nameW = g.measureText(u.name).width;
      g.fillStyle = C.dim; g.font = `600 20px ${FONT}`;
      g.fillText(`NIV. ${level}${u.max < 100 ? ' / ' + u.max : ''}`, x0 + 122 + nameW, y + 39);
      // Effet : maintenant → ensuite.
      g.font = `500 23px ${FONT}`;
      const now = u.fx(level);
      g.fillStyle = C.rose;
      g.fillText(now, x0 + 108, y + 76);
      if (level < u.max) {
        const wNow = g.measureText(now).width;
        g.fillStyle = C.faint; g.fillText('→', x0 + 118 + wNow, y + 76);
        g.fillStyle = C.cream; g.fillText(u.fx(level + 1), x0 + 148 + wNow, y + 76);
      }
      // Bouton de coût.
      const bw = 190, bh = 58, bx = x0 + rowW - bw - 16, by = y + (rowH - bh) / 2;
      g.beginPath(); g.roundRect(bx, by, bw, bh, 10);
      g.textAlign = 'center';
      if (block === 'max') {
        g.fillStyle = 'rgba(247,227,184,0.1)'; g.fill();
        g.fillStyle = C.dim; g.font = `700 24px ${FONT}`; g.fillText('MAX', bx + bw / 2, by + 38);
      } else if (block === null) {
        g.fillStyle = C.amber; g.fill();
        g.fillStyle = C.plum; g.font = `700 28px ${FONT}`; g.fillText(fmt(cost), bx + bw / 2, by + 39);
      } else {
        g.fillStyle = 'rgba(247,227,184,0.08)'; g.fill();
        g.strokeStyle = C.faint; g.lineWidth = 2; g.stroke();
        g.fillStyle = C.dim; g.font = `700 28px ${FONT}`; g.fillText(fmt(cost), bx + bw / 2, by + 39);
        // Jauge : où on en est par rapport au coût.
        const pr = Math.min(1, s.shards / cost);
        g.fillStyle = C.terra; g.beginPath(); g.roundRect(bx + 6, by + bh - 9, (bw - 12) * pr, 4, 2); g.fill();
      }
      g.textAlign = 'left';
      g.restore();
    });

    // ——— Panneau de détail : jamais un chiffre sans explication ———
    const px = 1034, py = 172, pw = 458, ph = 628;
    g.fillStyle = 'rgba(247,227,184,0.06)';
    g.beginPath(); g.roundRect(px, py, pw, ph, 14); g.fill();
    const u = this.hover?.upgrade;
    if (!u) {
      const st = derive(s);
      g.fillStyle = C.dim; g.font = `600 22px ${FONT}`;
      g.fillText('TES ÉCHOS', px + 28, py + 46);
      g.fillStyle = C.teal; g.font = `700 64px ${FONT}`;
      g.fillText(`${s.echoes.length} / ${st.slots}`, px + 28, py + 116);
      g.fillStyle = C.cream; g.font = `500 24px ${FONT}`;
      let y = this.wrap(`Chaque écho rejoue une de tes boucles et rapporte ${Math.round(st.efficiency * 100)} % de son butin à chaque rejeu.`, px + 28, py + 164, pw - 56, 32);
      y += 14;
      g.fillStyle = C.dim;
      y = this.wrap('Améliore ton arme, puis enregistre une meilleure boucle : elle remplacera ton écho le plus faible.', px + 28, y, pw - 56, 32);
      y += 28;
      g.fillStyle = C.dim; g.font = `600 22px ${FONT}`;
      g.fillText('MEILLEURE BOUCLE', px + 28, y);
      g.fillStyle = C.amber; g.font = `700 44px ${FONT}`;
      g.fillText(`${fmt(s.bestLoop)} éclats`, px + 28, y + 52);
      if (s.fragments > 0) {
        g.fillStyle = C.dim; g.font = `600 22px ${FONT}`;
        g.fillText('FRAGMENTS TEMPORELS', px + 28, y + 110);
        g.fillStyle = C.cream; g.font = `700 36px ${FONT}`;
        g.fillText(`${fmt(s.fragments)}  ·  gains ×${st.globalMult.toFixed(1).replace('.', ',')}`, px + 28, y + 154);
      }
      return;
    }
    const level = lvl(s, u.id), block = buyBlock(s, u.id);
    this.icon(u.icon, px + 28, py + 28, 120);
    g.fillStyle = C.cream; g.font = `700 34px ${FONT}`;
    this.wrap(u.name, px + 168, py + 74, pw - 190, 38);
    g.fillStyle = C.dim; g.font = `600 22px ${FONT}`;
    g.fillText(`Niveau ${level}${u.max < 100 ? ' sur ' + u.max : ''}`, px + 168, py + 136);
    g.fillStyle = C.cream; g.font = `500 25px ${FONT}`;
    let y = this.wrap(u.desc, px + 28, py + 200, pw - 56, 34);
    y += 22;
    g.fillStyle = C.dim; g.font = `600 20px ${FONT}`; g.fillText('MAINTENANT', px + 28, y);
    g.fillStyle = C.rose; g.font = `600 28px ${FONT}`; y = this.wrap(u.fx(level), px + 28, y + 36, pw - 56, 34);
    if (level < u.max) {
      y += 14;
      g.fillStyle = C.dim; g.font = `600 20px ${FONT}`; g.fillText('AU NIVEAU SUIVANT', px + 28, y);
      g.fillStyle = C.cream; g.font = `600 28px ${FONT}`; y = this.wrap(u.fx(level + 1), px + 28, y + 36, pw - 56, 34);
    }
    g.font = `600 24px ${FONT}`;
    const cost = costOf(s, u.id);
    const msg = block === 'max' ? 'Niveau maximum atteint.'
      : block === 'locked' ? `Nécessite ${UPGRADE_BY_ID[u.req![0]].name} niveau ${u.req![1]}.`
      : block === 'poor' ? `Il te manque ${fmt(Math.ceil(cost - s.shards))} éclats.`
      : `Clique pour acheter : ${fmt(cost)} éclats.`;
    g.fillStyle = block === null ? C.amber : C.dim;
    this.wrap(msg, px + 28, py + ph - 34, pw - 56, 30);
  }

  private drawPrestige(s: GameState): void {
    const g = this.ctx;
    const pv = prestigePreview(s);
    const x = 44, y = 180, w = W - 88;
    g.fillStyle = 'rgba(247,227,184,0.06)';
    g.beginPath(); g.roundRect(x, y, w, 610, 14); g.fill();
    this.icon(17, x + 36, y + 36, 150);
    g.fillStyle = C.cream; g.font = `700 52px ${FONT}`;
    g.fillText('L\'EFFONDREMENT', x + 220, y + 92);
    g.fillStyle = C.dim; g.font = `500 26px ${FONT}`;
    this.wrap('Condense tous tes échos en Fragments temporels. Tu recommences de zéro (éclats, améliorations, échos), mais chaque Fragment multiplie tous tes gains pour toujours, et tu choisis un bonus permanent parmi trois.', x + 220, y + 136, w - 260, 36);

    const bx = x + 36, by = y + 300, bw = w - 72;
    if (!pv.available) {
      g.fillStyle = C.cream; g.font = `600 30px ${FONT}`;
      g.fillText(`Encore ${fmt(Math.ceil(pv.missing))} éclats à récolter dans cette partie pour le déclencher.`, bx, by);
      g.fillStyle = 'rgba(247,227,184,0.12)'; g.beginPath(); g.roundRect(bx, by + 30, bw, 34, 17); g.fill();
      g.fillStyle = C.amber; g.beginPath(); g.roundRect(bx, by + 30, Math.max(34, bw * pv.progress), 34, 17); g.fill();
      g.fillStyle = C.dim; g.font = `500 24px ${FONT}`;
      g.fillText(`${Math.floor(pv.progress * 100)} %  ·  récoltés dans cette partie : ${fmt(Math.floor(s.runEarned))}`, bx, by + 104);
      return;
    }
    // Avant / après, chiffré.
    const col = (cx: number, title: string, frag: number, mult: number, color: string) => {
      g.textAlign = 'center';
      g.fillStyle = C.dim; g.font = `600 22px ${FONT}`; g.fillText(title, cx, by - 6);
      g.fillStyle = color; g.font = `700 76px ${FONT}`; g.fillText(`×${mult.toFixed(1).replace('.', ',')}`, cx, by + 74);
      g.fillStyle = C.dim; g.font = `500 24px ${FONT}`; g.fillText(`${fmt(frag)} Fragment${frag > 1 ? 's' : ''}`, cx, by + 112);
      g.textAlign = 'left';
    };
    col(x + w * 0.2, 'AVANT', pv.fragmentsBefore, pv.multBefore, C.rose);
    g.fillStyle = C.faint; g.font = `700 70px ${FONT}`; g.textAlign = 'center'; g.fillText('→', x + w * 0.36, by + 70); g.textAlign = 'left';
    col(x + w * 0.52, 'APRÈS', pv.fragmentsAfter, pv.multAfter, C.amber);
    const btn: Region = { x: x + w * 0.68, y: by - 10, w: w * 0.28, h: 120, action: { type: 'prestige' } };
    this.regions.push(btn);
    const hov = this.hover?.action.type === 'prestige';
    g.fillStyle = hov ? '#ffd166' : C.amber;
    g.beginPath(); g.roundRect(btn.x, btn.y, btn.w, btn.h, 14); g.fill();
    g.fillStyle = C.plum; g.textAlign = 'center';
    g.font = `700 34px ${FONT}`; g.fillText('DÉCLENCHER', btn.x + btn.w / 2, btn.y + 54);
    g.font = `600 24px ${FONT}`; g.fillText(`+${fmt(pv.gain)} Fragments`, btn.x + btn.w / 2, btn.y + 92);
    g.textAlign = 'left';
    g.fillStyle = C.dim; g.font = `500 24px ${FONT}`;
    g.fillText(`Tu perdras : ${pv.echoesLost} échos (+${fmtRate(pv.rateBefore)}/s), tes éclats et tes améliorations. Rien n'est déclenché avant ta confirmation.`, bx, by + 200);
  }
}
