/**
 * Turning text into vectors, with any embedding model you like.
 *
 * Most providers speak the same format: POST `{ model, input: [texts] }` to
 * `/v1/embeddings`, get back `{ data: [{ index, embedding }] }`. That covers
 * Voyage, OpenAI, Mistral, Together, and local Ollama / LM Studio. So this is
 * one adapter configured by four settings, not one adapter per vendor:
 *
 *   EMBED_URL    e.g. https://api.voyageai.com/v1/embeddings
 *                     http://localhost:11434/v1/embeddings   (Ollama, free, offline)
 *   EMBED_MODEL  e.g. voyage-4-lite
 *   EMBED_KEY    API key, if the endpoint needs one
 *   EMBED_DIMS   vector length the model returns (default 1024)
 *
 * Leave EMBED_URL and EMBED_MODEL unset to run with no model at all: search
 * then falls back to matching names.
 */

import 'dotenv/config';

export interface EmbedderConfig {
  url: string;
  model: string;
  key?: string;
  dims: number;
}

/** The configured embedder, or null if none is set. */
export function embedderConfig(): EmbedderConfig | null {
  const url = process.env.EMBED_URL?.trim();
  const model = process.env.EMBED_MODEL?.trim();
  if (!url && !model) return null;
  if (!url || !model) throw new Error('set both EMBED_URL and EMBED_MODEL in .env, or neither');

  const dims = Number(process.env.EMBED_DIMS ?? 1024);
  if (!Number.isInteger(dims) || dims <= 0) throw new Error(`EMBED_DIMS must be a positive whole number, got '${process.env.EMBED_DIMS}'`);

  const key = process.env.EMBED_KEY?.trim();
  return key ? { url, model, dims, key } : { url, model, dims };
}

/**
 * Voyage (directly, or through MongoDB's endpoint) embeds a search query
 * differently from a stored document, and is told which by `input_type`.
 * Other providers reject fields they don't know, so it is sent only to Voyage.
 */
export function sendsInputType(url: string): boolean {
  const host = new URL(url).hostname;
  return host.endsWith('voyageai.com') || host === 'ai.mongodb.com';
}

/** Texts per request. Fewer requests matters: Voyage without a card allows 3 a minute. */
const BATCH = 128;
const MAX_TRIES = 4;

/**
 * Embed many texts, in as few requests as possible. `purpose` is 'query' for
 * text you search WITH and 'document' for text being stored.
 */
export async function embed(
  texts: string[],
  purpose: 'query' | 'document',
  cfg: EmbedderConfig | null = embedderConfig(),
): Promise<number[][]> {
  if (!cfg) throw new Error('no embedding model configured — set EMBED_URL and EMBED_MODEL in .env');
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await embedBatch(texts.slice(i, i + BATCH), purpose, cfg)));
  }
  return out;
}

async function embedBatch(input: string[], purpose: 'query' | 'document', cfg: EmbedderConfig): Promise<number[][]> {
  const body: Record<string, unknown> = { model: cfg.model, input };
  if (sendsInputType(cfg.url)) body.input_type = purpose;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(body) });

    // Rate limited or a server hiccup: wait (as told, if told) and try again.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_TRIES) {
      const told = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(told) && res.headers.has('retry-after') ? told * 1000 : 5000 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`embedding request failed: ${res.status} ${res.statusText} — ${detail}`);
    }

    const json = (await res.json()) as { data?: { index?: number; embedding: number[] }[] };
    const data = json.data;
    if (!Array.isArray(data) || data.length !== input.length) {
      throw new Error(`embedding endpoint returned ${data?.length ?? 'no'} vectors for ${input.length} texts`);
    }
    // Providers may return them out of order; `index` says where each belongs.
    const vectors = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
    const wrong = vectors.find((v) => v.length !== cfg.dims);
    if (wrong) {
      throw new Error(`${cfg.model} returns ${wrong.length}-number vectors but EMBED_DIMS is ${cfg.dims} — set EMBED_DIMS=${wrong.length}`);
    }
    return vectors;
  }
}
