/**
 * Rebuild every vector with the model currently in .env.
 *
 * Needed after changing EMBED_MODEL or EMBED_DIMS, because vectors from two
 * models can't be compared. Also fills in vectors for anything stored while no
 * model was configured. A corpus is a few hundred short texts, so this is a
 * handful of requests.
 */

import type { Collection } from 'mongodb';
import { collections, ensureSchema } from './db.js';
import { embed, embedderConfig } from './embed.js';

export async function reembed(): Promise<{ flows: number; notes: number; model: string }> {
  const cfg = embedderConfig();
  if (!cfg) throw new Error('no embedding model configured — set EMBED_KEY (Voyage), or EMBED_URL and EMBED_MODEL for another model');

  const c = await collections();
  // Record the new model first, so ensureSchema accepts it and resizes the indexes.
  await c.meta.replaceOne(
    { _id: 'embedder' },
    { model: cfg.model, dims: cfg.dims, setAt: new Date() },
    { upsert: true },
  );
  await ensureSchema();

  return {
    flows: await reembedCollection(c.flows as unknown as Collection<Searchable>),
    notes: await reembedCollection(c.notes as unknown as Collection<Searchable>),
    model: cfg.model,
  };
}

interface Searchable {
  searchText: string;
  embedding?: number[];
}

async function reembedCollection(coll: Collection<Searchable>): Promise<number> {
  const docs = await coll.find({}, { projection: { searchText: 1 } }).toArray();
  if (!docs.length) return 0;
  const vectors = await embed(docs.map((d) => d.searchText), 'document');
  await coll.bulkWrite(
    docs.map((d, i) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { embedding: vectors[i]! } } } })),
  );
  return docs.length;
}
