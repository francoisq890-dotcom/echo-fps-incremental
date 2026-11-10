/**
 * Contrôleur FPS : déplacement, saut (coyote time + mise en tampon), jump pads, chute dans le vide.
 * La collision s'appuie sur les formes logiques de world/layout.ts.
 */
import { CFG } from '../config';
import { clamp, wrapAngle } from '../core/util';
import { PADS, START, groundAt, resolveSolids } from '../world/layout';
import type { Input } from './input';

export type PlayerEvent = 'jump' | 'land' | 'pad' | 'fall';

export class Player {
  x = START.x; y = START.y; z = START.z; // pieds
  vx = 0; vy = 0; vz = 0;
  yaw = START.yaw;
  pitch = 0;
  grounded = true;
  /** En vol après un jump pad : pas de contrôle aérien jusqu'à l'atterrissage. */
  launched = false;
  /** Hauteur d'œil lissée (montée de marche, atterrissage). */
  eyeY = START.y + CFG.player.eyeHeight;
  bob = 0;
  landDip = 0;
  speed = 0;
  /** Verrouille les déplacements (terminal, rembobinage). */
  frozen = false;
  /** Bornes de visée quand le joueur est amarré au terminal. */
  lookClamp: { yaw0: number; yawR: number; pitchMin: number; pitchMax: number } | null = null;
  private coyote = 0;
  private jumpBuffer = 0;
  private lastImpact = 0;
  events: PlayerEvent[] = [];

  reset(): void {
    this.x = START.x; this.y = START.y; this.z = START.z;
    this.vx = this.vy = this.vz = 0;
    this.grounded = true; this.launched = false;
    this.eyeY = this.y + CFG.player.eyeHeight;
  }

  get landImpact(): number { return this.lastImpact; }

  update(dt: number, input: Input, zoneLevel: number, sens: number, invertY: boolean): void {
    const P = CFG.player;
    // ——— Visée ———
    const k = 0.0022 * sens;
    this.yaw -= input.lookX * k;
    this.pitch -= input.lookY * k * (invertY ? -1 : 1);
    this.yaw = wrapAngle(this.yaw);
    this.pitch = clamp(this.pitch, -1.5, 1.5);
    if (this.lookClamp) {
      const c = this.lookClamp;
      this.yaw = c.yaw0 + clamp(wrapAngle(this.yaw - c.yaw0), -c.yawR, c.yawR);
      this.pitch = clamp(this.pitch, c.pitchMin, c.pitchMax);
    }

    if (this.frozen) {
      this.vx = this.vz = 0; this.vy = 0; this.speed = 0;
      this.eyeY += (this.y + P.eyeHeight - this.eyeY) * Math.min(1, dt * 14);
      return;
    }

    // ——— Déplacement horizontal ———
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = (input.moveX * cos - input.moveY * sin) * P.speed;
    const wz = (-input.moveX * sin - input.moveY * cos) * P.speed;
    if (!this.launched) {
      const accel = this.grounded ? 14 : 3.5;
      const a = Math.min(1, accel * dt);
      this.vx += (wx - this.vx) * a;
      this.vz += (wz - this.vz) * a;
    }

    // ——— Saut ———
    this.coyote = this.grounded ? 0.1 : this.coyote - dt;
    this.jumpBuffer = input.jumpPressed ? 0.12 : Math.max(0, this.jumpBuffer - dt);
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.vy = P.jumpSpeed;
      this.grounded = false;
      this.coyote = 0; this.jumpBuffer = 0;
      this.events.push('jump');
    }

    if (!this.grounded) this.vy -= P.gravity * dt;
    const prevY = this.y;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y += this.vy * dt;
    const pos = this as { x: number; y: number; z: number };
    resolveSolids(pos, P.radius, zoneLevel, P.stepHeight);

    // ——— Sol ———
    // En chute, on cherche le sol depuis la hauteur d'avant le pas : impossible de traverser une plateforme.
    const g = groundAt(this.x, this.z, this.grounded ? this.y : Math.max(prevY, this.y), zoneLevel, this.grounded ? P.stepHeight : 0.05);
    if (this.grounded) {
      if (g === -Infinity || g < this.y - P.stepHeight) {
        this.grounded = false; // on quitte un bord
      } else {
        this.y = g;
        this.vy = 0;
      }
    } else if (this.vy <= 0 && g > -Infinity && this.y <= g) {
      this.lastImpact = clamp(-this.vy / 22, 0, 1);
      this.y = g;
      this.vy = 0;
      this.grounded = true;
      this.launched = false;
      this.landDip = this.lastImpact;
      this.events.push('land');
    }

    // ——— Jump pads ———
    if (this.grounded) {
      for (const p of PADS) {
        if (p.zone > zoneLevel) continue;
        if (Math.abs(this.y - p.y) > 0.5) continue;
        const dx = this.x - p.x, dz = this.z - p.z;
        if (dx * dx + dz * dz < 1.3 * 1.3) {
          // Tir balistique : on arrive pile sur la cible en p.time secondes.
          this.vx = (p.tx - this.x) / p.time;
          this.vz = (p.tz - this.z) / p.time;
          this.vy = (p.ty + 0.3 - this.y + 0.5 * P.gravity * p.time * p.time) / p.time;
          this.grounded = false;
          this.launched = true;
          this.events.push('pad');
          break;
        }
      }
    }

    // ——— Chute dans le vide ———
    if (this.y < -26) {
      this.reset();
      this.events.push('fall');
    }

    // ——— Confort de caméra ———
    this.speed = Math.hypot(this.vx, this.vz);
    if (this.grounded) this.bob += this.speed * dt * 1.55;
    this.landDip = Math.max(0, this.landDip - dt * 4.5);
    const targetEye = this.y + P.eyeHeight;
    // Lissage vertical uniquement au sol (marches, rampes) ; en l'air la caméra suit exactement.
    this.eyeY = this.grounded ? this.eyeY + (targetEye - this.eyeY) * Math.min(1, dt * 18) : targetEye;
  }
}
