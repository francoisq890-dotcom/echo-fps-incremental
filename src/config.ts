/**
 * ÉCHO — configuration unique de l'équilibrage.
 * Tous les nombres du jeu (coûts, productions, géodes, zones, prestige) vivent ici.
 * La simulation (`npm run sim`) et les tests lisent ce même fichier.
 */

export type Family = 'weapon' | 'loop' | 'arena' | 'magnet' | 'element';
export type GeodeType = 'basic' | 'mobile' | 'armored' | 'golden' | 'explosive';

export interface UpgradeDef {
  id: string;
  family: Family;
  name: string;
  /** Phrase courte : à quoi sert l'amélioration. */
  desc: string;
  baseCost: number;
  growth: number;
  max: number;
  /** Index de l'icône dans la grille 5×4 générée (ligne × 5 + colonne). */
  icon: number;
  /** Texte de l'effet à un niveau donné (affiché « maintenant → ensuite »). */
  fx: (lvl: number, perks?: Record<string, number>) => string;
  /** Autre amélioration requise (id, niveau minimal). */
  req?: [string, number];
}

export const PALETTE = {
  plum: 0x2b1830,
  plumLight: 0x4a2a45,
  terracotta: 0xb65a3c,
  rose: 0xd49278,
  sand: 0xecc898,
  cream: 0xf7e3b8,
  teal: 0x3fc9b0, // couleur réservée aux échos
  amber: 0xffb81f, // accent réservé aux éclats
};

export const CFG = {
  version: 1,

  loop: {
    baseDuration: 12,
    durationPerLevel: 1,
    sampleHz: 20,
    /** Pause entre deux boucles : flash + rembobinage + matérialisation. */
    rewindTime: 1.1,
  },

  echo: {
    baseSlots: 3,
    maxSlots: 40,
    /** Part du butin de la boucle enregistrée que l'écho rapporte à chaque rejeu. */
    baseEfficiency: 0.06,
    efficiencyPerLevel: 0.12,
  },

  combo: {
    window: 2.4,
    step: 0.1,
    maxSteps: 20,
  },

  weapon: {
    baseDamage: 1,
    baseFireRate: 3.5,
    fireRatePerLevel: 0.11,
    range: 140,
    ricochetRange: 10,
    ricochetFalloff: 0.6,
    chainRadiusBase: 4,
    chainRadiusPerLevel: 0.6,
    chainDamagePerLevel: 0.5,
  },

  /** Seconde arme : le Fracasseur, une gerbe de plombs en cône. */
  w2: {
    pellets: 6,
    pelletsPerLevel: 1,
    /** Dégâts d'un plomb, en part des dégâts de l'arme. */
    damage: 0.4,
    /** Demi-angle du cône, en radians. */
    spread: 0.085,
    /** Cadence relative à celle de l'Éclateur. */
    fireRate: 0.4,
    /** Les plombs perdent leur force entre ces deux distances (m). */
    falloffStart: 9,
    falloffEnd: 26,
    falloffMin: 0.25,
  },

  /** Éléments : feu > glace > foudre > feu. */
  elements: {
    weak: 2,
    resist: 0.5,
    /** Brûlure : part des dégâts du tir infligée à chaque tic. */
    burnTick: 0.25,
    burnDuration: 2,
    burnBase: 0.12,
    burnPerLevel: 0.05,
    /** Gel : la géode devient fragile (dégâts subis augmentés). */
    brittleDuration: 3,
    brittleBase: 0.4,
    brittlePerLevel: 0.12,
    /** Foudre : arcs vers les géodes voisines. */
    arcRange: 8,
    arcCount: 1,
    arcBase: 0.4,
    arcPerLevel: 0.1,
    /** Géodes élémentaires : chance par élément débloqué, plafond, bonus. */
    geodeChance: 0.14,
    geodeChanceMax: 0.45,
    geodeHp: 1.5,
    geodeValue: 1.8,
  },

  magnet: {
    baseRadius: 7.5,
    radiusPerLevel: 1.3,
    baseSpeed: 13,
    speedGrowth: 1.22,
    /** Temps pendant lequel les éclats rebondissent avant de pouvoir être aspirés. */
    baseDelay: 0.5,
    delayPerLevel: 0.04,
  },

  player: {
    speed: 7.6,
    jumpSpeed: 7.8,
    gravity: 22,
    eyeHeight: 1.6,
    stepHeight: 0.6,
    radius: 0.45,
  },

  geodes: {
    /** Délai de réapparition sur un socle après une casse. */
    respawnDelay: 0.7,
    /** Intervalle programmé entre deux géodes d'un même socle. */
    queueInterval: 3.2,
    densityPerLevel: 0.1,
    goldenLifetime: 4,
    types: {
      basic: { hp: 3, value: 3, radius: 0.95 },
      mobile: { hp: 3, value: 9, radius: 0.85 },
      armored: { hp: 12, value: 40, radius: 1.15 },
      golden: { hp: 4, value: 120, radius: 0.8 },
      explosive: { hp: 2, value: 5, radius: 0.9 },
    } as Record<GeodeType, { hp: number; value: number; radius: number }>,
    /** Poids d'apparition par niveau de l'amélioration correspondante. */
    weightPerLevel: { mobile: 0.09, armored: 0.07, golden: 0.018, explosive: 0.06 } as Record<string, number>,
    valuePerTypeLevel: 0.25,
    explosiveDamage: 4,
    explosiveRadius: 6.5,
    /** Multiplicateurs par zone (0 = arène, 1 = terrasses, 2 = passerelles, 3 = aiguille). */
    zoneValue: [1, 4, 15, 55],
    zoneHp: [1, 3, 9, 28],
  },

  offline: {
    baseCapHours: 8,
    capHoursPerLevel: 2,
    /** En dessous de cette absence, pas d'écran de retour. */
    minSeconds: 60,
  },

  prestige: {
    /** Fragments = floor((éclats gagnés dans la partie / divisor) ^ exponent). */
    divisor: 9_000_000,
    exponent: 0.5,
    /** Fragments minimum pour pouvoir déclencher l'Effondrement. */
    minFragments: 5,
    multPerFragment: 0.2,
  },

  save: {
    key: 'echo-save-v1',
    autosaveSeconds: 10,
  },
};

