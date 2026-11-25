/**
 * The storage layer against a real MongoDB with vector search.
 *
 *   npm test                       uses MONGODB_URI from .env
 *   MONGODB_URI=… npm test         another cluster
 *
 * Use local Community for this. A free Atlas cluster allows only 3 search
 * indexes in total, so it can't hold the test database's 2 alongside a real
 * Understudy database's 2 — check Atlas with `understudy doctor` instead.
 *
 * Runs in its own database (understudy_test) and empties it afterwards, so it
 * never touches real data. Needs only the ordinary read/write role.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_DB = 'understudy_test';
// Start with no embedding model, whatever .env says: these tests supply vectors by hand.
process.env.EMBED_URL = '';
process.env.EMBED_MODEL = '';
process.env.EMBED_KEY = ''; // otherwise a key alone would mean Voyage
delete process.env.EMBED_DIMS;
const EMBED_DIMS = 1024;

const { connect, close, collections, ensureSchema, waitForVectorIndexes, vectorSearch } =
  await import('../src/store/db.js');
const { reembed } = await import('../src/store/reembed.js');
import type { Flow } from '../src/store/types.js';
import { startFakeEmbedder, axisFor } from './fake-embedder.js';

/** A unit vector pointing mostly along axis `i`, with a little of axis `j`. */
function vec(i: number, j = i, mix = 0): number[] {
  const v = new Array<number>(EMBED_DIMS).fill(0);
  v[i] = 1 - mix;
  v[j] = (v[j] ?? 0) + mix;
  const len = Math.hypot(...v);
  return v.map((x) => x / len);
}

function flow(app: string, slug: string, kind: Flow['kind'], embedding: number[]): Flow {
  const now = new Date();
  return {
    app, slug, kind, embedding,
    title: slug, intent: slug, outcome: '', searchText: slug,
    preconditions: [], destructive: false, corrections: [], steps: [],
    createdAt: now, updatedAt: now,
  };
}

/**
 * Empty the test database by dropping each collection. Not dropDatabase: an
 * Atlas user with the ordinary read/write role may not drop a database, and
 * the tests shouldn't need more than the app itself does.
 */
async function wipe() {
  const d = await connect();
  for (const c of await d.listCollections({}, { nameOnly: true }).toArray()) {
    await d.collection(c.name).drop();
  }
}

before(async () => {
  await wipe();
  await ensureSchema().catch((err: Error) => {
    if (/maximum number of FTS indexes/.test(err.message)) {
      throw new Error(
        'this cluster has no room for the test database\'s 2 vector indexes. A free Atlas cluster ' +
          'allows 3 search indexes in total, and a real Understudy database already uses 2. ' +
          'Run the tests against local Community instead, and check Atlas with `understudy doctor`.',
      );
    }
    throw err;
  });
  await ensureSchema(); // twice on purpose: it must be safe to run on every start
  await waitForVectorIndexes();

  const { flows } = await collections();
  await flows.insertMany([
    flow('shop', 'log-in', 'segment', vec(0)),
    flow('shop', 'sign-in-as-admin', 'segment', vec(0, 1, 0.3)),
    flow('shop', 'checkout', 'recording', vec(2)),
    flow('blog', 'log-in', 'segment', vec(0)), // same slug and vector, different app
  ]);
});

after(async () => {
  // Always close, even if cleanup fails — an open connection keeps the test
  // process alive forever instead of letting it report the failure.
  try {
    await wipe();
  } finally {
    await close();
  }
});

/** mongot indexes asynchronously; a just-inserted doc can take a moment to appear. */
async function searchUntil<T>(run: () => Promise<T[]>, want: number): Promise<T[]> {
  for (let i = 0; i < 60; i++) {
    const rows = await run();
    if (rows.length >= want) return rows;
    await new Promise((r) => setTimeout(r, 500));
  }
  return run();
}

test('ranks by meaning, nearest first', async () => {
  const { flows } = await collections();
  const rows = await searchUntil(() => vectorSearch(flows, 'shop', vec(0, 1, 0.05)), 3);
  assert.deepEqual(rows.map((r) => r.slug), ['log-in', 'sign-in-as-admin', 'checkout']);
  assert.ok(rows[0]!.score > rows[2]!.score);
  assert.equal('embedding' in rows[0]!, false, 'embeddings are not sent back');
});

test('never crosses apps', async () => {
  const { flows } = await collections();
  const rows = await searchUntil(() => vectorSearch(flows, 'blog', vec(0)), 1);
  assert.deepEqual(rows.map((r) => `${r.app}/${r.slug}`), ['blog/log-in']);
});

test('filters by kind', async () => {
  const { flows } = await collections();
  const rows = await searchUntil(() => vectorSearch(flows, 'shop', vec(0), { kind: 'recording' }), 1);
  assert.deepEqual(rows.map((r) => r.slug), ['checkout']);
});

test('one flow per slug per app', async () => {
  const { flows } = await collections();
  await assert.rejects(flows.insertOne(flow('shop', 'log-in', 'segment', vec(0))), /duplicate key/);
});

// Runs last: it switches the database onto a (fake) model.
test('one embedding model per database, and reembed switches it', async () => {
  const fake = await startFakeEmbedder(EMBED_DIMS);
  try {
    process.env.EMBED_URL = fake.url;
    process.env.EMBED_MODEL = 'model-a';
    await ensureSchema(); // first model seen → recorded
    const { meta, flows } = await collections();
    assert.equal((await meta.findOne({ _id: 'embedder' }))?.model, 'model-a');

    process.env.EMBED_MODEL = 'model-b';
    await assert.rejects(ensureSchema(), /embedded with model-a.*understudy reembed/s);

    const r = await reembed();
    assert.deepEqual(r, { flows: 4, notes: 0, model: 'model-b' });
    assert.equal((await meta.findOne({ _id: 'embedder' }))?.model, 'model-b');
    await ensureSchema(); // accepted now

    const login = await flows.findOne({ app: 'shop', slug: 'log-in' });
    assert.equal(login!.embedding![axisFor(login!.searchText, EMBED_DIMS)], 1, 'vector rebuilt from searchText');
    assert.equal(fake.requests.length, 1, 'all four flows embedded in one request');

    // A model that fails leaves the database as it was: still model-b, with model-b's vectors.
    process.env.EMBED_MODEL = 'model-c';
    fake.rateLimitNext(10);
    await assert.rejects(reembed(), /embedding request failed: 429/);
    fake.rateLimitNext(0);
    assert.equal((await meta.findOne({ _id: 'embedder' }))?.model, 'model-b', 'still recorded as the old model');
    assert.deepEqual((await flows.findOne({ app: 'shop', slug: 'log-in' }))!.embedding, login!.embedding, 'old vectors untouched');
    process.env.EMBED_MODEL = 'model-b';
    await ensureSchema(); // and still usable with the old model
  } finally {
    await fake.close();
  }
});
