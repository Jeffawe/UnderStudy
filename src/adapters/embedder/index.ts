import type { Embedder } from '../../core/types.js';
import { LocalEmbedder } from './local.js';
import { TitanEmbedder, TITAN_MODEL_ID } from './bedrock.js';

/**
 * Pick the embedder from config. Mode A and Mode B both default to local so
 * there is ONE vector space and corpora stay portable between them.
 *
 * Whatever this returns, its `id` gets written to the `meta` table on first
 * use and checked on every connect thereafter. See core/db.ts.
 */
export function createEmbedder(id = process.env.EMBEDDER_ID ?? 'mxbai-embed-large'): Embedder {
  switch (id) {
    case 'mxbai-embed-large':
      return new LocalEmbedder();
    // Only ever correct against a database that has never held an mxbai
    // vector. The `meta` guard enforces that; this is the note explaining why
    // it will refuse.
    case TITAN_MODEL_ID:
      return new TitanEmbedder();
    default:
      throw new Error(`unknown EMBEDDER_ID '${id}'`);
  }
}

export { LocalEmbedder, TitanEmbedder };
