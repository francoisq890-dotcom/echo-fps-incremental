// Test de déplacement en vrai navigateur (headless) : chaque touche, sur chaque disposition de clavier,
// doit déplacer le joueur dans la bonne direction, et aucune touche ne doit rester coincée.
// Prérequis : `npm run dev` lancé. Usage : node scripts/test-movement.mjs
import { chromium } from 'playwright';

const url = process.env.ECHO_URL ?? 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => !!window.__echo);
await page.evaluate(() => { window.__echo.save = () => {}; localStorage.clear(); });
await page.goto(url);
await page.waitForFunction(() => !!window.__echo);
await page.click('#t-play');
await page.waitForTimeout(400);

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name}${detail ? '  ' + detail : ''}`); };

/** Replace le joueur au centre, regard vers -Z, et renvoie son déplacement après `ms`. */
async function moveWith(downEvents, ms = 450) {
  await page.evaluate(() => { const p = window.__echo.player; p.x = 0; p.z = 0; p.y = 0; p.vx = p.vz = 0; p.yaw = 0; p.pitch = 0; p.grounded = true; });
  await page.evaluate((evs) => { for (const e of evs) window.dispatchEvent(new KeyboardEvent('keydown', e)); }, downEvents);
  await page.waitForTimeout(ms);
  const d = await page.evaluate(() => ({ x: window.__echo.player.x, z: window.__echo.player.z, frozen: window.__echo.player.frozen, phase: window.__echo.phase }));
  await page.evaluate((evs) => { for (const e of evs) window.dispatchEvent(new KeyboardEvent('keyup', e)); }, downEvents);
  await page.waitForTimeout(250);
  return d;
}

// Attendre d'être en pleine boucle (pas en rembobinage) avant chaque mesure.
const waitRun = () => page.waitForFunction(() => { const g = window.__echo; return g.phase === 'run' && g.loopT > 0.3 && g.loopT < g.stats.duration - 2.5 && !g.docked; }, null, { timeout: 30000 });

const DIRS = { avant: (d) => d.z < -1.2 && Math.abs(d.x) < 0.5, arrière: (d) => d.z > 1.2 && Math.abs(d.x) < 0.5, gauche: (d) => d.x < -1.2 && Math.abs(d.z) < 0.5, droite: (d) => d.x > 1.2 && Math.abs(d.z) < 0.5 };
const CASES = [
  // [description, direction attendue, événement clavier]
  ['QWERTY  W', 'avant', { code: 'KeyW', key: 'w' }],
  ['QWERTY  A', 'gauche', { code: 'KeyA', key: 'a' }],
  ['QWERTY  S', 'arrière', { code: 'KeyS', key: 's' }],
  ['QWERTY  D', 'droite', { code: 'KeyD', key: 'd' }],
  ['AZERTY  Z (code physique KeyW)', 'avant', { code: 'KeyW', key: 'z' }],
  ['AZERTY  Q (code physique KeyA)', 'gauche', { code: 'KeyA', key: 'q' }],
  ['AZERTY  S', 'arrière', { code: 'KeyS', key: 's' }],
  ['AZERTY  D', 'droite', { code: 'KeyD', key: 'd' }],
  ['AZERTY  Z quand le code suit la lettre (KeyZ)', 'avant', { code: 'KeyZ', key: 'z' }],
  ['AZERTY  Q quand le code suit la lettre (KeyQ)', 'gauche', { code: 'KeyQ', key: 'q' }],
  ['Sans code (clavier virtuel)  z', 'avant', { code: '', key: 'z' }],
  ['Sans code (clavier virtuel)  q', 'gauche', { code: '', key: 'q' }],
  ['Sans code (clavier virtuel)  s', 'arrière', { code: '', key: 's' }],
  ['Sans code (clavier virtuel)  d', 'droite', { code: '', key: 'd' }],
  ['Majuscule verrouillée  S', 'arrière', { code: 'KeyS', key: 'S' }],
  ['Majuscule verrouillée  D', 'droite', { code: 'KeyD', key: 'D' }],
  ['Flèche haut', 'avant', { code: 'ArrowUp', key: 'ArrowUp' }],
  ['Flèche bas', 'arrière', { code: 'ArrowDown', key: 'ArrowDown' }],
  ['Flèche gauche', 'gauche', { code: 'ArrowLeft', key: 'ArrowLeft' }],
  ['Flèche droite', 'droite', { code: 'ArrowRight', key: 'ArrowRight' }],
];
for (const [name, dir, ev] of CASES) {
  await waitRun();
  const d = await moveWith([ev]);
  check(name.padEnd(48) + '→ ' + dir, DIRS[dir](d), `(dx=${d.x.toFixed(2)}, dz=${d.z.toFixed(2)})`);
}

// Diagonale : deux touches à la fois.
await waitRun();
let d = await moveWith([{ code: 'KeyS', key: 's' }, { code: 'KeyD', key: 'd' }]);
check('Diagonale S + D → arrière-droite', d.x > 0.8 && d.z > 0.8, `(dx=${d.x.toFixed(2)}, dz=${d.z.toFixed(2)})`);

// Touche « coincée » : appui, perte de focus sans keyup → le joueur doit s'arrêter.
await waitRun();
await page.evaluate(() => { const p = window.__echo.player; p.x = 0; p.z = 0; p.vx = p.vz = 0; p.yaw = 0; });
await page.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' })); window.dispatchEvent(new Event('blur')); });
await page.waitForTimeout(350);
const a = await page.evaluate(() => window.__echo.player.z);
await page.waitForTimeout(350);
const b = await page.evaluate(() => window.__echo.player.z);
check('Perte de focus touche enfoncée → le joueur s\'arrête', Math.abs(b - a) < 0.05, `(dérive ${Math.abs(b - a).toFixed(3)} m)`);

// Le joueur continue d'avancer pendant un hit-stop (géode cassée).
await waitRun();
await page.evaluate(() => { const g = window.__echo; const p = g.player; p.x = 0; p.z = 0; p.vx = p.vz = 0; p.yaw = 0; g.hitStop = 0.4; window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' })); });
await page.waitForTimeout(400);
d = await page.evaluate(() => ({ z: window.__echo.player.z }));
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' })));
check('Déplacement fluide pendant un hit-stop', d.z < -1.2, `(dz=${d.z.toFixed(2)})`);

// Terminal : bouger suffit pour en sortir.
await waitRun();
await page.evaluate(() => { const g = window.__echo; g.player.x = 0; g.player.z = -3; g.player.yaw = 0; g.input.interactPressed = true; });
await page.waitForTimeout(700);
const docked = await page.evaluate(() => window.__echo.docked);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', key: 's' })));
await page.waitForTimeout(500);
const after = await page.evaluate(() => ({ docked: window.__echo.docked, frozen: window.__echo.player.frozen, z: window.__echo.player.z }));
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyS', key: 's' })));
check('Terminal : amarrage', docked);
check('Terminal : reculer fait sortir et libère le joueur', !after.docked && !after.frozen && after.z > -5.2, `(z=${after.z.toFixed(2)})`);

// Parcours : tour complet de l'arène puis traversée, sans jamais rester immobile hors rembobinage.
await page.evaluate(() => {
  const g = window.__echo;
  window.__stuck = { max: 0, cur: 0, where: null };
  g.input.debugHold('walk', 1);
  let ang = 0;
  window.__walk = setInterval(() => {
    const p = g.player;
    // Cap : suivre un cercle de 12 m de rayon (zone des géodes), en visant un point en avance sur le cercle.
    ang = Math.atan2(p.x, p.z) + 0.35;
    const tx = Math.sin(ang) * 12, tz = Math.cos(ang) * 12;
    p.yaw = Math.atan2(-(tx - p.x), -(tz - p.z));
    const moving = p.speed > 1.5;
    const free = g.phase === 'run' && !p.frozen;
    if (free && !moving) { window.__stuck.cur += 0.03; if (window.__stuck.cur > window.__stuck.max) { window.__stuck.max = window.__stuck.cur; window.__stuck.where = [p.x.toFixed(1), p.z.toFixed(1)]; } }
    else window.__stuck.cur = 0;
  }, 30);
});
await page.waitForTimeout(26000);
const stuck = await page.evaluate(() => { clearInterval(window.__walk); window.__echo.input.debugHold('walk', 0); return window.__stuck; });
check('Tour de l\'arène au milieu des géodes : jamais immobile plus de 0,4 s', stuck.max < 0.4, `(pire arrêt ${stuck.max.toFixed(2)} s${stuck.where ? ' en ' + stuck.where.join(', ') : ''})`);

console.log(errors.length ? 'Erreurs page : ' + errors.join(' | ') : 'console : aucune erreur');
console.log(failed ? `\n${failed} ÉCHEC(S)` : '\nTout passe.');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
