/// <reference types="node" />
/**
 * Simulation d'équilibrage d'ÉCHO (« npm run sim »).
 *
 * Simule une partie complète depuis `newState()` jusqu'au premier Effondrement disponible
 * (plafond : 90 min simulées), avec un bot « joueur moyen » (src/sim/bot.ts) qui joue
 * réellement chaque boucle, puis vérifie les critères d'équilibrage sur 3 graines.
 *
 * Modèle de temps
 *  - une boucle jouée dure stats.duration + CFG.loop.rewindTime secondes réelles ;
 *  - les éclats récoltés × globalMult sont crédités à la fin de la boucle ;
 *  - les échos produisent en continu (tickEchoes) ;
 *  - une visite au terminal coûte une boucle entière non jouée (les échos tournent toujours).
 *
 * Heuristique d'achat (gloutonne)
 *  - Revenu projeté d'un état : R = butin × mult × (1 / durée réelle + emplacements × efficacité / durée),
 *    c.-à-d. le revenu actif plus celui des échos une fois tous ré-enregistrés. Le « butin » est
 *    celui que le bot obtient réellement avec ces niveaux (moyenne de deux boucles d'essai).
 *  - Gain d'une amélioration = R(état + k niveaux) − R(état), pour k = 1 à LOOKAHEAD (certains
 *    niveaux ne paient qu'à un seuil : un tir de moins par géode). On achète, parmi les achats
 *    abordables dont le gain est positif, celui au meilleur rapport gain / coût, et on recommence
 *    tant qu'il reste quelque chose d'utile.
 *  - Tant qu'une zone reste à débloquer, un achat doit s'amortir en moins de PAYBACK_MAX ; après la
 *    dernière zone, les éclats n'ont plus d'autre usage : tout gain positif est bon à prendre.
 *  - « zone » (nouveau contenu) est achetée dès qu'elle est abordable ; quand son coût est à
 *    moins de ZONE_SAVE × les éclats actuels, le bot n'achète plus rien d'autre : il économise.
 *  - « offline » ne rapporte rien pendant une session active : le bot ne l'achète jamais.
 *
 * Options : --seeds=11,23,37  --quiet (tableau final seulement)  --max=90 (plafond en minutes)
 */
import { CFG, UPGRADES, UPGRADE_BY_ID, type Family } from '../src/config';
import { decodeRecording, encodeRecording, replay } from '../src/echo/recording';
import {
  buy, buyBlock, costAt, costOf, derive, earn, loopParams, lvl, newState, prestigePreview, submitLoop,
  tickEchoes, totalRate, type GameState,
} from '../src/economy/state';
import { bestLoop } from '../src/sim/bot';
import { ZONE_NAMES } from '../src/world/layout';

const args = process.argv.slice(2);
const argVal = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const QUIET = args.includes('--quiet');
const SEEDS = (argVal('seeds') ?? '11,23,37').split(',').map(Number);
const MAX_MIN = Number(argVal('max') ?? 90);

// ——— Surcharges d'essai : --set=echo.baseEfficiency=0.1,slots.growth=2,geodes.zoneValue.1=5 ———
// « <id d'amélioration>.<champ> » ou un chemin dans CFG. Sert à explorer un réglage sans toucher à
// src/config.ts ; le verdict affiché ne vaut alors que pour cet essai.
const SET_ARG = args.find((a) => a.startsWith('--set='));
if (SET_ARG) {
  for (const item of SET_ARG.slice(6).split(',')) {
    const eq = item.lastIndexOf('=');
    const path = item.slice(0, eq).split('.');
    const value = Number(item.slice(eq + 1));
    let obj: any = UPGRADE_BY_ID[path[0]] ? UPGRADE_BY_ID : CFG;
    for (let i = 0; i < path.length - 1; i++) obj = obj?.[path[i]];
    const last = path[path.length - 1];
    if (eq < 0 || !obj || typeof obj[last] !== 'number' || !isFinite(value)) {
      throw new Error(`--set : « ${item} » ne désigne pas un nombre de la configuration`);
    }
    obj[last] = value;
  }
  console.log(`⚠ Essai avec surcharges (src/config.ts inchangé) : ${SET_ARG.slice(6)}`);
}

/** Une amélioration doit se rembourser en moins de ce temps pour être jugée utile. */
const PAYBACK_MAX = 30 * 60;
/** Le bot économise pour « zone » quand son coût est à moins de ce multiple de ses éclats. */
const ZONE_SAVE = 3;
/** Graines des boucles d'essai servant à estimer le butin d'un état. */
const EVAL_SEEDS = [9001, 9002];
/**
 * Un niveau seul ne change parfois rien (un tir de moins pour casser une géode ne s'obtient qu'à
 * certains seuils de dégâts) : le bot évalue aussi l'achat de 2 ou 3 niveaux d'un coup.
 */
