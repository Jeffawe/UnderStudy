/**
 * calibrate: fitting recall's known/unknown cutoffs. The fit itself is pure;
 * the rest runs against local MongoDB in its own database (understudy_calibrate_test),
 * with a fake embedder whose vectors are chosen so the built-in cutoffs —
 * set for voyage-4-lite — get this "model" wrong, the way mxbai-embed-large did.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_DB = 'understudy_calibrate_test';
process.env.EMBED_KEY = '';
process.env.EMBED_MODEL = 'fake-model';
delete process.env.EMBED_DIMS;
const DIMS = 1024;

import { startFakeEmbedder, type FakeEmbedder } from './fake-embedder.js';
import type { Flow } from '../src/store/types.js';
const { connect, close, collections, ensureSchema, waitForVectorIndexes } = await import('../src/store/db.js');
const { calibrate, recalibrateAll, fit, score } = await import('../src/memory/calibrate.js');
const { recall, MEANING } = await import('../src/memory/recall.js');
type Sample = import('../src/memory/calibrate.js').Sample;

// --- the fit, pure -------------------------------------------------------------

const s = (top: number, second: number | undefined, known: boolean): Sample => ({
  goal: `${top}/${second}`, expect: known ? 'f' : null, from: 'goals file', topFlow: 'f', top, ...(second !== undefined ? { second } : {}),
});

test('fit: separates by score when score is enough', () => {
  const samples = [s(0.95, 0.7, true), s(0.93, 0.9, true), s(0.94, 0.75, true), s(0.85, 0.84, false), s(0.86, 0.8, false), s(0.84, 0.7, false)];
  const r = fit(samples);
  assert.equal(r.correct, samples.length);
  assert.ok(r.strong > 0.86 && r.strong <= 0.93, `strong ${r.strong} sits between the two groups`);
});

test('fit: uses the lead over the runner-up when scores overlap', () => {
  // The calibration that set the built-in cutoffs: "sign in" (known) scores below "download my invoices" (not).
  const samples = [s(0.73, 0.633, true), s(0.756, 0.619, true), s(0.776, 0.686, true), s(0.735, 0.709, false), s(0.72, 0.696, false), s(0.684, 0.683, false)];
  const r = fit(samples);
  assert.equal(r.correct, samples.length);
  assert.equal(score(samples, MEANING).correct, samples.length, 'the built-in cutoffs agree on these');
});

test('fit: a wrong "known" costs more than a missed one', () => {
  // Can't get both right: one known goal and one unknown share a score and lead.
  const r = fit([s(0.9, 0.7, true), s(0.9, 0.7, false), s(0.95, 0.7, true)]);
  assert.ok(r.strong > 0.9 && (r.good > 0.9 || r.margin > 0.2), 'prefers missing the known one over running the unknown one');
});

test('fit: a known goal the model ranked wrong should not be called known', () => {
  const misranked: Sample = { ...s(0.95, 0.7, true), topFlow: 'other' };
  const r = fit([misranked, s(0.9, 0.6, true), s(0.6, 0.55, false)]);
  assert.equal(r.correct, 3);
  assert.ok(r.strong > 0.95);
});

// --- against MongoDB ------------------------------------------------------------

/** Unit vector from {axis: weight}. */
function vec(parts: Record<number, number>): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const [i, w] of Object.entries(parts)) v[Number(i)] = w;
  const len = Math.hypot(...v);
  return v.map((x) => x / len);
}

const FLOWS = ['sign in', 'download an invoice', 'add to cart', 'check out', 'change password', 'track an order', 'write a review', 'contact support'];
const slug = (t: string) => t.replace(/ /g, '-');
// Each flow on its own axis. Known goals lean on their flow's axis; unknown goals sit between two flows.
const VECTORS: Record<string, number[]> = Object.fromEntries(FLOWS.map((t, i) => [t, vec({ [i]: 1 })]));
const KNOWN: Record<string, string> = {};
FLOWS.forEach((t, i) => {
  KNOWN[`please ${t}`] = slug(t);
  VECTORS[`please ${t}`] = vec({ [i]: 1, [(i + 1) % 8]: 0.35 });
  KNOWN[`I want to ${t}`] = slug(t);
  VECTORS[`I want to ${t}`] = vec({ [i]: 1, [(i + 3) % 8]: 0.25 });
});
const UNKNOWN = ['change my profile photo', 'cancel my subscription', 'export my data', 'delete my account', 'refer a friend', 'gift card balance'];
UNKNOWN.forEach((g, i) => { VECTORS[g] = vec({ [i]: 1, [(i + 4) % 8]: 0.95 }); });

let fake: FakeEmbedder;

