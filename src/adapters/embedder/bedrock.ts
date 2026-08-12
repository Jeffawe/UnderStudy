/**
 * TitanEmbedder — Bedrock's `amazon.titan-embed-text-v2:0`.
 *
 * READ THIS BEFORE SWITCHING TO IT. Titan and mxbai are both 1024-dimensional
 * and occupy entirely unrelated vector spaces. Pointing this at a corpus
 * embedded with mxbai does not error — retrieval just returns confident
 * nonsense. The `meta` guard in core/db.ts is the only thing standing between
 * you and that, and it works by refusing to connect when the embedder id
 * changes. So: this is for a FRESH database, not for the existing corpus.
 *
 * WHICH ALSO MEANS MODE A DOES NOT REQUIRE IT. The distiller and reasoner are
 * what make Mode A hosted; the embedder can stay local ONNX in both modes, and
 * defaults to exactly that, so one vector space keeps corpora portable between
 * them. Titan earns its place when you want no local model download at all —
 * a small container, a cold-start-sensitive box — not because Bedrock is in
 * play elsewhere.
 *
 * NOT THE MANTLE CLIENT. Titan is not an Anthropic model: no Messages API, no
 * structured outputs, no `anthropic.` prefix. Plain `InvokeModel` is the whole
 * interface.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { awsRegion } from '../bedrock/client.js';
import type { Embedder } from '../../core/types.js';

export const TITAN_MODEL_ID = 'amazon.titan-embed-text-v2:0';

interface TitanResponse {
  embedding?: number[];
  inputTextTokenCount?: number;
}

export class TitanEmbedder implements Embedder {
  readonly id = TITAN_MODEL_ID;
  readonly dims = 1024;

  #client: BedrockRuntimeClient | undefined;

  /**
   * Titan is SYMMETRIC — the same call for both sides.
   *
   * mxbai is not: it wants a retrieval prefix on queries and nothing on
   * documents, and getting that backwards silently degrades recall rather than
   * failing. The two-method interface exists for that model's sake; here both
   * methods legitimately do the same thing, and saying so is better than
   * inventing a prefix Titan was never trained with.
   */
  async embedDocument(text: string): Promise<number[]> {
    return this.#embed(text);
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.#embed(text);
  }

  async #embed(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('refusing to embed empty text');

    this.#client ??= new BedrockRuntimeClient({ region: awsRegion() });

    const response = await this.#client.send(
      new InvokeModelCommand({
        modelId: TITAN_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          inputText: trimmed,
          // Titan v2 offers 256 / 512 / 1024. Only 1024 fits VECTOR(1024), and
          // that column shape is irreversible once rows exist.
          dimensions: this.dims,
          // Unit vectors are a REQUIREMENT, not a preference: the index is
          // built on `vector_l2_ops` and L2 ranking only matches cosine
          // ranking when the vectors are normalized.
          normalize: true,
        }),
      }),
    );

    const decoded = JSON.parse(new TextDecoder().decode(response.body)) as TitanResponse;
    const embedding = decoded.embedding;

    if (!Array.isArray(embedding)) throw new Error('Titan returned no embedding');
    if (embedding.length !== this.dims) {
      // Would otherwise fail deep inside a pgvector INSERT with a message that
      // never mentions the embedder.
      throw new Error(`Titan returned ${embedding.length} dims, expected ${this.dims}`);
    }

    return embedding;
  }
}