const LOOKAHEAD = 3;
const CHECK_EVERY = 120;

// ——— Estimation du revenu ———

const rawCache = new Map<string, number>();

/** Butin brut moyen que le bot tire d'une boucle avec ces niveaux. */
function expectedRaw(s: GameState): number {
  const key = `${JSON.stringify(loopParams(s))}|${derive(s).fireRate}`;
  let v = rawCache.get(key);
  if (v === undefined) {
    v = 0;
    for (const seed of EVAL_SEEDS) v += bestLoop(s, seed).result.shards;
    v /= EVAL_SEEDS.length;
    rawCache.set(key, v);
  }
  return v;
}

/** Revenu projeté (éclats/s) : actif + échos tous ré-enregistrés. */
function projectedRate(s: GameState): number {
  const st = derive(s);
  const raw = expectedRaw(s);
  return raw * st.globalMult * (1 / (st.duration + CFG.loop.rewindTime) + (st.slots * st.efficiency) / st.duration);
}

function withLevels(s: GameState, id: string, k: number): GameState {
  return { ...s, levels: { ...s.levels, [id]: lvl(s, id) + k } };
}

interface Purchase { t: number; id: string; level: number; cost: number }

/** Applique la règle gloutonne sur `s` (modifié) et retourne les achats faits. */
function shop(s: GameState, t: number): Purchase[] {
  const out: Purchase[] = [];
  const push = (id: string) => {
    const cost = costOf(s, id);
    buy(s, id);
    out.push({ t, id, level: lvl(s, id), cost });
  };
  for (;;) {
    if (buyBlock(s, 'zone') === null) { push('zone'); continue; }
    if (buyBlock(s, 'zone') === 'poor' && costOf(s, 'zone') <= ZONE_SAVE * s.shards) break; // on économise
    const base = projectedRate(s);
    // Tant qu'une zone reste à débloquer, on ne dépense pas dans ce qui se rembourse trop lentement ;
    // une fois la dernière zone achetée, les éclats ne servent plus qu'à ça : tout gain positif est bon.
    const zoneLeft = buyBlock(s, 'zone') !== 'max';
    let best = '', bestK = 0, bestRatio = 0;
    for (const u of UPGRADES) {
      if (u.id === 'zone' || u.id === 'offline' || u.id === 'w2' || u.family === 'element' || buyBlock(s, u.id) !== null) continue;
      let cost = 0;
      for (let k = 1; k <= LOOKAHEAD && lvl(s, u.id) + k <= u.max; k++) {
        cost += costAt(u.id, lvl(s, u.id) + k - 1);
        if (cost > s.shards) break;
        const gain = projectedRate(withLevels(s, u.id, k)) - base;
        if (gain <= 0 || (zoneLeft && cost / gain > PAYBACK_MAX)) continue;
        if (gain / cost > bestRatio) { bestRatio = gain / cost; best = u.id; bestK = k; }
      }
    }
    if (!best) break;
    for (let k = 0; k < bestK; k++) push(best);
  }
  return out;
}

function cloneState(s: GameState): GameState {
  return { ...s, levels: { ...s.levels }, echoes: s.echoes.slice(), perks: { ...s.perks } };
}

// ——— Une partie ———

interface Checkpoint { t: number; active: number; echo: number; echoes: number; slots: number; zone: number; earned: number }

interface GameReport {
  seed: number;
  purchases: Purchase[];
  checkpoints: Checkpoint[];
  firstAffordable: number;
  prestigeAt: number;
  fragments: number;
  zoneAtPrestige: number;
  echoesAtPrestige: number;
  longestGap: number;
  gapFrom: number;
  loops: number;
  visits: number;
  strategies: number[];
  replayMismatch: number;
  families: Record<Family, number>;
  fails: string[];
}

function cheapestCost(s: GameState): number {
  let c = Infinity;
  for (const u of UPGRADES) {
    const b = buyBlock(s, u.id);
    if (b === 'max' || b === 'locked') continue;
    c = Math.min(c, costOf(s, u.id));
  }
  return c;
}

