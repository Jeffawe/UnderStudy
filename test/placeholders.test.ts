/** Keeping email fields out of memory, per app — against a real database, in a throwaway home folder. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'understudy-home-'));
process.env.UNDERSTUDY_HOME = home;
process.env.MONGODB_DB = 'understudy_test_placeholders';
process.env.EMBED_URL = '';
process.env.EMBED_MODEL = '';
process.env.EMBED_KEY = '';
for (const k of Object.keys(process.env)) if (/^UNDERSTUDY_.*USER_EMAIL/.test(k)) delete process.env[k];

const { connect, close, collections } = await import('../src/store/db.js');
const { setPlaceholders, applyPlaceholders, isEmailStep } = await import('../src/memory/placeholders.js');
const { valuesFromEnv } = await import('../src/store/settings.js');
import type { Flow, Step } from '../src/store/types.js';

async function wipe() {
  const d = await connect();
  for (const c of await d.listCollections({}, { nameOnly: true }).toArray()) await d.collection(c.name).drop();
}
before(wipe);
after(async () => {
  try { await wipe(); } finally { await close(); await rm(home, { recursive: true, force: true }); }
});

const url = 'https://shop.test/';
const email = (value: string, name = 'Email address'): Step => ({ action: 'fill', role: 'textbox', name, value, url, resolution: 'accname' });
function flow(app: string, slug: string, steps: Step[]): Flow {
  const now = new Date();
  return {
    app, slug, title: slug, intent: slug, kind: 'recording', preconditions: [], outcome: '', destructive: false,
    corrections: [], recording: 'x', startUrl: url, requiresSession: false, searchText: slug, createdAt: now, updatedAt: now,
    steps: [{ action: 'goto', value: url, url, resolution: 'synthesized' }, ...steps],
  };
}
const stepsOf = async (app: string, slug: string) => (await (await collections()).flows.findOne({ app, slug }))!.steps;

test('what counts as an email field', () => {
  assert.equal(isEmailStep(email('a@x.test')), true);
  assert.equal(isEmailStep(email('demo', 'E-mail')), true, 'named email, whatever the value');
  assert.equal(isEmailStep({ ...email('someone@x.test'), name: 'Contact' }), true, 'looks like an address');
  assert.equal(isEmailStep({ ...email('demo'), name: 'Username' }), false);
  assert.equal(isEmailStep({ ...email('a@x.test'), action: 'click' }), false, 'only typing');
});

test('two test accounts in one app get two placeholders; the addresses move to the env file', async () => {
  const { flows } = await collections();
  await flows.insertMany([
    flow('shop', 'log-in', [email('alice@shop.test')]),
    flow('shop', 'reorder', [email('alice@shop.test')]),
    flow('shop', 'admin-log-in', [email('admin@shop.test', 'Admin email')]),
    flow('shop', 'browse', []),
  ]);

  const out = await setPlaceholders('shop', ['email']);
  assert.deepEqual(out.converted, [
    { placeholder: 'USER.email', flows: ['log-in', 'reorder'], valueIn: 'UNDERSTUDY_USER_EMAIL' },
    { placeholder: 'USER.email_2', flows: ['admin-log-in'], valueIn: 'UNDERSTUDY_USER_EMAIL_2' },
  ], 'the most-used address is USER.email');

  const step = (await stepsOf('shop', 'log-in'))[1]!;
  assert.equal(step.valueRef, 'USER.email');
  assert.equal('value' in step, false, 'the address is gone from memory');

  const file = await readFile(out.envFile!, 'utf8');
  assert.match(file, /^UNDERSTUDY_USER_EMAIL='alice@shop\.test'$/m);
  assert.match(file, /^UNDERSTUDY_USER_EMAIL_2='admin@shop\.test'$/m);
  assert.deepEqual(valuesFromEnv(['USER.email'], 'shop'), { 'USER.email': 'alice@shop.test' }, 'replay finds it');

  const again = await setPlaceholders('shop', ['email']);
  assert.deepEqual(again.converted, [], 'running it again changes nothing');
  assert.equal(again.envFile, undefined);
});

test('a second app with a different address gets its own variable, not the shared one', async () => {
  const { flows } = await collections();
  await flows.insertOne(flow('blog', 'log-in', [email('bob@blog.test')]));
  const out = await setPlaceholders('blog', ['email']);
  assert.deepEqual(out.converted, [{ placeholder: 'USER.email', flows: ['log-in'], valueIn: 'UNDERSTUDY_BLOG_USER_EMAIL' }]);
  assert.deepEqual(valuesFromEnv(['USER.email'], 'blog'), { 'USER.email': 'bob@blog.test' });
  assert.deepEqual(valuesFromEnv(['USER.email'], 'shop'), { 'USER.email': 'alice@shop.test' }, 'the other app is untouched');
});

test('a newly saved flow reuses the placeholder for a known address; a new address gets the next one', async () => {
  const { flows } = await collections();
  await flows.insertOne(flow('shop', 'checkout', [email('alice@shop.test'), email('carol@shop.test', 'Gift recipient email')]));
  const out = await applyPlaceholders('shop', undefined, 'checkout');
  const steps = await stepsOf('shop', 'checkout');
  assert.equal(steps[1]!.valueRef, 'USER.email', 'same address, same placeholder');
  assert.equal(steps[2]!.valueRef, 'USER.email_3');
  assert.deepEqual(out.converted.map((c) => c.placeholder).sort(), ['USER.email', 'USER.email_3']);
});

test('only known kinds', async () => {
  await assert.rejects(setPlaceholders('shop', ['phone']), /unknown placeholder kind/);
});
