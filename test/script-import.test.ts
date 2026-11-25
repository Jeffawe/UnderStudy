/**
 * Importing a Playwright script: assertions and waits are kept (or reported),
 * name lookups keep their kind, and the result replays. Needs Playwright's
 * Chromium; no database.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScript } from '../src/adapters/recorder/script.js';
import { replay, describeLocator, urlGlob } from '../src/core/replay.js';
import { emitFlow } from '../src/flows/emit.js';
import { stepsFrom } from '../src/flows/save.js';
import type { Flow } from '../src/store/types.js';
import { startFixtureApp, type FixtureApp } from './fixture-app.js';

let shop: FixtureApp;
let dir: string;
before(async () => {
  shop = await startFixtureApp();
  dir = await mkdtemp(join(tmpdir(), 'understudy-script-'));
});
after(async () => {
  await shop.close();
  await rm(dir, { recursive: true, force: true });
});

async function parse(body: string, base = 'https://shop.test/') {
  const file = join(dir, `s${Math.random().toString(36).slice(2)}.spec.ts`);
  await writeFile(file, `import { test, expect } from '@playwright/test';\ntest('x', async ({ page }) => {\n${body}\n});`);
  return parseScript(file, 'shop', base);
}

test('assertions and waits are kept as steps, in the order they happen', async () => {
  const { recording, warnings, dropped } = await parse(`
  await page.goto('/');
  await page.getByPlaceholder('you@example.com').fill('demo');
  await Promise.all([page.waitForURL('**/shop'), page.getByRole('button', { name: 'Log in' }).click()]);
  await expect(page).toHaveURL(/\\/shop$/);
  await expect(page).toHaveTitle('Shop');
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
  await expect(page.getByText('Sign in')).not.toBeVisible();
  await expect.soft(page.locator('nav')).toContainText('Profile');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('main h1');`);
  assert.deepEqual(warnings, []);
  assert.deepEqual(dropped, []);
  const shape = recording.events.map((e) => `${e.action}${e.hints?.assert ? `:${e.hints.assert}` : ''}`);
  assert.deepEqual(shape, ['goto', 'fill', 'click', 'wait_url', 'wait_url', 'assert:title', 'assert:visible', 'assert:hidden', 'assert:contains', 'assert:visible'],
    'the wait in Promise.all comes after the click it waits on');
  assert.equal(recording.events[1]!.hints?.by, 'placeholder');
  assert.equal(recording.events[4]!.hints?.urlRegex, true);
});

test('an assertion the IR cannot say is reported, not silently dropped', async () => {
  const { dropped, warnings } = await parse(`
  await page.goto('/');
  const heading = page.getByRole('heading');
  await expect(heading).toBeVisible();
  await expect(page.getByRole('list')).toHaveCount(3);
  await expect.poll(async () => 1).toBe(1);
  await page.waitForRequest('**/api');`);
  assert.equal(warnings.length, 0, 'dropped checks do not refuse the save');
  assert.equal(dropped.length, 4);
  assert.match(dropped[0]!, /held in a variable/);
  assert.match(dropped[1]!, /toHaveCount/);
  assert.match(dropped[2]!, /expect\.poll/);
  assert.match(dropped[3]!, /waitForRequest/);
});

test('a failed step names its locator; URL globs mean what Playwright means', () => {
  const base = { seq: 0, ts: 0, action: 'fill' as const, url: '', resolution: 'script-literal' as const };
  assert.equal(describeLocator({ ...base, name: 'Email', hints: { by: 'placeholder' } }), "getByPlaceholder('Email')");
  assert.equal(describeLocator({ ...base, role: 'button', name: 'Save', exact: true }), "getByRole('button', { name: 'Save', exact: true })");
  assert.equal(describeLocator({ ...base, css: '#x', hints: { nth: 1 } }), "locator('#x').nth(1)");
  assert.ok(urlGlob('**/shop').test('http://127.0.0.1:5000/shop'));
  assert.ok(!urlGlob('**/shop').test('http://127.0.0.1:5000/shop/cart'));
  assert.ok(urlGlob('/shop*').test('http://x/shop?a=1'));
});

test('an imported script with placeholder lookups and assertions replays, and a false assertion fails it', async () => {
  const script = (title: string) => `
  await page.goto('/');
  await page.getByPlaceholder('you@example.com').fill('demo');
  await page.getByLabel('Password').fill(process.env.SHOP_PW!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL('**/shop');
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
  await expect(page.locator('nav')).toContainText('Profile');
  await expect(page).toHaveTitle('${title}');`;

  const good = await parse(script('Shop'), shop.url);
  const ok = await replay(good.recording, { values: { 'ENV.SHOP_PW': 'x' }, timeoutMs: 3000 });
  assert.equal(ok.ok, true, JSON.stringify(ok.steps.filter((s) => !s.ok)));

  const bad = await parse(script('Nope'), shop.url);
  const failed = await replay(bad.recording, { values: { 'ENV.SHOP_PW': 'x' }, timeoutMs: 1500 });
  assert.equal(failed.ok, false);
  assert.match(failed.steps.at(-1)!.error!, /title to be "Nope" — saw "Shop"/);

  const missing = await parse(`
  await page.goto('/');
  await page.getByPlaceholder('nobody@example.com').fill('demo');`, shop.url);
  const r = await replay(missing.recording, { timeoutMs: 1000 });
  assert.match(r.steps.at(-1)!.error!, /locator getByPlaceholder\('nobody@example\.com'\) matched no elements/);
});

test('emit prints assertions back as expect(), with the same lookups', async () => {
  const { recording } = await parse(`
  await page.goto('/');
  await page.getByPlaceholder('Email').fill('a');
  await page.waitForURL('**/shop');
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('Ann');`);
  const flow = { app: 'shop', slug: 's', title: 'S', intent: 'S', steps: stepsFrom(recording) } as unknown as Flow;
  const { code, warnings } = emitFlow(flow);
  assert.match(code, /import \{ test, expect \}/);
  assert.match(code, /getByPlaceholder\('Email'\)\.fill\('a'\)/);
  assert.match(code, /waitForURL\('\*\*\/shop'\)/);
  assert.match(code, /expect\(page\.getByRole\('heading', \{ name: 'Shop' \}\)\)\.toBeVisible\(\)/);
  assert.match(code, /expect\(page\.getByLabel\('Name'\)\)\.toHaveValue\('Ann'\)/);
  assert.deepEqual(warnings, []);
});

test('action options are options, not values: force is kept, the rest are reported', async () => {
  const { recording, warnings } = await parse(`
  await page.goto('/checkout');
  await page.getByLabel('I agree to the terms').check({ force: true });
  await page.getByRole('button', { name: 'Pay Now' }).click({ force: true, timeout: 5000 });
  await page.getByRole('button', { name: 'More' }).click({ button: 'right' });
  await page.getByLabel('Size').selectOption({ label: 'Large' });
  await page.getByLabel('Name').fill('Ada', { timeout: 1000 });`);
  const [, check, pay, more, size, name] = recording.events;
  assert.equal(check!.valueRef, undefined, 'an options object is not a login value');
  assert.equal(check!.hints?.force, true);
  assert.equal(pay!.valueRef, undefined);
  assert.equal(pay!.hints?.force, true, 'timeout is ignorable; force still kept');
  assert.equal(more!.hints?.force, undefined);
  assert.equal(size!.value, 'Large');
  assert.equal(name!.value, 'Ada');
  assert.deepEqual(warnings.map((w) => w.split(':')[0]), ['click({ button }) cannot be represented, ignored']);
});

test('a literal URL wait moves the page later steps are stamped with; the first replay replaces the guess', async () => {
  const { recording } = await parse(`
  await page.goto('/');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL('/shop');
  await page.getByRole('link', { name: 'Cart' }).click();
  await page.waitForURL('**/cart');
  await page.getByRole('heading', { name: 'Your cart' }).click();`);
  const urls = recording.events.map((e) => new URL(e.url).pathname);
  assert.deepEqual(urls, ['/', '/', '/', '/shop', '/shop', '/shop'], 'a glob names no page, so it changes nothing');

  // The truth comes from running it.
  const { recording: live } = await parse(`
  await page.goto('/');
  await page.getByPlaceholder('you@example.com').fill('demo');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('link', { name: 'Cart' }).click();
  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();`, shop.url);
  assert.equal(new URL(live.events[3]!.url).pathname, '/', 'statically, "Cart" is stamped with the last goto');
  const result = await replay(live);
  assert.equal(result.ok, true, JSON.stringify(result.steps.filter((s) => !s.ok)));
  const steps = stepsFrom(live, result);
  assert.deepEqual(steps.map((s) => new URL(s.url).pathname), ['/', '/', '/', '/shop', '/cart'], 'each step now carries the page it ran on');
});

test('force reaches a checkbox under its label; stopBefore checks the commit and never presses it', { timeout: 60_000 }, async () => {
  const before = shop.committed();
  const { recording } = await parse(`
  await page.goto('/checkout');
  await page.getByLabel('I agree to the terms').check({ force: true });
  await page.getByRole('button', { name: 'Confirm & Submit' }).click();
  await page.getByRole('button', { name: 'Pay Now' }).click();`, shop.url);

  const unforced = { ...recording, events: recording.events.map((e) => ({ ...e, hints: { ...e.hints, force: false } })) };
  const blocked = await replay(unforced, { timeoutMs: 1500, stopBefore: 2 });
  assert.equal(blocked.ok, false, 'without force the label intercepts the click');

  const held = await replay(recording, { stopBefore: 2 });
  assert.equal(held.ok, true, JSON.stringify(held.steps.filter((s) => !s.ok)));
  assert.equal(held.stoppedBefore, 2);
  assert.deepEqual(held.steps.map((s) => s.held ?? false), [false, false, true]);
  assert.equal(held.steps.length, 3, 'nothing after the commit runs');
  assert.deepEqual(shop.committed(), before, 'nothing was submitted');

  // The control has to be ready: unticked, "Confirm & Submit" stays disabled.
  const skipped = { ...recording, events: [recording.events[0]!, recording.events[2]!, recording.events[3]!].map((e, seq) => ({ ...e, seq })) };
  const notReady = await replay(skipped, { timeoutMs: 1500, stopBefore: 1 });
  assert.equal(notReady.ok, false);
  assert.match(notReady.steps.at(-1)!.error!, /not enabled/);
});

test('a person\'s step: read from human(), asked at replay, finished by their answer or by the page', { timeout: 90_000 }, async () => {
  const { recording, warnings } = await parse(`
  await page.goto('/approval');
  human('Accept the visit in the provider portal', { untilText: 'Visit accepted' });
  await expect(page.getByRole('heading', { name: 'Visit accepted' })).toBeVisible();`, shop.url);
  assert.deepEqual(warnings, []);
  assert.equal(recording.events[1]!.action, 'human');
  assert.equal(recording.events[1]!.value, 'Accept the visit in the provider portal');
  assert.equal(recording.events[1]!.hints?.untilText, 'Visit accepted');

  // Nobody to ask: it fails there, rather than guessing.
  shop.set({ approved: false });
  const alone = await replay(recording, { timeoutMs: 2000 });
  assert.equal(alone.ok, false);
  assert.match(alone.steps[1]!.error!, /needs a person: Accept the visit/);

  // They answer once they've done it; the page is checked too.
  const asked: string[] = [];
  const answered = await replay(recording, {
    onHuman: async (req) => { asked.push(req.instruction); shop.set({ approved: true }); return { action: 'done' }; },
  });
  assert.equal(answered.ok, true, JSON.stringify(answered.steps.filter((s) => !s.ok)));
  assert.deepEqual(asked, ['Accept the visit in the provider portal']);
  assert.equal(answered.steps[1]!.viaHuman, 'answered');

  // Nobody answers, but it happens: the page shows it and the run carries on.
  shop.set({ approved: false });
  let withdrawn = false;
  setTimeout(() => shop.set({ approved: true }), 800);
  const byPage = await replay(recording, {
    onHuman: (_req, signal) => new Promise(() => { signal.addEventListener('abort', () => { withdrawn = true; }); }),
  });
  assert.equal(byPage.ok, true, JSON.stringify(byPage.steps.filter((s) => !s.ok)));
  assert.equal(byPage.steps[1]!.viaHuman, 'page');
  assert.equal(withdrawn, true, 'the question is withdrawn, so nobody waits on it');

  // They say done, but it isn't.
  shop.set({ approved: false });
  const wrong = await replay(recording, { timeoutMs: 1500, onHuman: async () => ({ action: 'done' }) });
  assert.equal(wrong.ok, false);
  assert.match(wrong.steps[1]!.error!, /said .* was done, but the page never showed it \(the text "Visit accepted"\)/);
  shop.set({ approved: false });

  // A proof stops before it, like a commit.
  const held = await replay(recording, { stopBefore: 1 });
  assert.equal(held.ok, true);
  assert.equal(held.stoppedBefore, 1);
});

test('a failed step handed to a person in the open browser carries on from where they left it', { timeout: 60_000 }, async () => {
  const { openLease } = await import('../src/core/browser.js');
  const { recording } = await parse(`
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in now' }).click();
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();`, shop.url);
  const lease = await openLease({ headless: true });
  try {
    const result = await replay(recording, {
      lease, timeoutMs: 1500,
      // The "person": does the step the recording got wrong — the button is "Log in".
      onHandoff: async () => { await lease.page.getByRole('button', { name: 'Log in' }).click(); return { action: 'continue' }; },
    });
    assert.equal(result.ok, true, JSON.stringify(result.steps.filter((s) => !s.ok)));
    assert.equal(result.steps[1]!.viaHandoff, true);
    assert.equal(result.handoffs.length, 1);
    assert.ok(result.steps[1]!.sig?.startsWith('/shop'), 'the page they left is where it carries on');
  } finally {
    await lease.close();
  }
});

test('waitForResponse becomes a wait for the server: every way a spec writes it, checked against what came back', { timeout: 60_000 }, async () => {
  const { recording, dropped } = await parse(`
  await page.goto('/book');
  const answer = page.waitForResponse((r) => r.url().includes('/api/visits') && r.status() === 201 && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Book' }).click();
  await answer;
  await Promise.all([page.waitForResponse('**/api/visits'), page.getByRole('button', { name: 'Book' }).click()]);
  await page.waitForResponse(/visits/);`, shop.url);
  assert.deepEqual(recording.events.map((e) => e.action), ['goto', 'click', 'wait_response', 'click', 'wait_response'], 'each wait lands after the click that triggers it');
  assert.equal(recording.events[2]!.value, '/api/visits');
  assert.deepEqual(recording.events[2]!.hints, { status: 201, method: 'POST' });
  assert.equal(recording.events[4]!.value, '**/api/visits');
  assert.match(dropped.join(), /waitForResponse\(\/regex\/\)/);

  shop.set({ commission: 12 });
  const result = await replay(recording);
  assert.equal(result.ok, true, JSON.stringify(result.steps.filter((s) => !s.ok)));

  // One JSON field, as edited into a flow: the commission was recorded.
  const checked = {
    ...recording,
    events: [...recording.events.slice(0, 2), { ...recording.events[2]!, hints: { method: 'POST', status: 201, field: 'commission.amount', above: 0 } }],
  };
  assert.equal((await replay(checked)).ok, true);
  shop.set({ commission: 0 });
  const zero = await replay(checked, { timeoutMs: 1500 });
  assert.equal(zero.ok, false);
  assert.match(zero.steps[2]!.error!, /no response matched POST \/api\/visits → 201, commission\.amount > 0 — saw POST \/api\/visits → 201 with commission\.amount = 0/);
  shop.set({ commission: 12 });

  // Exported, the wait is set up before the click and awaited after it.
  const flow = { app: 'shop', slug: 'book', title: 'Book', intent: 'book', destructive: false, steps: stepsFrom(checked) } as unknown as Flow;
  const code = emitFlow(flow).code.split('\n').map((l) => l.trim());
  const setup = code.findIndex((l) => l.startsWith('const response2 = page.waitForResponse('));
  const click = code.findIndex((l) => l.includes("name: 'Book' }).click()"));
  assert.ok(setup >= 0 && setup < click, code.join('\n'));
  assert.ok(code.includes('expect((await (await response2).json())?.commission?.amount).toBeGreaterThan(0);'), code.join('\n'));
  assert.match(emitFlow(flow, 'cypress-js').code, /cy\.intercept\(\{ method: 'POST', url: new RegExp\('\/api\/visits'\) \}\)\.as\('response2'\)/);
});

test('a person\'s step can end on a server answer the page never shows', { timeout: 60_000 }, async () => {
  const { openLease } = await import('../src/core/browser.js');
  const { recording } = await parse(`
  await page.goto('/book');
  human('Book the visit from the admin console', { untilResponse: { url: '/api/visits', status: 201, field: 'commission.amount', above: 0 } });`, shop.url);
  assert.deepEqual(recording.events[1]!.hints?.untilResponse, { url: '/api/visits', status: 201, field: 'commission.amount', above: 0 });
  const lease = await openLease({ headless: true });
  try {
    shop.set({ commission: 12 });
    const result = await replay(recording, {
      lease,
      // The "person" books it elsewhere; nobody answers — the server's reply ends the step.
      onHuman: () => { void lease.page.evaluate(() => fetch('/api/visits', { method: 'POST' })); return new Promise(() => {}); },
    });
    assert.equal(result.ok, true, JSON.stringify(result.steps.filter((s) => !s.ok)));
    assert.equal(result.steps[1]!.viaHuman, 'page');
  } finally {
    await lease.close();
  }
});
