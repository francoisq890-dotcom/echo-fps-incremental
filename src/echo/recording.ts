/**
 * Enregistrement compressé d'une boucle et rejeu.
 *
 * - positions (œil du joueur) et orientation échantillonnées à 20 Hz, en int16 ;
 * - tirs horodatés (ms) avec origine et direction quantifiées.
 *
 * `LoopRun` quantifie AVANT d'alimenter la simulation : le direct et le rejeu voient donc
 * strictement les mêmes nombres, et `replay()` redonne toujours le même butin.
 */
import { CFG } from '../config';
import { base64ToBytes, bytesToBase64, wrapAngle } from '../core/util';
import { LoopSim, type LoopResult, type SimEvent } from './loopsim';
import type { LoopParams } from './pattern';

const POS_Q = 50; // 2 cm
const ANG_Q = 10000; // 0,1 mrad
const SAMPLE_STRIDE = 5; // x y z yaw pitch
/** Ancien format : t(ms) x y z yaw pitch. Format 2 : + nature du tir (arme et élément). */
const shotStride = (p: LoopParams) => (p.fmt === 2 ? 7 : 6);

export interface Recording {
  params: LoopParams;
  samples: Int16Array;
  shots: Int16Array;
}

const qPos = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * POS_Q))) + 0; // + 0 : jamais de -0
const qAng = (a: number) => Math.round(wrapAngle(a) * ANG_Q);

function dirFrom(yawQ: number, pitchQ: number, out: { x: number; y: number; z: number }): void {
  const yaw = yawQ / ANG_Q, pitch = pitchQ / ANG_Q;
  const cp = Math.cos(pitch);
  // Convention caméra Three.js : yaw 0 regarde vers -Z, yaw positif tourne vers la gauche.
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
}

export function tickCount(duration: number): number {
  return Math.floor(duration * CFG.loop.sampleHz + 1e-6) + 1;
}

/** Une boucle en cours : enregistre et simule en même temps. */
export class LoopRun {
  readonly sim: LoopSim;
  private samples: number[] = [];
  private shots: number[] = [];
  private dir = { x: 0, y: 0, z: 0 };
  ticks = 0;

  readonly params: LoopParams;

  constructor(params: LoopParams) {
    this.params = { ...params, fmt: 2 };
    this.sim = new LoopSim(this.params);
  }

  /** Nombre d'échantillons qui auraient dû être pris à l'instant t. */
  ticksDue(t: number): number {
    return Math.min(tickCount(this.params.duration), Math.floor(t * CFG.loop.sampleHz + 1e-6) + 1);
  }

  /** Échantillon n° `ticks` (instant ticks / 20 s). */
  tick(x: number, y: number, z: number, yaw: number, pitch: number): void {
    const qx = qPos(x), qy = qPos(y), qz = qPos(z);
    this.samples.push(qx, qy, qz, qAng(yaw), qAng(pitch));
    this.sim.sample(this.ticks / CFG.loop.sampleHz, qx / POS_Q, qy / POS_Q, qz / POS_Q);
    this.ticks++;
  }

  shoot(t: number, x: number, y: number, z: number, yaw: number, pitch: number, kind = 0): void {
    const tms = Math.max(0, Math.min(32767, Math.round(t * 1000)));
    const qx = qPos(x), qy = qPos(y), qz = qPos(z), qyaw = qAng(yaw), qp = qAng(pitch);
    this.shots.push(tms, qx, qy, qz, qyaw, qp, kind);
    dirFrom(qyaw, qp, this.dir);
    this.sim.shoot(tms / 1000, qx / POS_Q, qy / POS_Q, qz / POS_Q, this.dir.x, this.dir.y, this.dir.z, kind);
  }

  finish(): { recording: Recording; result: LoopResult } {
    const result = this.sim.finish();
    return {
      recording: { params: this.params, samples: Int16Array.from(this.samples), shots: Int16Array.from(this.shots) },
      result,
    };
  }
}

