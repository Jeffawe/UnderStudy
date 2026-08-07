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
import { recordLive } from '../adapters/recorder/live.js';
import { listRecordings, saveRecording } from '../core/recording-store.js';
import { parseScript } from '../adapters/recorder/script.js';
import { loadRecording } from '../core/recording-store.js';
import { replay } from '../core/replay.js';

const USAGE = `understudy — learn a web app, then test it by intent

USAGE
  understudy <command> [options]

COMMANDS
  explore <slug>        crawl an app and learn its map, facts and boundaries
  recall <slug> <goal>  query the memory for a goal (what the planner sees)
  record <slug>         capture a flow in a headed browser
  recordings [slug]     list captured recordings
  import <slug> <file>  read an existing Playwright script into a recording
  replay <hash>         re-run a recording, verify it, and capture signals
  test <goal>           plan and execute a goal against an app      [not built]

GLOBAL
  --target local|cloud  which store to use (default: $UNDERSTUDY_TARGET)
  -h, --help            this text

EXPLORE
  --url <baseUrl>       required on first run; remembered afterwards
  --login <user:pass>   seeded credentials; without them most apps show nothing
  --max-pages <n>       page-state budget (default 12)
  --headed              watch it work

RECORD
  --url <baseUrl>       required on first run; remembered afterwards
  --max-minutes <n>     stop recording after n minutes (default 30)

IMPORT
  --url <baseUrl>       resolves goto('/') when the script relies on a baseURL

REPLAY
  --value REF=value     supply a redacted value, e.g. SECRET.password=hunter2
  --headed              watch it replay

RECALL
  --kinds <a,b>         restrict to chunk kinds (segment, fact, lesson, …)
  --limit <n>           results per list (default 5)

EXAMPLES
  understudy explore saucedemo --url https://www.saucedemo.com \\
      --login standard_user:secret_sauce
  understudy recall saucedemo "add something to the cart"
  understudy record saucedemo
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

  const baseUrl = await resolveBaseUrl(slug, str(flags.get('url')));

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

/**
 * Resolve an app's base URL, remembering it after the first use.
 *
 * Shared by explore and record so `--url` is a first-run detail in both, and
 * the slug alone is enough thereafter.
 */
async function resolveBaseUrl(slug: string, flag: string | undefined): Promise<string> {
  const known = await getPool().query<{ base_url: string }>(
    'SELECT base_url FROM apps WHERE slug = $1',
    [slug],
  );
  const baseUrl = flag ?? known.rows[0]?.base_url;
  if (!baseUrl) fail(`no base URL for '${slug}'`, 'pass --url the first time you use an app');

  // Remember it, so the slug is sufficient next time.
  if (flag) {
    await getPool().query(
      `INSERT INTO apps (slug, name, base_url) VALUES ($1, $1, $2)
       ON CONFLICT (slug) DO UPDATE SET base_url = excluded.base_url`,
      [slug, flag],
    );
  }
  return baseUrl;
}

async function cmdRecord(positional: string[], flags: Map<string, string | true>) {
  const slug = positional[0] ?? fail('record needs an app slug', 'understudy record saucedemo --url https://…');
  const baseUrl = await resolveBaseUrl(slug, str(flags.get('url')));

  console.log(`target: ${describeTarget()}`);
  console.log(`recording ${slug} at ${baseUrl}\n`);

  const recording = await recordLive({
    appSlug: slug,
    startUrl: baseUrl,
    ...(flags.has('max-minutes') ? { maxMinutes: Number(str(flags.get('max-minutes'))) } : {}),
  });

  if (!recording.events.some((e) => e.action !== 'goto')) {
    console.error('\nnothing was recorded — no actions beyond the opening navigation.');
    console.error('  the recording was NOT saved.');
    process.exitCode = 2;
    return;
  }

  const { path, existed } = await saveRecording(recording);

  console.log(`\ncaptured ${recording.events.length} events`);
  for (const e of recording.events) {
    const value = e.value !== undefined ? ` = "${e.value}"` : e.valueRef ? ` = <${e.valueRef}>` : '';
    console.log(`  ${String(e.seq).padStart(2)}  ${e.action.padEnd(7)} ${(e.role ?? '').padEnd(9)} ${e.name ?? ''}${value}`);
  }

  // Names captured live are best-effort: clicking often destroys the element
  // before it can be resolved authoritatively. Replay fixes these, so say so
  // rather than letting the number look like a defect.
  const approximate = recording.events.filter((e) => e.resolution === 'unresolved').length;
  if (approximate) {
    console.log(`\n${approximate} step(s) have approximate role/name — replay will resolve them.`);
  }

  console.log(`\nhash  ${recording.hash}${existed ? '  (identical recording already existed)' : ''}`);
  console.log(`saved ${path}`);
}

async function cmdImport(positional: string[], flags: Map<string, string | true>) {
  const slug = positional[0] ?? fail('import needs an app slug', 'understudy import saucedemo tests/login.spec.ts');
  const file = positional[1] ?? fail('import needs a script path');

  // A script may use a baseURL from playwright.config, so `goto('/')` carries
  // no origin. The app's known base URL fills that in.
  const known = await getPool().query<{ base_url: string }>(
    'SELECT base_url FROM apps WHERE slug = $1',
    [slug],
  );
  const fallback = str(flags.get('url')) ?? known.rows[0]?.base_url;

  const { recording, warnings } = await parseScript(file, slug, fallback);

  if (!recording.events.length) {
    console.error(`no Playwright actions found in ${file}`);
    console.error('  expected calls like page.getByRole(...).click()');
    process.exitCode = 2;
    return;
  }

  console.log(`parsed ${recording.events.length} events from ${file}\n`);
  for (const e of recording.events) {
    const value = e.value !== undefined ? ` = "${e.value}"` : e.valueRef ? ` = <${e.valueRef}>` : '';
    console.log(`  ${String(e.seq).padStart(2)}  ${e.action.padEnd(7)} ${(e.role ?? '').padEnd(9)} ${e.name ?? ''}${value}`);
  }

  if (warnings.length) {
    console.log(`\n${warnings.length} call(s) could not be mapped:`);
    for (const w of warnings.slice(0, 10)) console.log(`  ${w}`);
  }

  const { path, existed } = await saveRecording(recording);
  console.log(`\nhash  ${recording.hash}${existed ? '  (identical recording already existed)' : ''}`);
  console.log(`saved ${path}`);
}

async function cmdReplay(positional: string[], flags: Map<string, string | true>) {
  const hash = positional[0] ?? fail('replay needs a recording hash', 'understudy recordings');
  const recording = await loadRecording(hash).catch(() => fail(`no recording '${hash}'`, 'understudy recordings'));

  // Credentials are deliberately absent from recordings, so they must be
  // supplied here: --value SECRET.password=hunter2 (repeatable).
  const values: Record<string, string> = {};
  for (const [k, v] of flags) {
    if (k !== 'value' || typeof v !== 'string') continue;
    const eq = v.indexOf('=');
    if (eq < 0) fail('--value must be REF=value');
    values[v.slice(0, eq)] = v.slice(eq + 1);
  }

  const needed = recording.events.filter((e) => e.valueRef && !(e.valueRef in values));
  if (needed.length) {
    console.log(`this recording needs ${needed.length} value(s) it deliberately does not store:`);
    for (const e of needed) console.log(`  --value ${e.valueRef}=…`);
    console.log('');
  }

  const result = await replay(recording, {
    values,
    ...(flags.has('headed') ? { headless: false } : {}),
  });

  console.log(`replay ${result.ok ? 'PASSED' : 'FAILED'} in ${(result.durationMs / 1000).toFixed(1)}s\n`);
  for (const s of result.steps) {
    const status = s.ok ? 'ok  ' : 'FAIL';
    const notes = [
      s.ambiguousByName && `ambiguous: ${s.ambiguousByName.matched} by name, resolved via ${s.ambiguousByName.disambiguatedBy}`,
      s.roundTripMismatch && `value did not survive: wrote "${s.roundTripMismatch.expected}", read "${s.roundTripMismatch.actual}"`,
      s.error,
    ].filter(Boolean).join('; ');
    console.log(`  ${String(s.seq).padStart(2)}  ${status}  ${s.action.padEnd(7)} ${(s.sig ?? '').padEnd(28)} ${notes}`);
  }

  console.log(`\npath: ${result.sigSequence.join('  ->  ')}`);

  if (result.signals.length) {
    console.log(`\n${result.signals.length} signal(s) captured:`);
    for (const g of result.signals.slice(0, 12)) {
      console.log(`  [step ${g.duringStep}] ${g.kind}${g.status ? ' ' + g.status : ''}  ${g.text.slice(0, 90)}`);
    }
  }

  if (result.needsReview) {
    console.log('\nNEEDS REVIEW — this recording will not be promoted to memory.');
    process.exitCode = 3;
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
      await cmdRecord(rest, flags);
      break;
    case 'import':
      await cmdImport(rest, flags);
      break;
    case 'replay':
      await cmdReplay(rest, flags);
      break;
    case 'recordings': {
      const rows = await listRecordings(rest[0]);
      if (!rows.length) console.log('no recordings yet — try `understudy record <slug>`');
      for (const r of rows) {
        console.log(`  ${r.hash}  ${r.appSlug.padEnd(14)} ${String(r.events).padStart(3)} events  ${r.source.padEnd(6)}  ${r.createdAt}`);
      }
      break;
    }
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
