#!/usr/bin/env node
/**
 * Draw the extension's icons: a white "record" dot on a rounded blue square.
 *
 *   node scripts/make-icons.mjs
 *
 * Drawn at 4× and averaged down so the edges stay smooth at 16 px. The PNGs
 * are committed; re-run only to change the design.
 */

import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const BLUE = [61, 90, 254];
const WHITE = [255, 255, 255];
const SS = 4; // supersampling

function draw(size) {
  const big = size * SS;
  const radius = big * 0.22; // corner rounding
  const ring = big * 0.3; // outer radius of the white ring
  const ringWidth = big * 0.07;
  const dot = big * 0.16; // inner dot
  const c = big / 2;

  const pixel = (x, y) => {
    // Rounded square: distance to the nearest corner circle.
    const qx = Math.max(Math.abs(x - c) - (c - radius), 0);
    const qy = Math.max(Math.abs(y - c) - (c - radius), 0);
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
