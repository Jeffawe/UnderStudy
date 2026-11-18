/**
 * Connecting to MongoDB, and making sure every collection and index exists.
 *
 * One setting: MONGODB_URI. Local Community Edition and Atlas use the same
 * driver and the same queries, so switching between them is only a change of
 * connection string. MONGODB_DB picks the database name (default `understudy`).
 */

import 'dotenv/config';
import { MongoClient, type Db, type Collection, type Document } from 'mongodb';
import type { App, Flow, Page, Note, Finding, Run } from './types.js';

/**
 * Length of every embedding. voyage-4-lite's default output size. Changing it
 * means re-embedding everything, and the vector indexes are rebuilt to match.
 */
export const EMBED_DIMS = 1024;

let client: MongoClient | undefined;
let db: Db | undefined;

export function mongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set. Put it in .env — e.g. ' +
        'mongodb://localhost:27017/?directConnection=true for local Community, ' +
        'or your Atlas mongodb+srv://… string.',
    );
  }
  return uri;
}

/** Host only, never credentials — safe to print. */
export function describeUri(uri = mongoUri()): string {
  return uri.replace(/^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?]+).*$/, 'mongodb$1://$2');
}

export async function connect(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(mongoUri(), { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  db = client.db(process.env.MONGODB_DB ?? 'understudy');
  return db;
}

export async function close(): Promise<void> {
  await client?.close();
  client = undefined;
  db = undefined;
}

/** Typed handles to the six collections. */
export async function collections() {
  const d = await connect();
  return {
    apps: d.collection<App>('apps'),
    flows: d.collection<Flow>('flows'),
    pages: d.collection<Page>('pages'),
    notes: d.collection<Note>('notes'),
    findings: d.collection<Finding>('findings'),
    runs: d.collection<Run>('runs'),
  };
}

/** Ordinary indexes: the lookups every command does. */
const INDEXES: Record<string, { key: Document; unique?: boolean }[]> = {
  apps: [{ key: { slug: 1 }, unique: true }],
  flows: [{ key: { app: 1, slug: 1 }, unique: true }],
  pages: [{ key: { app: 1, sig: 1 }, unique: true }],
  notes: [{ key: { app: 1, kind: 1 } }],
  findings: [{ key: { app: 1, fingerprint: 1 }, unique: true }, { key: { app: 1, status: 1 } }],
  runs: [{ key: { app: 1, startedAt: -1 } }],
};

/**
 * Vector indexes: flows and notes are what recall searches. `app` and `kind`
 * are filter fields so a search never crosses apps. The free Atlas tier allows
 * three search indexes per cluster; these are two.
 */
export const VECTOR_INDEX = 'embedding';
const VECTOR_COLLECTIONS = ['flows', 'notes'] as const;

/** What listSearchIndexes returns. The driver types it as just `{ name }`. */
interface SearchIndexInfo {
  name: string;
  status?: string;
  queryable?: boolean;
  latestDefinition?: Document;
}

async function vectorIndexInfo(coll: Collection<Document>): Promise<SearchIndexInfo | undefined> {
  return (await coll.listSearchIndexes(VECTOR_INDEX).toArray())[0] as SearchIndexInfo | undefined;
}

function vectorDefinition() {
  return {
    fields: [
      { type: 'vector', path: 'embedding', numDimensions: EMBED_DIMS, similarity: 'cosine' },
      { type: 'filter', path: 'app' },
      { type: 'filter', path: 'kind' },
    ],
  };
}

/**
 * Create anything missing. Safe to call on every start: existing collections
 * and indexes are left alone, and a vector index whose definition has drifted
 * (e.g. EMBED_DIMS changed) is updated in place.
 */
export async function ensureSchema(): Promise<void> {
  const d = await connect();
  const existing = new Set((await d.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  for (const [name, indexes] of Object.entries(INDEXES)) {
    // A search index can only be created on a collection that exists.
    if (!existing.has(name)) await d.createCollection(name);
    for (const ix of indexes) {
      await d.collection(name).createIndex(ix.key, ix.unique ? { unique: true } : {});
    }
  }

  for (const name of VECTOR_COLLECTIONS) {
    const coll = d.collection(name);
    const current = await vectorIndexInfo(coll);
    const wanted = vectorDefinition();
    if (!current) {
      await coll.createSearchIndex({ name: VECTOR_INDEX, type: 'vectorSearch', definition: wanted });
    } else if (JSON.stringify(current.latestDefinition) !== JSON.stringify(wanted)) {
      await coll.updateSearchIndex(VECTOR_INDEX, wanted);
    }
  }
}

export interface VectorIndexState {
  collection: string;
  status: string;
  queryable: boolean;
}

export async function vectorIndexStates(): Promise<VectorIndexState[]> {
  const d = await connect();
  const out: VectorIndexState[] = [];
  for (const name of VECTOR_COLLECTIONS) {
    const ix = await vectorIndexInfo(d.collection(name));
    out.push({ collection: name, status: ix?.status ?? 'MISSING', queryable: ix?.queryable === true });
  }
  return out;
}

/** Wait until both vector indexes can be queried. A new index takes ~20s locally. */
export async function waitForVectorIndexes(timeoutMs = 120_000): Promise<VectorIndexState[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = await vectorIndexStates();
    if (states.every((s) => s.queryable)) return states;
    if (Date.now() > deadline) {
      const stuck = states.filter((s) => !s.queryable).map((s) => `${s.collection}=${s.status}`);
      throw new Error(`vector indexes not ready after ${timeoutMs / 1000}s: ${stuck.join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Nearest documents to `vector` within one app. `score` is cosine similarity
 * rescaled by MongoDB to 0–1, where 1 is identical.
 */
export async function vectorSearch<T extends Document>(
  coll: Collection<T>,
  app: string,
  vector: number[],
  opts: { limit?: number; kind?: string } = {},
): Promise<(T & { score: number })[]> {
  const limit = opts.limit ?? 5;
  const filter: Document = { app };
  if (opts.kind) filter.kind = opts.kind;
  return coll
    .aggregate<T & { score: number }>([
      {
        $vectorSearch: {
          index: VECTOR_INDEX,
          path: 'embedding',
          queryVector: vector,
          numCandidates: Math.max(limit * 20, 100),
          limit,
          filter,
        },
      },
      { $set: { score: { $meta: 'vectorSearchScore' } } },
      { $project: { embedding: 0 } },
    ])
    .toArray();
}
