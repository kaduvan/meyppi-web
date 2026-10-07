/* Derives the brand asset suite from the approved logo PNG
   (brand-assets/logo-a.png — waveform mark + MEYPPI wordmark on a flat
   #F8F8F8 background, no alpha). Produces:

     public/brand/logo-full.png          full lockup, transparent bg
     public/brand/logo-full-reverse.png  full lockup, white/teal for dark bg
     public/brand/logo-mark.png          waveform mark only, transparent bg
     public/brand/logo-mark-reverse.png  waveform mark only, white/teal
     public/favicon-32x32.png
     public/apple-touch-icon.png
     public/og.png                       1200x630

   Uses sharp (an Astro dependency). Non-fatal if unavailable. */

import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pub = path.join(root, 'public');
const brandDir = path.join(pub, 'brand');

const BG = [248, 248, 248]; // baked-in background of the source PNG

const dist = (r, g, b) =>
  Math.sqrt((r - BG[0]) ** 2 + (g - BG[1]) ** 2 + (b - BG[2]) ** 2);

// alpha ramp: full transparent at bg, opaque once 60 units away — keeps
// anti-aliased edges smooth on both white and indigo backgrounds
const alphaFor = (d) => Math.max(0, Math.min(1, (d - 8) / 52)) * 255;

const isNavy = (r, g, b) => r < 120 && g < 130 && b > r && b >= g - 20;
const isTeal = (r, g, b) => g > 110 && g > r + 60 && b > 80 && r < 110;

async function loadSource() {
  const sharp = (await import('sharp')).default;
  const src = path.join(root, 'brand-assets', 'logo-a.png');
  return { sharp, raw: await sharp(src).raw().toBuffer({ resolveWithObject: true }) };
}

/** Full lockup with transparent background (navy+teal preserved). */
async function fullTransparent(sharp, { data, info }) {
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
    out[o + 3] = Math.round(alphaFor(dist(r, g, b)));
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/** Reverse lockup: navy -> white, teal kept, background transparent. */
async function fullReverse(sharp, { data, info }, { markOnly = false, splitY = null } = {}) {
  const h = markOnly ? splitY : info.height;
  const out = Buffer.alloc(info.width * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      const o = (y * info.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const a = alphaFor(dist(r, g, b));
      out[o + 3] = Math.round(a);
      if (isTeal(r, g, b)) {
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
      } else {
        // navy (and any anti-aliased navy edge) becomes white
        out[o] = 255; out[o + 1] = 255; out[o + 2] = 255;
      }
    }
  }
  return sharp(out, { raw: { width: info.width, height: h, channels: 4 } })
    .png()
    .toBuffer();
}

/** Find the row where the mark ends: after the first ink band (the
    waveform), the first empty run of >= 15 rows. Returns the first empty
    row of that run. */
function findMarkSplit({ data, info }) {
  const rowInk = new Array(info.height).fill(0);
  for (let y = 0; y < info.height; y++) {
    let ink = 0;
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      if (dist(data[i], data[i + 1], data[i + 2]) > 40) ink++;
    }
    rowInk[y] = ink;
  }
  const seenInk = rowInk.findIndex((n) => n > 5);
  let emptyRun = 0;
  for (let y = seenInk; y < info.height; y++) {
    if (rowInk[y] <= 2) {
      emptyRun++;
      if (emptyRun >= 15) return y - 14; // first row of this run
    } else {
      emptyRun = 0;
    }
  }
  return Math.floor(info.height * 0.7); // fallback: reasonable default
}

