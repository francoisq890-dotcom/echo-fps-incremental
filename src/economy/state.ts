/**
 * État du jeu et règles d'économie (pures, sans rendu) :
 * coûts, achats, statistiques dérivées, échos et leur rendement, hors-ligne, prestige.
 */
import { CFG, PERKS, UPGRADES, UPGRADE_BY_ID, damageAt, type PerkDef } from '../config';
import { mulberry32 } from '../core/util';
import type { LoopParams } from '../echo/pattern';

export interface EchoSave {
  id: number;
  /** Éclats bruts récoltés pendant la boucle enregistrée. */
  raw: number;
  /** Durée de la boucle enregistrée, en secondes. */
  duration: number;
  /** Enregistrement encodé (voir echo/recording.ts). */
  rec: string;
}

export interface Settings { volume: number; music: number; sens: number; shake: number; invertY: boolean }

export interface GameState {
  v: number;
  shards: number;
  /** Éclats gagnés depuis le dernier Effondrement (sert au calcul des Fragments). */
  runEarned: number;
  totalEarned: number;
  levels: Record<string, number>;
  echoes: EchoSave[];
  nextEchoId: number;
  fragments: number;
  prestiges: number;
  perks: Record<string, number>;
  tutorial: number;
  /** Horodatage (ms) de la dernière sauvegarde, pour le calcul hors ligne. */
  lastSeen: number;
  playTime: number;
  runTime: number;
  loops: number;
  bestLoop: number;
  settings: Settings;
}

export function newState(now = Date.now()): GameState {
  return {
    v: CFG.version,
    shards: 0,
    runEarned: 0,
    totalEarned: 0,
    levels: {},
    echoes: [],
    nextEchoId: 1,
    fragments: 0,
    prestiges: 0,
    perks: {},
    tutorial: 0,
    lastSeen: now,
    playTime: 0,
    runTime: 0,
    loops: 0,
    bestLoop: 0,
    settings: { volume: 0.8, music: 0.5, sens: 1, shake: 1, invertY: false },
  };
}

export const lvl = (s: GameState, id: string) => s.levels[id] ?? 0;
export const perk = (s: GameState, id: string) => s.perks[id] ?? 0;

// ——— Coûts et achats ———

export function costAt(id: string, level: number): number {
  const u = UPGRADE_BY_ID[id];
  return Math.ceil(u.baseCost * Math.pow(u.growth, level));
}

export function costOf(s: GameState, id: string): number {
  return costAt(id, lvl(s, id));
}

export type BuyBlock = 'max' | 'locked' | 'poor' | null;

export function buyBlock(s: GameState, id: string): BuyBlock {
  const u = UPGRADE_BY_ID[id];
  if (lvl(s, id) >= u.max) return 'max';
  if (id === 'slots' && derive(s).slots >= CFG.echo.maxSlots) return 'max';
  if (u.req && lvl(s, u.req[0]) < u.req[1]) return 'locked';
  if (s.shards < costOf(s, id)) return 'poor';
  return null;
}

export function buy(s: GameState, id: string): boolean {
  if (buyBlock(s, id) !== null) return false;
  s.shards -= costOf(s, id);
  s.levels[id] = lvl(s, id) + 1;
  return true;
}

// ——— Statistiques dérivées ———

export interface Stats {
  damage: number;
  fireRate: number;
  duration: number;
  slots: number;
  /** Part du butin enregistré que chaque écho rapporte par rejeu. */
  efficiency: number;
  magnetRadius: number;
  magnetSpeed: number;
  magnetDelay: number;
  comboWindow: number;
  offlineCapSec: number;
  /** Multiplicateur global (Fragments) appliqué à tous les gains. */
  globalMult: number;
  /** Palier visuel de l'arme (0 à 4). */
  weaponTier: number;
}

export function prestigeMult(fragments: number): number {
  return 1 + CFG.prestige.multPerFragment * fragments;
}

