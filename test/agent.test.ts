/**
 * Phase 4 end to end: the agent layer, with this test playing the agent.
 *
 * Two recordings (cart, profile) are saved, then distilled into segments. A
 * goal is planned from segments of BOTH — decompose question, bindings,
 * seams — and run in one browser. Then the parts an agent touches: an
 * unbridgeable seam (ask, refuse a non-answer, remember a real one), lessons
 * firing, a fact marking a control destructive, and a bad batch rejected whole.
 *
 * Needs local MongoDB and Playwright's Chromium; no model.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_DB = 'understudy_test_agent';
process.env.EMBED_URL = '';
process.env.EMBED_MODEL = '';

const { connect, close, collections } = await import('../src/store/db.js');
const { saveFlow } = await import('../src/flows/save.js');
const { distillRequest, saveDistilled } = await import('../src/flows/distill.js');
const { start, answer, runPlan } = await import('../src/plan/planner.js');
const { remember } = await import('../src/memory/notes.js');
const { replay } = await import('../src/core/replay.js');
const { buildRecording } = await import('../src/core/recording.js');
import { startFixtureApp, type FixtureApp } from './fixture-app.js';

let shop: FixtureApp;
const values = { 'SECRET.password': 'not-a-real-password' };

async function wipe() {
  const d = await connect();
  for (const c of await d.listCollections({}, { nameOnly: true }).toArray()) await d.collection(c.name).drop();
}
before(async () => { shop = await startFixtureApp(); await wipe(); });
after(async () => { try { await wipe(); } finally { await close(); await shop.close(); } });

/** Sign in, then click one link on the shop page. */
function recordingTo(link: string) {
  const u = shop.url;
  return buildRecording({ source: 'live', origin: `test-${link}`, appSlug: 'shop', startUrl: u }, [
    { seq: 0, ts: 0, action: 'goto', url: u, resolution: 'synthesized' },
    { seq: 1, ts: 1, action: 'fill', role: 'textbox', name: 'Username', value: 'demo', url: u, resolution: 'accname' },
    { seq: 2, ts: 2, action: 'fill', role: 'textbox', name: 'Password', valueRef: 'SECRET.password', url: u, resolution: 'accname' },
    { seq: 3, ts: 3, action: 'click', role: 'button', name: 'Log in', url: u, resolution: 'accname' },
    { seq: 4, ts: 4, action: 'click', role: 'link', name: link, url: `${u}shop`, resolution: 'accname' },
  ]);
}

async function proveAndSave(link: string, title: string) {
  const rec = recordingTo(link);
  const proof = await replay(rec, { values });
  assert.equal(proof.ok, true, `proving ${title} failed`);
  return saveFlow(rec, proof, { title });
}

test('distill: validated, every problem at once; segments merge by slug', { timeout: 120_000 }, async () => {
  await proveAndSave('Cart', 'Open the cart');
  await proveAndSave('Profile', 'View the profile');

  const req = await distillRequest('shop', 'open-the-cart');
  assert.equal(req.steps.length, 5);
  assert.ok(req.steps[3]!.sigAfter?.startsWith('/shop'), 'each step says which page it reached');

  await assert.rejects(
    saveDistilled('shop', 'open-the-cart', {
      intent: 'open the cart', outcome: 'on the cart', preconditions: ['authenticated as a member'],
      segments: [{ slug: 'Log In', title: 'x', intent: 'x', stepRange: [0, 9] }],
    }),
    (e: Error) => /preconditions/.test(e.message) && /kebab-case/.test(e.message) && /outside/.test(e.message),
    'all three problems reported together',
  );

  const a = await saveDistilled('shop', 'open-the-cart', {
    intent: 'sign in and open the cart', outcome: 'on the cart page', preconditions: ['not authenticated'],
    segments: [
      { slug: 'log-in', title: 'Log in', intent: 'sign in to the shop', stepRange: [0, 4], preconditions: ['not authenticated'] },
      { slug: 'open-the-cart-from-the-shop', title: 'Open the cart from the shop', intent: 'go to the cart', stepRange: [4, 5], preconditions: ['authenticated'] },
    ],
  });
  assert.deepEqual(a.segments.map((s) => [s.slug, s.steps, s.replaced]), [['log-in', 4, false], ['open-the-cart-from-the-shop', 1, false]]);

  const b = await saveDistilled('shop', 'view-the-profile', {
    intent: 'sign in and view the profile', outcome: 'on the profile page', preconditions: ['not authenticated'],
    segments: [
      { slug: 'log-in', title: 'Log in', intent: 'sign in to the shop', stepRange: [0, 4], preconditions: ['not authenticated'] },
      { slug: 'open-the-profile-from-the-shop', title: 'Open the profile from the shop', intent: 'go to the profile', stepRange: [4, 5], preconditions: ['authenticated'] },
    ],
  });
  assert.equal(b.segments[0]!.replaced, true, 'reusing log-in merged it instead of making a rival');

  const { flows } = await collections();
  assert.equal(await flows.countDocuments({ app: 'shop', kind: 'segment' }), 3);
  const cart = await flows.findOne({ app: 'shop', slug: 'open-the-cart-from-the-shop' });
  assert.deepEqual(cart?.from, { flow: 'open-the-cart', steps: [4, 5] });
});

