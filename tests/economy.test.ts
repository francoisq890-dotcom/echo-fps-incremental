/**
 * Tests de l'économie : coûts, achats, statistiques dérivées, échos, prestige.
 * Aucune valeur d'équilibrage en dur : tout est recalculé depuis CFG / UPGRADE_BY_ID.
 */
import { describe, expect, it } from 'vitest';
import { CFG, PERKS, UPGRADES, UPGRADE_BY_ID } from '../src/config';
import {
  buy, buyBlock, costAt, costOf, derive, doPrestige, earn, earnedForFragments, echoRate,
  fragmentsFor, lvl, newState, perkChoices, prestigeMult, prestigePreview, submitLoop,
  tickEchoes, totalRate, weakestIndex, type GameState,
} from '../src/economy/state';

const NOW = 1_700_000_000_000;

/** État neuf avec des niveaux donnés (bornés au max de chaque amélioration). */
function withLevels(levels: Record<string, number>, base: GameState = newState(NOW)): GameState {
  for (const [id, n] of Object.entries(levels)) base.levels[id] = Math.min(UPGRADE_BY_ID[id].max, n);
  return base;
}

/** Remplit tous les emplacements avec des échos de rendement croissant (raw/duration = 20 + i). */
function fillSlots(s: GameState): void {
  const slots = derive(s).slots;
  for (let i = 0; i < slots; i++) {
    const out = submitLoop(s, (20 + i) * 10, 10, `rec${i}`);
    expect(out.kind).toBe('added');
  }
  expect(s.echoes.length).toBe(slots);
}

describe('costAt', () => {
  it('vaut ceil(base × growth^n) pour chaque amélioration', () => {
    for (const u of UPGRADES) {
      for (let n = 0; n <= Math.min(u.max, 12); n++) {
        expect(costAt(u.id, n)).toBe(Math.ceil(u.baseCost * Math.pow(u.growth, n)));
        expect(Number.isInteger(costAt(u.id, n))).toBe(true);
      }
    }
  });

  it('est strictement croissant avec le niveau', () => {
    for (const u of UPGRADES) {
      for (let n = 0; n < u.max; n++) {
        expect(costAt(u.id, n + 1), `${u.id} niveau ${n + 1}`).toBeGreaterThan(costAt(u.id, n));
      }
    }
  });

  it('costOf suit le niveau courant', () => {
    const s = newState(NOW);
    const u = UPGRADES[0];
    expect(costOf(s, u.id)).toBe(costAt(u.id, 0));
    s.levels[u.id] = 1;
    expect(costOf(s, u.id)).toBe(costAt(u.id, 1));
  });
});

describe('buy / buyBlock', () => {
  const free = UPGRADES.filter((u) => !u.req);

  it('débite le coût exact et incrémente le niveau', () => {
    for (const u of free) {
      const s = newState(NOW);
      const cost = costAt(u.id, 0);
      s.shards = cost + 7;
      expect(buyBlock(s, u.id)).toBeNull();
      expect(buy(s, u.id)).toBe(true);
      expect(s.shards).toBe(7);
      expect(lvl(s, u.id)).toBe(1);
    }
  });

  it('enchaîne les achats avec le coût du niveau courant', () => {
    const u = free.find((x) => x.max >= 3)!;
    const s = newState(NOW);
    s.shards = costAt(u.id, 0) + costAt(u.id, 1) + costAt(u.id, 2);
    expect(buy(s, u.id)).toBe(true);
    expect(buy(s, u.id)).toBe(true);
    expect(buy(s, u.id)).toBe(true);
    expect(lvl(s, u.id)).toBe(3);
    expect(s.shards).toBe(0);
    expect(buy(s, u.id)).toBe(false);
  });

  it('refuse si le joueur est trop pauvre, sans rien modifier', () => {
    for (const u of free) {
      const s = newState(NOW);
      s.shards = costAt(u.id, 0) - 1;
      expect(buyBlock(s, u.id)).toBe('poor');
      expect(buy(s, u.id)).toBe(false);
      expect(s.shards).toBe(costAt(u.id, 0) - 1);
      expect(lvl(s, u.id)).toBe(0);
    }
  });

  it('refuse au niveau maximum, même riche', () => {
    for (const u of UPGRADES) {
      const s = newState(NOW);
      s.levels[u.id] = u.max;
      s.shards = Number.MAX_VALUE;
      expect(buyBlock(s, u.id)).toBe('max');
      expect(buy(s, u.id)).toBe(false);
      expect(lvl(s, u.id)).toBe(u.max);
      expect(s.shards).toBe(Number.MAX_VALUE);
    }
  });

  it('respecte les prérequis éventuels (locked)', () => {
    for (const u of UPGRADES.filter((x) => x.req)) {
      const [reqId, reqLvl] = u.req!;
      const s = newState(NOW);
      s.shards = Number.MAX_VALUE;
      s.levels[reqId] = reqLvl - 1;
      expect(buyBlock(s, u.id)).toBe('locked');
      expect(buy(s, u.id)).toBe(false);
      s.levels[reqId] = reqLvl;
      expect(buyBlock(s, u.id)).toBeNull();
    }
  });
});