before(async () => {
  fake = await startFakeEmbedder(DIMS, { vectorFor: (t) => VECTORS[t] });
  process.env.EMBED_URL = fake.url;
  const d = await connect();
  for (const c of await d.listCollections({}, { nameOnly: true }).toArray()) await d.collection(c.name).drop();
  await ensureSchema();
  await waitForVectorIndexes();
  const now = new Date();
  const { flows } = await collections();
  await flows.insertMany(FLOWS.map((t): Flow => ({
    app: 'shop', slug: slug(t), kind: 'recording', title: t, intent: t, outcome: '', searchText: t, embedding: VECTORS[t]!,
    preconditions: [], destructive: false, corrections: [], steps: [], recording: 'x', startUrl: 'http://x', requiresSession: false,
    createdAt: now, updatedAt: now,
  })));
  // Searchable takes a moment after insert.
  for (let i = 0; i < 60 && (await recall('shop', 'please sign in')).flows.length < FLOWS.length; i++) await new Promise((r) => setTimeout(r, 500));
});

after(async () => {
  const d = await connect();
  for (const c of await d.listCollections({}, { nameOnly: true }).toArray()) await d.collection(c.name).drop();
  await close();
  await fake.close();
});

test('uncalibrated model: recall says so, and calls a goal between two flows known', async () => {
  const r = await recall('shop', 'change my profile photo');
  assert.equal(r.cutoffs?.source, 'uncalibrated');
  assert.equal(r.verdict, 'known', 'the built-in strong cutoff is too low for this model');
  assert.match(r.why, /understudy calibrate shop/);

  // The scale calibrate scores with is the one vector search reports.
  const q = VECTORS['change my profile photo']!, f = VECTORS['sign in']!;
  const cos = q.reduce((a, x, i) => a + x * f[i]!, 0);
  assert.ok(Math.abs(r.flows.find((m) => m.slug === 'sign-in')!.score - (1 + cos) / 2) < 1e-3);
});

test('too few goals: nothing fitted is saved, but the goals are kept', async () => {
  const c = await calibrate('shop', { goals: { known: [{ flow: 'sign-in', goal: 'please sign in' }], unknown: [] } });
  assert.equal(c.saved, false);
  assert.match(c.notes.join(' '), /only 1 known goal/);
  assert.equal(c.goals.leftOut, FLOWS.length, 'no real unknown goals: made up by leaving each flow out');
  const { apps } = await collections();
  const doc = await apps.findOne({ slug: 'shop' });
  assert.equal(doc?.calibrationGoals?.known.length, 1);
  assert.equal(doc?.cutoffs, undefined);
});

test('rejects a goal naming a flow that does not exist', async () => {
  await assert.rejects(calibrate('shop', { goals: { known: [{ flow: 'nope', goal: 'x' }] }, dryRun: true }), /no flow 'nope'/);
});

test('calibrate fits, saves, and recall uses the fitted cutoffs', async () => {
  const c = await calibrate('shop', {
    goals: { known: Object.entries(KNOWN).map(([goal, flow]) => ({ flow, goal })), unknown: [...UNKNOWN, 'Sign In'] },
  });
  assert.equal(c.saved, true);
  assert.equal(c.notes.some((n) => /skipped/.test(n)), true, "a flow's exact name is skipped");
  assert.equal(c.goals.leftOut, 0, 'enough real unknown goals: none made up');
  assert.equal(c.total, 16 + 6);
  assert.equal(c.after.correct, c.total, JSON.stringify(c.mistakes));
  assert.ok(c.before.correct < c.total, 'the built-in cutoffs got some wrong');
  assert.ok(c.after.strong > MEANING.strong);

  for (const g of UNKNOWN) {
    const r = await recall('shop', g);
    assert.equal(r.cutoffs?.source, 'this app');
    assert.notEqual(r.verdict, 'known', g);
  }
  for (const [g, flow] of Object.entries(KNOWN)) {
    const r = await recall('shop', g);
    assert.equal(r.verdict, 'known', g);
    assert.equal(r.best?.slug, flow);
  }
});

test('a new model ignores the old cutoffs; recalibrateAll re-fits from the kept goals', async () => {
  process.env.EMBED_MODEL = 'fake-model-2';
  const { meta } = await collections();
  await meta.updateOne({ _id: 'embedder' }, { $set: { model: 'fake-model-2' } }); // what reembed records
  try {
    assert.equal((await recall('shop', 'export my data')).cutoffs?.source, 'uncalibrated');
    const { refitted, withoutGoals } = await recalibrateAll();
    assert.equal(refitted.length, 1);
    assert.equal(refitted[0]!.saved, true);
    assert.equal(refitted[0]!.model, 'fake-model-2');
    assert.deepEqual(withoutGoals, []);
    assert.equal((await recall('shop', 'export my data')).cutoffs?.source, 'this app');
  } finally {
    process.env.EMBED_MODEL = 'fake-model';
    await meta.updateOne({ _id: 'embedder' }, { $set: { model: 'fake-model' } });
  }
});
