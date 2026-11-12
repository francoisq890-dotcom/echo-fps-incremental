/// <reference types="node" />
/**
 * Diagnostic d'équilibrage des armes (« npx tsx scripts/weapon-compare.ts ») :
 * butin d'une boucle jouée par le bot à l'Éclateur puis au Fracasseur, pour plusieurs
 * étapes de partie typiques. Sert à régler CFG.w2 sans lancer la simulation complète.
 */
import { CFG } from '../src/config';
import { loopParams, derive, newState, type GameState } from '../src/economy/state';
import { playLoop } from '../src/sim/bot';

const STAGES: { name: string; levels: Record<string, number> }[] = [
  { name: 'début (3 min)', levels: { dmg: 3, rate: 2, mrad: 1, mspd: 1 } },
  { name: 'arène pleine (8 min)', levels: { dmg: 7, rate: 4, mrad: 3, mspd: 2, density: 3, mobile: 2 } },
  { name: 'terrasses (15 min)', levels: { dmg: 12, rate: 6, mrad: 5, mspd: 4, density: 5, mobile: 3, explosive: 2, armored: 2, zone: 1, rico: 1 } },
  { name: 'passerelles (25 min)', levels: { dmg: 20, rate: 9, mrad: 8, mspd: 6, density: 8, mobile: 4, explosive: 3, armored: 3, golden: 2, zone: 2, rico: 2, pierce: 1, chain: 2, dur: 2 } },
];
const SEEDS = [1, 2, 3, 4];

// --set=pellets=7,damage=0.5,fireRate=0.6 : essai de réglage de CFG.w2 sans modifier la config.
const set = process.argv.find((a) => a.startsWith('--set='));
if (set) for (const kv of set.slice(6).split(',')) { const [k, v] = kv.split('='); (CFG.w2 as any)[k] = Number(v); }

function avg(s: GameState, weapon: number): { shards: number; zone: number } {
  const p = loopParams(s), st = derive(s);
  let best = 0, total = 0, bz = 0;
  for (const seed of SEEDS) {
    best = 0;
    for (let z = 0; z <= p.zone; z++) {
      const r = playLoop(p, st, { seed: seed * 31 + z, maxZone: z, weapon });
      if (r.result.shards > best) { best = r.result.shards; bz = z; }
    }
    total += best;
  }
  return { shards: total / SEEDS.length, zone: bz };
}

console.log(`Fracasseur : ${CFG.w2.pellets} plombs × ${CFG.w2.damage}, cadence ×${CFG.w2.fireRate}, cône ${CFG.w2.spread} rad, chute ${CFG.w2.falloffStart}–${CFG.w2.falloffEnd} m\n`);
for (const st of STAGES) {
  const s = newState(0);
  s.levels = { ...st.levels };
  const a = avg(s, 0);
  const cells: string[] = [`${st.name.padEnd(22)} Éclateur ${a.shards.toFixed(0).padStart(6)}`];
  for (const l of [1, 3, 6]) {
    s.levels = { ...st.levels, w2: l };
    const b = avg(s, 1);
    cells.push(`Fracasseur niv.${l} ${b.shards.toFixed(0).padStart(6)} (${((b.shards / a.shards) * 100).toFixed(0)} %)`);
  }
  console.log(cells.join('  |  '));
}
