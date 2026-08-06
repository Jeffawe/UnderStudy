#!/usr/bin/env node
/**
 * understudy — CLI entry point.
 *
 * Subcommands mirror the lifecycle: learn the app (`explore`, `record`), then
 * use what was learned (`recall`, `test`).
 *
 * Deliberately dependency-free argument parsing. The package is meant to stay a
 * few megabytes, and the surface here is small enough that a parser library
 * would be more code than it saves.
 *
 * Commands that aren't built yet EXIT NON-ZERO with a specific reason rather
 * than being hidden from `--help`. A missing command should be discoverable —
 * silently omitting `test` makes the tool look finished when it isn't.
 */

import { createEmbedder } from '../adapters/embedder/index.js';
import { closePool, describeTarget, ensureMeta, getPool } from '../core/db.js';
import { explore } from '../core/explore.js';
import { recall, isGap, GAP_DISTANCE, type ChunkKind } from '../core/recall.js';

const USAGE = `understudy — learn a web app, then test it by intent

USAGE
  understudy <command> [options]

COMMANDS
  explore <slug>        crawl an app and learn its map, facts and boundaries
  recall <slug> <goal>  query the memory for a goal (what the planner sees)
  record <slug>         capture a flow in a headed browser          [not built]
  test <goal>           plan and execute a goal against an app      [not built]

GLOBAL
  --target local|cloud  which store to use (default: $UNDERSTUDY_TARGET)
  -h, --help            this text

EXPLORE
  --url <baseUrl>       required on first run; remembered afterwards
  --login <user:pass>   seeded credentials; without them most apps show nothing
  --max-pages <n>       page-state budget (default 12)
  --headed              watch it work

RECALL
  --kinds <a,b>         restrict to chunk kinds (segment, fact, lesson, …)
  --limit <n>           results per list (default 5)

EXAMPLES
  understudy explore saucedemo --url https://www.saucedemo.com \\
      --login standard_user:secret_sauce
  understudy recall saucedemo "add something to the cart"
`;

/** Minimal flag parser: --key value, --flag, and positional arguments. */
function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const key = arg.replace(/^--?/, '');
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return { flags, positional };
}

const str = (v: string | true | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

function fail(message: string, hint?: string): never {
  console.error(`error: ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

async function cmdExplore(positional: string[], flags: Map<string, string | true>) {
  const slug = positional[0] ?? fail('explore needs an app slug', 'understudy explore saucedemo --url https://…');

  // The base URL is remembered per app, so only the first run needs it.
  const known = await getPool().query<{ base_url: string }>(
    'SELECT base_url FROM apps WHERE slug = $1',
    [slug],
  );
  const baseUrl = str(flags.get('url')) ?? known.rows[0]?.base_url;
  if (!baseUrl) {
    fail(`no base URL for '${slug}'`, 'pass --url on the first explore of an app');
  }

  const credential = str(flags.get('login'));
  if (credential && !credential.includes(':')) {
    fail('--login must be user:pass');
  }
  const [username, ...rest] = credential?.split(':') ?? [];

  console.log(`target: ${describeTarget()}`);
  console.log(`exploring ${slug} at ${baseUrl}\n`);

  const t0 = Date.now();
  const result = await explore(createEmbedder(), {
    slug,
    baseUrl,
    ...(username ? { login: { username, password: rest.join(':') } } : {}),
    ...(flags.has('max-pages') ? { maxPages: Number(str(flags.get('max-pages'))) } : {}),
    ...(flags.has('headed') ? { headless: false } : {}),
  });

  console.log(`learned in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  pages      ${result.pages}`);
  console.log(`  edges      ${result.edges}`);
  console.log(`  selectors  ${result.selectors}`);
  console.log(`  facts      ${result.facts} new, ${result.reobserved} confirmed`);

  if (result.refusals.length) {
    console.log(`\nrefused to click ${result.refusals.length} control(s) — each is now a boundary fact:`);
    for (const r of result.refusals) {
      console.log(`  ${r.why.padEnd(14)} ${r.page.padEnd(24)} ${r.name}`);
    }
  }
}

async function cmdRecall(positional: string[], flags: Map<string, string | true>) {
  const slug = positional[0] ?? fail('recall needs an app slug');
  const goal = positional.slice(1).join(' ');
  if (!goal) fail('recall needs a goal', 'understudy recall saucedemo "add to cart"');

  const { rows } = await getPool().query<{ app_id: string }>(
    'SELECT app_id FROM apps WHERE slug = $1',
    [slug],
  );
  const appId = rows[0]?.app_id ?? fail(`unknown app '${slug}'`, 'run `understudy explore` first');

  const embedder = createEmbedder();
  await ensureMeta(embedder);

  const kinds = str(flags.get('kinds'))?.split(',').map((k) => k.trim() as ChunkKind);
  const limit = Number(str(flags.get('limit')) ?? 5);

  const result = await recall(embedder, appId, goal, {
    ...(kinds ? { kinds } : {}),
    limit,
  });

  console.log(`target: ${describeTarget()}`);
  console.log(`goal:   "${goal}"\n`);
  console.log(
    `top=${result.topDistance?.toFixed(4) ?? 'n/a'}  ` +
      `margin=${result.margin?.toFixed(4) ?? 'n/a'}  ` +
      `scanned=${result.scanned}  threshold=${GAP_DISTANCE}`,
  );

  // The distinction the planner acts on: bindable is what it can RUN, context
  // is what it knows. A goal with rich context and nothing bindable is exactly
  // the case that triggers asking rather than guessing.
  console.log(`\nBINDABLE (${result.bindable.length}) — what a sub-goal can execute`);
  if (!result.bindable.length) console.log('  (none — nothing runnable is known for this goal)');
  for (const c of result.bindable) {
    console.log(`  ${c.distance.toFixed(4)}  [${c.kind}] ${c.text.slice(0, 78)}`);
  }

  console.log(`\nCONTEXT (${result.context.length}) — informs execution, isn't executable`);
  for (const c of result.context) {
    console.log(`  ${c.distance.toFixed(4)}  [${c.kind}] ${c.text.slice(0, 78)}`);
  }

  console.log(
    `\nverdict: ${isGap(result) ? 'GAP — would ask rather than guess' : 'known — would bind and run'}`,
  );
}

function notBuilt(command: string, blockedBy: string): never {
  console.error(`'understudy ${command}' is not built yet.`);
  console.error(`  blocked by: ${blockedBy}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);

  if (!positional.length || flags.has('help') || flags.has('h')) {
    console.log(USAGE);
    return;
  }

  // --target has to land in the environment before anything reads a pool.
  const target = str(flags.get('target'));
  if (target) process.env.TARGET = target;

  const [command, ...rest] = positional;

  switch (command) {
    case 'explore':
      await cmdExplore(rest, flags);
      break;
    case 'recall':
      await cmdRecall(rest, flags);
      break;
    case 'record':
      notBuilt('record', 'the recorder is not implemented — see STATUS.md');
      break;
    case 'test':
      notBuilt('test', 'needs the recorder and distiller: nothing bindable exists yet');
      break;
    default:
      fail(`unknown command '${command}'`, 'understudy --help');
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
    await closePool().catch(() => {});
    // Not process.exit(): the ONNX runtime's native threads may still be live,
    // and tearing the process down under them aborts with a mutex error that
    // buries the message above.
    process.exitCode = 1;
  });