export function derive(s: GameState): Stats {
  const W = CFG.weapon, M = CFG.magnet;
  const weaponLevels = lvl(s, 'dmg') + lvl(s, 'rate') + 3 * (lvl(s, 'rico') + lvl(s, 'pierce') + lvl(s, 'chain'));
  return {
    damage: damageAt(lvl(s, 'dmg')) * Math.pow(1.5, perk(s, 'dmg')),
    fireRate: W.baseFireRate * (1 + W.fireRatePerLevel * lvl(s, 'rate')),
    duration: CFG.loop.baseDuration + CFG.loop.durationPerLevel * lvl(s, 'dur'),
    slots: Math.min(CFG.echo.maxSlots, CFG.echo.baseSlots + lvl(s, 'slots') + 2 * perk(s, 'slots')),
    efficiency: CFG.echo.baseEfficiency * (1 + CFG.echo.efficiencyPerLevel * lvl(s, 'power')) * Math.pow(1.4, perk(s, 'echo')),
    magnetRadius: (M.baseRadius + M.radiusPerLevel * lvl(s, 'mrad')) * (1 + 0.4 * perk(s, 'magnet')),
    magnetSpeed: M.baseSpeed * Math.pow(M.speedGrowth, lvl(s, 'mspd')),
    magnetDelay: Math.max(0.1, M.baseDelay - M.delayPerLevel * lvl(s, 'mspd')),
    comboWindow: CFG.combo.window + perk(s, 'combo'),
    offlineCapSec: (CFG.offline.baseCapHours + CFG.offline.capHoursPerLevel * lvl(s, 'offline') + 6 * perk(s, 'offline')) * 3600,
    globalMult: prestigeMult(s.fragments),
    weaponTier: weaponLevels >= 60 ? 4 : weaponLevels >= 36 ? 3 : weaponLevels >= 18 ? 2 : weaponLevels >= 6 ? 1 : 0,
  };
}

/** Instantané des paramètres qui déterminent le résultat d'une boucle jouée maintenant. */
export function loopParams(s: GameState): LoopParams {
  const st = derive(s);
  return {
    seed: 1,
    duration: st.duration,
    zone: lvl(s, 'zone'),
    density: lvl(s, 'density'),
    mobile: lvl(s, 'mobile'),
    armored: lvl(s, 'armored'),
    golden: lvl(s, 'golden'),
    explosive: lvl(s, 'explosive'),
    damage: st.damage,
    rico: lvl(s, 'rico'),
    pierce: lvl(s, 'pierce'),
    chain: lvl(s, 'chain'),
    magnetRadius: Math.round(st.magnetRadius * 100) / 100,
    magnetSpeed: Math.round(st.magnetSpeed * 100) / 100,
    magnetDelay: Math.round(st.magnetDelay * 100) / 100,
    comboWindow: st.comboWindow,
    valueMult: 1 + 0.3 * perk(s, 'gold'),
  };
}

// ——— Gains ———

export function earn(s: GameState, amount: number): void {
  s.shards += amount;
  s.runEarned += amount;
  s.totalEarned += amount;
}

/** Éclats par seconde rapportés par un écho. */
export function echoRate(s: GameState, e: EchoSave, st: Stats = derive(s)): number {
  return (e.raw / e.duration) * st.efficiency * st.globalMult;
}

export function totalRate(s: GameState, st: Stats = derive(s)): number {
  let r = 0;
  for (const e of s.echoes) r += echoRate(s, e, st);
  return r;
}

/** Fait produire les échos pendant dt secondes. */
export function tickEchoes(s: GameState, dt: number): number {
  const gain = totalRate(s) * dt;
  if (gain > 0) earn(s, gain);
  return gain;
}

// ——— Échos : ajout, remplacement, rejet ———

export type LoopOutcome =
  | { kind: 'empty' }
  | { kind: 'added'; echo: EchoSave; rate: number }
  | { kind: 'replaced'; echo: EchoSave; rate: number; removedId: number; removedRate: number }
  | { kind: 'discarded'; rate: number; weakestRate: number };

/**
 * Propose une boucle terminée comme nouvel écho.
 * Emplacement libre → ajoutée. Sinon elle remplace l'écho le plus faible si elle fait mieux,
 * ou elle est jetée.
 */
export function submitLoop(s: GameState, raw: number, duration: number, rec: string): LoopOutcome {
  s.loops++;
  if (raw > s.bestLoop) s.bestLoop = raw;
  if (raw <= 0) return { kind: 'empty' };
  const st = derive(s);
  const candidate: EchoSave = { id: s.nextEchoId, raw, duration, rec };
  const rate = echoRate(s, candidate, st);
  // Si le nombre d'emplacements a baissé (import, prestige), on retire les plus faibles.
  while (s.echoes.length > st.slots) s.echoes.splice(weakestIndex(s), 1);
  if (s.echoes.length < st.slots) {
    s.nextEchoId++;
    s.echoes.push(candidate);
    return { kind: 'added', echo: candidate, rate };
  }
  const wi = weakestIndex(s);
  const weakest = s.echoes[wi];
  const weakestRate = echoRate(s, weakest, st);
  if (raw / duration > weakest.raw / weakest.duration) {
    s.nextEchoId++;
    s.echoes[wi] = candidate;
    return { kind: 'replaced', echo: candidate, rate, removedId: weakest.id, removedRate: weakestRate };
  }
  return { kind: 'discarded', rate, weakestRate };
}