async function main() {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.warn('[icons] sharp unavailable — skipping PNG generation');
    return;
  }

  const raw = await readFile(path.join(root, 'brand-assets', 'logo-a.png')).catch(() => null);
  if (!raw) {
    console.warn('[icons] brand-assets/logo-a.png missing — skipping');
    return;
  }
  const src = await sharp(raw).raw().toBuffer({ resolveWithObject: true });
  await mkdir(brandDir, { recursive: true });

  const splitY = findMarkSplit(src);

  // full lockups (trimmed to ink bounds, palette-quantized)
  const fullPng = await sharp(await fullTransparent(sharp, src))
    .trim({ threshold: 18 }).png().toBuffer();
  const revPng = await sharp(await fullReverse(sharp, src))
    .trim({ threshold: 18 }).png().toBuffer();

  // the lockup is effectively 3 colors + anti-alias ramp, so 64-colour
  // palette with dither is visually lossless here
  const optimize = (buf, width) =>
    sharp(buf)
      .resize({ width })
      .png({ palette: true, colours: 64, dither: 1.0, compressionLevel: 9 })
      .toBuffer();

  const fullMeta = await sharp(fullPng).metadata();

  // mark-only: crop above the mark/wordmark gap, then trim — as two
  // separate sharp pipelines (extract+trim chained in one pipeline is
  // rejected by sharp)
  const markCrop = await sharp(await fullTransparent(sharp, src))
    .extract({ left: 0, top: 0, width: src.info.width, height: splitY })
    .png()
    .toBuffer();
  const markPng = await sharp(markCrop).trim({ threshold: 18 }).png().toBuffer();
  const markTrim = await sharp(markPng).metadata();
  const markRevCrop = await sharp(
    await fullReverse(sharp, src, { markOnly: true, splitY }),
  )
    .png()
    .toBuffer();
  const markRevTrim = await sharp(markRevCrop).trim({ threshold: 18 }).png().toBuffer();

  // write web-optimized sizes: nav/footer lockup at 480w (2x of 240),
  // hero mark at 960w (2x of 480)
  await sharp(await optimize(fullPng, 480)).toFile(path.join(brandDir, 'logo-full.png'));
  await sharp(await optimize(revPng, 480)).toFile(path.join(brandDir, 'logo-full-reverse.png'));
  await sharp(await optimize(markPng, 960)).toFile(path.join(brandDir, 'logo-mark.png'));
  await sharp(await optimize(markRevTrim, 960)).toFile(path.join(brandDir, 'logo-mark-reverse.png'));

  // favicon 32px — mark on white
  await sharp(markPng)
    .resize(32, 32, { fit: 'contain', background: '#FFFFFF' })
    .flatten({ background: '#FFFFFF' })
    .png()
    .toFile(path.join(pub, 'favicon-32x32.png'));

  // apple-touch-icon 180px — reverse mark on solid indigo
  const mRev = await sharp(markRevTrim).metadata();
  const pad = 40;
  const scale = Math.min(
    (180 - pad * 2) / mRev.width,
    (180 - pad * 2) / mRev.height,
  );
  const w = Math.round(mRev.width * scale);
  const h = Math.round(mRev.height * scale);
  await sharp({
    create: {
      width: 180,
      height: 180,
      channels: 4,
      background: { r: 27, g: 42, b: 74, alpha: 1 },
    },
  })
    .composite([
      {
        input: await sharp(markRevTrim).resize(w, h).png().toBuffer(),
        left: Math.round((180 - w) / 2),
        top: Math.round((180 - h) / 2),
      },
    ])
    .png()
    .toFile(path.join(pub, 'apple-touch-icon.png'));

  // OG image 1200x630 — full lockup on white + tagline
  const ogW = 560;
  const ogH = Math.round((fullMeta.height / fullMeta.width) * ogW);
  const lockup = await sharp(fullPng).resize(ogW, ogH).png().toBuffer();
  const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <rect width="1200" height="630" fill="#FFFFFF"/>
    <rect x="40" y="40" width="1120" height="550" fill="none" stroke="#D8DDE5" stroke-width="2"/>
    <image x="${(1200 - ogW) / 2}" y="170" width="${ogW}" height="${ogH}"
           href="data:image/png;base64,${lockup.toString('base64')}"/>
    <text x="600" y="520" text-anchor="middle"
          font-family="Inter, Helvetica, Arial, sans-serif"
          font-size="30" fill="#6B7280">Independent media delivery verification</text>
  </svg>`;
  await sharp(Buffer.from(ogSvg)).png({ compressionLevel: 9 }).toFile(path.join(pub, 'og.png'));

  console.log(
    `[icons] brand suite written (mark split at y=${splitY}, mark ${markTrim.width}x${markTrim.height})`,
  );
}

main().catch((err) => {
  console.warn('[icons] failed (non-fatal):', err.message);
});