describe('derive', () => {
  const base = derive(newState(NOW));

  it('part des valeurs de base de CFG', () => {
    expect(base.duration).toBe(CFG.loop.baseDuration);
    expect(base.slots).toBe(CFG.echo.baseSlots);
    expect(base.efficiency).toBeCloseTo(CFG.echo.baseEfficiency, 12);
    expect(base.fireRate).toBeCloseTo(CFG.weapon.baseFireRate, 12);
    expect(base.magnetRadius).toBeCloseTo(CFG.magnet.baseRadius, 12);
    expect(base.magnetSpeed).toBeCloseTo(CFG.magnet.baseSpeed, 12);
    expect(base.comboWindow).toBe(CFG.combo.window);
    expect(base.offlineCapSec).toBe(CFG.offline.baseCapHours * 3600);
    expect(base.globalMult).toBe(1);
    expect(base.weaponTier).toBe(0);
  });

  const up: [string, keyof typeof base][] = [
    ['dmg', 'damage'], ['rate', 'fireRate'], ['dur', 'duration'], ['slots', 'slots'],
    ['power', 'efficiency'], ['mrad', 'magnetRadius'], ['mspd', 'magnetSpeed'], ['offline', 'offlineCapSec'],
  ];
  for (const [id, stat] of up) {
    it(`« ${id} » augmente ${stat} à chaque niveau`, () => {
      let prev = base[stat];
      for (let n = 1; n <= UPGRADE_BY_ID[id].max; n++) {
        const cur = derive(withLevels({ [id]: n }))[stat];
        expect(cur, `${id} niveau ${n}`).toBeGreaterThan(prev);
        prev = cur;
      }
    });
  }

  it('« mspd » ne rallonge jamais le délai d\'aimant, qui reste positif', () => {
    let prev = base.magnetDelay;
    for (let n = 1; n <= UPGRADE_BY_ID.mspd.max; n++) {
      const cur = derive(withLevels({ mspd: n })).magnetDelay;
      expect(cur).toBeLessThanOrEqual(prev);
      expect(cur).toBeGreaterThan(0);
      prev = cur;
    }
    expect(prev).toBeLessThan(base.magnetDelay);
  });

  it('les emplacements ne dépassent jamais CFG.echo.maxSlots', () => {
    const s = withLevels({ slots: UPGRADE_BY_ID.slots.max });
    s.perks.slots = 50;
    expect(derive(s).slots).toBe(CFG.echo.maxSlots);
  });

  it('les Fragments augmentent le multiplicateur global', () => {
    const s = newState(NOW);
    s.fragments = 10;
    expect(derive(s).globalMult).toBe(prestigeMult(10));
    expect(prestigeMult(10)).toBeCloseTo(1 + CFG.prestige.multPerFragment * 10, 12);
    expect(prestigeMult(11)).toBeGreaterThan(prestigeMult(10));
  });

  it('les perks améliorent la statistique correspondante', () => {
    const cases: [string, keyof typeof base][] = [
      ['dmg', 'damage'], ['slots', 'slots'], ['magnet', 'magnetRadius'], ['echo', 'efficiency'],
      ['combo', 'comboWindow'], ['offline', 'offlineCapSec'],
    ];
    for (const [id, stat] of cases) {
      const s = newState(NOW);
      s.perks[id] = 1;
      const one = derive(s)[stat];
      s.perks[id] = 2;
      const two = derive(s)[stat];
      expect(one, `perk ${id}`).toBeGreaterThan(base[stat]);
      expect(two, `perk ${id} ×2`).toBeGreaterThan(one);
    }
  });

  it('le palier visuel de l\'arme ne décroît pas quand les niveaux montent', () => {
    let prev = 0;
    for (let n = 0; n <= UPGRADE_BY_ID.dmg.max; n++) {
      const tier = derive(withLevels({ dmg: n, rate: n, rico: n, pierce: n, chain: n })).weaponTier;
      expect(tier).toBeGreaterThanOrEqual(prev);
      expect(tier).toBeLessThanOrEqual(4);
      prev = tier;
    }
  });
});

