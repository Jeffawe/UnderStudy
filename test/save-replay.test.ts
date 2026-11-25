/**
 * Phase 2, end to end, with no AI: a recording of logging in and opening the
 * cart is proven by replay, saved as a flow, and replayed from MongoDB. Then
 * the app changes, and drift and findings notice.
 *
 * Needs local MongoDB (MONGODB_URI) and Playwright's Chromium. Uses its own
 * database, emptied afterwards.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_DB = 'understudy_test_e2e';
process.env.EMBED_URL = '';
process.env.EMBED_MODEL = '';
process.env.EMBED_KEY = ''; // otherwise a key alone would mean Voyage

const { connect, close, collections } = await import('../src/store/db.js');
const { saveFlow, recordingFrom } = await import('../src/flows/save.js');
const { recordRun } = await import('../src/flows/runs.js');
const { replay } = await import('../src/core/replay.js');
const { buildRecording } = await import('../src/core/recording.js');
import { startFixtureApp, type FixtureApp } from './fixture-app.js';

let shop: FixtureApp;
const values = { 'SECRET.password': 'not-a-real-password' };

async function wipe() {
  const d = await connect();
  for (const c of await d.listCollections({}, { nameOnly: true }).toArray()) await d.collection(c.name).drop();
}

before(async () => {
  shop = await startFixtureApp();
  await wipe();
});
after(async () => {
  try { await wipe(); } finally { await close(); await shop.close(); }
});

/** What `understudy record` would capture: sign in, then open the cart. */
function recordingOfLoginAndCart() {
  const u = shop.url;
  return buildRecording({ source: 'live', origin: 'test', appSlug: 'shop', startUrl: u }, [
    { seq: 0, ts: 0, action: 'goto', url: u, resolution: 'synthesized' },
    { seq: 1, ts: 1, action: 'fill', role: 'textbox', name: 'Username', value: 'demo', url: u, resolution: 'accname' },
    { seq: 2, ts: 2, action: 'fill', role: 'textbox', name: 'Password', valueRef: 'SECRET.password', url: u, resolution: 'accname' },
    { seq: 3, ts: 3, action: 'click', role: 'button', name: 'Log in', url: u, resolution: 'accname' },
    { seq: 4, ts: 4, action: 'click', role: 'link', name: 'Cart', url: `${u}shop`, resolution: 'accname' },
  ]);
}

/** What `understudy replay shop <flow>` does. */
async function replayFlow(slug: string) {
  const { flows } = await collections();
  const flow = (await flows.findOne({ app: 'shop', slug }))!;
  const result = await replay(recordingFrom(flow), { values });
  const run = await recordRun({ app: 'shop', flow: slug, result, steps: flow.steps });
  return { result, run };
}

test('save → replay → drift and findings', { timeout: 180_000 }, async () => {
  // 1. Prove the recording, save it, record that first run (what `understudy save` does).
  const recording = recordingOfLoginAndCart();
  const proof = await replay(recording, { values });
  assert.equal(proof.ok, true, `proving replay failed: ${JSON.stringify(proof.steps.filter((s) => !s.ok))}`);

  const flow = await saveFlow(recording, proof, { title: 'Open the cart' });
  assert.equal(flow.slug, 'open-the-cart');
  assert.equal(flow.destructive, false);
  assert.equal(flow.steps.length, 5);
  assert.ok(flow.steps.every((s) => s.action === 'goto' || s.expectedSig), 'each step remembers the page it reached');
  assert.equal(JSON.stringify(flow).includes(values['SECRET.password']), false, 'the password is not stored');
  const first = await recordRun({ app: 'shop', flow: flow.slug, result: proof, steps: flow.steps });
  assert.equal(first.drift.firstRun, true);

  // 2. Replay from memory, app unchanged: same path, nothing wrong.
  const same = await replayFlow('open-the-cart');
  assert.equal(same.result.ok, true);
  assert.equal(same.run.drift.changed, false);
  assert.equal(same.run.findings.length, 0);

  // 3. The app ships a promo page in front of the cart, and breaks the cart.
  shop.set({ promo: true, broken: true });
  const changed = await replayFlow('open-the-cart');
  assert.equal(changed.run.drift.changed, true, 'the new path is noticed');
  assert.ok(changed.run.drift.added.some((s) => s.startsWith('/promo')), `promo page reported as new: ${JSON.stringify(changed.run.drift)}`);
  const kinds = changed.run.findings.map((f) => f.kind);
  assert.ok(kinds.includes('flow_drift'), `drift became a finding: ${kinds}`);

  // 4. Cart directly broken (no promo): console error and the 500 become findings.
  shop.set({ promo: false, broken: true });
  const broken = await replayFlow('open-the-cart');
  const brokenKinds = broken.run.findings.map((f) => f.kind);
  assert.ok(brokenKinds.includes('console_error'), `console error found: ${brokenKinds}`);
  assert.ok(brokenKinds.includes('network_error'), `500 found: ${brokenKinds}`);

  // 5. Run it broken again: same findings, more occurrences — not duplicates.
  await replayFlow('open-the-cart');
  const { findings, runs, pages } = await collections();
  const net = await findings.find({ app: 'shop', kind: 'network_error' }).toArray();
  assert.equal(net.length, 1);
  assert.equal(net[0]!.occurrences, 2);
  assert.equal(net[0]!.severity, 'high');

  // Everything was recorded.
  assert.equal(await runs.countDocuments({ app: 'shop', plan: ['open-the-cart'] }), 5);
  const shopPage = await pages.findOne({ app: 'shop', urlPattern: '/shop' });
  assert.ok(shopPage?.links.some((l) => l.via.name === 'Cart'), 'the page map knows Cart leads on from /shop');
});

