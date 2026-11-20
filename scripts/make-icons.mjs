#!/usr/bin/env node
/**
 * Draw the extension's icons: a white "record" dot on a rounded blue square.
 *
 *   node scripts/make-icons.mjs
 *
 * Also writes build/store/store-icon-128.png for the Chrome Web Store, which
 * wants the artwork at 96×96 inside a 128×128 image, with 16 px of
 * transparent padding on every side.
 *
 * Drawn at 4× and averaged down so the edges stay smooth at 16 px. The PNGs
 * are committed; re-run only to change the design.
 */

import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const BLUE = [61, 90, 254];
const WHITE = [255, 255, 255];
const SS = 4; // supersampling

function draw(size, pad = 0) {
  const big = size * SS;
  const inset = pad * SS; // transparent margin around the artwork
  const art = big - 2 * inset;
  const radius = art * 0.22; // corner rounding
  const ring = art * 0.3; // outer radius of the white ring
  const ringWidth = art * 0.07;
  const dot = art * 0.16; // inner dot
  const c = big / 2;
  const half = art / 2;

  const pixel = (x, y) => {
    // Rounded square: distance to the nearest corner circle.
    const qx = Math.max(Math.abs(x - c) - (half - radius), 0);
    const qy = Math.max(Math.abs(y - c) - (half - radius), 0);
    if (Math.hypot(qx, qy) > radius) return null; // outside: transparent
    const d = Math.hypot(x - c, y - c);
    if (d <= dot || (d <= ring && d >= ring - ringWidth)) return WHITE;
    return BLUE;
  };

  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = pixel(x * SS + sx + 0.5, y * SS + sy + 0.5);
          if (!p) continue;
          r += p[0]; g += p[1]; b += p[2]; a += 255;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const covered = a / 255;
      png.data[i] = covered ? Math.round(r / covered) : 0;
      png.data[i + 1] = covered ? Math.round(g / covered) : 0;
      png.data[i + 2] = covered ? Math.round(b / covered) : 0;
      png.data[i + 3] = Math.round(a / n);
    }
  }
  return PNG.sync.write(png);
}

mkdirSync('extension/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(`extension/icons/icon-${size}.png`, draw(size));
  console.log(`wrote extension/icons/icon-${size}.png`);
}
mkdirSync('build/store', { recursive: true });
writeFileSync('build/store/store-icon-128.png', draw(128, 16));
console.log('wrote build/store/store-icon-128.png (96×96 artwork, 16 px transparent padding)');