test('plan: decompose → bind segments from two recordings → seams → run', { timeout: 120_000 }, async () => {
  const q = await start({ app: 'shop', goal: 'check my profile, then my cart' });
  assert.equal(q.status, 'waiting');
  assert.equal((q as { question: { kind: string } }).question.kind, 'decompose');
  const vocab = (q as { question: { vocabulary: { segments: { slug: string }[] } } }).question.vocabulary;
  assert.ok(vocab.segments.some((s) => s.slug === 'open-the-profile-from-the-shop'), 'the agent is shown the segments');

  // The agent answers in the app's own words.
  const planned = await answer(q.runId, { subGoals: ['log-in', 'open-the-profile-from-the-shop', 'open-the-cart-from-the-shop'] });
  assert.equal(planned.status, 'planned', JSON.stringify(planned));
  if (planned.status !== 'planned') return;
  assert.deepEqual(planned.plan, ['log-in', 'open-the-profile-from-the-shop', 'open-the-cart-from-the-shop']);
  assert.match(planned.seams[0]!.how, /ends where/, 'log-in already ends on the shop page');
  assert.match(planned.seams[1]!.how, /navigate to \/shop/, 'profile → shop: plain address, so go there');

  const { executed, recorded } = await runPlan(planned.runId, { values });
  assert.equal(executed.result.ok, true, JSON.stringify(executed.result.steps.filter((s) => !s.ok)));
  const pages = executed.result.sigSequence.map((s) => s.slice(0, s.indexOf('#')));
  assert.deepEqual(pages, ['/', '/shop', '/profile', '/shop', '/cart']);
  const { runs } = await collections();
  const run = await runs.findOne({ _id: recorded.runId });
  assert.equal(run?.status, 'passed');
  assert.equal(run?.question, undefined);
});

