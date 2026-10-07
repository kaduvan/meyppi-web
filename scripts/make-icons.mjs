/* Renders the SVG logo suite into PNG icons (favicon, apple-touch, OG
   image) using sharp (already an Astro dependency). Runs before build.
   If sharp is unavailable the script warns and exits 0 — the site still
   builds with SVG favicons. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pub = path.join(root, 'public');

async function main() {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.warn('[icons] sharp unavailable — skipping PNG generation');
    return;
  }

  const mark = await readFile(path.join(pub, 'logo-mark.svg'));

  // favicon 32px
  await sharp(mark, { density: 300 })
    .resize(32, 32, { fit: 'contain', background: '#FFFFFF' })
    .png()
    .toFile(path.join(pub, 'favicon-32x32.png'));

  // apple-touch-icon 180px (solid indigo background, padded mark)
  const appleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">
    <rect width="180" height="180" fill="#1B2A4A"/>
    <g transform="translate(31,70) scale(1.0)">${mark.toString()
      .replace(/<svg[^>]*>/, '')
      .replace('</svg>', '')}</g>
  </svg>`;
  await sharp(Buffer.from(appleSvg)).png().toFile(
    path.join(pub, 'apple-touch-icon.png'),
  );

  // OG image 1200x630 — logo on white per brief §6
  const markB64 = mark.toString('base64');
  const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <rect width="1200" height="630" fill="#FFFFFF"/>
    <image x="440" y="150" width="320" height="109"
           href="data:image/svg+xml;base64,${markB64}"/>
    <text x="600" y="360" text-anchor="middle"
          font-family="Inter, Helvetica, Arial, sans-serif"
          font-size="72" font-weight="700" letter-spacing="10"
          fill="#1B2A4A">MEYPPI</text>
    <text x="600" y="425" text-anchor="middle"
          font-family="Inter, Helvetica, Arial, sans-serif"
          font-size="28" fill="#6B7280">Independent media delivery verification</text>
  </svg>`;
  await sharp(Buffer.from(ogSvg)).png().toFile(path.join(pub, 'og.png'));

  console.log('[icons] favicon-32x32.png, apple-touch-icon.png, og.png written');
}

main().catch((err) => {
  console.warn('[icons] failed (non-fatal):', err.message);
});