/** Rejoue un enregistrement dans une simulation neuve. Déterministe. */
export function replay(rec: Recording): { result: LoopResult; events: SimEvent[] } {
  const sim = new LoopSim(rec.params);
  const dir = { x: 0, y: 0, z: 0 };
  const nS = rec.samples.length / SAMPLE_STRIDE;
  const stride = shotStride(rec.params);
  const nShots = Math.floor(rec.shots.length / stride);
  let si = 0;
  for (let k = 0; k < nS; k++) {
    const tk = k / CFG.loop.sampleHz;
    // Les tirs antérieurs à l'échantillon passent d'abord, comme en direct.
    while (si < nShots && rec.shots[si * stride] / 1000 < tk) si = feedShot(sim, rec, si, dir, stride);
    const o = k * SAMPLE_STRIDE;
    sim.sample(tk, rec.samples[o] / POS_Q, rec.samples[o + 1] / POS_Q, rec.samples[o + 2] / POS_Q);
  }
  while (si < nShots) si = feedShot(sim, rec, si, dir, stride);
  const result = sim.finish();
  return { result, events: sim.events };
}

function feedShot(sim: LoopSim, rec: Recording, si: number, dir: { x: number; y: number; z: number }, stride: number): number {
  const o = si * stride;
  dirFrom(rec.shots[o + 4], rec.shots[o + 5], dir);
  sim.shoot(rec.shots[o] / 1000, rec.shots[o + 1] / POS_Q, rec.shots[o + 2] / POS_Q, rec.shots[o + 3] / POS_Q, dir.x, dir.y, dir.z, stride === 7 ? rec.shots[o + 6] : 0);
  return si + 1;
}

export interface Pose { x: number; y: number; z: number; yaw: number; pitch: number }

/** Pose interpolée de l'écho à l'instant t de sa boucle. */
export function poseAt(rec: Recording, t: number, out: Pose): void {
  const n = rec.samples.length / SAMPLE_STRIDE;
  if (n === 0) { out.x = out.y = out.z = out.yaw = out.pitch = 0; return; }
  const f = Math.max(0, Math.min(n - 1, t * CFG.loop.sampleHz));
  const i0 = Math.floor(f), i1 = Math.min(n - 1, i0 + 1), a = f - i0;
  const s = rec.samples, o0 = i0 * SAMPLE_STRIDE, o1 = i1 * SAMPLE_STRIDE;
  out.x = (s[o0] + (s[o1] - s[o0]) * a) / POS_Q;
  out.y = (s[o0 + 1] + (s[o1 + 1] - s[o0 + 1]) * a) / POS_Q;
  out.z = (s[o0 + 2] + (s[o1 + 2] - s[o0 + 2]) * a) / POS_Q;
  const y0 = s[o0 + 3] / ANG_Q;
  out.yaw = y0 + wrapAngle(s[o1 + 3] / ANG_Q - y0) * a;
  out.pitch = (s[o0 + 4] + (s[o1 + 4] - s[o0 + 4]) * a) / ANG_Q;
}

export function shotCount(rec: Recording): number { return Math.floor(rec.shots.length / shotStride(rec.params)); }

// ——— Sérialisation texte (sauvegarde) ———

export function encodeRecording(rec: Recording): string {
  const head = JSON.stringify(rec.params);
  const b1 = bytesToBase64(new Uint8Array(rec.samples.buffer, rec.samples.byteOffset, rec.samples.byteLength));
  const b2 = bytesToBase64(new Uint8Array(rec.shots.buffer, rec.shots.byteOffset, rec.shots.byteLength));
  return `${head}|${b1}|${b2}`;
}

export function decodeRecording(text: string): Recording {
  const i2 = text.lastIndexOf('|');
  const i1 = text.lastIndexOf('|', i2 - 1);
  if (i1 < 0 || i2 < 0) throw new Error('Enregistrement illisible');
  const params = JSON.parse(text.slice(0, i1)) as LoopParams;
  const toI16 = (b64: string) => {
    const bytes = base64ToBytes(b64);
    return new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
  };
  return { params, samples: toI16(text.slice(i1 + 1, i2)), shots: toI16(text.slice(i2 + 1)) };
}