test('plan: a seam it can\'t bridge is asked, never guessed', { timeout: 60_000 }, async () => {
  const { flows } = await collections();
  // A flow starting on a page with an id in its address: no page-map link, can't just navigate there.
  const now = new Date();
  await flows.insertOne({
    app: 'shop', slug: 'reorder', title: 'Reorder', intent: 'reorder', kind: 'segment', preconditions: ['authenticated'],
    outcome: '', destructive: false, corrections: [], recording: 'x', startUrl: `${shop.url}orders/1`, requiresSession: false,
    startState: '/orders/:id#00000000', steps: [{ action: 'click', role: 'button', name: 'Again', url: `${shop.url}orders/1`, resolution: 'accname' }],
    searchText: 'reorder', createdAt: now, updatedAt: now,
  });

  const q = await start({ app: 'shop', goal: 'reorder', subGoals: ['log-in', 'reorder'], dryRun: true });
  assert.equal(q.status, 'waiting');
  const question = (q as { question: Record<string, unknown> }).question;
  assert.equal(question.kind, 'seam');
  assert.ok(Array.isArray(question.knownLinksFromHere), 'evidence comes with the question');

  await assert.rejects(answer(q.runId, { steps: [{ action: 'click' }] }), /must be/, 'a malformed answer is refused, not stored');
  const refused = await answer(q.runId, { steps: [] });
  assert.equal(refused.status, 'blocked', '"I don\'t know" blocks the plan');

  const again = await start({ app: 'shop', goal: 'reorder', subGoals: ['log-in', 'reorder'], dryRun: true });
  const ok = await answer(again.runId, { steps: [{ action: 'click', role: 'link', name: 'Profile' }] });
  assert.equal(ok.status, 'planned');

  const third = await start({ app: 'shop', goal: 'reorder', subGoals: ['log-in', 'reorder'], dryRun: true });
  assert.equal(third.status, 'planned', 'the answer was remembered in the page map');
  if (third.status === 'planned') assert.match(third.seams[0]!.how, /the page map/);
  await flows.deleteOne({ app: 'shop', slug: 'reorder' });
});

test('remember: a bad batch is rejected whole; lessons fire and are counted', { timeout: 120_000 }, async () => {
  await assert.rejects(
    remember('shop', {
      facts: [{ text: '' }],
      lessons: [{ title: 'x', text: 'y', kind: 'wait', trigger: {} }],
    }),
    (e: Error) => /facts\[0\]\.text/.test(e.message) && /empty/.test(e.message),
  );
  const { notes, runs } = await collections();
  assert.equal(await notes.countDocuments({ app: 'shop' }), 0, 'nothing from the bad batch was written');

  const r = await remember('shop', {
    lessons: [{ title: 'Let the shop settle before Cart', text: 'the nav renders late', kind: 'wait', trigger: { action: 'click', name: 'Cart' } }],
    reached: [{ goal: 'pay for the cart', passed: true, drivenBy: 'agent with Playwright' }],
  });
  assert.equal(r.lessons.written, 1);
  assert.equal(r.reached, 1);
  assert.equal((await remember('shop', { lessons: [{ title: 'Let the shop settle before Cart', text: 'again', kind: 'wait', trigger: { name: 'Cart' } }] })).lessons.alreadyKnown, 1);
  assert.equal(await runs.countDocuments({ app: 'shop', mode: 'attributed' }), 1, 'stored as attributed, not as a replay');

  const planned = await start({ app: 'shop', goal: 'cart', subGoals: ['log-in', 'open-the-cart-from-the-shop'] });
  assert.equal(planned.status, 'planned');
  const { executed } = await runPlan(planned.runId, { values });
  assert.equal(executed.result.ok, true);
  assert.equal(executed.lessons?.fired, 1);
  assert.equal((await notes.findOne({ app: 'shop', kind: 'lesson' }))?.timesApplied, 1);
});

test('a fact can mark a control destructive, and the planner refuses it', { timeout: 30_000 }, async () => {
  await remember('shop', { facts: [{ text: 'The Profile link here actually deletes the account.', marksDestructive: 'Profile' }] });
  const blocked = await start({ app: 'shop', goal: 'profile', subGoals: ['log-in', 'open-the-profile-from-the-shop'], dryRun: true });
  assert.equal(blocked.status, 'blocked');
  if (blocked.status === 'blocked') assert.match(blocked.why, /deletes the account/);
  const allowed = await start({ app: 'shop', goal: 'profile', subGoals: ['log-in', 'open-the-profile-from-the-shop'], dryRun: true, allowPurchases: true });
  assert.equal(allowed.status, 'planned');
});

test('plan: a sub-goal nothing does blocks, with the closest flows', async () => {
  const s = await start({ app: 'shop', goal: 'x', subGoals: ['log-in', 'change my password'], dryRun: true });
  assert.equal(s.status, 'blocked');
  if (s.status === 'blocked') assert.match(s.why, /change my password/);
});
