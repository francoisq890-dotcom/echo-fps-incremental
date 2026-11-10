/**
 * Écrans plein cadre : titre, pause/réglages (export/import), retour hors ligne, Effondrement.
 */
import { fmt, fmtDuration, fmtRate } from '../core/util';
import { derive, perk, perkChoices, prestigePreview, totalRate, type GameState, type OfflineReport } from '../economy/state';
import { exportSave, importSave } from '../economy/save';

const root = () => document.querySelector<HTMLElement>('#overlay')!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function closeOverlay(): void {
  const r = root();
  r.className = 'hidden';
  r.innerHTML = '';
}

export function overlayOpen(): boolean {
  return !root().classList.contains('hidden');
}

function open(html: string, cls = ''): HTMLElement {
  const r = root();
  r.className = cls;
  r.innerHTML = html;
  return r;
}

export function showTitle(hasSave: boolean, touch: boolean, onPlay: () => void, onNew: () => void): void {
  const r = open(`
    <div class="title-wrap">
      <div class="logo" data-text="ÉCHO">ÉCHO</div>
      <div class="tagline">Joue une boucle de 12 secondes. Ton écho la rejouera pour toujours.</div>
      <div class="row">
        <button class="btn primary" id="t-play">${hasSave ? 'CONTINUER' : 'JOUER'}</button>
        ${hasSave ? '<button class="btn" id="t-new">NOUVELLE PARTIE</button>' : ''}
      </div>
      <div class="keys">${touch
        ? 'Joystick à gauche · glisse à droite pour viser · le tir part tout seul sur une géode'
        : '<kbd>Z</kbd><kbd>Q</kbd><kbd>S</kbd><kbd>D</kbd> / <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> bouger · <kbd>Souris</kbd> viser · <kbd>Clic</kbd> tirer · <kbd>Espace</kbd> sauter · <kbd>E</kbd> terminal · <kbd>Échap</kbd> pause'}</div>
    </div>`, 'title');
  r.querySelector('#t-play')!.addEventListener('click', onPlay);
  r.querySelector('#t-new')?.addEventListener('click', () => {
    if (confirm('Effacer la sauvegarde et recommencer de zéro ?')) onNew();
  });
}

export interface PauseHandlers {
  onResume: () => void;
  onSettings: () => void;
  onImport: (state: GameState) => void;
  onReset: () => void;
}

export function showPause(s: GameState, h: PauseHandlers): void {
  const st = s.settings;
  const r = open(`
    <div class="panel">
      <h1>PAUSE</h1>
      <p class="muted">Tes échos continuent de produire pendant la pause : +${fmtRate(totalRate(s))} éclats/s.</p>
      <h2>RÉGLAGES</h2>
      <div class="settings">
        <label>Volume</label><input type="range" id="s-vol" min="0" max="1" step="0.05" value="${st.volume}"><span id="v-vol"></span>
        <label>Musique</label><input type="range" id="s-mus" min="0" max="1" step="0.05" value="${st.music}"><span id="v-mus"></span>
        <label>Sensibilité souris</label><input type="range" id="s-sens" min="0.2" max="3" step="0.05" value="${st.sens}"><span id="v-sens"></span>
        <label>Secousses d'écran</label><input type="range" id="s-shake" min="0" max="1" step="0.1" value="${st.shake}"><span id="v-shake"></span>
        <label>Inverser l'axe Y</label><input type="checkbox" id="s-inv" ${st.invertY ? 'checked' : ''} style="justify-self:start;width:22px;height:22px"><span></span>
      </div>
      <h2>SAUVEGARDE</h2>
      <p class="muted">Sauvegarde automatique toutes les 10 s. Exporte ce texte pour changer d'appareil.</p>
      <textarea class="save" id="save-text" spellcheck="false" placeholder="Colle ici une sauvegarde exportée, puis clique sur Importer."></textarea>
      <div class="msg" id="save-msg"></div>
      <div class="row">
        <button class="btn" id="p-export">EXPORTER</button>
        <button class="btn" id="p-import">IMPORTER</button>
        <button class="btn danger" id="p-reset">TOUT EFFACER</button>
      </div>
      <div class="row"><button class="btn primary" id="p-resume">REPRENDRE</button></div>
    </div>`);
  const q = <T extends HTMLElement>(id: string) => r.querySelector<T>(id)!;
  const bind = (id: string, key: 'volume' | 'music' | 'sens' | 'shake', out: string, pctFmt: boolean) => {
    const input = q<HTMLInputElement>(id), label = q(out);
    const show = () => (label.textContent = pctFmt ? `${Math.round(+input.value * 100)} %` : `×${(+input.value).toFixed(2).replace('.', ',')}`);
    show();
    input.addEventListener('input', () => { st[key] = +input.value; show(); h.onSettings(); });
  };
  bind('#s-vol', 'volume', '#v-vol', true);
  bind('#s-mus', 'music', '#v-mus', true);
  bind('#s-sens', 'sens', '#v-sens', false);
  bind('#s-shake', 'shake', '#v-shake', true);
  q<HTMLInputElement>('#s-inv').addEventListener('change', (e) => { st.invertY = (e.target as HTMLInputElement).checked; h.onSettings(); });
  const text = q<HTMLTextAreaElement>('#save-text'), msg = q('#save-msg');
  const say = (t: string, err = false) => { msg.textContent = t; msg.classList.toggle('err', err); };
  q('#p-export').addEventListener('click', async () => {
    text.value = exportSave(s);
    text.select();
    try { await navigator.clipboard.writeText(text.value); say('Sauvegarde copiée dans le presse-papiers.'); }
    catch { say('Sauvegarde affichée ci-dessus : copie le texte.'); }
  });
  q('#p-import').addEventListener('click', () => {
    try {
      const imported = importSave(text.value);
      say('Sauvegarde importée.');
      h.onImport(imported);
    } catch (e) { say((e as Error).message || 'Sauvegarde illisible', true); }
  });
  q('#p-reset').addEventListener('click', () => {
    if (confirm('Effacer définitivement ta partie (éclats, échos, Fragments) ?')) h.onReset();
  });
  q('#p-resume').addEventListener('click', h.onResume);
}

