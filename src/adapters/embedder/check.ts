/**
 * Smoke test for the embedder + the memory plane end to end.
 *
 *   npm run embedder:check                  # local
 *   TARGET=cloud npm run embedder:check     # cloud
 *
 * Proves five things, in order of what breaks first:
 *   1. the model loads and produces 1024 dims
 *   2. vectors are unit length  (required — L2 ranking == cosine only for unit
 *      vectors, and L2 is the only index-accelerated operator)
 *   3. the query prefix actually changes the vector (asymmetry is wired up)
 *   4. semantically close text scores closer than unrelated text
 *   5. the database accepts a real VECTOR(1024) round trip, and the meta guard works
 */

import { createEmbedder } from './index.js';
import { getPool, closePool, ensureMeta, describeTarget } from '../../core/db.js';

const l2 = (a: number[], b: number[]) =>
  Math.hypot(...a.map((x, i) => x - (b[i] ?? 0)));

const norm = (v: number[]) => Math.hypot(...v);

async function main() {
  console.log(`target: ${describeTarget()}\n`);

  const embedder = createEmbedder();
  console.log(`embedder: ${embedder.id} (${embedder.dims} dims)`);
  console.log('loading model — first run downloads weights, this is the slow part…');

  const t0 = Date.now();
  const login = await embedder.embedDocument(
    'Authenticate a member using email, password, and a six-digit code',
  );
  console.log(`model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // 1 + 2
  console.log(`dims:       ${login.length}  ${login.length === 1024 ? 'ok' : 'WRONG'}`);
  console.log(`unit norm:  ${norm(login).toFixed(6)}  ${Math.abs(norm(login) - 1) < 1e-3 ? 'ok' : 'WRONG'}`);

  // 3 — query prefix must produce a different vector than the document form
  const asDoc = await embedder.embedDocument('test login');
  const asQuery = await embedder.embedQuery('test login');
  const prefixDelta = l2(asDoc, asQuery);
  console.log(`asymmetry:  ${prefixDelta.toFixed(4)}  ${prefixDelta > 0.01 ? 'ok (prefix applied)' : 'WRONG — prefix not applied'}`);

  // 4 — the actual claim: "test login" should land near the login flow and far
  // from something unrelated. This is the number the whole confidence signal
  // rests on, so it is worth seeing with your own eyes on day one.
  const unrelated = await embedder.embedDocument('Upload a profile photo and crop it');
  const near = l2(asQuery, login);
  const far = l2(asQuery, unrelated);
  console.log(`\n  "test login" -> login flow      ${near.toFixed(4)}`);
  console.log(`  "test login" -> upload a photo  ${far.toFixed(4)}`);
  console.log(`  ${near < far ? 'ok — related text is closer' : 'WRONG — ranking is inverted'}`);

  // 5 — real round trip through CockroachDB
  console.log('\ndatabase:');
  const meta = await ensureMeta(embedder);
  console.log(`  meta row ${meta.created ? 'created' : 'verified'} (${embedder.id})`);

  const pool = getPool();
  const { rows } = await pool.query<{ dist: string }>(
    `SELECT $1::VECTOR(1024) <-> $2::VECTOR(1024) AS dist`,
    [`[${asQuery.join(',')}]`, `[${login.join(',')}]`],
  );
  console.log(`  server-side distance: ${Number(rows[0]!.dist).toFixed(4)}`);
  console.log(`  ${Math.abs(Number(rows[0]!.dist) - near) < 1e-3 ? 'ok — matches local computation' : 'WRONG'}`);

  await closePool();
}

main().catch(async (err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  await closePool();
  // NOT process.exit() — the ONNX runtime's native threads are still live, and
  // yanking the process out from under them aborts with a mutex error that
  // buries the message above. Setting the code lets Node unwind normally.
  process.exitCode = 1;
});
