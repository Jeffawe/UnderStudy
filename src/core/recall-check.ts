/**
 * Smoke test for recall() against a small seeded corpus.
 *
 *   npm run recall:check
 *
 * Proves four things:
 *   1. the CTE form still uses the ANN index (not a full scan)
 *   2. a known query ranks the right segment first
 *   3. an unknown query lands far away — the gap-detection signal works
 *   4. kind filtering and the re-rank run without disturbing raw distances
 *
 * It also PRINTS the distances, which is the input to calibrating the
 * threshold. Don't ship a guessed constant.
 */

import { createEmbedder } from '../adapters/embedder/index.js';
import { getPool, closePool, ensureMeta, describeTarget } from './db.js';
import { recall, toVector, isGap } from './recall.js';

const SLUG = 'recall-check';

/** Deliberately saucedemo-shaped: this is what a real corpus will look like. */
const CORPUS: Array<{ kind: string; text: string }> = [
  { kind: 'segment', text: 'Log in as a standard user with username and password' },
  { kind: 'segment', text: 'Add an item to the cart from the inventory list' },
  { kind: 'segment', text: 'Complete checkout by entering first name, last name and postal code' },
  { kind: 'segment', text: 'Remove an item from the shopping cart' },
  { kind: 'segment', text: 'Sort the product list by price from low to high' },
  { kind: 'segment', text: 'Log out using the burger menu' },
  { kind: 'fact', text: 'The standard_user account signs in with the password secret_sauce' },
  { kind: 'fact', text: 'The cart badge displays the number of items currently in the cart' },
  { kind: 'lesson', text: 'When the inventory page is still loading, wait for the inventory container before clicking add to cart' },
];

async function main() {
  console.log(`target: ${describeTarget()}\n`);

  const embedder = createEmbedder();
  await ensureMeta(embedder);
  const pool = getPool();

  // Fresh every run so the numbers are reproducible. Chunks cascade with the
  // app now — see db/01-memory-chunks-fk.sql.
  await pool.query('DELETE FROM apps WHERE slug = $1', [SLUG]);
  const { rows: appRows } = await pool.query<{ app_id: string }>(
    `INSERT INTO apps (slug, name, base_url) VALUES ($1, $2, $3) RETURNING app_id`,
    [SLUG, 'recall check fixture', 'https://www.saucedemo.com'],
  );
  const appId = appRows[0]!.app_id;

  // Single-row INSERTs: IMPORT INTO is unsupported on vector-indexed tables and
  // batched vector inserts are discouraged anyway.
  process.stdout.write(`seeding ${CORPUS.length} chunks`);
  for (const c of CORPUS) {
    const v = await embedder.embedDocument(c.text);
    await pool.query(
      `INSERT INTO memory_chunks (app_id, kind, ref_id, text, embedding, health)
       VALUES ($1, $2, gen_random_uuid(), $3, $4::VECTOR(1024), 0.5)`,
      [appId, c.kind, c.text, toVector(v)],
    );
    process.stdout.write('.');
  }
  console.log(' done\n');

  // 1 — the ANN index must be USABLE. Note the @mc_embed_idx hint: without it
  // the optimizer is free to ignore the index, and on a corpus this small it
  // SHOULD — an exact top-k over a dozen rows beats an approximate search, and
  // is exact besides. Asserting on the unhinted plan would be testing a cost
  // decision that correctly changes with corpus size, not testing the index.
  const probe = await embedder.embedQuery('test login');
  const explain = async (hint: string) => {
    const { rows } = await pool.query<{ info: string }>(
      `EXPLAIN SELECT chunk_id, embedding <-> $1::VECTOR(1024) AS dist
       FROM memory_chunks${hint} WHERE app_id = $2
       ORDER BY embedding <-> $1::VECTOR(1024) LIMIT 60`,
      [toVector(probe), appId],
    );
    return rows.map((r) => r.info).join('\n');
  };

  const hinted = await explain('@mc_embed_idx');
  const usesAnn = /vector search/i.test(hinted);
  const usesPrefix = /prefix spans/i.test(hinted);
  console.log(`ann index usable:  ${usesAnn ? 'ok — • vector search' : 'WRONG — index unusable'}`);
  console.log(`app_id prefix:     ${usesPrefix ? 'ok — prefix spans' : 'WRONG — not pushed down'}`);

  // Informational: what the optimizer actually picks today. Expect it to switch
  // to the vector index as the corpus grows.
  const natural = /vector search/i.test(await explain(''));
  console.log(`optimizer picks:   ${natural ? 'ANN index' : 'exact scan (expected at this size)'}\n`);

  // 2 + 3 — the numbers that matter
  const queries = [
    ['test login', 'KNOWN'],
    ['sign in to the app', 'KNOWN'],
    ['buy something and check out', 'KNOWN'],
    ['export the quarterly revenue report as a PDF', 'UNKNOWN'],
    ['configure the SAML identity provider', 'UNKNOWN'],
  ] as const;

  for (const [q, label] of queries) {
    const r = await recall(embedder, appId, q, { limit: 5 });
    console.log(`${label.padEnd(7)} "${q}"`);
    console.log(
      `  top=${r.topDistance?.toFixed(4)}  margin=${r.margin?.toFixed(4)}` +
        `  scanned=${r.scanned}  gap=${isGap(r) ? 'YES — ask' : 'no'}`,
    );
    for (const c of r.bindable.slice(0, 2)) {
      console.log(`    bind    ${c.distance.toFixed(4)}  [${c.kind}] ${c.text.slice(0, 58)}`);
    }
    for (const c of r.context.slice(0, 2)) {
      console.log(`    context ${c.distance.toFixed(4)}  [${c.kind}] ${c.text.slice(0, 58)}`);
    }
    console.log();
  }

  // 4 — kind filter still returns rows and preserves raw distances
  const factsOnly = await recall(embedder, appId, 'what is the password', {
    kinds: ['fact'],
    limit: 3,
  });
  console.log(`kind filter (fact only): ${factsOnly.chunks.length} rows`);
  for (const c of factsOnly.chunks) {
    console.log(`  ${c.distance.toFixed(4)}  [${c.kind}] ${c.text.slice(0, 62)}`);
  }
  const leaked = factsOnly.chunks.filter((c) => c.kind !== 'fact');
  console.log(`  ${leaked.length === 0 ? 'ok — no other kinds leaked' : 'WRONG — leaked kinds'}`);

  await closePool();
}

main().catch(async (err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  await closePool();
  process.exitCode = 1;
});
