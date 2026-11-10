/**
 * Tests de la production hors ligne : gain, plafond, crédit et cas limites d'horloge.
 */
import { describe, expect, it } from 'vitest';
import { CFG, UPGRADE_BY_ID } from '../src/config';
import { applyOffline, computeOffline, derive, newState, totalRate, type GameState } from '../src/economy/state';

const T0 = 1_700_000_000_000;

/** État avec deux échos productifs, vu pour la dernière fois à T0. */
function stateWithEchoes(): GameState {
  const s = newState(T0);
  s.echoes.push(
    { id: 1, raw: 60_000, duration: CFG.loop.baseDuration, rec: 'a' },
    { id: 2, raw: 25_000, duration: CFG.loop.baseDuration + 1, rec: 'b' },
  );
  s.nextEchoId = 3;
  return s;
}

describe('computeOffline', () => {
  it('gain = taux total × durée d\'absence', () => {
    const s = stateWithEchoes();
    const rate = totalRate(s);
    expect(rate).toBeGreaterThan(0);
    const cap = derive(s).offlineCapSec;
    for (const frac of [0.01, 0.1, 0.5, 0.9]) {
      const sec = Math.floor(cap * frac);
      const rep = computeOffline(s, T0 + sec * 1000);
      expect(rep.away).toBe(sec);
      expect(rep.counted).toBe(sec);
      expect(rep.capped).toBe(false);
      expect(rep.gain).toBe(Math.floor(rate * sec));
      expect(rep.echoes).toBe(2);
    }
  });

  it('ne modifie pas l\'état', () => {
    const s = stateWithEchoes();
    const before = structuredClone(s);
    computeOffline(s, T0 + 3_600_000);
    expect(s).toEqual(before);
  });

  it('respecte le plafond offlineCapSec (capped = true)', () => {
    const s = stateWithEchoes();
    const cap = derive(s).offlineCapSec;
    const rate = totalRate(s);
    const atCap = computeOffline(s, T0 + cap * 1000);
    expect(atCap.capped).toBe(false);
    expect(atCap.counted).toBe(cap);

    for (const extra of [1, 3600, 30 * 86_400]) {
      const rep = computeOffline(s, T0 + (cap + extra) * 1000);
      expect(rep.away).toBe(cap + extra);
      expect(rep.counted).toBe(cap);
      expect(rep.capped).toBe(true);
      expect(rep.gain).toBe(Math.floor(rate * cap));
      expect(rep.gain).toBe(atCap.gain);
    }
  });

  it('le plafond de base vient de CFG.offline.baseCapHours', () => {
    expect(derive(stateWithEchoes()).offlineCapSec).toBe(CFG.offline.baseCapHours * 3600);
  });

  it('l\'amélioration « offline » augmente le plafond et le gain d\'une longue absence', () => {
    const base = stateWithEchoes();
    const up = stateWithEchoes();
    up.levels.offline = Math.min(UPGRADE_BY_ID.offline.max, 2);
    const capBase = derive(base).offlineCapSec;
    const capUp = derive(up).offlineCapSec;
    expect(capUp).toBeGreaterThan(capBase);
    expect(capUp).toBe((CFG.offline.baseCapHours + CFG.offline.capHoursPerLevel * up.levels.offline) * 3600);

    // Absence comprise entre les deux plafonds : plafonnée sans l'amélioration, pas avec.
    const now = T0 + ((capBase + capUp) / 2) * 1000;
    const repBase = computeOffline(base, now);
    const repUp = computeOffline(up, now);
    expect(repBase.capped).toBe(true);
    expect(repUp.capped).toBe(false);
    expect(repUp.counted).toBeGreaterThan(repBase.counted);
    expect(repUp.gain).toBeGreaterThan(repBase.gain);

    // Absence très longue : chacun est limité par son propre plafond.
    const far = T0 + capUp * 10 * 1000;
    expect(computeOffline(base, far).counted).toBe(capBase);
    expect(computeOffline(up, far).counted).toBe(capUp);
  });

  it('chaque niveau de « offline » relève le plafond', () => {
    let prev = derive(stateWithEchoes()).offlineCapSec;
    for (let n = 1; n <= UPGRADE_BY_ID.offline.max; n++) {
      const s = stateWithEchoes();
      s.levels.offline = n;
      const cap = derive(s).offlineCapSec;
      expect(cap).toBeGreaterThan(prev);
      prev = cap;
    }
  });

  it('sans écho : aucun gain', () => {
    const s = newState(T0);
    const rep = computeOffline(s, T0 + 3_600_000);
    expect(rep.gain).toBe(0);
    expect(rep.echoes).toBe(0);
    expect(rep.away).toBe(3600);
  });

  it('horloge reculée (now < lastSeen) : absence nulle, aucun gain', () => {
    const s = stateWithEchoes();
    const rep = computeOffline(s, T0 - 86_400_000);
    expect(rep.away).toBe(0);
    expect(rep.counted).toBe(0);
    expect(rep.capped).toBe(false);
    expect(rep.gain).toBe(0);
  });

  it('le gain tient compte du multiplicateur des Fragments', () => {
    const a = stateWithEchoes();
    const b = stateWithEchoes();
    b.fragments = 10;
    const now = T0 + 3_600_000;
    expect(computeOffline(b, now).gain).toBeGreaterThan(computeOffline(a, now).gain);
    expect(computeOffline(b, now).gain).toBe(Math.floor(totalRate(b) * 3600));
  });
});

