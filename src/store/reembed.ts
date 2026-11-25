/**
 * Rebuild every vector with the model now configured.
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
  const flows = c.flows as unknown as Collection<Searchable>;
  const notes = c.notes as unknown as Collection<Searchable>;

  // Embed everything BEFORE changing anything: if the model fails (wrong
  // name, not pulled, out of quota), the database is left as it was — still
  // recorded as the old model, with the old model's vectors.
  const [flowVectors, noteVectors] = [await vectorsFor(flows), await vectorsFor(notes)];

  // Record the new model, so ensureSchema accepts it and resizes the indexes.
  await c.meta.replaceOne(
    { _id: 'embedder' },
    { model: cfg.model, dims: cfg.dims, setAt: new Date() },
    { upsert: true },
  );
  await ensureSchema();

  return {
    flows: await write(flows, flowVectors),
    notes: await write(notes, noteVectors),
    model: cfg.model,
  };
}

interface Searchable {
  searchText: string;
  embedding?: number[];
}

type Vectors = { _id: unknown; embedding: number[] }[];

async function vectorsFor(coll: Collection<Searchable>): Promise<Vectors> {
  const docs = await coll.find({}, { projection: { searchText: 1 } }).toArray();
  if (!docs.length) return [];
  const vectors = await embed(docs.map((d) => d.searchText), 'document');
  return docs.map((d, i) => ({ _id: d._id, embedding: vectors[i]! }));
}

async function write(coll: Collection<Searchable>, vectors: Vectors): Promise<number> {
  if (!vectors.length) return 0;
  await coll.bulkWrite(vectors.map((v) => ({ updateOne: { filter: { _id: v._id as never }, update: { $set: { embedding: v.embedding } } } })));
  return vectors.length;
}
