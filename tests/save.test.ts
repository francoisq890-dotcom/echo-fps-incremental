/**
 * Tests de la sauvegarde : aller-retour, export/import texte, migration et bornage des valeurs.
 */
import { describe, expect, it } from 'vitest';
import { CFG, PERKS, UPGRADES, UPGRADE_BY_ID } from '../src/config';
import { bytesToBase64 } from '../src/core/util';
import { deserialize, exportSave, importSave, migrate, serialize } from '../src/economy/save';
import { newState, type GameState } from '../src/economy/state';

const NOW = 1_700_000_000_000;

/** État « riche » : niveaux, perks, échos, réglages modifiés. Toutes les valeurs sont valides. */
function richState(): GameState {
  const s = newState(NOW - 5000);
  s.shards = 98_765.25;
  s.runEarned = 1_234_567.5;
  s.totalEarned = 9_876_543.75;
  UPGRADES.forEach((u, i) => {
    const l = Math.min(u.max, (i % 4) + 1);
    if (i % 3 !== 2) s.levels[u.id] = l;
  });
  s.levels[UPGRADES[0].id] = UPGRADES[0].max;
  s.perks[PERKS[0].id] = 2;
  s.perks[PERKS[PERKS.length - 1].id] = 1;
  s.echoes.push(
    { id: 3, raw: 420, duration: 12, rec: '{"seed":1}|AAAA|BBBB' },
    { id: 5, raw: 1337.5, duration: 14, rec: 'écho « accentué » ✓|QUJD|' },
    { id: 9, raw: 77, duration: 13, rec: '' },
  );
  s.nextEchoId = 10;
  s.fragments = 12;
  s.prestiges = 3;
  s.tutorial = 4;
  s.playTime = 7200.5;
  s.runTime = 640.25;
  s.loops = 321;
  s.bestLoop = 1500;
  s.settings = { volume: 0.35, music: 0, sens: 1.7, shake: 0.5, invertY: true };
  return s;
}

const b64 = (text: string) => bytesToBase64(new TextEncoder().encode(text));

describe('serialize / deserialize', () => {
  it('aller-retour sans perte sur un état riche', () => {
    const s = richState();
    const back = deserialize(serialize(s), NOW);
    expect(back).toEqual(s);
    expect(back).not.toBe(s);
  });

  it('aller-retour sans perte sur un état neuf', () => {
    const s = newState(NOW);
    expect(deserialize(serialize(s), NOW)).toEqual(s);
  });

  it('un second aller-retour est stable', () => {
    const once = deserialize(serialize(richState()), NOW);
    expect(deserialize(serialize(once), NOW)).toEqual(once);
  });

  it('deserialize rejette un texte qui n\'est pas du JSON', () => {
    expect(() => deserialize('ceci n\'est pas du JSON', NOW)).toThrow();
    expect(() => deserialize('', NOW)).toThrow();
  });
});

describe('exportSave / importSave', () => {
  it('aller-retour sans perte sur un état riche', () => {
    const s = richState();
    const text = exportSave(s);
    expect(typeof text).toBe('string');
    // Le texte exporté doit pouvoir se copier-coller : une seule ligne ASCII.
    expect(text).toMatch(/^[\x21-\x7e]+$/);
    expect(importSave(text, NOW)).toEqual(s);
  });

  it('tolère les espaces et retours à la ligne autour du texte collé', () => {
    const s = richState();
    expect(importSave(`  \n${exportSave(s)}\n\t `, NOW)).toEqual(s);
  });

  it('rejette un texte quelconque', () => {
    const prefix = exportSave(newState(NOW)).slice(0, exportSave(newState(NOW)).indexOf(':') + 1);
    const bad = [
      '',
      'bonjour',
      '{"v":1,"shards":10}',
      serialize(richState()), // JSON valide mais sans l'enveloppe d'export
      exportSave(richState()).slice(prefix.length), // base64 sans préfixe
      `${prefix}%%% pas du base64 %%%`,
      `${prefix}${b64('pas du JSON')}`,
      `${prefix}${b64('42')}`,
      `${prefix}${b64('null')}`,
      `${prefix}${b64('{"shards":10}')}`, // objet sans version
    ];
    for (const text of bad) expect(() => importSave(text, NOW), JSON.stringify(text.slice(0, 40))).toThrow();
  });

  it('rejette un export tronqué', () => {
    const text = exportSave(richState());
    expect(() => importSave(text.slice(0, Math.floor(text.length / 2)), NOW)).toThrow();
  });
});