export function showOffline(rep: OfflineReport, s: GameState, onClose: () => void): void {
  const capHours = Math.round(derive(s).offlineCapSec / 3600);
  const r = open(`
    <div class="panel">
      <h2 style="margin-top:0">PENDANT TON ABSENCE</h2>
      <p>Tu es parti ${esc(fmtDuration(rep.away))}. Tes <b style="color:var(--teal)">${rep.echoes} écho${rep.echoes > 1 ? 's' : ''}</b> ${rep.echoes > 1 ? 'ont' : 'a'} continué à rejouer tes boucles et ${rep.echoes > 1 ? 'ont' : 'a'} récolté :</p>
      <div class="big-number">+${fmt(rep.gain)} <span style="font-size:28px">éclats</span></div>
      <p class="muted">${rep.capped
        ? `Production comptée sur ${esc(fmtDuration(rep.counted))} : c'est le plafond hors ligne (${capHours} h). L'amélioration « Mémoire longue » (BOUCLE) l'augmente.`
        : `Production comptée sur toute ton absence. Plafond hors ligne actuel : ${capHours} h.`}</p>
      <div class="row"><button class="btn primary" id="o-ok">RÉCUPÉRER</button></div>
    </div>`);
  r.querySelector('#o-ok')!.addEventListener('click', onClose);
}

export function showPrestige(s: GameState, onConfirm: (perkId: string) => void, onCancel: () => void): void {
  const pv = prestigePreview(s);
  const st = derive(s);
  const choices = perkChoices(s);
  const m = (x: number) => x.toFixed(1).replace('.', ',');
  const r = open(`
    <div class="panel wide">
      <h1>L'EFFONDREMENT</h1>
      <p>Tes ${pv.echoesLost} échos se condensent en <b style="color:var(--amber)">${fmt(pv.gain)} Fragments temporels</b>. Chaque Fragment augmente tous tes gains de 20 %, pour toujours.</p>
      <div class="compare">
        <div class="col">
          <h3>AVANT</h3>
          <div class="mult">×${m(pv.multBefore)}</div>
          <ul>
            <li>${fmt(pv.fragmentsBefore)} Fragments</li>
            <li>${pv.echoesLost} échos · +${fmtRate(pv.rateBefore)}/s</li>
            <li>${fmt(Math.floor(s.shards))} éclats en poche</li>
            <li>${Object.values(s.levels).reduce((a, b) => a + b, 0)} niveaux d'améliorations</li>
          </ul>
        </div>
        <div class="arrow">→</div>
        <div class="col after">
          <h3>APRÈS</h3>
          <div class="mult">×${m(pv.multAfter)}</div>
          <ul>
            <li>${fmt(pv.fragmentsAfter)} Fragments <span class="muted">(+${fmt(pv.gain)})</span></li>
            <li>0 écho : à ré-enregistrer, chacun rapportera ×${m(pv.multAfter / pv.multBefore)}</li>
            <li>${perk(s, 'start') > 0 ? fmt(400 * perk(s, 'start') * pv.fragmentsAfter) : '0'} éclat en poche</li>
            <li>Améliorations remises à zéro</li>
          </ul>
        </div>
      </div>
      <h2>CHOISIS UN BONUS PERMANENT</h2>
      <div class="perks">
        ${choices.map((p) => `<button class="perk" data-id="${p.id}"><b>${esc(p.name)}</b><span>${esc(p.desc)}</span>${perk(s, p.id) > 0 ? `<small>Déjà possédé ×${perk(s, p.id)} : se cumule</small>` : ''}</button>`).join('')}
      </div>
      <div class="row">
        <button class="btn primary" id="pr-go" disabled>CHOISIS UN BONUS</button>
        <button class="btn" id="pr-no">PAS MAINTENANT</button>
      </div>
      <p class="muted" style="font-size:14px;margin-top:14px">Durée de boucle actuelle : ${st.duration} s · tu gardes tes Fragments, tes bonus et tes réglages.</p>
    </div>`);
  let chosen = '';
  const go = r.querySelector<HTMLButtonElement>('#pr-go')!;
  r.querySelectorAll<HTMLButtonElement>('.perk').forEach((b) => b.addEventListener('click', () => {
    chosen = b.dataset.id!;
    r.querySelectorAll('.perk').forEach((x) => x.classList.toggle('sel', x === b));
    go.disabled = false;
    go.textContent = 'DÉCLENCHER L\'EFFONDREMENT';
  }));
  go.addEventListener('click', () => chosen && onConfirm(chosen));
  r.querySelector('#pr-no')!.addEventListener('click', onCancel);
}
