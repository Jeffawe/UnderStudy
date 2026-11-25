/**
 * A tiny local stand-in for an OpenAI-style /v1/embeddings endpoint, so tests
 * need no network, no key and no money. Each text becomes a unit vector along
 * an axis chosen by hashing the text, so equal texts get equal vectors.
 */

import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeEmbedder {
  url: string;
  /** Every request body received, in order. */
  requests: Record<string, unknown>[];
  /** Respond 429 to the next N requests. */
  rateLimitNext(n: number): void;
  close(): Promise<void>;
}

export function axisFor(text: string, dims: number): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % dims;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return JSON.parse(s) as Record<string, unknown>;
}

/** `vectorFor`: the vector to return for a text, instead of one hashed axis. */
export async function startFakeEmbedder(dims: number, opts: { returnDims?: number; vectorFor?: (text: string) => number[] | undefined } = {}): Promise<FakeEmbedder> {
  const requests: Record<string, unknown>[] = [];
  let limited = 0;

  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push(body);
    if (limited > 0) {
      limited--;
      res.writeHead(429, { 'retry-after': '0' }).end('slow down');
      return;
    }
    const n = opts.returnDims ?? dims;
    const data = (body.input as string[]).map((text, index) => {
      const chosen = opts.vectorFor?.(text);
      if (chosen) return { index, embedding: chosen };
      const v = new Array<number>(n).fill(0);
      v[axisFor(text, n)] = 1;
      return { index, embedding: v };
    });
    // Out of order on purpose: clients must sort by `index`.
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: data.reverse() }));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/embeddings`,
    requests,
    rateLimitNext: (n) => { limited = n; },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