export function weakestIndex(s: GameState): number {
  let wi = 0;
  for (let i = 1; i < s.echoes.length; i++) {
    if (s.echoes[i].raw / s.echoes[i].duration < s.echoes[wi].raw / s.echoes[wi].duration) wi = i;
  }
  return wi;
}

// ——— Hors ligne ———

export interface OfflineReport {
  /** Durée réelle de l'absence. */
  away: number;
  /** Durée effectivement comptée (plafonnée). */
  counted: number;
  capped: boolean;
  gain: number;
  echoes: number;
}

export function computeOffline(s: GameState, now: number): OfflineReport {
  const st = derive(s);
  const away = Math.max(0, (now - s.lastSeen) / 1000);
  const counted = Math.min(away, st.offlineCapSec);
  return {
    away,
    counted,
    capped: away > st.offlineCapSec,
    gain: Math.floor(totalRate(s, st) * counted),
    echoes: s.echoes.length,
  };
}

/** Crédite l'absence et remet l'horloge à maintenant. Retourne null si l'absence est trop courte. */
export function applyOffline(s: GameState, now: number): OfflineReport | null {
  const rep = computeOffline(s, now);
  s.lastSeen = now;
  if (rep.gain <= 0) return null;
  // Toute absence est créditée ; le seuil ne décide que de l'affichage de l'écran de retour.
  earn(s, rep.gain);
  return rep.away >= CFG.offline.minSeconds ? rep : null;
}

// ——— Prestige : l'Effondrement ———

export function fragmentsFor(runEarned: number): number {
  return Math.floor(Math.pow(Math.max(0, runEarned) / CFG.prestige.divisor, CFG.prestige.exponent));
}

/** Éclats à gagner dans la partie pour obtenir n Fragments. */
export function earnedForFragments(n: number): number {
  return Math.pow(n, 1 / CFG.prestige.exponent) * CFG.prestige.divisor;
}

export interface PrestigePreview {
  available: boolean;
  gain: number;
  fragmentsBefore: number;
  fragmentsAfter: number;
  multBefore: number;
  multAfter: number;
  /** Éclats encore à gagner pour débloquer (0 si disponible). */
  missing: number;
  /** Progression 0..1 vers le déblocage. */
  progress: number;
  echoesLost: number;
  rateBefore: number;
}

export function prestigePreview(s: GameState): PrestigePreview {
  const gain = fragmentsFor(s.runEarned);
  const need = earnedForFragments(CFG.prestige.minFragments);
  return {
    available: gain >= CFG.prestige.minFragments,
    gain,
    fragmentsBefore: s.fragments,
    fragmentsAfter: s.fragments + gain,
    multBefore: prestigeMult(s.fragments),
    multAfter: prestigeMult(s.fragments + gain),
    missing: Math.max(0, need - s.runEarned),
    progress: Math.min(1, s.runEarned / need),
    echoesLost: s.echoes.length,
    rateBefore: totalRate(s),
  };
}

/** Les 3 bonus proposés pour le prochain Effondrement (déterministes : pas de re-tirage en rechargeant). */
export function perkChoices(s: GameState): PerkDef[] {
  const rng = mulberry32(1000 + s.prestiges * 97);
  const pool = PERKS.slice();
  const out: PerkDef[] = [];
  while (out.length < 3 && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

/** Condense les échos en Fragments : remet la partie à zéro, garde Fragments et bonus. */
export function doPrestige(s: GameState, perkId: string): boolean {
  const pv = prestigePreview(s);
  if (!pv.available) return false;
  if (!perkChoices(s).some((p) => p.id === perkId)) return false;
  s.fragments += pv.gain;
  s.prestiges++;
  s.perks[perkId] = perk(s, perkId) + 1;
  s.shards = 400 * perk(s, 'start') * s.fragments;
  s.runEarned = 0;
  s.runTime = 0;
  s.levels = {};
  s.echoes = [];
  s.bestLoop = 0;
  return true;
}

export { UPGRADES };
