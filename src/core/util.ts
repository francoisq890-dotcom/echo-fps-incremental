/** Générateur pseudo-aléatoire déterministe (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi'];

/** 950 → « 950 », 1234 → « 1,23K », 3.4e6 → « 3,40M », au-delà → notation scientifique. */
export function fmt(n: number): string {
  if (!isFinite(n)) return '∞';
  const neg = n < 0;
  n = Math.abs(n);
  let out: string;
  if (n < 1000) {
    out = n < 10 && n % 1 !== 0 ? n.toFixed(1).replace('.', ',') : Math.floor(n).toString();
  } else {
    const tier = Math.floor(Math.log10(n) / 3);
    if (tier < SUFFIX.length) {
      const v = n / Math.pow(1000, tier);
      const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
      // Tronquer plutôt qu'arrondir : ne jamais afficher plus que ce qu'on possède.
      const f = Math.pow(10, digits);
      out = (Math.floor(v * f) / f).toFixed(digits).replace('.', ',') + SUFFIX[tier];
    } else {
      const e = Math.floor(Math.log10(n));
      out = (n / Math.pow(10, e)).toFixed(2).replace('.', ',') + 'e' + e;
    }
  }
  return neg ? '-' + out : out;
}

/** Taux par seconde : garde une décimale sous 100. */
export function fmtRate(n: number): string {
  if (n < 100) return (Math.round(n * 10) / 10).toFixed(1).replace('.', ',');
  return fmt(n);
}

export function fmtDuration(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h} h ${m.toString().padStart(2, '0')}`;
  if (m > 0) return `${m} min ${s.toString().padStart(2, '0')} s`;
  return `${s} s`;
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
