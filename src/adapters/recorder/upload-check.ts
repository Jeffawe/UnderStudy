/**
 * Gate for capturing file uploads in the LIVE recorder.
 *
 * The bug this exists to keep dead: a file input used to flow through the
 * deferred-text path and flush as a `fill` carrying the browser's masked
 * `C:\fakepath\<name>`. The step could not replay, the file was absent from the
 * recording entirely, and NOTHING reported either — so a recording that looked
 * complete was quietly useless, and the only way to capture an upload was to
 * leave Understudy and use `playwright codegen`.
 *
 * Cheap on purpose, in the style of handoff:check — no database, no corpus, no
 * model, no app. A temp page with two file inputs is enough to prove the whole
 * path: page detects, CDP resolves, the file is copied into the corpus.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordLive } from './live.js';

const PAGE = `<!doctype html>
<title>upload check</title>
<label for="one">Scalp photo</label>
<input id="one" type="file">
<label for="many">Supporting documents</label>
<input id="many" type="file" multiple>
`;

// A one-pixel PNG. Two distinct files, so the multi-file case proves ORDER and
// not merely count.
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_B = Buffer.concat([PNG_A, Buffer.from('understudy-b')]);

let failures = 0;
const ok = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!pass) failures++;
};

const work = await mkdtemp(join(tmpdir(), 'understudy-upload-'));
const fixtures = join(work, 'fixtures');
process.env.UNDERSTUDY_FIXTURES_DIR = fixtures;

try {
  await mkdir(fixtures, { recursive: true });
  const html = join(work, 'page.html');
  const fileA = join(work, 'scalp.png');
  const fileB = join(work, 'referral.png');
  await writeFile(html, PAGE);
  await writeFile(fileA, PNG_A);
  await writeFile(fileB, PNG_B);

  const recording = await recordLive({
    appSlug: 'upload-check',
    startUrl: pathToFileURL(html).href,
    headless: true,
    drive: async (page) => {
      await page.setInputFiles('#one', fileA);
      await page.setInputFiles('#many', [fileA, fileB]);
      // The recorder flushes deferred text on the next action; give the two
      // async binding round trips room to land before the browser closes.
      await page.waitForTimeout(500);
    },
  });

  const uploads = recording.events.filter((e) => e.action === 'upload');
  const fakepath = recording.events.filter((e) => (e.value ?? '').toLowerCase().includes('fakepath'));

  ok('no step carries a masked fakepath value', fakepath.length === 0, `${fakepath.length} found`);
  ok('a file input is never recorded as a fill', !recording.events.some((e) => e.action === 'fill'));
  ok('both uploads captured', uploads.length === 2, `got ${uploads.length}`);

  const single = uploads[0];
  const multi = uploads[1];
  if (single && multi) {

    const singlePath = single.value ?? '';
    ok('single upload has a value', singlePath.length > 0);
    ok('single upload points at a real file', existsSync(resolve(singlePath)), singlePath);
    ok(
      'single upload was copied into the corpus, not left on the desktop',
      singlePath.startsWith(fixtures) || resolve(singlePath).startsWith(fixtures),
      singlePath,
    );
    if (existsSync(resolve(singlePath))) {
      ok('copied bytes match the original', (await readFile(resolve(singlePath))).equals(PNG_A));
    }
    ok('upload keeps a literal value, never a SECRET valueRef', single.valueRef === undefined, single.valueRef ?? '');

    const parts = (multi.value ?? '').split('\n');
    ok('multi-file upload keeps both files, in order', parts.length === 2, `${parts.length} path(s)`);
    if (parts.length === 2) {
      const bytes = await Promise.all(parts.map((p) => readFile(resolve(p))));
      ok(
        'multi-file bytes match, in order',
        Boolean(bytes[0]?.equals(PNG_A)) && Boolean(bytes[1]?.equals(PNG_B)),
      );
      ok('identical files are stored once', parts[0] === singlePath, `${parts[0]} vs ${singlePath}`);
    }
  }
} catch (err) {
  ok('check ran without throwing', false, (err as Error).message.split('\n')[0]);
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nupload:check OK' : `\nupload:check FAILED (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
