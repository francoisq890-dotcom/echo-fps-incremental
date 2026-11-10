/**
 * Sauvegarde versionnée : localStorage, sauvegarde automatique, export/import en texte.
 */
import { CFG, UPGRADE_BY_ID, PERKS } from '../config';
import { base64ToBytes, bytesToBase64 } from '../core/util';
import { newState, type GameState } from './state';

const EXPORT_PREFIX = 'ECHO1:';

export function serialize(s: GameState): string {
  return JSON.stringify(s);
}

const num = (v: unknown, d: number, min = 0, max = Number.MAX_VALUE) =>
  typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : d;

/**
 * Reconstruit un état valide à partir de données arbitraires (ancienne version, texte importé…).
 * Tout champ absent ou invalide reprend sa valeur par défaut. Lève une erreur si ce n'est pas une sauvegarde.
 */
export function migrate(raw: unknown, now = Date.now()): GameState {
  if (!raw || typeof raw !== 'object') throw new Error('Sauvegarde illisible');
  const r = raw as Record<string, any>;
  if (typeof r.v !== 'number') throw new Error('Sauvegarde sans numéro de version');
  if (r.v > CFG.version) throw new Error('Sauvegarde créée par une version plus récente du jeu');
  // v0 → v1 : `earned` a été scindé en runEarned / totalEarned.
  if (r.v < 1) {
    r.runEarned = r.runEarned ?? r.earned ?? 0;
    r.totalEarned = r.totalEarned ?? r.earned ?? 0;
  }
  const s = newState(now);
  s.shards = num(r.shards, 0);
  s.runEarned = num(r.runEarned, 0);
  s.totalEarned = num(r.totalEarned, s.runEarned);
  s.fragments = Math.floor(num(r.fragments, 0));
  s.prestiges = Math.floor(num(r.prestiges, 0));
  s.tutorial = Math.floor(num(r.tutorial, 0));
  s.lastSeen = num(r.lastSeen, now, 0, now);
  s.playTime = num(r.playTime, 0);
  s.runTime = num(r.runTime, 0);
  s.loops = Math.floor(num(r.loops, 0));
  s.bestLoop = num(r.bestLoop, 0);
  s.nextEchoId = Math.floor(num(r.nextEchoId, 1, 1));
  if (r.levels && typeof r.levels === 'object') {
    for (const id of Object.keys(UPGRADE_BY_ID)) {
      const l = Math.floor(num(r.levels[id], 0, 0, UPGRADE_BY_ID[id].max));
      if (l > 0) s.levels[id] = l;
    }
  }
  if (r.perks && typeof r.perks === 'object') {
    for (const p of PERKS) {
      const c = Math.floor(num(r.perks[p.id], 0, 0, 1000));
      if (c > 0) s.perks[p.id] = c;
    }
  }
  if (Array.isArray(r.echoes)) {
    for (const e of r.echoes.slice(0, CFG.echo.maxSlots)) {
      if (!e || typeof e.rec !== 'string') continue;
      const raw = num(e.raw, 0), duration = num(e.duration, CFG.loop.baseDuration, 1, 120);
      if (raw <= 0) continue;
      const id = Math.floor(num(e.id, s.nextEchoId));
      s.echoes.push({ id, raw, duration, rec: e.rec });
      if (id >= s.nextEchoId) s.nextEchoId = id + 1;
    }
  }
  if (r.settings && typeof r.settings === 'object') {
    s.settings.volume = num(r.settings.volume, s.settings.volume, 0, 1);
    s.settings.music = num(r.settings.music, s.settings.music, 0, 1);
    s.settings.sens = num(r.settings.sens, s.settings.sens, 0.2, 3);
    s.settings.shake = num(r.settings.shake, s.settings.shake, 0, 1);
    s.settings.invertY = !!r.settings.invertY;
  }
  return s;
}

export function deserialize(text: string, now = Date.now()): GameState {
  return migrate(JSON.parse(text), now);
}

export function exportSave(s: GameState): string {
  return EXPORT_PREFIX + bytesToBase64(new TextEncoder().encode(serialize(s)));
}

export function importSave(text: string, now = Date.now()): GameState {
  const t = text.trim();
  if (!t.startsWith(EXPORT_PREFIX)) throw new Error('Ce texte n\'est pas une sauvegarde ÉCHO');
  const json = new TextDecoder().decode(base64ToBytes(t.slice(EXPORT_PREFIX.length)));
  return deserialize(json, now);
}

export function saveLocal(s: GameState, now = Date.now()): boolean {
  s.lastSeen = now;
  try {
    localStorage.setItem(CFG.save.key, serialize(s));
    return true;
  } catch {
    return false;
  }
}

export function loadLocal(now = Date.now()): GameState | null {
  try {
    const text = localStorage.getItem(CFG.save.key);
    if (!text) return null;
    return deserialize(text, now);
  } catch (e) {
    console.warn('Sauvegarde ignorée :', e);
    return null;
  }
}

export function wipeLocal(): void {
  try { localStorage.removeItem(CFG.save.key); } catch { /* stockage indisponible */ }
}