describe('applyOffline', () => {
  it('crédite le gain et remet lastSeen à now', () => {
    const s = stateWithEchoes();
    s.shards = 10; s.runEarned = 20; s.totalEarned = 30;
    const sec = CFG.offline.minSeconds * 10;
    const now = T0 + sec * 1000;
    const expected = computeOffline(s, now);
    expect(expected.gain).toBeGreaterThan(0);

    const rep = applyOffline(s, now);
    expect(rep).toEqual(expected);
    expect(rep!.gain).toBe(Math.floor(totalRate(s) * sec));
    expect(s.shards).toBe(10 + expected.gain);
    expect(s.runEarned).toBe(20 + expected.gain);
    expect(s.totalEarned).toBe(30 + expected.gain);
    expect(s.lastSeen).toBe(now);
  });

  it('ne crédite pas deux fois la même absence', () => {
    const s = stateWithEchoes();
    const now = T0 + CFG.offline.minSeconds * 20 * 1000;
    expect(applyOffline(s, now)).not.toBeNull();
    const shards = s.shards;
    expect(applyOffline(s, now)).toBeNull();
    expect(s.shards).toBe(shards);
  });

  it('une absence plafonnée ne crédite que le plafond', () => {
    const s = stateWithEchoes();
    const cap = derive(s).offlineCapSec;
    const rate = totalRate(s);
    const now = T0 + cap * 5 * 1000;
    const rep = applyOffline(s, now);
    expect(rep).not.toBeNull();
    expect(rep!.capped).toBe(true);
    expect(s.shards).toBe(Math.floor(rate * cap));
    expect(s.lastSeen).toBe(now);
  });

  it('retourne null sous CFG.offline.minSeconds, sans crédit, mais remet l\'horloge', () => {
    const s = stateWithEchoes();
    const now = T0 + Math.floor(CFG.offline.minSeconds * 1000 * 0.5);
    // Le gain théorique existe : c'est bien la durée minimale qui bloque.
    expect(computeOffline(s, now).gain).toBeGreaterThan(0);
    expect(applyOffline(s, now)).toBeNull();
    expect(s.shards).toBe(0);
    expect(s.runEarned).toBe(0);
    expect(s.totalEarned).toBe(0);
    expect(s.lastSeen).toBe(now);
  });

  it('juste sous le seuil → null ; au seuil → rapport', () => {
    const under = stateWithEchoes();
    expect(applyOffline(under, T0 + CFG.offline.minSeconds * 1000 - 1)).toBeNull();
    expect(under.shards).toBe(0);
    const at = stateWithEchoes();
    const rep = applyOffline(at, T0 + CFG.offline.minSeconds * 1000);
    expect(rep).not.toBeNull();
    expect(at.shards).toBe(rep!.gain);
  });

  it('retourne null sans écho, même après une longue absence', () => {
    const s = newState(T0);
    s.shards = 50;
    const now = T0 + 86_400_000;
    expect(applyOffline(s, now)).toBeNull();
    expect(s.shards).toBe(50);
    expect(s.totalEarned).toBe(0);
    expect(s.lastSeen).toBe(now);
  });

  it('horloge reculée (now < lastSeen) → aucun gain', () => {
    const s = stateWithEchoes();
    s.shards = 75;
    const now = T0 - 7 * 86_400_000;
    expect(applyOffline(s, now)).toBeNull();
    expect(s.shards).toBe(75);
    expect(s.runEarned).toBe(0);
    expect(s.totalEarned).toBe(0);
    // L'horloge est recalée : un retour ultérieur ne compte que depuis ce nouveau repère.
    expect(s.lastSeen).toBe(now);
    const later = now + CFG.offline.minSeconds * 4 * 1000;
    const rep = applyOffline(s, later);
    expect(rep).not.toBeNull();
    expect(rep!.away).toBe(CFG.offline.minSeconds * 4);
    expect(s.shards).toBe(75 + rep!.gain);
  });
});
