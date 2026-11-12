/**
 * Entrées : clavier (KeyboardEvent.code → AZERTY et QWERTY sans réglage), souris en pointer lock,
 * et tactile (joystick à gauche, visée à droite, boutons).
 */
const FWD = 1, BACK = 2, LEFT = 4, RIGHT = 8;

/**
 * Directions d'une touche. On accepte à la fois la position physique (`code`) et le caractère
 * produit (`key`) : selon le système, le navigateur ou un clavier distant, `code` suit parfois
 * la lettre au lieu de la position. ZQSD et WASD marchent donc dans tous les cas.
 */
function moveBits(code: string, key: string): number {
  let b = 0;
  if (code === 'KeyW' || code === 'KeyZ' || code === 'ArrowUp' || key === 'z' || key === 'w' || key === 'ArrowUp') b |= FWD;
  if (code === 'KeyS' || code === 'ArrowDown' || key === 's' || key === 'ArrowDown') b |= BACK;
  if (code === 'KeyA' || code === 'KeyQ' || code === 'ArrowLeft' || key === 'q' || key === 'a' || key === 'ArrowLeft') b |= LEFT;
  if (code === 'KeyD' || code === 'ArrowRight' || key === 'd' || key === 'ArrowRight') b |= RIGHT;
  return b;
}

export class Input {
  moveX = 0; // droite +
  moveY = 0; // avant +
  lookX = 0; // delta accumulé, consommé par le contrôleur
  lookY = 0;
  fire = false;
  jumpPressed = false;
  interactPressed = false;
  pausePressed = false;
  /** Arme demandée cette image : -1 rien, 0 ou 1 = cette arme, 2 = l'autre (molette, bouton tactile). */
  weaponPressed = -1;
  /** Passer à l'élément suivant. */
  elemPressed = false;
  /** Clic « pointé » (hors pointer lock ou tactile) : coordonnées écran, consommé par le terminal. */
  tap: { x: number; y: number } | null = null;
  locked = false;
  touch = false;
  /** Sur mobile, le tir part tout seul quand le viseur est sur une géode. */
  autoFire = false;
  /** Vrai quand le joueur est amarré au terminal : un toucher bref devient un « clic » sur l'écran. */
  uiMode = false;
  private tapStart: { id: number; x: number; y: number } | null = null;
  private keys = new Set<string>();
  /** Touches de déplacement enfoncées : identifiant de touche → directions (bits). */
  private held = new Map<string, number>();
  private joyId = -1; private joyX = 0; private joyY = 0; private joyOX = 0; private joyOY = 0;
  private lookId = -1; private lookPX = 0; private lookPY = 0;
  private touchFire = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  onFirstGesture: (() => void) | null = null;
  private gestured = false;

