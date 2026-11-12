/**
 * HUD minimal : éclats + taux, nombre d'échos, anneau de boucle autour du viseur,
 * combo, info-bulle contextuelle, bannière de fin de boucle, objectif en cours.
 */
import { fmt, fmtRate } from '../core/util';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const ARC = 2 * Math.PI * 40;

export class Hud {
  private root = $('#hud');
  private count = $('#shard-count');
  private shardsEl = $('#wallet .shards');
  private rate = $('#rate-line');
  private echo = $('#echo-line');
  private arc = document.querySelector<SVGCircleElement>('#loop-arc')!;
  private reticle = $('#reticle');
  private loopTime = $('#loop-time');
  private tally = $('#loop-tally');
  private combo = $('#combo');
  private comboB = $('#combo b');
  private comboBar = $('#combo i');
  private tooltip = $('#tooltip');
  private banner = $('#banner');
  private hitmark = $('#hitmark');
  private toasts = $('#toasts');
  private obj = $('#objective');
  private objText = $('#objective .obj-text');
  private objHint = $('#objective .obj-hint');
  private objBar = $('#objective .obj-bar i');
  private shown = 0;
  private loadoutEl = $('#loadout');
  private lastLoadout = '';
  private lastText = { count: '', rate: '', echo: '', tally: '', tip: '', time: '', combo: 0, obj: '' };

  setVisible(on: boolean): void { this.root.classList.toggle('hidden', !on); }

  /** Le compteur affiché rattrape la vraie valeur : les gains « défilent ». */
  wallet(dt: number, shards: number, rate: number, echoes: number, slots: number): void {
    const diff = shards - this.shown;
    this.shown = Math.abs(diff) < 0.5 ? shards : this.shown + diff * Math.min(1, dt * 10);
    const t = fmt(Math.floor(this.shown + 1e-6));
    if (t !== this.lastText.count) { this.count.textContent = t; this.lastText.count = t; }
    const r = rate > 0 ? `+${fmtRate(rate)} éclats/s grâce à tes échos` : 'Aucun écho : termine une boucle';
    if (r !== this.lastText.rate) { this.rate.textContent = r; this.lastText.rate = r; }
    const e = `Échos : ${echoes} / ${slots}`;
    if (e !== this.lastText.echo) { this.echo.textContent = e; this.lastText.echo = e; }
  }

  snapWallet(shards: number): void { this.shown = shards; }

  pulseWallet(): void {
    this.shardsEl.classList.remove('pulse');
    void this.shardsEl.offsetWidth;
    this.shardsEl.classList.add('pulse');
  }

  /** Anneau autour du viseur : temps restant de la boucle. */
  loop(progress: number, remaining: number, running: boolean, docked: boolean): void {
    this.arc.style.strokeDashoffset = String(ARC * (running ? progress : 0));
    this.reticle.classList.toggle('urgent', running && remaining <= 3);
    this.reticle.classList.toggle('idle', !running);
    this.reticle.classList.toggle('docked', docked);
    const t = running ? remaining.toFixed(1).replace('.', ',') + ' s' : '';
    if (t !== this.lastText.time) { this.loopTime.textContent = t; this.lastText.time = t; }
  }

  /** Sous le viseur : ce que la boucle en cours a déjà récolté, et ce qu'il faut battre. */
  loopTally(shards: number, toBeat: number | null, show: boolean): void {
    let html = '';
    if (show) {
      html = `Cette boucle : <b>${fmt(shards)}</b> éclats`;
      if (toBeat !== null) html += shards > toBeat ? ` · <span class="beat">écho le plus faible battu !</span>` : ` · à battre : ${fmt(toBeat)}`;
    }
    if (html !== this.lastText.tally) { this.tally.innerHTML = html; this.lastText.tally = html; }
  }

  setCombo(combo: number, timeFrac: number, mult: number): void {
    if (combo < 2) { if (this.lastText.combo !== 0) { this.combo.classList.add('hidden'); this.lastText.combo = 0; } return; }
    if (combo !== this.lastText.combo) {
      this.combo.classList.remove('hidden', 'bump');
      void this.combo.offsetWidth;
      this.combo.classList.add('bump');
      this.comboB.textContent = `×${mult.toFixed(1).replace('.', ',')}`;
      this.lastText.combo = combo;
    }
    this.comboBar.style.transform = `scaleX(${Math.max(0, timeFrac).toFixed(3)})`;
  }

  onTarget(on: boolean): void { this.reticle.classList.toggle('on-target', on); }

  hit(kill: boolean): void {
    this.hitmark.classList.remove('hit', 'kill');
    void this.hitmark.offsetWidth;
    this.hitmark.classList.add(kill ? 'kill' : 'hit');
  }

  tip(html: string): void {
    if (html === this.lastText.tip) return;
    this.lastText.tip = html;
    this.tooltip.classList.toggle('hidden', !html);
    this.tooltip.innerHTML = html;
  }

  showBanner(title: string, sub: string, cls: 'good' | 'great' | 'bad'): void {
    this.banner.className = cls;
    $('#banner .b-title').textContent = title;
    $('#banner .b-sub').textContent = sub;
    // Relance l'animation CSS.
    this.banner.style.animation = 'none';
    void this.banner.offsetWidth;
    this.banner.style.animation = '';
  }

  toast(text: string): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild!.remove();
    setTimeout(() => el.remove(), 4100);
  }

  objective(text: string, hint: string, progress: number): void {
    const key = text + '|' + hint;
    if (key !== this.lastText.obj) {
      this.lastText.obj = key;
      this.obj.classList.toggle('hidden', !text);
      this.objText.textContent = text;
      this.objHint.textContent = hint;
    }
    this.objBar.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
  }

  /** Arme et élément en main (en bas à gauche). Vide = masqué. */
  loadout(html: string): void {
    if (html === this.lastLoadout) return;
    this.lastLoadout = html;
    this.loadoutEl.classList.toggle('hidden', !html);
    this.loadoutEl.innerHTML = html;
  }

  objectiveDone(): void {
    this.obj.classList.remove('done');
    void this.obj.offsetWidth;
    this.obj.classList.add('done');
  }
}
