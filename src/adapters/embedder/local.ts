import { homedir } from 'node:os';
import { join } from 'node:path';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { Embedder } from '../../core/types.js';

/**
 * Local ONNX embedder — runs in-process, no API key, no server.
 *
 * mxbai-embed-large-v1 is 1024-dim, which is the whole reason VECTOR(1024) was
 * chosen: it's the only dimension compatible with BOTH this and Bedrock's
 * Titan v2. That decision was made so a corpus could move between the hosted
 * mode and the subscription mode without re-embedding.
 *
 * Weights are NOT bundled. They download from the HF hub on first use and
 * cache to disk, so `npm i understudy` stays a few MB.
 */

const MODEL_ID = process.env.EMBEDDER_MODEL ?? 'mixedbread-ai/mxbai-embed-large-v1';

/**
 * mxbai is asymmetric: queries get this prefix, documents get nothing.
 * Omitting it doesn't error — retrieval just quietly degrades, which is the
 * worst kind of bug in a system whose confidence signal IS the distance.
 */
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/**
 * q8 is ~340MB vs ~1.3GB for fp32. Quantization has minimal measured impact on
 * retrieval quality and this downloads to every machine that runs the tool.
 * Override with EMBEDDER_DTYPE=fp32 if a benchmark ever says otherwise.
 */
const DTYPE = (process.env.EMBEDDER_DTYPE ?? 'q8') as 'q8' | 'fp32' | 'fp16';

/**
 * transformers.js defaults to caching inside node_modules, so `npm ci` or any
 * dependency bump silently discards ~340MB and re-downloads it. Pin the cache
 * outside the install tree so it survives reinstalls and is shared by every
 * checkout on the machine.
 */
env.cacheDir =
  process.env.UNDERSTUDY_MODEL_CACHE ?? join(homedir(), '.understudy', 'models');

export class LocalEmbedder implements Embedder {
  readonly id = 'mxbai-embed-large';
  readonly dims = 1024;

  #pipe: FeatureExtractionPipeline | undefined;
  #loading: Promise<FeatureExtractionPipeline> | undefined;

  /** Lazy + memoized: the first call pays the model load, later calls don't. */
  async #pipeline(): Promise<FeatureExtractionPipeline> {
    if (this.#pipe) return this.#pipe;
    this.#loading ??= pipeline('feature-extraction', MODEL_ID, { dtype: DTYPE }).then((p) => {
      this.#pipe = p as FeatureExtractionPipeline;
      return this.#pipe;
    });
    return this.#loading;
  }

  async #embed(text: string): Promise<number[]> {
    const pipe = await this.#pipeline();

    // CLS pooling is what mxbai was trained with — mean pooling gives worse
    // vectors. normalize:true produces unit vectors, which is REQUIRED: for
    // unit vectors L2 ranking is identical to cosine, and L2 (`<->`) is the
    // only operator CockroachDB's vector index accelerates.
    const out = await pipe(text, { pooling: 'cls', normalize: true });

    const vec = Array.from(out.data as Float32Array);
    if (vec.length !== this.dims) {
      throw new Error(
        `${MODEL_ID} returned ${vec.length} dims, expected ${this.dims}. ` +
          `The schema declares VECTOR(${this.dims}); a mismatch means the wrong model.`,
      );
    }
    return vec;
  }

  embedDocument(text: string): Promise<number[]> {
    return this.#embed(text);
  }

  embedQuery(text: string): Promise<number[]> {
    return this.#embed(QUERY_PREFIX + text);
  }
}
