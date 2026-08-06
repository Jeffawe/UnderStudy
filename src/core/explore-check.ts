/**
 * Run `explore` against saucedemo and report what it learned.
 *
 *   npm run explore:check
 *
 * This is the first real corpus. Everything downstream — binding, seams,
 * threshold calibration — gets tested against what this produces.
 */

import { createEmbedder } from '../adapters/embedder/index.js';
import { getPool, closePool, ensureMeta, describeTarget } from './db.js';
import { explore } from './explore.js';

const SLUG = 'saucedemo';

async function main() {
  console.log(`target: ${describeTarget()}\n`);

  const embedder = createEmbedder();
  await ensureMeta(embedder);

  // Fresh corpus each run so counts mean something. One delete clears pages,
  // edges, selectors, facts AND chunks — memory_chunks got its ON DELETE
  // CASCADE in db/01-memory-chunks-fk.sql.
  await getPool().query('DELETE FROM apps WHERE slug = $1', [SLUG]);

  const t0 = Date.now();
  const r = await explore(embedder, {
    slug: SLUG,
    baseUrl: 'https://www.saucedemo.com',
    login: { username: 'standard_user', password: 'secret_sauce' },
    maxPages: 10,
  });

  console.log(`explored in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  console.log(`  pages     ${r.pages}`);
  console.log(`  edges     ${r.edges}`);
  console.log(`  selectors ${r.selectors}`);
  console.log(`  facts     ${r.facts} new, ${r.reobserved} re-observed`);

  console.log(`\nrefusals (${r.refusals.length}) — each became a boundary fact:`);
  for (const ref of r.refusals) {
    console.log(`  [${ref.why.padEnd(14)}] ${ref.page.padEnd(22)} ${ref.name}`);
  }

  const pool = getPool();
  const { rows: pages } = await pool.query<{ sig: string; title: string }>(
    `SELECT sig, title FROM pages WHERE app_id = $1 ORDER BY sig`,
    [r.appId],
  );
  console.log(`\npage map:`);
  for (const p of pages) console.log(`  ${p.sig}  "${p.title}"`);

  const { rows: edges } = await pool.query<{ f: string; t: string; via: string; kind: string }>(
    `SELECT pf.sig AS f, pt.sig AS t, s.name AS via, e.kind
     FROM page_edges e
     JOIN pages pf ON pf.page_id = e.from_page
     JOIN pages pt ON pt.page_id = e.to_page
     LEFT JOIN selectors s ON s.selector_id = e.via_selector
     WHERE e.app_id = $1 ORDER BY pf.sig`,
    [r.appId],
  );
  console.log(`\nedges:`);
  for (const e of edges) console.log(`  ${e.f}  --[${e.kind}: ${e.via}]-->  ${e.t}`);

  await closePool();
}

main().catch(async (err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  await closePool();
  process.exitCode = 1;
});