test('recall finds the saved flow by name and by words, and refuses to guess', async () => {
  const { recall } = await import('../src/memory/recall.js');
  const exact = await recall('shop', 'open-the-cart');
  assert.equal(exact.method, 'exact');
  assert.equal(exact.best?.slug, 'open-the-cart');

  const byWords = await recall('shop', 'open my cart', { withSteps: true });
  assert.equal(byWords.method, 'words', 'no model configured in this test');
  assert.equal(byWords.verdict, 'known');
  assert.equal(byWords.best?.slug, 'open-the-cart');
  // Enough to drive it yourself: the steps, and where the password comes from — never the password.
  assert.equal(byWords.steps?.length, 5);
  assert.deepEqual(byWords.steps?.[2], { n: 2, action: 'fill', role: 'textbox', name: 'Password', placeholder: 'SECRET.password' });
  assert.deepEqual(byWords.needs, [{ placeholder: 'SECRET.password', readFrom: ['UNDERSTUDY_SHOP_SECRET_PASSWORD', 'UNDERSTUDY_SECRET_PASSWORD'], set: false }]);
  assert.equal(JSON.stringify(byWords).includes(values['SECRET.password']), false);

  const nope = await recall('shop', 'change my password');
  assert.equal(nope.verdict, 'unknown');
  assert.equal(nope.best, undefined, 'nothing to run');

  assert.equal((await recall('another-app', 'open the cart')).verdict, 'unknown', 'never crosses apps');
});

test('a run found from a goal shares drift history with replays of the same flow', { timeout: 60_000 }, async () => {
  shop.set({ promo: false, broken: false });
  const { flows } = await collections();
  const flow = (await flows.findOne({ app: 'shop', slug: 'open-the-cart' }))!;
  const result = await replay(recordingFrom(flow), { values });
  const run = await recordRun({ app: 'shop', flow: flow.slug, result, steps: flow.steps, mode: 'run', goal: 'open my cart' });
  assert.equal(run.drift.firstRun, false, 'earlier replays count as history');
  assert.equal(run.drift.changed, false);
});

test('a destructive flow is marked on save', { timeout: 60_000 }, async () => {
  const u = shop.url;
  const recording = buildRecording({ source: 'live', origin: 'test', appSlug: 'shop', startUrl: u }, [
    { seq: 0, ts: 0, action: 'goto', url: u, resolution: 'synthesized' },
    { seq: 1, ts: 1, action: 'click', role: 'button', name: 'Place order', url: u, resolution: 'accname' },
  ]);
  // Not replayed: saveFlow trusts the caller to have proven it, and marking
  // reads only the steps.
  const fake = { ok: true, steps: [], sigSequence: [], signals: [], durationMs: 0 } as unknown as Parameters<typeof saveFlow>[1];
  const flow = await saveFlow(recording, fake, { title: 'Buy it' });
  assert.equal(flow.destructive, true);
  assert.match(flow.destructiveBecause!, /Place order/);
});