describe('earn / echoRate / totalRate / tickEchoes', () => {
  it('earn crédite les trois compteurs', () => {
    const s = newState(NOW);
    s.shards = 5; s.runEarned = 10; s.totalEarned = 100;
    earn(s, 42);
    expect(s.shards).toBe(47);
    expect(s.runEarned).toBe(52);
    expect(s.totalEarned).toBe(142);
  });

  it('echoRate = raw / durée × efficacité × multiplicateur global', () => {
    const s = withLevels({ power: 3 });
    s.fragments = 4;
    const st = derive(s);
    const e = { id: 1, raw: 480, duration: 12, rec: '' };
    expect(echoRate(s, e)).toBeCloseTo((480 / 12) * st.efficiency * st.globalMult, 10);
    expect(echoRate(s, e)).toBeGreaterThan(echoRate(newState(NOW), e));
  });

  it('totalRate est la somme des taux des échos', () => {
    const s = newState(NOW);
    expect(totalRate(s)).toBe(0);
    s.echoes.push({ id: 1, raw: 100, duration: 12, rec: '' }, { id: 2, raw: 350, duration: 14, rec: '' });
    expect(totalRate(s)).toBeCloseTo(echoRate(s, s.echoes[0]) + echoRate(s, s.echoes[1]), 10);
  });

  it('tickEchoes : gain = taux × dt, crédité sur les compteurs', () => {
    const s = newState(NOW);
    s.echoes.push({ id: 1, raw: 300, duration: 12, rec: '' }, { id: 2, raw: 90, duration: 15, rec: '' });
    const rate = totalRate(s);
    expect(rate).toBeGreaterThan(0);
    const gain = tickEchoes(s, 2.5);
    expect(gain).toBeCloseTo(rate * 2.5, 10);
    expect(s.shards).toBeCloseTo(rate * 2.5, 10);
    expect(s.runEarned).toBeCloseTo(rate * 2.5, 10);
    expect(s.totalEarned).toBeCloseTo(rate * 2.5, 10);
    const gain2 = tickEchoes(s, 0.5);
    expect(gain2).toBeCloseTo(rate * 0.5, 10);
    expect(s.shards).toBeCloseTo(rate * 3, 10);
  });

  it('tickEchoes sans écho ne rapporte rien', () => {
    const s = newState(NOW);
    expect(tickEchoes(s, 10)).toBe(0);
    expect(s.shards).toBe(0);
  });
});