function runGame(seed: number): GameReport {
  const s = newState(0);
  const rep: GameReport = {
    seed, purchases: [], checkpoints: [], firstAffordable: -1, prestigeAt: -1, fragments: 0,
    zoneAtPrestige: 0, echoesAtPrestige: 0, longestGap: 0, gapFrom: 0, loops: 0, visits: 0,
    strategies: [0, 0, 0, 0], replayMismatch: 0,
    families: { weapon: 0, loop: 0, arena: 0, magnet: 0, element: 0 }, fails: [],
  };
  let T = 0;
  let nextCheck = CHECK_EVERY;
  let winActive = 0, winTime = 0, lastActive = 0;
  const limit = MAX_MIN * 60;

  const afterStep = () => {
    if (rep.firstAffordable < 0 && s.shards >= cheapestCost(s)) rep.firstAffordable = T;
    while (T >= nextCheck) {
      if (winTime > 0) lastActive = winActive / winTime;
      rep.checkpoints.push({
        t: nextCheck, active: lastActive, echo: totalRate(s), echoes: s.echoes.length,
        slots: derive(s).slots, zone: lvl(s, 'zone'), earned: s.runEarned,
      });
      winActive = 0; winTime = 0;
      nextCheck += CHECK_EVERY;
    }
  };

  while (T < limit) {
    const st = derive(s);
    const real = st.duration + CFG.loop.rewindTime;
    const wants = s.shards > 0 && shop(cloneState(s), T).length > 0;
    if (wants) {
      // Visite au terminal : une boucle non jouée, puis les achats.
      tickEchoes(s, real);
      T += real;
      rep.visits++;
      for (const p of shop(s, T)) {
        rep.purchases.push(p);
        rep.families[UPGRADE_BY_ID[p.id].family]++;
      }
    } else {
      const loop = bestLoop(s, seed * 100003 + rep.loops);
      const raw = loop.result.shards;
      const enc = encodeRecording(loop.recording);
      if (replay(decodeRecording(enc)).result.shards !== raw) rep.replayMismatch++;
      tickEchoes(s, st.duration);
      T += st.duration;
      earn(s, raw * st.globalMult);
      if (rep.firstAffordable < 0 && s.shards >= cheapestCost(s)) rep.firstAffordable = T;
      submitLoop(s, raw, st.duration, enc);
      tickEchoes(s, CFG.loop.rewindTime);
      T += CFG.loop.rewindTime;
      rep.loops++;
      rep.strategies[loop.strategy]++;
      winActive += raw * st.globalMult;
      winTime += real;
    }
    afterStep();
    const pv = prestigePreview(s);
    if (pv.available) {
      rep.prestigeAt = T;
      rep.fragments = pv.gain;
      break;
    }
  }
  rep.zoneAtPrestige = lvl(s, 'zone');
  rep.echoesAtPrestige = s.echoes.length;

  // Plus long intervalle sans achat pendant les 15 premières minutes.
  const horizon = Math.min(15 * 60, T);
  let prev = 0;
  const times = rep.purchases.map((p) => p.t).filter((t) => t <= horizon);
  times.push(horizon);
  for (const t of times) {
    if (t - prev > rep.longestGap) { rep.longestGap = t - prev; rep.gapFrom = prev; }
    prev = t;
  }

  // ——— Critères ———
  if (rep.longestGap > 180) {
    rep.fails.push(`A : ${mmss(rep.longestGap)} sans achat à partir de ${mmss(rep.gapFrom)} (maximum 3:00 pendant les 15 premières minutes)`);
  }
  if (rep.prestigeAt < 0) rep.fails.push(`B : aucun Effondrement disponible en ${MAX_MIN} min (attendu entre 30 et 45 min)`);
  else if (rep.prestigeAt < 30 * 60 || rep.prestigeAt > 45 * 60) {
    rep.fails.push(`B : premier Effondrement à ${mmss(rep.prestigeAt)} (attendu entre 30:00 et 45:00)`);
  }
  for (const c of rep.checkpoints) {
    if (c.t <= 600 && c.echo > c.active) {
      rep.fails.push(`C : à ${mmss(c.t)}, les échos (${c.echo.toFixed(1)}/s) dépassent le revenu actif (${c.active.toFixed(1)}/s)`);
    }
  }
  if (rep.prestigeAt >= 0) {
    if (rep.zoneAtPrestige < 2) rep.fails.push(`D : zone ${rep.zoneAtPrestige} (${ZONE_NAMES[rep.zoneAtPrestige]}) au prestige, il faut au moins la zone 2 (${ZONE_NAMES[2]})`);
    if (rep.echoesAtPrestige < 8) rep.fails.push(`D : ${rep.echoesAtPrestige} échos au prestige (minimum 8)`);
  }
  if (rep.firstAffordable < 0 || rep.firstAffordable >= 45) {
    rep.fails.push(`E : première amélioration achetable à ${rep.firstAffordable < 0 ? 'jamais' : rep.firstAffordable.toFixed(1) + ' s'} (maximum 45 s)`);
  }
  if (rep.replayMismatch > 0) rep.fails.push(`BUG : ${rep.replayMismatch} boucle(s) dont le rejeu ne redonne pas le même butin`);
  return rep;
}

