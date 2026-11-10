// Post-traitement des images Higgsfield : raw-assets/ → public/assets/ (WebP, puissances de 2).
// Usage : npm run assets
import sharp from 'sharp';
import { mkdirSync, statSync, existsSync } from 'node:fs';

const RAW = 'raw-assets';
const OUT = 'public/assets';
mkdirSync(OUT, { recursive: true });

async function sky() {
  // Le panorama généré n'est pas réellement raccordé gauche/droite : on le met en miroir
  // (image + image retournée) pour obtenir un 360° sans couture, puis on passe en 2:1.
  const src = sharp(`${RAW}/sky_1.png`);
  const { width, height } = await src.metadata();
  const left = await src.toBuffer();
  const right = await sharp(left).flop().toBuffer();
  const wide = await sharp({ create: { width: width * 2, height, channels: 3, background: '#000' } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: width, top: 0 }])
    .png().toBuffer();
  await sharp(wide).resize(4096, 2048, { fit: 'fill' }).webp({ quality: 82 }).toFile(`${OUT}/sky.webp`);
  await sharp(wide).resize(512, 256, { fit: 'fill' }).blur(2).webp({ quality: 80 }).toFile(`${OUT}/sky_env.webp`);
}

async function texture(name, size, mod) {
  let img = sharp(`${RAW}/${name}_1.png`).resize(size, size, { fit: 'fill' });
  if (mod) img = img.modulate(mod);
  await img.webp({ quality: 80 }).toFile(`${OUT}/${name}.webp`);
}

async function icons() {
  // Grille 5 × 4 → atlas 640 × 512 (cellules de 128 px), fond conservé.
  await sharp(`${RAW}/icons_1.png`).resize(640, 512, { fit: 'fill' }).webp({ quality: 90 }).toFile(`${OUT}/icons.webp`);
}

async function title() {
  if (!existsSync(`${RAW}/title_1.png`)) return;
  await sharp(`${RAW}/title_1.png`).resize(1600, 900, { fit: 'cover' }).webp({ quality: 82 }).toFile(`${OUT}/title.webp`);
  await sharp(`${RAW}/title_1.png`).resize(1200, 630, { fit: 'cover' }).jpeg({ quality: 82 }).toFile(`${OUT}/og.jpg`);
}

await sky();
// Le sol généré est un peu saturé : on le calme pour qu'il ne dispute pas l'attention aux géodes.
await texture('floor', 1024, { saturation: 0.5, brightness: 1.08 });
await texture('wall', 1024, { saturation: 0.85 });
await icons();
await title();

let total = 0;
for (const f of ['sky.webp', 'sky_env.webp', 'floor.webp', 'wall.webp', 'icons.webp', 'title.webp', 'og.jpg']) {
  if (!existsSync(`${OUT}/${f}`)) continue;
  const s = statSync(`${OUT}/${f}`).size;
  total += s;
  console.log(f.padEnd(14), (s / 1024).toFixed(0).padStart(6), 'Ko');
}
console.log('TOTAL'.padEnd(14), (total / 1024).toFixed(0).padStart(6), 'Ko');
