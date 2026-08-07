#!/usr/bin/env node
/**
 * Bundle dom-accessibility-api into a browser-injectable IIFE, emitted as a TS
 * string constant.
 *
 *   npm run vendor:accname
 *
 * WHY a committed constant rather than a build artifact:
 * `addInitScript` needs plain browser-ready JavaScript, and the library ships
 * ESM/CJS. Generating into `dist/` would leave `tsx` dev runs without it;
 * reading from `node_modules` at runtime would break once the package is
 * installed elsewhere. A checked-in constant works identically in dev, in
 * `dist`, and for anyone who `npm i understudy`.
 *
 * WHY this exists at all: accessible name and role are the addressing scheme
 * for the whole system — selector dedupe, sig(), binding. They must be computed
 * IN THE PAGE, SYNCHRONOUSLY, at event time, because clicking frequently
 * destroys the element clicked. That is exactly what `playwright codegen` does
 * with its own injected bundle; this is the same move with a spec-compliant
 * implementation we can actually ship.
 */

import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';

const ENTRY = `
import { computeAccessibleName, getRole, isInaccessible } from 'dom-accessibility-api';
// isInaccessible mirrors what ariaSnapshot excludes (hidden / aria-hidden
// subtrees), so callers can compare like for like against Playwright.
window.__understudyA11y = { computeAccessibleName, getRole, isInaccessible };
`;

const result = await build({
  stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2018',
  minify: true,
  write: false,
  legalComments: 'none',
});

const code = result.outputFiles[0].text;

// JSON.stringify, not a template literal: the minified bundle contains
// backticks and ${ sequences that would terminate or interpolate one.
const file = `/**
 * GENERATED — do not edit. Regenerate with \`npm run vendor:accname\`.
 *
 * dom-accessibility-api bundled as a browser IIFE. Installs
 * window.__understudyA11y = { computeAccessibleName, getRole, isInaccessible }.
 *
 * Injected ahead of the recorder's listener so role and accessible name can be
 * computed in-page and synchronously, before a click can re-render the element
 * away. See scripts/vendor-accname.mjs for why this is vendored as a constant.
 */

export const ACCNAME_BUNDLE = ${JSON.stringify(code)};
`;

const out = 'src/adapters/recorder/accname-bundle.ts';
await writeFile(out, file, 'utf8');
console.log(`wrote ${out} (${(code.length / 1024).toFixed(1)} KB of injected JS)`);