const pct = (x: number) => `${Math.round(x * 100)} %`;
const rel = (t: GeodeType) => Math.round(CFG.geodes.types[t].value / CFG.geodes.types.basic.value);
const fix1 = (x: number) => (Math.round(x * 10) / 10).toString().replace('.', ',');

export function damageAt(lvl: number): number {
  return Math.round((CFG.weapon.baseDamage + lvl) * Math.pow(1.09, lvl) * 10) / 10;
}

export const UPGRADES: UpgradeDef[] = [
  // ——— Arme ———
  {
    id: 'dmg', family: 'weapon', name: 'Puissance', icon: 0,
    desc: 'Chaque tir retire plus de points de structure aux géodes.',
    baseCost: 12, growth: 1.5, max: 40,
    fx: (l, p) => `${fix1(damageAt(l) * Math.pow(1.5, p?.dmg ?? 0))} dégâts / tir`,
  },
  {
    id: 'rate', family: 'weapon', name: 'Cadence', icon: 1,
    desc: 'Plus de tirs par seconde en maintenant le clic.',
    baseCost: 20, growth: 1.8, max: 15,
    fx: (l) => `${fix1(CFG.weapon.baseFireRate * (1 + CFG.weapon.fireRatePerLevel * l))} tirs / s`,
  },
  {
    id: 'rico', family: 'weapon', name: 'Ricochet', icon: 2,
    desc: `Le tir rebondit vers la géode la plus proche (${pct(CFG.weapon.ricochetFalloff)} des dégâts à chaque rebond).`,
    baseCost: 350, growth: 7, max: 4,
    fx: (l) => (l === 0 ? 'aucun rebond' : `${l} rebond${l > 1 ? 's' : ''}`),
  },
  {
    id: 'pierce', family: 'weapon', name: 'Perforation', icon: 3,
    desc: 'Le tir traverse la géode touchée et frappe celles alignées derrière.',
    baseCost: 900, growth: 9, max: 3,
    fx: (l) => (l === 0 ? 'ne traverse pas' : `traverse ${l} géode${l > 1 ? 's' : ''}`),
  },
  {
    id: 'chain', family: 'weapon', name: 'Réaction en chaîne', icon: 4,
    desc: 'Une géode brisée explose et abîme ses voisines. Les explosions s\'enchaînent.',
    baseCost: 2500, growth: 5.5, max: 5,
    fx: (l) => (l === 0 ? 'pas d\'explosion' : `explosion : ${pct(CFG.weapon.chainDamagePerLevel * l)} des dégâts, ${fix1(CFG.weapon.chainRadiusBase + CFG.weapon.chainRadiusPerLevel * l)} m`),
  },
  {
    id: 'w2', family: 'weapon', name: 'Fracasseur', icon: 20,
    desc: `Une seconde arme : une gerbe de plombs en cône, dévastatrice de près, faible au-delà de ${CFG.w2.falloffStart} m, et lente. Touche 2 ou molette pour la prendre.`,
    baseCost: 500, growth: 4.5, max: 6,
    fx: (l) => (l === 0 ? 'verrouillé' : `${CFG.w2.pellets + CFG.w2.pelletsPerLevel * (l - 1)} plombs × ${pct(CFG.w2.damage)} des dégâts`),
  },
  // ——— Boucle ———
  {
    id: 'slots', family: 'loop', name: 'Emplacements d\'échos', icon: 5,
    desc: 'Nombre d\'échos qui rejouent tes boucles en même temps.',
    baseCost: 120, growth: 2.1, max: CFG.echo.maxSlots - CFG.echo.baseSlots,
    fx: (l, p) => `${Math.min(CFG.echo.maxSlots, CFG.echo.baseSlots + l + 2 * (p?.slots ?? 0))} échos max`,
  },
  {
    id: 'power', family: 'loop', name: 'Puissance des échos', icon: 6,
    desc: 'Part du butin de la boucle enregistrée que chaque écho rapporte à chaque rejeu.',
    baseCost: 300, growth: 1.6, max: 30,
    fx: (l) => `${pct(CFG.echo.baseEfficiency * (1 + CFG.echo.efficiencyPerLevel * l))} du butin`,
  },
  {
    id: 'dur', family: 'loop', name: 'Durée de boucle', icon: 7,
    desc: 'Boucle plus longue : plus de géodes par boucle et le temps d\'atteindre les zones lointaines.',
    baseCost: 800, growth: 3.4, max: 8,
    fx: (l) => `${CFG.loop.baseDuration + CFG.loop.durationPerLevel * l} s par boucle`,
  },
  {
    id: 'offline', family: 'loop', name: 'Mémoire longue', icon: 8,
    desc: 'Durée maximale pendant laquelle tes échos produisent quand le jeu est fermé.',
    baseCost: 1500, growth: 4, max: 8,
    fx: (l, p) => `${CFG.offline.baseCapHours + CFG.offline.capHoursPerLevel * l + 6 * (p?.offline ?? 0)} h hors ligne`,
  },
  // ——— Arène ———
  {
    id: 'zone', family: 'arena', name: 'Expansion', icon: 9,
    desc: 'Fait surgir une nouvelle zone. Ses géodes valent beaucoup plus, mais il faut y aller.',
    baseCost: 1500, growth: 22, max: 3,
    fx: (l) => ['Arène seule', 'Terrasses (×4)', 'Passerelles (×15)', 'Aiguille (×55)'][l],
  },
  {
    id: 'density', family: 'arena', name: 'Densité', icon: 10,
    desc: 'Les géodes réapparaissent plus vite sur leurs socles.',
    baseCost: 150, growth: 1.9, max: 12,
    fx: (l) => `+${Math.round(CFG.geodes.densityPerLevel * l * 100)} % de géodes`,
  },
  {
    id: 'mobile', family: 'arena', name: 'Géodes mobiles', icon: 11,
    desc: 'Des géodes en orbite, plus dures à viser : ×3 la valeur d\'une géode simple.',
    baseCost: 250, growth: 2.6, max: 6,
    fx: (l) => (l === 0 ? 'verrouillé' : `${pct(CFG.geodes.weightPerLevel.mobile * l)} des géodes, valeur +${Math.round((l - 1) * 25)} %`),
  },
  {
    id: 'explosive', family: 'arena', name: 'Géodes explosives', icon: 12,
    desc: 'Elles explosent en cassant et abîment tout autour : de quoi lancer des chaînes.',
    baseCost: 700, growth: 2.8, max: 6,
    fx: (l) => (l === 0 ? 'verrouillé' : `${pct(CFG.geodes.weightPerLevel.explosive * l)} des géodes`),
  },
  {
    id: 'armored', family: 'arena', name: 'Géodes blindées', icon: 13,
    desc: 'Très résistantes, mais ×13 la valeur d\'une géode simple.',
    baseCost: 1200, growth: 2.9, max: 6,
    fx: (l) => (l === 0 ? 'verrouillé' : `${pct(CFG.geodes.weightPerLevel.armored * l)} des géodes, valeur +${Math.round((l - 1) * 25)} %`),
  },
  {
    id: 'golden', family: 'arena', name: 'Géodes dorées', icon: 14,
    desc: 'Rares, elles disparaissent en 4 s : ×40 la valeur d\'une géode simple.',
    baseCost: 4000, growth: 3.2, max: 6,
    fx: (l) => (l === 0 ? 'verrouillé' : `${fix1(CFG.geodes.weightPerLevel.golden * l * 100)} % des géodes, valeur +${Math.round((l - 1) * 25)} %`),
  },
  // ——— Aimant ———
  {
    id: 'mrad', family: 'magnet', name: 'Rayon d\'aimant', icon: 15,
    desc: 'Distance à laquelle les éclats tombés au sol sont aspirés vers toi. Les éclats non ramassés à la fin de la boucle sont perdus.',
    baseCost: 30, growth: 1.7, max: 14,
    fx: (l, p) => `${fix1((CFG.magnet.baseRadius + CFG.magnet.radiusPerLevel * l) * (1 + 0.4 * (p?.magnet ?? 0)))} m`,
  },
  {
    id: 'mspd', family: 'magnet', name: 'Vitesse d\'aimant', icon: 16,
    desc: 'Les éclats partent plus tôt et volent plus vite vers toi.',
    baseCost: 45, growth: 1.75, max: 10,
    fx: (l) => `${fix1(CFG.magnet.baseSpeed * Math.pow(CFG.magnet.speedGrowth, l))} m/s`,
  },
  // ——— Éléments ———
  {
    id: 'fire', family: 'element', name: 'Feu', icon: 21,
    desc: `Tes tirs enflamment la géode : elle brûle pendant ${CFG.elements.burnDuration} s. ×${CFG.elements.weak} contre les géodes de glace. Touche R pour changer d'élément.`,
    baseCost: 400, growth: 4.5, max: 5,
    fx: (l) => (l === 0 ? 'verrouillé' : `brûlure : ${pct((CFG.elements.burnBase + CFG.elements.burnPerLevel * (l - 1)) / CFG.elements.burnTick)} des dégâts / s`),
  },
  {
    id: 'ice', family: 'element', name: 'Glace', icon: 22,
    desc: `Tes tirs gèlent la géode : fragile pendant ${CFG.elements.brittleDuration} s, elle subit plus de dégâts de toutes les sources. ×${CFG.elements.weak} contre les géodes de foudre.`,
    baseCost: 400, growth: 4.5, max: 5,
    fx: (l) => (l === 0 ? 'verrouillé' : `gel : +${pct(CFG.elements.brittleBase + CFG.elements.brittlePerLevel * (l - 1))} de dégâts`),
  },
  {
    id: 'volt', family: 'element', name: 'Foudre', icon: 23,
    desc: `Chaque tir qui touche lance un arc vers une géode voisine (${CFG.elements.arcRange} m). ×${CFG.elements.weak} contre les géodes de feu.`,
    baseCost: 400, growth: 4.5, max: 5,
    fx: (l) => (l === 0 ? 'verrouillé' : `${CFG.elements.arcCount + Math.floor((l - 1) / 2)} arc${l >= 3 ? 's' : ''} à ${pct(CFG.elements.arcBase + CFG.elements.arcPerLevel * (l - 1))} des dégâts`),
  },
];

