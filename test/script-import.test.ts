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
  await page.waitForResponse('**/api');`);
  assert.equal(warnings.length, 0, 'dropped checks do not refuse the save');
  assert.equal(dropped.length, 4);
  assert.match(dropped[0]!, /held in a variable/);
  assert.match(dropped[1]!, /toHaveCount/);
  assert.match(dropped[2]!, /expect\.poll/);
  assert.match(dropped[3]!, /waitForResponse/);
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