test('a flow that buys something is proven up to its commit, and nothing is bought', { timeout: 120_000 }, async () => {
  const { proveAndSave, proveFlow } = await import('../src/flows/save.js');
  const checkout = `${shop.url}checkout`;
  // As a script import leaves it: every step stamped with the last goto.
  const rec = buildRecording({ source: 'script', origin: 'test', appSlug: 'shop', startUrl: checkout }, [
    { seq: 0, ts: 0, action: 'goto', value: checkout, url: checkout, resolution: 'script-literal' },
    { seq: 1, ts: 1, action: 'check', role: 'checkbox', name: 'I agree to the terms', hints: { force: true }, url: checkout, resolution: 'script-literal' },
    { seq: 2, ts: 2, action: 'click', role: 'button', name: 'Confirm & Submit', url: checkout, resolution: 'script-literal' },
    { seq: 3, ts: 3, action: 'click', role: 'button', name: 'Pay Now', url: checkout, resolution: 'script-literal' },
  ]);
  const before = shop.committed();

  const out = await proveAndSave(rec, { title: 'Check out' });
  assert.equal(out.saved, true, JSON.stringify(out.proven?.result.steps));
  if (!out.saved) return;
  assert.equal(out.verified, true);
  assert.equal(out.flow.proven, undefined, 'proven — as far as it can be without buying');
  assert.equal(out.flow.provenUpTo, 2, 'up to its first commit');
  assert.match(out.flow.destructiveBecause!, /Confirm & Submit.*Pay Now/, 'both commits are named');
  assert.equal(out.flow.endState, undefined, 'it never saw where the flow ends');
  assert.deepEqual(shop.committed(), before, 'nothing was submitted or paid');
  assert.match(out.run!.drift.notCompared!, /stopped before step 2/);
  const { runs } = await collections();
  assert.equal((await runs.findOne({ _id: out.run!.runId }))!.stoppedBefore, 2, 'kept out of drift history');

  // Kept earlier with verify: false: proving it where it stands gets it as far.
  const later = await proveAndSave(rec, { title: 'Check out later', verify: false });
  assert.equal(later.saved && later.flow.proven, false);
  const proved = await proveFlow('shop', 'check-out-later');
  assert.equal(proved.result.ok, true, JSON.stringify(proved.result.steps.filter((s) => !s.ok)));
  assert.equal(proved.newlyProven, true);
  assert.equal(proved.commit?.index, 2);
  assert.equal(proved.flow.proven, undefined);
  assert.equal(proved.flow.provenUpTo, 2);
  assert.ok(proved.flow.steps.slice(1, 2).every((s) => s.expectedSig), 'the steps before the commit know their pages');
  assert.deepEqual(shop.committed(), before, 'still nothing bought');
  assert.equal((await proveFlow('shop', 'check-out-later')).newlyProven, false, 'proven this far already');
});

test('saving without a replay: kept as unproven; the first passing run proves it and fills in the pages', { timeout: 120_000 }, async () => {
  shop.set({ promo: false, broken: false });
  const { proveAndSave, proveByRun } = await import('../src/flows/save.js');
  const rec = recordingOfLoginAndCart();
  const out = await proveAndSave(rec, { title: 'Cart, unverified', verify: false });
  assert.equal(out.saved, true);
  if (!out.saved) return;
  assert.equal(out.verified, false);
  assert.equal(out.run, undefined, 'no replay, so no run');
  assert.equal(out.flow.proven, false);
  assert.equal(out.flow.unprovenBecause, 'saved without a replay');
  assert.ok(out.flow.steps.every((s) => !s.expectedSig), 'no replay, so no page fingerprints yet');

  const { recall } = await import('../src/memory/recall.js');
  const r = await recall('shop', 'cart-unverified');
  assert.equal(r.best?.proven, false, 'recall says so');
  assert.match(r.why, /unproven \(saved without a replay\), so it may not work; a passing run proves it/);
  const { distillRequest } = await import('../src/flows/distill.js');
  await assert.rejects(distillRequest('shop', 'cart-unverified'), /is unproven .* run it once/, 'not distilled until proven');

  // A passing run proves it.
  const { flows } = await collections();
  const flow = (await flows.findOne({ app: 'shop', slug: 'cart-unverified' }))!;
  const result = await replay(recordingFrom(flow), { values });
  assert.equal(result.ok, true);
  assert.equal(await proveByRun('shop', 'cart-unverified', result), true);
  const after = (await flows.findOne({ app: 'shop', slug: 'cart-unverified' }))!;
  assert.equal(after.proven, undefined, 'no longer unproven');
  assert.ok(after.steps.slice(1).every((s) => s.expectedSig), 'each step now knows the page it lands on');
  assert.ok(after.endState?.startsWith('/cart'));
  assert.equal(await proveByRun('shop', 'cart-unverified', result), false, 'already proven: nothing to do');
  assert.ok((await distillRequest('shop', 'cart-unverified')).flow, 'proven now, so it can be distilled');
});