export const UPGRADE_BY_ID: Record<string, UpgradeDef> = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

export const FAMILIES: { id: Family; name: string }[] = [
  { id: 'weapon', name: 'ARME' },
  { id: 'loop', name: 'BOUCLE' },
  { id: 'arena', name: 'ARÈNE' },
  { id: 'magnet', name: 'AIMANT' },
  { id: 'element', name: 'ÉLÉMENTS' },
];

export const WEAPON_NAMES = ['Éclateur', 'Fracasseur'];
export const ELEM_NAMES = ['Neutre', 'Feu', 'Glace', 'Foudre'];
export const ELEM_IDS = ['', 'fire', 'ice', 'volt'];
/** Élément que chaque élément bat (feu > glace > foudre > feu). */
export const ELEM_BEATS = [0, 2, 3, 1];
/** Couleurs HDR des éléments (tirs, cœurs de géodes). L'ambre reste réservé aux éclats. */
export const ELEM_RGB: [number, number, number][] = [[3.2, 2.1, 0.7], [3.4, 0.9, 0.25], [1.2, 2.4, 3.4], [2.3, 1.1, 3.6]];
export const ELEM_CSS = ['#f7e3b8', '#ff7a3c', '#9fdcff', '#c79bff'];

export interface PerkDef {
  id: string;
  name: string;
  desc: string;
}

/** Bonus permanents proposés (3 au choix) à chaque Effondrement. Cumulables. */
export const PERKS: PerkDef[] = [
  { id: 'slots', name: 'Écho résiduel', desc: '+2 emplacements d\'échos dès le départ.' },
  { id: 'dmg', name: 'Canon dense', desc: 'Dégâts de l\'arme ×1,5.' },
  { id: 'magnet', name: 'Aimant ancestral', desc: 'Rayon d\'aimant +40 %.' },
  { id: 'echo', name: 'Résonance', desc: 'Les échos rapportent ×1,4.' },
  { id: 'combo', name: 'Combo tenace', desc: 'Le combo tient 1 s de plus entre deux cassures.' },
  { id: 'start', name: 'Réserve', desc: 'Recommence chaque partie avec 400 éclats par Fragment possédé.' },
  { id: 'offline', name: 'Veille profonde', desc: '+6 h de production hors ligne.' },
  { id: 'gold', name: 'Filon', desc: 'Toutes les géodes valent +30 %.' },
];