describe('submitLoop', () => {
  it('boucle vide → « empty », aucun écho créé', () => {
    const s = newState(NOW);
    expect(submitLoop(s, 0, CFG.loop.baseDuration, 'x')).toEqual({ kind: 'empty' });
    expect(s.echoes).toEqual([]);
    expect(s.nextEchoId).toBe(1);
    expect(s.loops).toBe(1);
  });

  it('emplacements libres → « added » jusqu\'à remplir', () => {
    const s = newState(NOW);
    const slots = derive(s).slots;
    for (let i = 0; i < slots; i++) {
      const out = submitLoop(s, 100 + i, 12, `rec${i}`);
      expect(out.kind).toBe('added');
      if (out.kind !== 'added') continue;
      expect(out.echo).toEqual({ id: i + 1, raw: 100 + i, duration: 12, rec: `rec${i}` });
      expect(out.rate).toBeCloseTo(echoRate(s, out.echo), 10);
      expect(s.echoes[i]).toBe(out.echo);
    }
    expect(s.echoes.length).toBe(slots);
    expect(s.loops).toBe(slots);
    expect(s.bestLoop).toBe(100 + slots - 1);
    expect(new Set(s.echoes.map((e) => e.id)).size).toBe(slots);
  });

  it('plein + meilleure boucle → « replaced », et c\'est l\'écho le plus faible qui part', () => {
    const s = newState(NOW);
    fillSlots(s);
    // On déplace le plus faible au milieu pour vérifier que ce n'est pas « le premier » qui part.
    const mid = Math.floor(s.echoes.length / 2);
    [s.echoes[0], s.echoes[mid]] = [s.echoes[mid], s.echoes[0]];
    const weakest = s.echoes[mid];
    expect(weakestIndex(s)).toBe(mid);
    const others = s.echoes.filter((e) => e !== weakest).map((e) => e.id);
    const weakestRate = echoRate(s, weakest);
    const nextId = s.nextEchoId;

    const out = submitLoop(s, 9999, 10, 'mieux');
    expect(out.kind).toBe('replaced');
    if (out.kind !== 'replaced') return;
    expect(out.removedId).toBe(weakest.id);
    expect(out.removedRate).toBeCloseTo(weakestRate, 10);
    expect(out.echo).toEqual({ id: nextId, raw: 9999, duration: 10, rec: 'mieux' });
    expect(out.rate).toBeGreaterThan(out.removedRate);
    expect(s.echoes.length).toBe(derive(s).slots);
    expect(s.echoes.some((e) => e.id === weakest.id)).toBe(false);
    expect(s.echoes.filter((e) => e.id !== nextId).map((e) => e.id).sort()).toEqual(others.sort());
    expect(s.echoes[mid]).toBe(out.echo);
  });

  it('le plus faible se juge au rendement raw/durée, pas au butin brut', () => {
    const s = newState(NOW);
    fillSlots(s);
    // Gros butin mais boucle très longue : rendement 10/s, inférieur à tous les autres (≥ 20/s).
    const lazy = { id: 777, raw: 50_000, duration: 5000, rec: 'long' };
    const last = s.echoes.length - 1;
    s.echoes[last] = lazy;
    expect(weakestIndex(s)).toBe(last);
    // Candidat : butin bien plus petit que « lazy », mais rendement 15/s.
    const out = submitLoop(s, 150, 10, 'court');
    expect(out.kind).toBe('replaced');
    if (out.kind !== 'replaced') return;
    expect(out.removedId).toBe(777);
    expect(s.echoes.includes(lazy)).toBe(false);
  });

  it('plein + boucle moins bonne → « discarded », rien ne change', () => {
    const s = newState(NOW);
    fillSlots(s);
    const before = structuredClone(s.echoes);
    const nextId = s.nextEchoId;
    const weakestRate = echoRate(s, s.echoes[weakestIndex(s)]);

    const out = submitLoop(s, 50, 10, 'pire');
    expect(out.kind).toBe('discarded');
    if (out.kind !== 'discarded') return;
    expect(out.weakestRate).toBeCloseTo(weakestRate, 10);
    expect(out.rate).toBeLessThan(out.weakestRate);
    expect(s.echoes).toEqual(before);
    expect(s.nextEchoId).toBe(nextId);
  });

  it('à rendement égal, la boucle est jetée (il faut faire strictement mieux)', () => {
    const s = newState(NOW);
    fillSlots(s);
    const w = s.echoes[weakestIndex(s)];
    const before = structuredClone(s.echoes);
    expect(submitLoop(s, w.raw, w.duration, 'égal').kind).toBe('discarded');
    expect(s.echoes).toEqual(before);
  });

  it('un emplacement acheté rouvre l\'ajout', () => {
    const s = newState(NOW);
    fillSlots(s);
    s.levels.slots = 1;
    expect(submitLoop(s, 1, 10, 'faible').kind).toBe('added');
    expect(s.echoes.length).toBe(CFG.echo.baseSlots + 1);
  });

  it('bestLoop garde le meilleur butin brut', () => {
    const s = newState(NOW);
    submitLoop(s, 40, 12, 'a');
    submitLoop(s, 25, 12, 'b');
    expect(s.bestLoop).toBe(40);
    expect(s.loops).toBe(2);
  });
});