  constructor(private canvas: HTMLCanvasElement, private touchRoot: HTMLElement) {
    this.touch = matchMedia('(pointer: coarse)').matches && 'ontouchstart' in window;
    this.autoFire = this.touch;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.gesture();
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.keys.add(e.code);
      const dir = moveBits(e.code, key);
      if (dir) this.held.set(e.code || key, dir);
      if (e.code === 'Space' || key === ' ') { this.jumpPressed = true; e.preventDefault(); }
      if (e.code === 'KeyE' || e.code === 'KeyF' || key === 'e' || key === 'f') this.interactPressed = true;
      if (e.code === 'Escape' || key === 'Escape' || e.code === 'KeyP' || key === 'p') this.pausePressed = true;
      // Rangée des chiffres : `code` d'abord (AZERTY y produit & et é), le caractère en secours.
      if (e.code === 'Digit1' || key === '1' || key === '&') this.weaponPressed = 0;
      if (e.code === 'Digit2' || key === '2' || key === 'é') this.weaponPressed = 1;
      if (e.code === 'KeyR' || key === 'r') this.elemPressed = true;
      if (e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.held.delete(e.code || (e.key.length === 1 ? e.key.toLowerCase() : e.key));
    });
    // Une touche relâchée pendant que la page n'a pas le focus ne nous prévient pas : on relâche tout.
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    canvas.addEventListener('mousedown', (e) => {
      this.gesture();
      if (e.button !== 0) return;
      if (this.locked) this.fire = true;
      else this.tap = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.fire = false; });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Certains navigateurs envoient un saut énorme juste après le verrouillage.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (Math.abs(e.deltaY) > 0) this.weaponPressed = 2; }, { passive: false });
    canvas.addEventListener('mousedown', (e) => { if (e.button === 2) this.elemPressed = true; });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.releaseAll();
      this.onLockChange?.(this.locked);
    });
    if (this.touch) this.setupTouch();
  }

  /** Relâche toutes les touches (perte de focus, pause, sortie du pointer lock) : aucune touche ne reste coincée. */
  releaseAll(): void {
    this.keys.clear();
    this.held.clear();
    this.fire = false;
    this.touchFire = false;
  }

  private gesture(): void {
    if (this.gestured) return;
    this.gestured = true;
    this.onFirstGesture?.();
  }

  requestLock(): void {
    if (this.touch || this.locked) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => { /* refus du navigateur (trop tôt après Échap) : le prochain clic réessaiera */ });
    } catch { /* idem */ }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private setupTouch(): void {
    const root = this.touchRoot;
    root.classList.add('on');
    const stick = root.querySelector<HTMLElement>('.stick')!;
    const knob = root.querySelector<HTMLElement>('.knob')!;
    const bind = (sel: string, down: () => void, up?: () => void) => {
      const el = root.querySelector<HTMLElement>(sel)!;
      el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); this.gesture(); down(); }, { passive: false });
      if (up) {
        el.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); up(); }, { passive: false });
        el.addEventListener('touchcancel', () => up());
      }
    };
    bind('.btn-fire', () => (this.touchFire = true), () => (this.touchFire = false));
    bind('.btn-jump', () => (this.jumpPressed = true));
    bind('.btn-use', () => (this.interactPressed = true));
    bind('.btn-pause', () => (this.pausePressed = true));
    bind('.btn-wpn', () => (this.weaponPressed = 2));
    bind('.btn-elem', () => (this.elemPressed = true));

    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.gesture();
      for (const t of Array.from(e.changedTouches)) {
        if (this.uiMode) {
          // Terminal : pas de joystick ; on attend le relâchement pour distinguer un toucher d'un glissé.
          if (!this.tapStart) this.tapStart = { id: t.identifier, x: t.clientX, y: t.clientY };
          if (this.lookId < 0) { this.lookId = t.identifier; this.lookPX = t.clientX; this.lookPY = t.clientY; }
          continue;
        }
        if (t.clientX < window.innerWidth * 0.4 && this.joyId < 0) {
          this.joyId = t.identifier; this.joyOX = t.clientX; this.joyOY = t.clientY;
          stick.style.left = `${t.clientX}px`; stick.style.top = `${t.clientY}px`; stick.classList.add('on');
        } else if (this.lookId < 0) {
          this.lookId = t.identifier; this.lookPX = t.clientX; this.lookPY = t.clientY;
        }
      }
    }, { passive: false });
    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joyId) {
          const dx = t.clientX - this.joyOX, dy = t.clientY - this.joyOY;
          const d = Math.hypot(dx, dy), max = 56;
          const k = d > max ? max / d : 1;
          this.joyX = (dx * k) / max; this.joyY = (-dy * k) / max;
          knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
        } else if (t.identifier === this.lookId) {
          this.lookX += (t.clientX - this.lookPX) * 2.2;
          this.lookY += (t.clientY - this.lookPY) * 2.2;
          this.lookPX = t.clientX; this.lookPY = t.clientY;
        }
      }
    }, { passive: false });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.tapStart && t.identifier === this.tapStart.id) {
          if (e.type === 'touchend' && Math.hypot(t.clientX - this.tapStart.x, t.clientY - this.tapStart.y) < 14) this.tap = { x: t.clientX, y: t.clientY };
          this.tapStart = null;
        }
        if (t.identifier === this.joyId) {
          this.joyId = -1; this.joyX = this.joyY = 0;
          stick.classList.remove('on'); knob.style.transform = '';
        } else if (t.identifier === this.lookId) this.lookId = -1;
      }
    };
    this.canvas.addEventListener('touchend', end);
    this.canvas.addEventListener('touchcancel', end);
  }

  /** À appeler une fois par image, avant de lire moveX / moveY. */
  poll(): void {
    let bits = 0;
    for (const b of this.held.values()) bits |= b;
    let x = 0, y = 0;
    if (bits & FWD) y += 1;
    if (bits & BACK) y -= 1;
    if (bits & RIGHT) x += 1;
    if (bits & LEFT) x -= 1;
    x += this.joyX; y += this.joyY;
    const d = Math.hypot(x, y);
    if (d > 1) { x /= d; y /= d; }
    this.moveX = x; this.moveY = y;
    if (this.touch) this.fire = this.touchFire;
  }

  /** Simule une touche de déplacement (tests et captures headless). */
  debugHold(id: string, bits: number): void {
    if (bits) this.held.set(id, bits); else this.held.delete(id);
  }

  /** À appeler en fin d'image : remet à zéro les appuis ponctuels. */
  endFrame(): void {
    this.jumpPressed = false;
    this.interactPressed = false;
    this.pausePressed = false;
    this.weaponPressed = -1;
    this.elemPressed = false;
    this.tap = null;
    this.lookX = 0;
    this.lookY = 0;
  }
}
