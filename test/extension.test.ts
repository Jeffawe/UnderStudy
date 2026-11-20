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
const { execute, prove } = await import('../src/flows/execute.js');
const { loadSessionById } = await import('../src/core/auth-cache.js');
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
  for (const origin of ['chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'moz-extension://0b6f5c2e-1f3a-4c8e-9d2b-7a1e5f3c9b4d']) {
    const ext = await fetch(`${rec.url}/hello`, { headers: { origin } });
    assert.equal(ext.status, 200, `${origin.split(':')[0]} is let in`);
    assert.equal(ext.headers.get('access-control-allow-origin'), origin, 'and may read the token');
  }
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

  // The tab's sign-in was copied anyway; proving finds this flow doesn't need it, and deletes it.
  const id = out.recording.entry?.session;
  assert.ok(id, 'the session is always copied at the start');
  const proven = await prove(out.recording, { values });
  assert.equal(proven.result.ok, true, JSON.stringify(proven.result.steps.filter((s) => !s.ok)));
  assert.ok(proven.result.sigSequence.at(-1)?.startsWith('/cart'));
  assert.equal(proven.signIn, 'not needed');
  assert.equal(proven.recording.entry, undefined, 'saved without a session');
  assert.equal(await loadSessionById('shop', id!), undefined, 'the copied session was deleted');
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

test('unticked on a signed-in tab: proving finds it needs the sign-in, and keeps it', { timeout: 120_000 }, async () => {
  // Sign in first, NOT recorded — the way you'd already be signed in to your own app.
  const login = await browser.newPage();
  await login.goto(shop.url);
  await login.getByRole('textbox', { name: 'Username' }).fill('demo');
  await login.getByRole('textbox', { name: 'Password' }).fill('x');
  await login.getByRole('button', { name: 'Log in' }).click();
  await login.waitForURL(/\/shop$/);
  await login.close();

  const { rec, page } = await startOn(`${shop.url}shop`);
  await page.getByRole('link', { name: 'Profile' }).click();
  await page.waitForURL(/\/profile$/);
  await page.waitForTimeout(300);
  await stop();
  const out = await rec.done;
  await page.close();

  assert.deepEqual(brief(out.recording.events), [`goto ${shop.url}shop`, 'click link Profile']);
  assert.ok(out.sessionPath, 'the session was copied');

  // Without the session, /shop bounces to the login page and the step can't be found.
  const cold = await replay(out.recording, {});
  assert.equal(cold.ok, false, 'a cold browser is not signed in');

  // prove() tries cold, fails, tries signed in, passes — and says so.
  const proven = await prove(out.recording);
  assert.equal(proven.result.ok, true, JSON.stringify(proven.result.steps.filter((s) => !s.ok)));
  assert.equal(proven.signIn, 'needed');
  assert.equal(proven.recording.entry?.requiresSession, true, 'saved as starting signed in');

  // Every later replay restores it, the way replay/run/plans do.
  const again = await execute(proven.recording);
  assert.equal(again.result.ok, true);
  assert.ok(again.result.sigSequence.at(-1)?.startsWith('/profile'));
});

test('ticked "I\'m signed in here": the flow starts signed in, no guessing', { timeout: 120_000 }, async () => {
  // Still signed in from the previous test, in this same Chrome profile.
  const { rec, page } = await startOn(`${shop.url}shop`, { signedIn: true });
  await page.getByRole('link', { name: 'Cart' }).click();
  await page.waitForURL(/\/cart$/);
  await page.waitForTimeout(300);
  await stop();
  const out = await rec.done;
  await page.close();

  assert.equal(out.recording.entry?.requiresSession, true, 'required, because you said so');
  const proven = await prove(out.recording);
  assert.equal(proven.result.ok, true);
  assert.equal(proven.signIn, 'needed');
  assert.ok(await loadSessionById('shop', out.recording.entry!.session!), 'the session is kept');
});

test('allowing a site starts the recording by itself — the popup closing no longer loses the click', { timeout: 120_000 }, async () => {
  const rec = await startExtensionRecorder({ appSlug: 'shop', port: 0 });
  await worker.evaluate((p) => chrome.storage.local.set({ port: p }), Number(new URL(rec.url).port));
  const page = await browser.newPage();
  await page.goto(shop.url);
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0]!.id!, shop.url);
  const origin = new URL(shop.url).origin;

  // What the popup leaves behind before Chrome shows its dialog (and closes the popup).
  await worker.evaluate(([id, o]) => chrome.storage.session.set({ pending: { tabId: id, origin: o, signedIn: false, at: Date.now() } }), [tabId, origin] as const);

  // Some OTHER site being allowed must not start anything.
  await worker.evaluate(() => (self as unknown as { understudy: { onPermissionAdded: Function } }).understudy.onPermissionAdded({ origins: ['https://elsewhere.example/*'] }));
  assert.equal(await worker.evaluate(() => (self as unknown as { understudy: { current: Function } }).understudy.current()), undefined, 'a different site does not start it');

  // The site that was asked about being allowed does.
  await worker.evaluate((o) => (self as unknown as { understudy: { onPermissionAdded: Function } }).understudy.onPermissionAdded({ origins: [`${o}/*`] }), origin);
  const now = await worker.evaluate(() => (self as unknown as { understudy: { current: Function } }).understudy.current());
  assert.equal((now as { app: string }).app, 'shop', 'recording started with no further click');
  assert.equal(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId), 'REC');
  assert.equal((await worker.evaluate(() => chrome.storage.session.get('pending'))).pending, undefined, 'the note is used up');

  await page.getByRole('textbox', { name: 'Username' }).fill('demo');
  await page.waitForTimeout(300);
  await stop();
  const out = await rec.done;
  await page.close();
  assert.ok(out.recording.events.some((e) => e.name === 'Username'), 'and it recorded');
});

test('a start that fails after the popup closed shows up as a red ! and a message next time', { timeout: 60_000 }, async () => {
  // Nothing is listening on this port, so starting fails.
  await worker.evaluate(() => chrome.storage.local.set({ port: 1 }));
  const page = await browser.newPage();
  await page.goto(shop.url);
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0]!.id!, shop.url);
  const origin = new URL(shop.url).origin;
  await worker.evaluate(([id, o]) => chrome.storage.session.set({ pending: { tabId: id, origin: o, signedIn: false, at: Date.now() } }), [tabId, origin] as const);
  await worker.evaluate((o) => (self as unknown as { understudy: { onPermissionAdded: Function } }).understudy.onPermissionAdded({ origins: [`${o}/*`] }), origin);

  assert.equal(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId), '!');
  const { lastError } = await worker.evaluate(() => chrome.storage.session.get('lastError'));
  assert.match(lastError, /Understudy is not waiting/);
  await page.close();
  await worker.evaluate(() => chrome.storage.session.remove('lastError'));
});