// ——— Affichage ———

function mmss(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
function num(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n).toString();
}
const pad = (v: string | number, n: number) => v.toString().padEnd(n);
const padL = (v: string | number, n: number) => v.toString().padStart(n);

function printReport(r: GameReport): void {
  console.log(`\n════════ Graine ${r.seed} ════════`);
  console.log('Chronologie des achats (minute  id→niveau (coût)) :');
  let line = '', lineT = -1;
  const flush = () => { if (line) console.log(`  ${padL(mmss(lineT), 5)}  ${line}`); line = ''; };
  for (const p of r.purchases) {
    if (p.t !== lineT) { flush(); lineT = p.t; }
    line += `${p.id}→${p.level} (${num(p.cost)})  `;
  }
  flush();
  console.log('\nRevenus toutes les 2 min :');
  console.log(`  ${pad('min', 5)}${padL('actif/s', 10)}${padL('échos/s', 10)}${padL('échos', 8)}${padL('zone', 6)}${padL('gagné', 10)}`);
  for (const c of r.checkpoints) {
    console.log(`  ${pad(c.t / 60, 5)}${padL(c.active.toFixed(1), 10)}${padL(c.echo.toFixed(1), 10)}${padL(`${c.echoes}/${c.slots}`, 8)}${padL(c.zone, 6)}${padL(num(c.earned), 10)}`);
  }
  console.log(`\nBoucles jouées : ${r.loops} (par stratégie de zone : ${r.strategies.join(' / ')}), visites au terminal : ${r.visits}`);
  console.log(`Achats par famille : arme ${r.families.weapon}, boucle ${r.families.loop}, arène ${r.families.arena}, aimant ${r.families.magnet}`);
  console.log(`Première amélioration achetable : ${r.firstAffordable < 0 ? 'jamais' : r.firstAffordable.toFixed(1) + ' s'}`);
  console.log(`Plus long intervalle sans achat (15 premières min) : ${mmss(r.longestGap)} (à partir de ${mmss(r.gapFrom)})`);
  console.log(r.prestigeAt < 0
    ? `Effondrement : pas disponible en ${MAX_MIN} min`
    : `Premier Effondrement disponible : ${mmss(r.prestigeAt)} → ${r.fragments} Fragments (zone ${r.zoneAtPrestige}, ${r.echoesAtPrestige} échos)`);
  for (const f of r.fails) console.log(`  ✗ ${f}`);
}

const reports = SEEDS.map((seed) => {
  const r = runGame(seed);
  if (!QUIET) printReport(r);
  return r;
});

console.log('\n════════ Récapitulatif ════════');
console.log(`${pad('graine', 8)}${pad('1er achat', 11)}${pad('trou max', 10)}${pad('prestige', 10)}${pad('fragm.', 8)}${pad('zone', 6)}${pad('échos', 7)}${pad('achats A/B/Ar/Ai', 18)}${pad('C max', 8)}verdict`);
let failed = false;
for (const r of reports) {
  const cMax = Math.max(0, ...r.checkpoints.filter((c) => c.t <= 600).map((c) => (c.active > 0 ? c.echo / c.active : Infinity)));
  const ok = r.fails.length === 0;
  if (!ok) failed = true;
  console.log(
    pad(r.seed, 8) + pad(r.firstAffordable < 0 ? '—' : r.firstAffordable.toFixed(1) + ' s', 11) + pad(mmss(r.longestGap), 10)
    + pad(r.prestigeAt < 0 ? '—' : mmss(r.prestigeAt), 10) + pad(r.fragments, 8) + pad(r.zoneAtPrestige, 6) + pad(r.echoesAtPrestige, 7)
    + pad(`${r.families.weapon}/${r.families.loop}/${r.families.arena}/${r.families.magnet}`, 18)
    + pad(cMax.toFixed(2), 8) + (ok ? 'OK' : 'ÉCHEC'),
  );
}
console.log('(C max = plus grand rapport échos / actif aux points de contrôle des 10 premières minutes ; doit rester ≤ 1)');
if (failed) {
  console.log('\nCritères en échec :');
  for (const r of reports) for (const f of r.fails) console.log(`  graine ${r.seed} — ${f}`);
  process.exit(1);
}
console.log(`
Tous les critères passent (A, B, C, D, E) sur les ${reports.length} graines.`);