test('a failed replay is refused unless the caller keeps it — then it is unproven, and its run is recorded', { timeout: 120_000 }, async () => {
  const { proveAndSave } = await import('../src/flows/save.js');
  const u = shop.url;
  // Asks for a link the shop doesn't have, so the replay fails.
  const broken = buildRecording({ source: 'live', origin: 'test-broken', appSlug: 'shop', startUrl: u }, [
    { seq: 0, ts: 0, action: 'goto', url: u, resolution: 'synthesized' },
    { seq: 1, ts: 1, action: 'click', role: 'link', name: 'No such link', url: u, resolution: 'accname' },
  ]);
  let asked = 0;
  const refused = await proveAndSave(broken, { title: 'Broken', keepIfFailed: async () => { asked++; return false; } });
  assert.equal(refused.saved, false);
  assert.equal(asked, 1, 'the caller was asked');

  const kept = await proveAndSave(broken, { title: 'Broken', keepIfFailed: async () => true });
  assert.equal(kept.saved, true);
  if (!kept.saved) return;
  assert.equal(kept.flow.proven, false);
  assert.match(kept.flow.unprovenBecause!, /replay failed/);
  assert.equal(kept.run?.drift.firstRun, false, 'a failed run is not "the first run"');
  assert.match(kept.run!.drift.notCompared!, /failed/);
  const { runs } = await collections();
  assert.equal((await runs.findOne({ app: 'shop', plan: ['broken'] }))?.status, 'failed');
});

test('on a tie, recall puts a proven flow ahead of an unproven one', async () => {
  const { rank } = await import('../src/memory/recall.js');
  const m = (slug: string, score: number, proven: boolean) =>
    ({ slug, title: slug, kind: 'recording' as const, madeBy: 'user' as const, proven, score, destructive: false, requiresSession: false });
  assert.deepEqual(rank([m('shaky', 0.81, false), m('solid', 0.81, true), m('low', 0.5, true)]).map((x) => x.slug), ['solid', 'shaky', 'low']);
  assert.deepEqual(rank([m('shaky', 0.9, false), m('solid', 0.81, true)]).map((x) => x.slug), ['shaky', 'solid'], 'a clearly better match still wins');
});

test('a redirect caught a beat early or late is not an unexpected page; a real detour still is', { timeout: 120_000 }, async () => {
  shop.set({ promo: false, broken: false });
  const u = shop.url;
  const steps = [
    { seq: 0, ts: 0, action: 'goto', url: u, resolution: 'synthesized' },
    { seq: 1, ts: 1, action: 'fill', role: 'textbox', name: 'Username', value: 'demo', url: u, resolution: 'accname' },
    { seq: 2, ts: 2, action: 'fill', role: 'textbox', name: 'Password', valueRef: 'SECRET.password', url: u, resolution: 'accname' },
    { seq: 3, ts: 3, action: 'click', role: 'button', name: 'Log in', url: u, resolution: 'accname' },
    { seq: 4, ts: 4, action: 'assert', role: 'link', name: 'Cart', hints: { assert: 'visible' }, url: `${u}shop`, resolution: 'accname' },
  ] as const;
  const plain = buildRecording({ source: 'live', origin: 'test-phase', appSlug: 'shop', startUrl: u }, steps.map((s) => ({ ...s })));
  const first = await replay(plain, { values });
  assert.equal(first.ok, true);
  const [login, shopPage] = [first.steps[2]!.sig!, first.steps[4]!.sig!];

  // Saved while the sign-in redirect hadn't landed yet: step 3 expects the login page.
  const early = { ...plain, events: plain.events.map((e) => ({ ...e, expectedSig: e.seq <= 3 ? login : shopPage })) };
  const r = await replay(early, { values });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.filter((s) => s.unexpectedPage), [], 'landing where the next step expects is the same path');

  // A page nobody expected, before or after, is still flagged.
  const detour = { ...plain, events: plain.events.map((e) => ({ ...e, expectedSig: e.seq === 3 ? '/somewhere-else#00000000' : e.seq < 3 ? login : '/also-not#00000000' })) };
  const d = await replay(detour, { values });
  assert.equal(d.steps.find((s) => s.seq === 3)?.unexpectedPage?.observed, shopPage);
});