describe('prestige', () => {
  const P = CFG.prestige;

  it('fragmentsFor et earnedForFragments sont cohérents', () => {
    expect(fragmentsFor(0)).toBe(0);
    expect(fragmentsFor(-100)).toBe(0);
    expect(earnedForFragments(0)).toBe(0);
    for (let n = 1; n <= 30; n++) {
      const need = earnedForFragments(n);
      expect(fragmentsFor(need * 1.0001), `juste au-dessus de ${n}`).toBe(n);
      expect(fragmentsFor(need * 0.9999), `juste en dessous de ${n}`).toBe(n - 1);
      expect(earnedForFragments(n + 1)).toBeGreaterThan(need);
    }
  });

  it('fragmentsFor suit la formule de CFG et ne décroît jamais', () => {
    let prev = 0;
    for (let k = 0; k <= 40; k++) {
      const earned = P.divisor * k * 0.73;
      const f = fragmentsFor(earned);
      expect(f).toBe(Math.floor(Math.pow(earned / P.divisor, P.exponent)));
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it('prestigePreview : indisponible sous le seuil', () => {
    const s = newState(NOW);
    const need = earnedForFragments(P.minFragments);
    s.runEarned = need * 0.25;
    s.fragments = 3;
    s.echoes.push({ id: 1, raw: 120, duration: 12, rec: '' });
    const pv = prestigePreview(s);
    expect(pv.available).toBe(false);
    expect(pv.gain).toBe(fragmentsFor(s.runEarned));
    expect(pv.gain).toBeLessThan(P.minFragments);
    expect(pv.missing).toBeCloseTo(need * 0.75, 6);
    expect(pv.progress).toBeCloseTo(0.25, 10);
    expect(pv.fragmentsBefore).toBe(3);
    expect(pv.multBefore).toBe(prestigeMult(3));
    expect(pv.echoesLost).toBe(1);
    expect(pv.rateBefore).toBeCloseTo(totalRate(s), 10);
  });

  it('prestigePreview : disponible dès le seuil, multiplicateur en hausse', () => {
    const s = newState(NOW);
    s.fragments = 2;
    s.runEarned = earnedForFragments(P.minFragments + 3) * 1.0001;
    const pv = prestigePreview(s);
    expect(pv.available).toBe(true);
    expect(pv.gain).toBe(P.minFragments + 3);
    expect(pv.fragmentsAfter).toBe(2 + P.minFragments + 3);
    expect(pv.multAfter).toBe(prestigeMult(pv.fragmentsAfter));
    expect(pv.multAfter).toBeGreaterThan(pv.multBefore);
    expect(pv.missing).toBe(0);
    expect(pv.progress).toBe(1);
  });

  it('perkChoices : 3 bonus distincts, tirés de PERKS, déterministes', () => {
    for (let p = 0; p < 25; p++) {
      const s = newState(NOW);
      s.prestiges = p;
      const a = perkChoices(s);
      expect(a.length).toBe(3);
      expect(new Set(a.map((x) => x.id)).size).toBe(3);
      for (const c of a) expect(PERKS).toContain(c);
      // Même état → mêmes choix, y compris sur un autre objet d'état (rechargement).
      expect(perkChoices(s)).toEqual(a);
      const other = newState(NOW + 123456);
      other.prestiges = p;
      other.shards = 999;
      expect(perkChoices(other)).toEqual(a);
    }
  });

  it('perkChoices ne modifie pas PERKS', () => {
    const before = PERKS.map((p) => p.id);
    perkChoices(newState(NOW));
    expect(PERKS.map((p) => p.id)).toEqual(before);
  });

  /** État avancé, prêt pour l'Effondrement. */
  function richState(): GameState {
    const s = withLevels({ dmg: 6, rate: 3, slots: 2, power: 4, zone: 1, mrad: 2 });
    s.shards = 123_456;
    s.runEarned = earnedForFragments(P.minFragments + 2) * 1.0001;
    s.totalEarned = s.runEarned * 3;
    s.fragments = 7;
    s.prestiges = 2;
    s.runTime = 900;
    s.playTime = 5000;
    s.bestLoop = 800;
    s.echoes.push({ id: 1, raw: 400, duration: 12, rec: 'a' }, { id: 2, raw: 800, duration: 13, rec: 'b' });
    s.nextEchoId = 3;
    return s;
  }

  it('doPrestige refusé si l\'Effondrement est indisponible', () => {
    const s = richState();
    s.runEarned = earnedForFragments(P.minFragments) * 0.5;
    const before = structuredClone(s);
    expect(prestigePreview(s).available).toBe(false);
    expect(doPrestige(s, perkChoices(s)[0].id)).toBe(false);
    expect(s).toEqual(before);
  });

  it('doPrestige refusé si le bonus n\'est pas dans les choix proposés', () => {
    const s = richState();
    const before = structuredClone(s);
    const choices = perkChoices(s).map((p) => p.id);
    const outside = PERKS.find((p) => !choices.includes(p.id))!;
    expect(outside).toBeDefined();
    expect(doPrestige(s, outside.id)).toBe(false);
    expect(doPrestige(s, 'bonus-inexistant')).toBe(false);
    expect(s).toEqual(before);
  });

  it('doPrestige remet la partie à zéro, garde Fragments et bonus, augmente le multiplicateur', () => {
    const s = richState();
    const choices = perkChoices(s).map((p) => p.id);
    // Un bonus déjà possédé hors des choix : il doit survivre.
    const kept = PERKS.find((p) => !choices.includes(p.id) && p.id !== 'start')!.id;
    s.perks[kept] = 2;
    // On évite « start » (qui redonne des éclats au départ) pour vérifier la remise à zéro.
    const chosen = choices.find((id) => id !== 'start')!;
    const pv = prestigePreview(s);
    const multBefore = derive(s).globalMult;
    const totalBefore = s.totalEarned;
    const playBefore = s.playTime;

    expect(doPrestige(s, chosen)).toBe(true);

    expect(s.levels).toEqual({});
    expect(s.echoes).toEqual([]);
    expect(s.shards).toBe(0);
    expect(s.runEarned).toBe(0);
    expect(s.runTime).toBe(0);
    expect(s.bestLoop).toBe(0);
    expect(s.fragments).toBe(7 + pv.gain);
    expect(s.fragments).toBe(pv.fragmentsAfter);
    expect(s.prestiges).toBe(3);
    expect(s.perks).toEqual({ [kept]: 2, [chosen]: 1 });
    expect(s.totalEarned).toBe(totalBefore);
    expect(s.playTime).toBe(playBefore);
    expect(derive(s).globalMult).toBeGreaterThan(multBefore);
    expect(derive(s).globalMult).toBe(pv.multAfter);
    expect(totalRate(s)).toBe(0);
    // Plus rien à condenser juste après.
    expect(prestigePreview(s).available).toBe(false);
    expect(doPrestige(s, perkChoices(s)[0].id)).toBe(false);
  });

  it('doPrestige cumule un bonus déjà possédé', () => {
    const s = richState();
    const chosen = perkChoices(s)[0].id;
    s.perks[chosen] = 1;
    expect(doPrestige(s, chosen)).toBe(true);
    expect(s.perks[chosen]).toBe(2);
  });
});
