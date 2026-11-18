/** The embedding adapter, against a fake local endpoint. No network, no database. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { embed, embedderConfig, sendsInputType } from '../src/store/embed.js';
import { startFakeEmbedder, axisFor, type FakeEmbedder } from './fake-embedder.js';

const DIMS = 8;
let fake: FakeEmbedder;

before(async () => { fake = await startFakeEmbedder(DIMS); });
after(async () => { await fake.close(); });

const cfg = () => ({ url: fake.url, model: 'fake-model', dims: DIMS });

test('returns one vector per text, in the order given', async () => {
  const texts = ['log in', 'check out', 'reset password'];
  const vectors = await embed(texts, 'document', cfg());
  assert.equal(vectors.length, 3);
  texts.forEach((t, i) => assert.equal(vectors[i]![axisFor(t, DIMS)], 1));
});

test('sends many texts in few requests', async () => {
  fake.requests.length = 0;
  await embed(Array.from({ length: 300 }, (_, i) => `text ${i}`), 'document', cfg());
  assert.equal(fake.requests.length, 3, '300 texts → 3 requests of up to 128');
});

test('waits and retries when rate limited', async () => {
  fake.requests.length = 0;
  fake.rateLimitNext(2);
  const vectors = await embed(['log in'], 'query', cfg());
  assert.equal(vectors.length, 1);
  assert.equal(fake.requests.length, 3);
});

test('says which EMBED_DIMS to set when the model returns another length', async () => {
  await assert.rejects(embed(['x'], 'query', { ...cfg(), dims: 16 }), /set EMBED_DIMS=8/);
});

test('only Voyage gets input_type', async () => {
  assert.equal(sendsInputType('https://api.voyageai.com/v1/embeddings'), true);
  assert.equal(sendsInputType('https://ai.mongodb.com/v1/embeddings'), true);
  assert.equal(sendsInputType('https://api.openai.com/v1/embeddings'), false);
  assert.equal(sendsInputType('http://localhost:11434/v1/embeddings'), false);
  fake.requests.length = 0;
  await embed(['x'], 'query', cfg());
  assert.equal('input_type' in fake.requests[0]!, false);
});

test('reads its settings from the environment', () => {
  const saved = { ...process.env };
  try {
    process.env.EMBED_URL = ''; process.env.EMBED_MODEL = ''; process.env.EMBED_KEY = '';
    assert.equal(embedderConfig(), null, 'nothing set → no model, names only');

    process.env.EMBED_KEY = 'k';
    assert.deepEqual(embedderConfig(), { url: 'https://api.voyageai.com/v1/embeddings', model: 'voyage-4-lite', dims: 1024, key: 'k' }, 'just a key → Voyage');
    process.env.EMBED_KEY = '';

    process.env.EMBED_URL = 'https://api.voyageai.com/v1/embeddings';
    assert.throws(() => embedderConfig(), /both EMBED_URL and EMBED_MODEL/);

    process.env.EMBED_MODEL = 'voyage-4-lite'; process.env.EMBED_DIMS = '512'; process.env.EMBED_KEY = 'k';
    assert.deepEqual(embedderConfig(), { url: process.env.EMBED_URL, model: 'voyage-4-lite', dims: 512, key: 'k' });

    process.env.EMBED_DIMS = 'lots';
    assert.throws(() => embedderConfig(), /positive whole number/);
  } finally {
    process.env = saved;
  }
});
