/**
 * The Chrome extension recorder, for real: Chromium is launched with the
 * unpacked extension from extension/, a flow is recorded in a tab through the
 * extension's own background worker, and the result is replayed headless.
 *
 * The popup isn't clicked (Playwright can't click an extension's toolbar
 * button); the test calls the same functions the popup sends messages to.
 * The test shop runs on 127.0.0.1, which the extension may always reach, so
 * no per-site permission prompt is needed here — on a real site the popup asks.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Worker } from 'playwright';

process.env.UNDERSTUDY_SESSIONS_DIR = await mkdtemp(join(tmpdir(), 'understudy-sessions-'));

const { startExtensionRecorder } = await import('../src/adapters/recorder/extension.js');
const { recordLive } = await import('../src/adapters/recorder/live.js');
const { replay } = await import('../src/core/replay.js');
const { execute } = await import('../src/flows/execute.js');
const { recorderSource } = await import('../scripts/build-extension.js');
import { startFixtureApp, type FixtureApp } from './fixture-app.js';

const EXTENSION = resolve('extension');
let shop: FixtureApp;
let browser: BrowserContext;
let worker: Worker;
let profile: string;
const values = { 'SECRET.password': 'not-a-real-password' };

before(async () => {
  shop = await startFixtureApp();
  profile = await mkdtemp(join(tmpdir(), 'understudy-chrome-'));
  browser = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent('serviceworker'));
});

after(async () => {
  await browser?.close();
  await shop?.close();
  await rm(profile, { recursive: true, force: true });
  await rm(process.env.UNDERSTUDY_SESSIONS_DIR!, { recursive: true, force: true });
});

/** Point the extension at a recorder, open the shop, and start recording on that tab. */
async function startOn(url: string, opts: { signedIn?: boolean } = {}) {
  const rec = await startExtensionRecorder({ appSlug: 'shop', port: 0 });
  const port = Number(new URL(rec.url).port);
  await worker.evaluate((p) => chrome.storage.local.set({ port: p }), port);
  const page = await browser.newPage();
  await page.goto(url);
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0]!.id!, url.replace(/\/[^/]*$/, '/'));
  const started = await worker.evaluate(
    ([id, signedIn]) => (self as unknown as { understudy: { startRecording: Function } }).understudy.startRecording(id, { signedIn }),
    [tabId, Boolean(opts.signedIn)] as const,
  );
  assert.equal((started as { app: string }).app, 'shop');
  return { rec, page };
}

const stop = () => worker.evaluate(() => (self as unknown as { understudy: { stopRecording: Function } }).understudy.stopRecording());
const brief = (events: { action: string; role?: string; name?: string; value?: string; valueRef?: string }[]) =>
  events.map((e) => [e.action, e.role, e.name, e.valueRef ?? e.value].filter(Boolean).join(' '));

test('extension/recorder.js is generated from the shared recorder and up to date', async () => {
  assert.equal(await readFile(join(EXTENSION, 'recorder.js'), 'utf8'), recorderSource(), 'run: npm run extension:build');
});

test('the local server only talks to extensions, and only with the token', async () => {
  const rec = await startExtensionRecorder({ appSlug: 'shop', port: 0 });
  const fromSite = await fetch(`${rec.url}/hello`, { headers: { origin: 'https://evil.example' } });
  assert.equal(fromSite.status, 403, 'a web page is refused');
  const noToken = await fetch(`${rec.url}/start`, { method: 'POST', body: JSON.stringify({ url: 'x' }) });
  assert.equal(noToken.status, 401);
  rec.stop();
  await rec.done;
});

test('record a flow in an open tab, then replay it headless', { timeout: 120_000 }, async () => {
  const { rec, page } = await startOn(shop.url);
  await page.getByRole('textbox', { name: 'Username' }).fill('demo');
  await page.getByRole('textbox', { name: 'Password' }).fill(values['SECRET.password']);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(/\/shop$/);
  await page.getByRole('link', { name: 'Cart' }).click();
  await page.waitForURL(/\/cart$/);
  await page.waitForTimeout(300);
  await stop();
  const out = await rec.done;
  await page.close();

  assert.deepEqual(brief(out.recording.events), [
    `goto ${shop.url}`,
    'fill textbox Username demo',
    'fill textbox Password SECRET.password',
    'click button Log in',
    'click link Cart', // recorded on the page AFTER a navigation: the recorder was re-injected
  ]);
  assert.equal(JSON.stringify(out.recording).includes(values['SECRET.password']), false, 'the password never leaves the page');
  assert.equal(out.recording.origin, 'chrome-extension');

  const result = await replay(out.recording, { values });
  assert.equal(result.ok, true, JSON.stringify(result.steps.filter((s) => !s.ok)));
  assert.ok(result.sigSequence.at(-1)?.startsWith('/cart'));
});

test('the same actions record identically with the Playwright recorder', { timeout: 120_000 }, async () => {
  const live = await recordLive({
    appSlug: 'shop',
    startUrl: shop.url,
    drive: async (page) => {
      await page.getByRole('textbox', { name: 'Username' }).fill('demo');
      await page.getByRole('textbox', { name: 'Password' }).fill(values['SECRET.password']);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.waitForURL(/\/shop$/);
      await page.getByRole('link', { name: 'Cart' }).click();
      await page.waitForURL(/\/cart$/);
    },
  });
  assert.deepEqual(brief(live.events), [
    `goto ${shop.url}`, 'fill textbox Username demo', 'fill textbox Password SECRET.password',
    'click button Log in', 'click link Cart',
  ]);
});

test('starting on a signed-in tab saves the session, so replay starts signed in', { timeout: 120_000 }, async () => {
  // Sign in first, NOT recorded — the way you'd already be signed in to your own app.
  const login = await browser.newPage();
  await login.goto(shop.url);
  await login.getByRole('textbox', { name: 'Username' }).fill('demo');
  await login.getByRole('textbox', { name: 'Password' }).fill('x');
  await login.getByRole('button', { name: 'Log in' }).click();
  await login.waitForURL(/\/shop$/);
  await login.close();

  const { rec, page } = await startOn(`${shop.url}shop`, { signedIn: true });
  await page.getByRole('link', { name: 'Profile' }).click();
  await page.waitForURL(/\/profile$/);
  await page.waitForTimeout(300);
  await stop();
  const out = await rec.done;
  await page.close();

  assert.deepEqual(brief(out.recording.events), [`goto ${shop.url}shop`, 'click link Profile']);
  assert.equal(out.recording.entry?.requiresSession, true);
  assert.ok(out.sessionPath, 'the session was saved');

  // Without the session, /shop bounces to the login page and the step can't be found.
  const cold = await replay(out.recording, {});
  assert.equal(cold.ok, false, 'a cold browser is not signed in');

  // execute() restores it, the way replay/save/run do.
  const warm = await execute(out.recording);
  assert.equal(warm.result.ok, true, JSON.stringify(warm.result.steps.filter((s) => !s.ok)));
  assert.ok(warm.result.sigSequence.at(-1)?.startsWith('/profile'));
});
