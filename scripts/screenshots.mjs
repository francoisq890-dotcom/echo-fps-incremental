// Captures headless des écrans clés + mesure de performance à 40 échos.
// Prérequis : `npm run dev` lancé (http://localhost:5173). Usage : npm run shots
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.env.ECHO_URL ?? 'http://localhost:5173/';
const only = process.argv[2];
mkdirSync('shots', { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

async function boot() {
  await page.goto(url);
  await page.waitForFunction(() => !!window.__echo);
  await page.waitForTimeout(1200);
}

/** Fabrique une partie avancée : le bot de simulation enregistre de vraies boucles. */
async function buildState(levels, echoes, extra = {}, mode = 'bot') {
  await page.evaluate(async ({ levels, echoes, extra, mode }) => {
    const { bestLoop } = await import('/src/sim/bot.ts');
    const st = await import('/src/economy/state.ts');
    const rec = await import('/src/echo/recording.ts');
    const s = st.newState();
    s.levels = levels;
    s.tutorial = 99;
    // Boucles « joueur qui tourne dans l'arène » : trajets variés, pour voir les échos se répartir.
    const roam = (k) => {
      const params = st.loopParams(s), stats = st.derive(s);
      const run = new rec.LoopRun(params);
      const dir = k % 2 ? 1 : -1, r = 4.5 + (k % 5) * 1.5, a0 = k * 2.4, c = { x: 0, y: 0, z: 0 };
      let nextShot = 0.2, yaw = 0, pitch = 0;
      const n = Math.floor(params.duration * 20) + 1;
      for (let i = 0; i < n; i++) {
        const t = i / 20, ang = a0 + dir * (5.5 / r) * t;
        const x = Math.sin(ang) * r, z = Math.cos(ang) * r;
        let best = -1, bd = 1e9;
        for (let g = 0; g < run.sim.specs.length; g++) {
          if (!run.sim.isActive(g) || run.sim.specs[g].zone > 0) continue;
          run.sim.pos(g, t, c);
          const d = Math.hypot(c.x - x, c.z - z);
          if (d < bd) { bd = d; best = g; }
        }
        if (best >= 0) {
          run.sim.pos(best, t, c);
          yaw = Math.atan2(-(c.x - x), -(c.z - z));
          pitch = Math.atan2(c.y - 1.6, Math.hypot(c.x - x, c.z - z));
        } else yaw = ang + (dir > 0 ? -Math.PI / 2 : Math.PI / 2) + Math.PI;
        run.tick(x, 1.6, z, yaw, pitch);
        if (best >= 0 && t >= nextShot && t < params.duration - 0.05) {
          const miss = (i * 7 + k * 3) % 5 === 0 ? 0.12 : 0;
          run.shoot(t + 0.01, x, 1.6, z, yaw + miss, pitch);
          nextShot = t + 1 / stats.fireRate;
        }
      }
      return run.finish();
    };
    for (let i = 0; i < echoes; i++) {
      const b = mode === 'roam' ? roam(i) : bestLoop(s, 100 + i * 7);
      st.submitLoop(s, b.result.shards, b.recording.params.duration, rec.encodeRecording(b.recording));
    }
    Object.assign(s, extra);
    window.__echo.loadState(s);
    window.__echo.save();
  }, { levels, echoes, extra, mode });
}

/** Petit pilote : vise la géode la plus rentable proche et avance vers elle. */
async function autopilot(on) {
  await page.evaluate((on) => {
    const g = window.__echo;
    clearInterval(window.__aim);
    g.input.fire = false; g.input.debugHold('auto', 0);
    if (!on) return;
    window.__aim = setInterval(() => {
      const run = g.run; if (!run || g.docked) { g.input.fire = false; return; }
      const sim = run.sim, p = g.player, c = { x: 0, y: 0, z: 0 };
      let best = -1, bd = 1e9;
      for (let i = 0; i < sim.specs.length; i++) {
        if (!sim.isActive(i) || sim.specs[i].zone > 0) continue;
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
      g.input.debugHold('auto', bd > 7 ? 1 : 0);
    }, 30);
  }, on);
}

const info = () => page.evaluate(() => {
  const g = window.__echo;
  return { fps: +g.perf.fps.toFixed(1), frameMs: +g.perf.frameMs.toFixed(2), drawCalls: g.perf.drawCalls, echoes: g.echoes.count, shards: Math.floor(g.state.shards), visibleShards: g.shards.count };
});

const shots = {
  async title() {
    await boot();
    await page.evaluate(() => { window.__echo.save = () => {}; localStorage.clear(); });
    await boot();
    await page.screenshot({ path: 'shots/01-accueil.png' });
  },

  async combat() {
    await boot();
    await buildState({ dmg: 9, rate: 6, slots: 11, power: 4, mobile: 2, explosive: 2, armored: 1, mrad: 5, mspd: 4, density: 3, rico: 1, chain: 1 }, 14, { shards: 18500, runEarned: 400000, totalEarned: 400000 }, 'roam');
    await page.click('#t-play');
    await autopilot(true);
    await page.waitForTimeout(6200);
    await page.screenshot({ path: 'shots/02-combat-14-echos.png' });
    console.log('combat', JSON.stringify(await info()));
    // Vue d'ensemble : on recule au bord pour voir les échos tirer en rythme.
    await autopilot(false);
    await page.evaluate(() => { const p = window.__echo.player; p.x = 10.5; p.z = 9.5; p.yaw = 0.83; p.pitch = -0.05; });
    await page.waitForTimeout(2600);
    await page.screenshot({ path: 'shots/02b-echos-en-rythme.png' });
  },

  async terminal() {
    await boot();
    await buildState({ dmg: 6, rate: 4, slots: 5, power: 3, mobile: 1, mrad: 3, mspd: 2, density: 1 }, 8, { shards: 4200, runEarned: 90000, totalEarned: 90000 });
    await page.click('#t-play');
    await page.waitForTimeout(500);
    await page.evaluate(() => { const g = window.__echo; g.player.x = 0; g.player.z = -2.5; g.input.interactPressed = true; });
    await page.waitForTimeout(900);
    // Survole la deuxième ligne de la famille ARME.
    await page.evaluate(() => { const p = window.__echo.player; p.yaw = 0.3; p.pitch = 0.36; });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'shots/03-terminal.png' });
    await page.evaluate(() => { const g = window.__echo; g.termAction({ type: 'tab', tab: 2 }); g.player.yaw = 0.3; g.player.pitch = 0.5; });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'shots/03b-terminal-arene.png' });
  },

  async prestige() {
    await boot();
    await buildState({ dmg: 22, rate: 11, slots: 18, power: 12, zone: 3, mobile: 4, explosive: 3, armored: 3, golden: 2, mrad: 9, mspd: 7, density: 7, rico: 2, pierce: 1, chain: 2, dur: 3 }, 21, { shards: 3.1e7, runEarned: 2.6e8, totalEarned: 2.6e8 });
    await page.click('#t-play');
    await page.waitForTimeout(500);
    await page.evaluate(() => { const g = window.__echo; g.player.x = 0; g.player.z = -2.5; g.input.interactPressed = true; });
    await page.waitForTimeout(900);
    await page.evaluate(() => { const g = window.__echo; g.termAction({ type: 'tab', tab: 5 }); g.player.yaw = -0.45; g.player.pitch = 0.18; });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'shots/04a-terminal-effondrement.png' });
    await page.evaluate(() => window.__echo.termAction({ type: 'prestige' }));
    await page.waitForTimeout(400);
    await page.click('.perk:nth-child(2)');
    await page.waitForTimeout(200);
    await page.screenshot({ path: 'shots/04-effondrement.png' });
  },

  async offline() {
    await boot();
    await buildState({ dmg: 9, rate: 6, slots: 9, power: 6, zone: 1, mobile: 2, mrad: 5, mspd: 4, density: 3 }, 12, { shards: 5300, runEarned: 300000, totalEarned: 300000 });
    // On recule l'horloge de la sauvegarde : 11 h d'absence (plafond : 8 h).
    await page.evaluate(() => {
      const key = 'echo-save-v1';
      const s = JSON.parse(localStorage.getItem(key));
      s.lastSeen = Date.now() - 11 * 3600 * 1000;
      localStorage.setItem(key, JSON.stringify(s));
      window.__echo.save = () => {};
    });
    await boot();
    await page.click('#t-play');
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'shots/05-retour-hors-ligne.png' });
  },

  async zones() {
    await boot();
    await buildState({ dmg: 22, rate: 11, slots: 12, power: 8, zone: 3, mobile: 4, explosive: 3, armored: 3, golden: 2, mrad: 9, mspd: 7, density: 5, rico: 2, chain: 2 }, 12, { shards: 2e6, runEarned: 6e7, totalEarned: 6e7 });
    await page.click('#t-play');
    await page.waitForTimeout(800);
    await page.evaluate(() => { const p = window.__echo.player; p.x = 29.4; p.y = 8; p.z = 17; p.grounded = true; p.yaw = 1.05; p.pitch = -0.12; });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'shots/07-zones.png' });
    await page.evaluate(() => { const p = window.__echo.player; p.x = 0; p.y = 15; p.z = 4; p.grounded = true; p.yaw = 3.1; p.pitch = -0.35; });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'shots/07b-aiguille.png' });
  },

  async elements() {
    await boot();
    await buildState({ dmg: 12, rate: 8, slots: 9, power: 6, zone: 1, mobile: 3, explosive: 2, armored: 2, mrad: 6, mspd: 4, density: 6, w2: 3, fire: 2, ice: 2, volt: 2 }, 6, { shards: 40000, runEarned: 9e5, totalEarned: 9e5 }, 'roam');
    await page.click('#t-play');
    await page.waitForTimeout(400);
    // Fracasseur + feu, au contact des géodes.
    await page.evaluate(() => { const g = window.__echo; g.selectWeapon(1); g.setElement(1); });
    await autopilot(true);
    await page.waitForTimeout(4200);
    await page.screenshot({ path: 'shots/09-fracasseur-feu.png' });
    // Éclateur + foudre : arcs entre géodes.
    await page.evaluate(() => { const g = window.__echo; g.selectWeapon(0); g.setElement(3); });
    await page.waitForTimeout(2600);
    await page.screenshot({ path: 'shots/09b-eclateur-foudre.png' });
    // Glace : géodes gelées.
    await page.evaluate(() => window.__echo.setElement(2));
    await page.waitForTimeout(2200);
    await page.screenshot({ path: 'shots/09c-glace.png' });
    console.log('elements', JSON.stringify(await info()));
    await autopilot(false);
    // Terminal, onglet ÉLÉMENTS.
    await page.evaluate(() => { const g = window.__echo; g.player.x = 0; g.player.z = -2.5; g.input.interactPressed = true; });
    await page.waitForTimeout(900);
    await page.evaluate(() => { const g = window.__echo; g.termAction({ type: 'tab', tab: 4 }); g.player.yaw = 0.3; g.player.pitch = 0.42; });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'shots/09d-terminal-elements.png' });
  },

  async perf() {
    await boot();
    await buildState({ dmg: 22, rate: 15, slots: 37, power: 12, zone: 3, mobile: 5, explosive: 5, armored: 3, golden: 3, mrad: 14, mspd: 8, density: 12, rico: 4, pierce: 2, chain: 4, dur: 4 }, 40, { shards: 9e7, runEarned: 4e8, totalEarned: 4e8 });
    await page.click('#t-play');
    await autopilot(true);
    await page.waitForTimeout(7000);
    const samples = [];
    for (let i = 0; i < 6; i++) { await page.waitForTimeout(700); samples.push(await info()); }
    await page.screenshot({ path: 'shots/06-40-echos.png' });
    console.log('perf 40 échos', JSON.stringify(samples));
  },
};

for (const [name, fn] of Object.entries(shots)) {
  if (only && only !== name) continue;
  await fn();
  console.log('✓', name);
}
console.log(errors.length ? errors.slice(0, 20).join('\n') : 'console : aucune erreur');
await browser.close();
process.exit(errors.length ? 1 : 0);
