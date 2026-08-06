import pg from 'pg';
import 'dotenv/config';
import type { Embedder } from './types.js';

/**
 * Connection handling for both targets, plus the two guards that make
 * switching between them safe.
 *
 * Mirrors scripts/db.sh deliberately: UNDERSTUDY_TARGET selects local or
 * cloud, and nothing else in the codebase decides which database it talks to.
 */

/**
 * CockroachDB's `INT` is INT8, and node-postgres returns INT8 (OID 20) as a
 * STRING to avoid precision loss past 2^53. Every comparison against a JS
 * number then fails silently-but-confusingly (`"1024" !== 1024`).
 *
 * Every INT column in this schema is a counter, ordinal, dimension, or
 * duration — none can approach 2^53 — so parsing them as numbers is safe here
 * and removes a whole class of bug from recall(), health rollups, and findings
 * dedupe. Revisit only if a genuinely large INT8 column is ever added.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Target = 'local' | 'cloud';

export function resolveTarget(): Target {
  const t = (process.env.TARGET ?? process.env.UNDERSTUDY_TARGET ?? 'local').toLowerCase();
  if (t !== 'local' && t !== 'cloud') {
    throw new Error(`UNDERSTUDY_TARGET must be 'local' or 'cloud', got '${t}'`);
  }
  return t;
}

export function connectionString(target = resolveTarget()): string {
  const url = target === 'cloud' ? process.env.CRDB_URL : process.env.CRDB_LOCAL_URL;
  if (!url) throw new Error(`no connection string for target '${target}' — check .env`);
  return url;
}

/** Host without credentials — safe to log. */
export function describeTarget(target = resolveTarget()): string {
  const host = connectionString(target).replace(/.*@([^/?]+).*/, '$1');
  return `${target.toUpperCase()} ${host}`;
}

let pool: pg.Pool | undefined;

export function getPool(target = resolveTarget()): pg.Pool {
  if (pool) return pool;
  const url = connectionString(target);
  // node-postgres doesn't act on sslmode= in the URL; CockroachDB Cloud serves
  // a publicly-trusted cert, so system CAs are enough.
  const needsTls = /sslmode=(verify-full|verify-ca|require)/.test(url);
  pool = new pg.Pool({
    connectionString: url,
    ...(needsTls ? { ssl: { rejectUnauthorized: true } } : {}),
    max: 8,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Run a transaction, retrying serialization failures.
 *
 * CockroachDB defaults to SERIALIZABLE, not READ COMMITTED. Under contention
 * it aborts a transaction with SQLSTATE 40001 and expects the CLIENT to retry
 * — node-postgres will not do this for you. Ingest (dedupe selectors, then
 * insert steps + chunks) and finish_run (health rollup + findings dedupe) are
 * both multi-statement, so both need this.
 */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, attempts = 5): Promise<T> {
  const p = getPool();
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if ((err as { code?: string }).code !== '40001') throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2 ** i * 50 + Math.random() * 50));
    } finally {
      client.release();
    }
  }
  throw new Error(`transaction failed after ${attempts} attempts: ${String(lastErr)}`);
}

/**
 * THE EMBEDDER GUARD.
 *
 * On an empty database, record which embedder produced the vectors. On every
 * subsequent connect, verify it still matches.
 *
 * Titan v2 and mxbai-embed-large are both 1024-dim, so a mismatch passes every
 * type check and every constraint — the column accepts the row, the index
 * accepts the vector, and retrieval silently returns nonsense because the two
 * models occupy unrelated vector spaces. There is no error to catch. This
 * function is the only thing that notices.
 */
export async function ensureMeta(embedder: Embedder): Promise<{ created: boolean }> {
  const p = getPool();
  const { rows } = await p.query<{ embedder_id: string; embedding_dims: number }>(
    'SELECT embedder_id, embedding_dims FROM meta WHERE id = 1',
  );

  const existing = rows[0];
  if (!existing) {
    await p.query(
      'INSERT INTO meta (id, embedder_id, embedding_dims) VALUES (1, $1, $2)',
      [embedder.id, embedder.dims],
    );
    return { created: true };
  }

  if (existing.embedder_id !== embedder.id) {
    throw new Error(
      `embedder mismatch on ${describeTarget()}:\n` +
        `  stored:    ${existing.embedder_id}\n` +
        `  configured: ${embedder.id}\n` +
        `Every vector in this database was produced by the stored model. Using a ` +
        `different one returns confident nonsense with no error. Either set ` +
        `EMBEDDER_ID back, or re-embed the whole corpus.`,
    );
  }

  if (existing.embedding_dims !== embedder.dims) {
    throw new Error(
      `dimension mismatch: stored ${existing.embedding_dims}, configured ${embedder.dims}`,
    );
  }

  return { created: false };
}