test('a failed assertion names the locator and says what it saw — the visible text near the expected words', { timeout: 120_000 }, async () => {
  const u = shop.url;
  // A replay stops at its first failed step, so each check gets its own.
  const failing = async (step: Record<string, unknown>) => {
    const rec = buildRecording({ source: 'live', origin: 'test-saw', appSlug: 'shop', startUrl: u }, [
      { seq: 0, ts: 0, action: 'goto', url: u, resolution: 'synthesized' },
      { seq: 1, ts: 1, url: u, ...step } as never,
    ]);
    const r = await replay(rec, { values, timeoutMs: 1500 });
    assert.equal(r.ok, false);
    return r.steps.find((s) => s.seq === 1)!;
  };
  const text = await failing({ action: 'assert', css: 'body', value: 'Username: admin', hints: { assert: 'contains' }, resolution: 'css' });
  assert.match(text.error!, /locator\('body'\)/, 'names the locator');
  assert.match(text.saw!, /Username/, 'shows the text around the words it did find');
  const visible = await failing({ action: 'assert', role: 'button', name: 'No such button', hints: { assert: 'visible' }, resolution: 'accname' });
  assert.match(visible.saw!, /matched no elements/);
  const click = await failing({ action: 'click', css: '#nothing-here', resolution: 'css' });
  assert.match(click.error!, /#nothing-here/, 'a click that fails names its locator too');
});

test('editing a saved flow: a person\'s step or a wait goes in, it is unproven again, and its segments keep their steps', { timeout: 60_000 }, async () => {
  const { editFlow } = await import('../src/flows/save.js');
  const u = shop.url;
  const rec = buildRecording({ source: 'live', origin: 'edit', appSlug: 'shop', startUrl: u }, [
    { seq: 0, ts: 0, action: 'goto', url: u, resolution: 'synthesized' },
    { seq: 1, ts: 1, action: 'click', role: 'button', name: 'One', url: u, resolution: 'accname' },
    { seq: 2, ts: 2, action: 'click', role: 'button', name: 'Two', url: u, resolution: 'accname' },
    { seq: 3, ts: 3, action: 'click', role: 'button', name: 'Three', url: u, resolution: 'accname' },
  ]);
  const fake = { ok: true, steps: [], sigSequence: [], signals: [], durationMs: 0 } as unknown as Parameters<typeof saveFlow>[1];
  await saveFlow(rec, fake, { title: 'Edit me' });
  const { saveDistilled } = await import('../src/flows/distill.js');
  await saveDistilled('shop', 'edit-me', {
    intent: 'edit me', outcome: 'edited', preconditions: [],
    segments: [{ slug: 'edit-me-start', title: 'Start', intent: 'start', stepRange: [0, 2] }, { slug: 'edit-me-end', title: 'End', intent: 'end', stepRange: [2, 4] }],
  });

  await assert.rejects(editFlow('shop', 'edit-me', [{ before: 9, step: { action: 'click', value: 'x' } }]), /before must be a step index.*\n.*action must be one of human, wait_response/s);
  await assert.rejects(editFlow('shop', 'edit-me', [{ before: 1, step: { action: 'human', value: 'x', hints: { force: true } } }]), /hints can't have force \(it can have untilText, untilUrl, untilResponse\)/);

  const flow = await editFlow('shop', 'edit-me', [
    { before: 1, step: { action: 'human', value: 'Approve it', hints: { untilText: 'Approved' } } },
    { before: 3, step: { action: 'wait_response', value: '/api/visits', hints: { status: 201 } } },
  ]);
  assert.deepEqual(flow.steps.map((s) => s.name ?? s.action), ['goto', 'human', 'One', 'Two', 'wait_response', 'Three']);
  assert.equal(flow.proven, false);
  assert.match(flow.unprovenBecause!, /edited: 2 step\(s\) added/);

  const { flows } = await collections();
  const start = (await flows.findOne({ app: 'shop', slug: 'edit-me-start' }))!;
  const end = (await flows.findOne({ app: 'shop', slug: 'edit-me-end' }))!;
  assert.deepEqual(start.from!.steps, [0, 3], 'the person\'s step landed inside it');
  assert.deepEqual(start.steps.map((s) => s.name ?? s.action), ['goto', 'human', 'One']);
  assert.equal(start.proven, false);
  assert.deepEqual(end.from!.steps, [3, 6]);
  assert.deepEqual(end.steps.map((s) => s.name ?? s.action), ['Two', 'wait_response', 'Three']);
});