describe('migrate', () => {
  it('rejette ce qui n\'est pas une sauvegarde', () => {
    for (const raw of [null, undefined, 0, 42, 'texte', true]) expect(() => migrate(raw, NOW)).toThrow();
    expect(() => migrate({}, NOW)).toThrow();
    expect(() => migrate({ v: '1' }, NOW)).toThrow();
    expect(() => migrate({ shards: 10 }, NOW)).toThrow();
  });

  it('rejette une version future', () => {
    expect(() => migrate({ v: CFG.version + 1, shards: 10 }, NOW)).toThrow();
    expect(() => migrate({ ...richState(), v: CFG.version + 5 }, NOW)).toThrow();
  });

  it('champs manquants → valeurs par défaut', () => {
    expect(migrate({ v: CFG.version }, NOW)).toEqual(newState(NOW));
  });

  it('garde les champs présents et complète les autres', () => {
    const s = migrate({ v: CFG.version, shards: 55, levels: { [UPGRADES[0].id]: 1 }, settings: { volume: 0.2 } }, NOW);
    const def = newState(NOW);
    expect(s.shards).toBe(55);
    expect(s.levels).toEqual({ [UPGRADES[0].id]: 1 });
    expect(s.settings).toEqual({ ...def.settings, volume: 0.2 });
    expect(s.echoes).toEqual([]);
    expect(s.perks).toEqual({});
    expect(s.fragments).toBe(0);
    expect(s.nextEchoId).toBe(1);
    expect(s.lastSeen).toBe(NOW);
    expect(s.v).toBe(CFG.version);
  });

  it('totalEarned absent → au moins runEarned', () => {
    expect(migrate({ v: CFG.version, runEarned: 300 }, NOW).totalEarned).toBe(300);
  });

  it('valeurs numériques invalides → défaut ou borne', () => {
    const def = newState(NOW);
    const s = migrate({
      v: CFG.version,
      shards: NaN,
      runEarned: -500,
      totalEarned: Infinity,
      fragments: -3,
      prestiges: 'beaucoup',
      tutorial: null,
      playTime: -1,
      runTime: NaN,
      loops: -Infinity,
      bestLoop: {},
      nextEchoId: -4,
    }, NOW);
    expect(s.shards).toBe(0);
    expect(s.runEarned).toBe(0);
    expect(s.totalEarned).toBe(0);
    expect(s.fragments).toBe(0);
    expect(s.prestiges).toBe(0);
    expect(s.tutorial).toBe(0);
    expect(s.playTime).toBe(0);
    expect(s.runTime).toBe(0);
    expect(s.loops).toBe(0);
    expect(s.bestLoop).toBe(0);
    expect(s.nextEchoId).toBe(1);
    expect(s).toEqual(def);
  });

  it('les compteurs entiers sont tronqués', () => {
    const s = migrate({ v: CFG.version, fragments: 3.9, prestiges: 2.5, loops: 10.99, tutorial: 1.2 }, NOW);
    expect(s.fragments).toBe(3);
    expect(s.prestiges).toBe(2);
    expect(s.loops).toBe(10);
    expect(s.tutorial).toBe(1);
  });

  it('niveaux : bornés au max, négatifs / invalides / inconnus ignorés', () => {
    const [a, b, c, d, e] = UPGRADES;
    const s = migrate({
      v: CFG.version,
      levels: {
        [a.id]: a.max + 50,
        [b.id]: -3,
        [c.id]: NaN,
        [d.id]: 1.8,
        [e.id]: '3',
        'amelioration-inconnue': 4,
      },
    }, NOW);
    expect(s.levels).toEqual({ [a.id]: a.max, [d.id]: 1 });
    for (const id of Object.keys(s.levels)) {
      expect(UPGRADE_BY_ID[id]).toBeDefined();
      expect(s.levels[id]).toBeLessThanOrEqual(UPGRADE_BY_ID[id].max);
    }
  });

  it('niveaux au-delà du max sur toutes les améliorations', () => {
    const levels = Object.fromEntries(UPGRADES.map((u) => [u.id, 1e9]));
    const s = migrate({ v: CFG.version, levels }, NOW);
    for (const u of UPGRADES) expect(s.levels[u.id]).toBe(u.max);
  });

  it('perks : négatifs / invalides / inconnus ignorés', () => {
    const s = migrate({
      v: CFG.version,
      perks: { [PERKS[0].id]: 2.7, [PERKS[1].id]: -1, [PERKS[2].id]: NaN, 'perk-inconnu': 3 },
    }, NOW);
    expect(s.perks).toEqual({ [PERKS[0].id]: 2 });
  });

  it('levels / perks / echoes / settings de mauvais type → défauts', () => {
    const s = migrate({ v: CFG.version, levels: 'x', perks: 7, echoes: { length: 3 }, settings: 'fort' }, NOW);
    expect(s).toEqual(newState(NOW));
  });

  it('échos : les entrées invalides sont écartées, les valides gardées', () => {
    const s = migrate({
      v: CFG.version,
      echoes: [
        { id: 1, raw: 100, duration: 12, rec: 'ok' },
        null,
        'texte',
        { id: 2, raw: 100, duration: 12 }, // pas d'enregistrement
        { id: 3, raw: 0, duration: 12, rec: 'vide' },
        { id: 4, raw: -50, duration: 12, rec: 'négatif' },
        { id: 5, raw: NaN, duration: 12, rec: 'nan' },
        { id: 6, raw: 250, duration: 13, rec: 'ok2' },
      ],
    }, NOW);
    expect(s.echoes).toEqual([
      { id: 1, raw: 100, duration: 12, rec: 'ok' },
      { id: 6, raw: 250, duration: 13, rec: 'ok2' },
    ]);
    // Le prochain identifiant ne doit jamais réutiliser celui d'un écho existant.
    expect(s.nextEchoId).toBeGreaterThan(6);
  });

  it('échos : durée hors bornes (nulle, négative, énorme) ramenée à une valeur strictement positive', () => {
    const s = migrate({
      v: CFG.version,
      echoes: [
        { id: 1, raw: 100, duration: 0, rec: 'a' },
        { id: 2, raw: 100, duration: -5, rec: 'b' },
        { id: 4, raw: 100, duration: 1e9, rec: 'd' },
      ],
    }, NOW);
    expect(s.echoes.length).toBe(3);
    for (const e of s.echoes) {
      expect(e.duration).toBeGreaterThan(0);
      expect(Number.isFinite(e.raw / e.duration)).toBe(true);
    }
  });

  // BUG CONNU (src/economy/save.ts, ligne 59) : `num(e.duration, 0, 1, 120)` renvoie le défaut 0
  // (le défaut n'est pas borné par min) quand la durée n'est pas un nombre fini (NaN, absente, chaîne…).
  // L'écho est alors gardé avec duration = 0, donc raw / duration = Infinity : production infinie.
  // Retirer `.fails` une fois le défaut corrigé (le test doit alors passer tel quel).
  it('échos : durée non numérique (NaN, absente, chaîne) → jamais de division par zéro', () => {
    const s = migrate({
      v: CFG.version,
      echoes: [
        { id: 1, raw: 100, duration: NaN, rec: 'a' },
        { id: 2, raw: 100, rec: 'b' },
        { id: 3, raw: 100, duration: '12', rec: 'c' },
      ],
    }, NOW);
    for (const e of s.echoes) {
      expect(e.duration).toBeGreaterThan(0);
      expect(Number.isFinite(e.raw / e.duration)).toBe(true);
    }
  });

  it('échos : jamais plus que CFG.echo.maxSlots', () => {
    const echoes = Array.from({ length: CFG.echo.maxSlots + 25 }, (_, i) => ({ id: i + 1, raw: 10 + i, duration: 12, rec: 'r' }));
    const s = migrate({ v: CFG.version, echoes }, NOW);
    expect(s.echoes.length).toBe(CFG.echo.maxSlots);
    expect(s.nextEchoId).toBeGreaterThan(Math.max(...s.echoes.map((e) => e.id)));
  });

  it('réglages hors bornes ramenés dans leur plage', () => {
    const s = migrate({ v: CFG.version, settings: { volume: 5, music: -2, sens: 1000, shake: NaN, invertY: 1 } }, NOW);
    const def = newState(NOW).settings;
    expect(s.settings.volume).toBe(1);
    expect(s.settings.music).toBe(0);
    expect(s.settings.sens).toBeLessThan(1000);
    expect(s.settings.sens).toBeGreaterThan(0);
    expect(s.settings.shake).toBe(def.shake);
    expect(s.settings.invertY).toBe(true);
    const low = migrate({ v: CFG.version, settings: { sens: -3 } }, NOW);
    expect(low.settings.sens).toBeGreaterThan(0);
  });

  it('v0 avec « earned » → runEarned et totalEarned', () => {
    const s = migrate({ v: 0, shards: 120, earned: 4500 }, NOW);
    expect(s.v).toBe(CFG.version);
    expect(s.shards).toBe(120);
    expect(s.runEarned).toBe(4500);
    expect(s.totalEarned).toBe(4500);
  });

  it('v0 sans « earned » → compteurs à zéro', () => {
    const s = migrate({ v: 0, shards: 120 }, NOW);
    expect(s.runEarned).toBe(0);
    expect(s.totalEarned).toBe(0);
  });

  it('v0 : des compteurs déjà scindés ne sont pas écrasés par « earned »', () => {
    const s = migrate({ v: 0, earned: 4500, runEarned: 100, totalEarned: 9000 }, NOW);
    expect(s.runEarned).toBe(100);
    expect(s.totalEarned).toBe(9000);
  });

  it('lastSeen n\'est jamais dans le futur', () => {
    expect(migrate({ v: CFG.version, lastSeen: NOW + 86_400_000 }, NOW).lastSeen).toBe(NOW);
    expect(migrate({ v: CFG.version, lastSeen: Infinity }, NOW).lastSeen).toBe(NOW);
    expect(migrate({ v: CFG.version, lastSeen: NaN }, NOW).lastSeen).toBe(NOW);
    expect(migrate({ v: CFG.version, lastSeen: 'hier' }, NOW).lastSeen).toBe(NOW);
    expect(migrate({ v: CFG.version }, NOW).lastSeen).toBe(NOW);
    // Un horodatage passé est conservé tel quel.
    expect(migrate({ v: CFG.version, lastSeen: NOW - 3_600_000 }, NOW).lastSeen).toBe(NOW - 3_600_000);
    // Négatif : ramené à une valeur non négative et pas dans le futur.
    const neg = migrate({ v: CFG.version, lastSeen: -5 }, NOW).lastSeen;
    expect(neg).toBeGreaterThanOrEqual(0);
    expect(neg).toBeLessThanOrEqual(NOW);
  });

  it('une sauvegarde importée avec une horloge en avance ne donne pas de lastSeen futur', () => {
    const s = richState();
    s.lastSeen = NOW + 10 * 86_400_000;
    expect(importSave(exportSave(s), NOW).lastSeen).toBe(NOW);
    expect(deserialize(serialize(s), NOW).lastSeen).toBe(NOW);
  });
});
