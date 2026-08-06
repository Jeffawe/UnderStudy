import type { Embedder } from '../../core/types.js';
import { LocalEmbedder } from './local.js';

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
    case 'amazon.titan-embed-text-v2:0':
      throw new Error('Titan embedder not implemented yet — use EMBEDDER_ID=mxbai-embed-large');
    default:
      throw new Error(`unknown EMBEDDER_ID '${id}'`);
  }
}

export { LocalEmbedder };
