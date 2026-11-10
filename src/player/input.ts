/**
 * Entrées : clavier (KeyboardEvent.code → AZERTY et QWERTY sans réglage), souris en pointer lock,
 * et tactile (joystick à gauche, visée à droite, boutons).
 */
export class Input {
  moveX = 0; // droite +
  moveY = 0; // avant +
  lookX = 0; // delta accumulé, consommé par le contrôleur
  lookY = 0;
  fire = false;
  jumpPressed = false;
  interactPressed = false;
  pausePressed = false;
  /** Clic « pointé » (hors pointer lock ou tactile) : coordonnées écran, consommé par le terminal. */
  tap: { x: number; y: number } | null = null;
  locked = false;
  touch = false;
  /** Sur mobile, le tir part tout seul quand le viseur est sur une géode. */
  autoFire = false;
  private keys = new Set<string>();
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
      this.keys.add(e.code);
      if (e.code === 'Space') { this.jumpPressed = true; e.preventDefault(); }
      if (e.code === 'KeyE' || e.code === 'KeyF') this.interactPressed = true;
      if (e.code === 'Escape' || e.code === 'KeyP') this.pausePressed = true;
      if (e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.fire = false; });
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
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.fire = false;
      this.onLockChange?.(this.locked);
    });
    if (this.touch) this.setupTouch();
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
      if (up) el.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); up(); }, { passive: false });
    };
    bind('.btn-fire', () => (this.touchFire = true), () => (this.touchFire = false));
    bind('.btn-jump', () => (this.jumpPressed = true));
    bind('.btn-use', () => (this.interactPressed = true));
    bind('.btn-pause', () => (this.pausePressed = true));

    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.gesture();
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < window.innerWidth * 0.4 && this.joyId < 0) {
          this.joyId = t.identifier; this.joyOX = t.clientX; this.joyOY = t.clientY;
          stick.style.left = `${t.clientX}px`; stick.style.top = `${t.clientY}px`; stick.classList.add('on');
        } else if (this.lookId < 0) {
          this.lookId = t.identifier; this.lookPX = t.clientX; this.lookPY = t.clientY;
          this.tap = { x: t.clientX, y: t.clientY };
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
    const k = this.keys;
    let x = 0, y = 0;
    // `code` désigne la touche physique : KeyW est « Z » sur un clavier AZERTY, KeyA est « Q ».
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    x += this.joyX; y += this.joyY;
    const d = Math.hypot(x, y);
    if (d > 1) { x /= d; y /= d; }
    this.moveX = x; this.moveY = y;
    if (this.touch) this.fire = this.touchFire;
  }

  /** À appeler en fin d'image : remet à zéro les appuis ponctuels. */
  endFrame(): void {
    this.jumpPressed = false;
    this.interactPressed = false;
    this.pausePressed = false;
    this.tap = null;
    this.lookX = 0;
    this.lookY = 0;
  }
}
