// Sonde de développement : lance le jeu en headless, joue quelques secondes, capture.
// Usage : node scripts/probe.mjs [nom] [secondes]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const name = process.argv[2] ?? 'probe';
const seconds = Number(process.argv[3] ?? 4);
const url = process.env.ECHO_URL ?? 'http://localhost:5173/';
mkdirSync('shots/tmp', { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => !!window.__echo);
await page.waitForTimeout(1500);
await page.screenshot({ path: `shots/tmp/${name}-title.png` });
await page.click('#t-play');
await page.waitForTimeout(600);
// Vise la géode la plus proche et tire en continu.
await page.evaluate(() => {
  const g = window.__echo;
  window.__aim = setInterval(() => {
    const run = g.run; if (!run) return;
    const sim = run.sim, p = g.player, c = { x: 0, y: 0, z: 0 };
    let best = -1, bd = 1e9;
    for (let i = 0; i < sim.specs.length; i++) {
      if (!sim.isActive(i)) continue;
      sim.pos(i, g.loopT, c);
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) { g.input.fire = false; return; }
    sim.pos(best, g.loopT, c);
    const dx = c.x - p.x, dy = c.y - p.eyeY, dz = c.z - p.z;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    g.input.fire = true;
    if (bd > 6.5) g.input.keys.add("KeyW"); else g.input.keys.delete("KeyW");
  }, 30);
});
await page.waitForTimeout(seconds * 1000);
await page.screenshot({ path: `shots/tmp/${name}-play.png` });
const info = await page.evaluate(() => {
  const g = window.__echo;
  return { perf: g.perf, shards: g.state.shards, echoes: g.state.echoes.length, phase: g.phase, loopT: g.loopT, tutorial: g.state.tutorial };
});
console.log(JSON.stringify(info));
console.log(errors.slice(0, 20).join('\n') || 'console: aucune erreur');
await browser.close();
