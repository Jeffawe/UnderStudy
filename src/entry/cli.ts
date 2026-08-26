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
import { createReasoner, vocabularyLines } from '../adapters/reasoner/index.js';
import { closePool, describeTarget, ensureMeta, getPool } from '../core/db.js';
import { explore } from '../core/explore.js';
import { recall, isGap, GAP_DISTANCE, type ChunkKind } from '../core/recall.js';
import { recordLive } from '../adapters/recorder/live.js';
import { listRecordings, saveRecording } from '../core/recording-store.js';
import {
  loadSession,
  saveSession,
  forgetSession,
  loadHandoffSession,
  type StorageState,
} from '../core/auth-cache.js';
import { buildRecording, type RawEvent, type RawRecording } from '../core/recording.js';
import { eventsForFlowSlugs } from '../core/flow-ir.js';
import { parseScript } from '../adapters/recorder/script.js';
import { loadRecording } from '../core/recording-store.js';
import { replay } from '../core/replay.js';
import { ingestRecording } from '../core/ingest.js';
import {
  buildDistillRequest, validateDistilled, saveDistilled, loadDistilled, distilledPath,
} from '../core/distill.js';
import { fetchVocabulary } from '../core/vocabulary.js';
import { remember, validateRemember } from '../core/remember.js';
import { recordAttributedRun } from '../core/run.js';
import { lessonsFor, foldLessonOutcomes } from '../core/lessons.js';
import type { RememberInput } from '../core/remember.js';
import { recordRun } from '../core/run.js';
import { mineMacros } from '../core/macros.js';
import { buildPlan } from '../core/plan.js';
import { emitFlow, type Framework } from '../core/emit.js';
import { listOpenFindings, suppressThirdParty, triageSummary } from '../core/triage.js';
import { executePlan } from '../core/execute.js';
import { writeFile, readFile, mkdir } from 'node:fs/promises';

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
  ingest <hash>         replay, then write the flow into memory
  distill <hash>        ask for intent + segments; --save <file> to answer
  mine <slug>           find step blocks that recur across recorded flows
  flows <slug>          list what this app knows how to do
  findings <slug>       what looks wrong, filtered and ranked
  remember <slug> <file> write facts/lessons/findings from a JSON batch
  attribute <slug> <goal> record a goal Understudy did not drive itself
  emit <slug> <flow>    print a flow as runnable test code
  test <slug> <goal>    plan and execute a goal against an app

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
  --arm-manually        drive to the starting point yourself, unrecorded, then
                        press Enter to begin capturing. Use this to record a
                        flow without recording the login that precedes it.
  --after <flow-slug>   replay a known flow first, unrecorded, and capture from
                        where it ends (repeatable, ordered). Skips an INTAKE,
                        which a saved session cannot — wizard progress lives on
                        the server. Combine with --arm-manually to adjust by
                        hand before capture arms. A prelude flow that fills
                        credentials needs the matching --value here too.
  --value REF=value     credentials the saved session is keyed on (repeatable)
  --fresh               ignore any saved session and sign in again
  --seed-session <file> start from an explicit saved-state file rather than the
                        credential cache. Handed to you by a stuck run that
                        asked for a capture — see --seed-url.
  --seed-url <url>      open here instead of the app's base URL. Used with
                        --seed-session to resume exactly where a run got stuck.

IMPORT
  --url <baseUrl>       resolves goto('/') when the script relies on a baseURL

REPLAY
  --value REF=value     supply a redacted value, e.g. SECRET.password=hunter2
  --headed              watch it replay

INGEST
  --value REF=value     supply a redacted value, as for replay
  --force               ingest even if replay failed (stays unbindable)

DISTILL
  --save <file>         supply the distillation JSON; validated before writing
  --again               re-distill even if a cached answer exists
  --value REF=value     as for replay

TEST
  --sub-goal <text>     supply a sub-goal (repeatable); stands in for decompose
  --reasoner bedrock    decompose and judge with a model instead (Mode A).
                        Without it the CLI is fully deterministic and never
                        calls one. Needs AWS — see: npm run bedrock:check
  --dry-run             plan only, never open a browser
  --allow-purchases     permit a destructive plan (default: refuse)
  --value REF=value     as for replay
  --headed              watch it run

FINDINGS
  --no-filter           keep findings from other origins
  --all                 include already-triaged findings

EMIT
  --framework <name>    playwright-ts (default) | cypress-js
  --out <file>          write instead of printing

RECALL
  --kinds <a,b>         restrict to chunk kinds (segment, fact, lesson, …)
  --limit <n>           results per list (default 5)

EXAMPLES
  understudy explore saucedemo --url https://www.saucedemo.com \\
      --login standard_user:secret_sauce
  understudy recall saucedemo "add something to the cart"
  understudy record saucedemo
`;

/**
 * Minimal flag parser: --key value, --flag, and positional arguments.
 *
 * Values accumulate per key. A Map<string, string> silently kept only the LAST
 * occurrence, which made every repeatable flag a lie: `--sub-goal a --sub-goal
 * b` planned only b, and `--value` could never supply more than one credential.
 */
type Flags = Map<string, Array<string | true>>;

function parseArgs(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = new Map();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const key = arg.replace(/^--?/, '');
    const next = argv[i + 1];
    const value: string | true = next !== undefined && !next.startsWith('-') ? next : true;
    if (typeof value === 'string') i++;
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return { flags, positional };
}

/** Last string value for a key, if any. */
const str = (v: Array<string | true> | undefined): string | undefined => {
  const strings = (v ?? []).filter((x): x is string => typeof x === 'string');
  return strings[strings.length - 1];
};

/** Every string value for a key — for genuinely repeatable flags. */
const all = (flags: Flags, key: string): string[] =>
  (flags.get(key) ?? []).filter((x): x is string => typeof x === 'string');

function fail(message: string, hint?: string): never {
  console.error(`error: ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

async function cmdExplore(positional: string[], flags: Flags) {
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

/**
 * Wait for the operator to say "start recording now".
 *
 * Deliberately stdin and not anything on the page. The recorder's stop signal
 * is closing the window for the same reason: any in-page control would itself
 * be captured, and the first recorded step would be a click on Understudy's
 * own UI rather than on the app.
 */
function waitForEnter(prompt: string): Promise<void> {
  // Without a terminal there is nothing to press Enter on, and the wait would
  // hang forever holding a browser window open. Say so instead.
  if (!process.stdin.isTTY) {
    fail(
      '--arm-manually needs a terminal to read the arming keypress from',
      'run it directly rather than through a pipe or a non-interactive shell',
    );
  }

  return new Promise((resolve) => {
    console.log(prompt);
    const finish = () => {
      process.stdin.off('data', finish);
      process.stdin.off('end', finish);
      process.stdin.pause();
      resolve();
    };
    process.stdin.resume();
    process.stdin.once('data', finish);
    // EOF is a legitimate "go" signal too, and without this the promise would
    // never settle on a closed stdin.
    process.stdin.once('end', finish);
  });
}

async function cmdRecord(positional: string[], flags: Flags) {
  const slug = positional[0] ?? fail('record needs an app slug', 'understudy record saucedemo --url https://…');
  const baseUrl = await resolveBaseUrl(slug, str(flags.get('url')));

  const values = valuesFromFlags(flags);
  const seedSessionFile = str(flags.get('seed-session'));
  const seedUrl = str(flags.get('seed-url'));
  // A seeded capture is always late-armed: the whole point is to look at where
  // the run got stuck before deciding what to record.
  const armManually = flags.has('arm-manually') || Boolean(seedSessionFile);
  const fresh = flags.has('fresh');
  const after = all(flags, 'after');

  console.log(`target: ${describeTarget()}`);
  console.log(`recording ${slug} at ${baseUrl}`);

  // Resolved BEFORE the browser opens, so an unknown slug or a cycle costs a
  // query rather than a launched Chromium and a confused operator.
  let prelude: { events: RawEvent[]; slugs: string[] } | undefined;
  if (after.length) {
    const appId = await appIdOrFail(slug);
    const { events, chain } = await eventsForFlowSlugs(appId, after).catch((err: Error) =>
      fail(err.message, 'see `understudy flows ' + slug + '` for the slugs that exist'),
    );

    // A destructive prelude would run on record, replay, ingest AND distill —
    // four real orders per recording. Refuse rather than discover that later.
    const commits = chain.filter((f) => f.destructive).map((f) => f.slug);
    if (commits.length && !flags.has('allow-purchases')) {
      fail(
        `prelude flow(s) marked destructive: ${commits.join(', ')}`,
        'a prelude replays on record, replay, ingest and distill — pass --allow-purchases only if that is genuinely safe',
      );
    }

    prelude = { events, slugs: chain.map((f) => f.slug) };
    console.log(`prelude: ${prelude.slugs.join(' -> ')}  (${events.length} steps, not recorded)`);
  }

  // A saved session only makes sense when capture starts late — if the login is
  // part of what we are recording, restoring one would skip the very steps the
  // recording exists to capture.
  // An explicit seed file wins over the credential cache: it is a specific
  // paused browser being handed over, not a cache of "whoever logged in last".
  const seeded = seedSessionFile ? await loadHandoffSession(seedSessionFile) : undefined;
  if (seedSessionFile && !seeded) {
    fail(
      `could not read the seed session at ${seedSessionFile}`,
      'the run that wrote it may have finished — handoff state is deleted when a run ends',
    );
  }

  const cached = seeded
    ? { storageState: seeded.storageState, savedAt: seeded.savedAt }
    : (armManually || Boolean(prelude)) && !fresh
      ? await loadSession(slug, values, prelude?.slugs)
      : undefined;
  if (seeded) {
    console.log(`session: seeded from ${seedSessionFile} (run ${seeded.runId})`);
    console.log(`         the run is paused at ${seeded.url}`);
  } else if (cached) {
    console.log(`session: restored (saved ${cached.savedAt})`);
  } else if (armManually || prelude) {
    console.log(`session: none — the prelude or your own login establishes one`);
  }
  console.log();

  const recording = await recordLive({
    appSlug: slug,
    startUrl: seedUrl ?? baseUrl,
    ...(cached ? { storageState: cached.storageState } : {}),
    ...(flags.has('max-minutes') ? { maxMinutes: Number(str(flags.get('max-minutes'))) } : {}),
    ...(prelude
      ? {
          preludeSlugs: prelude.slugs,
          beforeArm: async (lease) => {
            console.log(`replaying prelude (${prelude.events.length} steps)…`);
            const pre = await replay(
              buildRecording(
                { source: 'import', origin: `prelude:${prelude.slugs.join('+')}`, appSlug: slug, startUrl: baseUrl },
                prelude.events,
              ),
              { lease, values, headless: false },
            );

            // Arming from a state the prelude did not actually reach would
            // capture steps against a page nobody can get back to.
            if (!pre.ok) {
              const failedStep = pre.steps.find((st) => !st.ok);
              fail(
                `prelude did not replay clean — step ${failedStep?.seq} (${failedStep?.action}) ${failedStep?.error ?? ''}`,
                'fix or re-ingest the prelude flow before recording on top of it',
              );
            }
            console.log(`prelude finished — ${pre.steps.length} steps replayed`);
          },
        }
      : {}),
    ...(armManually
      ? {
          armWhen: () =>
            waitForEnter(
              prelude
                ? 'the prelude has finished — adjust if you need to, nothing is being recorded yet.\n' +
                    'press Enter here to begin capturing.'
                : 'drive to the point you want to start from — nothing is being recorded yet.\n' +
                  'press Enter here to begin capturing.',
            ),
        }
      : {}),
    ...(armManually || prelude
      ? {
          onArmed: async ({ context, sig }) => {
            console.log(`\narmed at ${sig}\n`);

            // A SEEDED CAPTURE MUST NOT BANK ITS STATE AS THE LOGIN SESSION.
            // It was handed a specific paused browser sitting mid-flow; writing
            // that under the credential key would mean the next ordinary
            // `--arm-manually` restores a half-finished wizard. It still
            // counts as requiring a session, because it plainly does.
            if (seeded) return { sessionSaved: true };

            // Saved at arm time, not at the end: this is the state the recording
            // claims to start from, and the steps that follow may well log out
            // of it.
            const path = await saveSession(context, slug, values, sig, prelude?.slugs);
            if (path) console.log(`session saved  ${path}`);
            return { sessionSaved: Boolean(path) };
          },
        }
      : {}),
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

  if (recording.entry?.requiresSession) {
    console.log(
      `\nthis recording starts from a signed-in browser (${recording.entry.startState}).`,
    );
    console.log('  replay and ingest restore the saved session for these --value credentials.');
  }

  console.log(`\nhash  ${recording.hash}${existed ? '  (identical recording already existed)' : ''}`);
  console.log(`saved ${path}`);
}

/**
 * Resolve the session a recording needs before it can replay.
 *
 * A late-armed recording declares that its first step is not reachable from a
 * cold browser. Failing here with the reason is the whole point: without it,
 * replay lands on a login page and dies on a locator that was never going to be
 * there, which reads as a broken recording rather than a missing session.
 */
/**
 * Resolve the prelude a recording declares into steps that can be walked.
 *
 * The same shape as `sessionForRecording`, and for the same reason: a recording
 * captured with `--after` holds only the tail, so replaying it cold starts on a
 * page its first step never expected. Failing HERE, naming the missing flow, is
 * the difference between an explicable error and a locator timeout twenty steps
 * from the actual cause.
 */
async function preludeForRecording(
  recording: RawRecording,
): Promise<RawEvent[] | undefined> {
  const slugs = recording.entry?.prelude;
  if (!slugs?.length) return undefined;

  const appId = await appIdFor(recording.appSlug);
  if (!appId) {
    fail(
      `this recording declares a prelude (${slugs.join(' -> ')}) but app '${recording.appSlug}' is not in this store`,
      'ingest the app first, or switch --target',
    );
  }

  const { events, chain } = await eventsForFlowSlugs(appId, slugs).catch((err: Error) =>
    fail(
      `this recording declares a prelude that cannot be resolved — ${err.message}`,
      'the referenced flow must exist in this corpus; re-ingest it or re-record without --after',
    ),
  );

  console.log(`prelude: ${chain.map((f) => f.slug).join(' -> ')}  (${events.length} steps)`);
  return events;
}

async function sessionForRecording(
  recording: RawRecording,
  values: Record<string, string>,
): Promise<StorageState | undefined> {
  if (!recording.entry?.requiresSession) return undefined;

  const cached = await loadSession(recording.appSlug, values, recording.entry.prelude);
  if (!cached) {
    fail(
      'this recording starts from a signed-in browser, and no saved session matches these credentials',
      'pass the same --value credentials you recorded with, or re-record with --arm-manually',
    );
  }

  console.log(`session: restored (saved ${cached.savedAt})`);
  return cached.storageState;
}

/**
 * A restored session that did not land where it was saved is dead — drop it.
 *
 * Detected, not probed: step 0 of a late-armed recording carries the arming
 * fingerprint as its `expectedSig`, so replay has already made the comparison.
 * Deleting the entry here is what stops the same stale session being restored
 * on the next run and producing the identical confusing failure.
 */
/**
 * Report a prelude that did not replay, and stop.
 *
 * Distinct from a failed recording on purpose: the recording's own steps never
 * ran, so nothing was learned about it. Saying "replay FAILED" here would send
 * someone to debug a recording that is very likely fine, when what actually
 * broke is upstream — the referenced flow has rotted, or the app changed before
 * the part under test.
 */
function reportPreludeFailure(
  recording: RawRecording,
  result: { preludeOk?: boolean; preludeSteps?: Array<{ seq: number; action: string; error?: string }> },
): boolean {
  if (result.preludeOk !== false) return false;

  const bad = result.preludeSteps?.find((s) => s.error);
  console.error('\nthe PRELUDE failed — this recording\'s own steps never ran.');
  console.error(`  prelude   ${recording.entry?.prelude?.join(' -> ') ?? '(unknown)'}`);
  if (bad) console.error(`  step ${bad.seq} (${bad.action}): ${bad.error}`);
  console.error('  the recording is not implicated; fix or re-ingest the prelude flow.');
  process.exitCode = 4;
  return true;
}

async function dropStaleSession(
  recording: RawRecording,
  values: Record<string, string>,
  result: { steps: Array<{ seq: number; unexpectedPage?: { expected: string; observed: string } }> },
): Promise<void> {
  if (!recording.entry?.requiresSession) return;

  const entryStep = result.steps.find((s) => s.seq === 0);
  if (!entryStep?.unexpectedPage) return;

  await forgetSession(recording.appSlug, values, recording.entry.prelude);
  console.log('\nthe restored session did not land where it was recorded:');
  console.log(`  expected  ${entryStep.unexpectedPage.expected}`);
  console.log(`  observed  ${entryStep.unexpectedPage.observed}`);
  console.log('  the saved session has been discarded — re-record with --arm-manually to refresh it.');
}

async function cmdImport(positional: string[], flags: Flags) {
  const slug = positional[0] ?? fail('import needs an app slug', 'understudy import saucedemo tests/login.spec.ts');
  const file = positional[1] ?? fail('import needs a script path');

  // A script may use a baseURL from playwright.config, so `goto('/')` carries
  // no origin. The app's known base URL fills that in.
  const known = await getPool().query<{ base_url: string }>(
    'SELECT base_url FROM apps WHERE slug = $1',
    [slug],
  );
  const fallback = str(flags.get('url')) ?? known.rows[0]?.base_url;

  const { recording: parsed, warnings } = await parseScript(file, slug, fallback);

  // CUT AT A VERIFIED BOUNDARY.
  //
  // A spec can contain steps this IR cannot express — an inline page.evaluate,
  // a wait the schema has no action for — and replay stops at the first of
  // them. Everything before that point still replayed and is still true, so
  // throwing it away because of what follows loses real memory. --until keeps
  // the proven prefix and drops the rest, which is honest in a way that
  // --force is not: the stored recording then describes exactly what was
  // verified, rather than claiming steps nobody proved.
  const until = str(flags.get('until'));
  const recording = until
    ? buildRecording(
        { source: parsed.source, origin: parsed.origin, appSlug: parsed.appSlug, startUrl: parsed.startUrl },
        parsed.events.slice(0, Number(until)),
      )
    : parsed;

  if (until) {
    console.log(`kept ${recording.events.length} of ${parsed.events.length} steps (--until ${until})\n`);
  }

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

async function cmdReplay(positional: string[], flags: Flags) {
  const hash = positional[0] ?? fail('replay needs a recording hash', 'understudy recordings');
  const recording = await loadRecording(hash).catch(() => fail(`no recording '${hash}'`, 'understudy recordings'));

  // Credentials are deliberately absent from recordings, so they must be
  // supplied here: --value SECRET.password=hunter2 (repeatable).
  const values = valuesFromFlags(flags);

  const needed = recording.events.filter((e) => e.valueRef && !(e.valueRef in values));
  if (needed.length) {
    console.log(`this recording needs ${needed.length} value(s) it deliberately does not store:`);
    for (const e of needed) console.log(`  --value ${e.valueRef}=…`);
    console.log('');
  }

  // Consult what the corpus has learned, exactly as the executor does. Without
  // this a verification replay is the one place that ignores the memory — and
  // it is also where lesson counters would otherwise never move.
  const replayAppId = await appIdFor(recording.appSlug);
  const storageState = await sessionForRecording(recording, values);
  const replayPrelude = await preludeForRecording(recording);
  const result = await replay(recording, {
    values,
    ...(storageState ? { storageState } : {}),
    ...(replayPrelude ? { prelude: replayPrelude } : {}),
    ...(flags.has('headed') ? { headless: false } : {}),
    ...(replayAppId ? { lessonsFor: (context) => lessonsFor(replayAppId, context) } : {}),
  });
  if (replayAppId) {
    const folded = await foldLessonOutcomes(replayAppId, result.steps, recording.events);
    if (folded.fired) console.log(`lessons  ${folded.fired} fired, ${folded.helped} on steps with a history of failing`);
  }
  await dropStaleSession(recording, values, result);
  if (reportPreludeFailure(recording, result)) return;

  console.log(`replay ${result.ok ? 'PASSED' : 'FAILED'} in ${(result.durationMs / 1000).toFixed(1)}s\n`);
  for (const s of result.steps) {
    const status = s.ok ? 'ok  ' : 'FAIL';
    const notes = [
      s.ambiguousByName && `ambiguous: ${s.ambiguousByName.matched} by name, resolved via ${s.ambiguousByName.disambiguatedBy}`,
      s.roleHadNoMatch && `role matched nothing, fell back to ${s.roleHadNoMatch.fellBackTo}`,
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

/**
 * App id, or null when this app has no corpus yet.
 *
 * Soft on purpose: a replay must still work against an app nothing has been
 * ingested for. Lesson lookup is an enhancement to a replay, never a
 * precondition for one.
 */
async function appIdFor(slug: string): Promise<string | null> {
  const { rows } = await getPool().query<{ app_id: string }>(
    'SELECT app_id FROM apps WHERE slug = $1',
    [slug],
  );
  return rows[0]?.app_id ?? null;
}

async function appIdOrFail(slug: string): Promise<string> {
  const { rows } = await getPool().query<{ app_id: string }>(
    'SELECT app_id FROM apps WHERE slug = $1',
    [slug],
  );
  return rows[0]?.app_id ?? fail(`unknown app '${slug}'`, 'run `understudy explore` or `ingest` first');
}

function valuesFromFlags(flags: Flags): Record<string, string> {
  const values: Record<string, string> = {};
  for (const v of all(flags, 'value')) {
    const eq = v.indexOf('=');
    if (eq < 0) fail('--value must be REF=value');
    values[v.slice(0, eq)] = v.slice(eq + 1);
  }
  return values;
}

async function cmdIngest(positional: string[], flags: Flags) {
  const hash = positional[0] ?? fail('ingest needs a recording hash', 'understudy recordings');
  const recording = await loadRecording(hash).catch(() => fail(`no recording '${hash}'`));

  // Replay is not optional. A recording that does not reproduce must not become
  // memory, and the replay is also where start_state/end_state and per-step
  // fingerprints come from.
  console.log(`target: ${describeTarget()}`);
  console.log('replaying to verify…');
  const ingestValues = valuesFromFlags(flags);
  const replayAppId = await appIdFor(recording.appSlug);
  const ingestSession = await sessionForRecording(recording, ingestValues);
  const ingestPrelude = await preludeForRecording(recording);
  const result = await replay(recording, {
    values: ingestValues,
    ...(ingestSession ? { storageState: ingestSession } : {}),
    ...(ingestPrelude ? { prelude: ingestPrelude } : {}),
    ...(replayAppId ? { lessonsFor: (context) => lessonsFor(replayAppId, context) } : {}),
  });
  if (replayAppId) await foldLessonOutcomes(replayAppId, result.steps, recording.events);
  await dropStaleSession(recording, ingestValues, result);
  if (reportPreludeFailure(recording, result)) return;

  const failed = result.steps.find((s) => !s.ok);
  if (failed) {
    console.log(`  step ${failed.seq} (${failed.action}) failed: ${failed.error}`);
  }
  console.log(`  ${result.steps.filter((s) => s.ok).length}/${recording.events.length} steps replayed\n`);

  if (result.needsReview && !flags.has('force')) {
    console.error('NOT INGESTED — this recording did not replay cleanly.');
    console.error('  memory built from an unverified recording is worse than no memory.');
    console.error('  use --force to write it anyway (it will be flagged needs_review and stay unbindable).');
    process.exitCode = 3;
    return;
  }

  const ing = await ingestRecording(createEmbedder(), recording, result, {
    ...(flags.has('force') ? { force: true } : {}),
  });
  const run = await recordRun(result, {
    appId: ing.appId,
    goal: `verify recording ${hash.slice(0, 8)}`,
    mode: 'dry-run',
    stepIds: ing.stepIds,
    selectorIds: ing.selectorIds,
  });

  console.log(`${ing.created ? 'created' : 'updated'} flow  ${ing.slug}`);
  console.log(`  steps       ${ing.steps}`);
  console.log(`  selectors   ${ing.selectorsCreated} new, ${ing.selectorsReused} already known`);
  if (ing.unnamedControls) {
    console.log(
      `  UNNAMED     ${ing.unnamedControls} control(s) have no accessible name — filed as addressability findings.`,
    );
    console.log('              Steps reaching them cannot be addressed as {role, name}, which is what makes a seam unresolvable.');
  }
  console.log(`  destructive ${ing.destructive}`);
  console.log(`  bindable    ${ing.chunkWritten ? 'yes — embedded and searchable' : 'no (needs_review)'}`);
  console.log(`  run         ${run.events} events, ${run.edges} page edge(s)`);
  console.log(`  findings    ${run.findingsNew} new, ${run.findingsSeenAgain} seen before`);

  // Macro mining runs at ingest, per the plan. It is the deterministic backstop
  // for distillation: a distiller only ever sees ONE recording, so it cannot
  // know that this one opens with the same block as the last three.
  const mined = await mineMacros(createEmbedder(), ing.appId);
  const created = mined.macros.filter((m) => !m.deferredTo);
  const deferred = mined.macros.filter((m) => m.deferredTo);
  if (created.length || deferred.length) {
    console.log(`  macros      ${created.length} mined, ${deferred.length} already named`);
    for (const m of deferred) console.log(`                "${m.deferredTo}" now used by ${m.usedBy} flows`);
  }
}

async function cmdDistill(positional: string[], flags: Flags) {
  const hash = positional[0] ?? fail('distill needs a recording hash', 'understudy recordings');
  const recording = await loadRecording(hash).catch(() => fail(`no recording '${hash}'`));

  // Replay first, always. The distiller must only ever see VERIFIED steps —
  // an unreplayable step could otherwise be named, segmented, and bound like
  // a real one.
  const replayAppId = await appIdFor(recording.appSlug);
  const distillValues = valuesFromFlags(flags);
  const distillSession = await sessionForRecording(recording, distillValues);
  const distillPrelude = await preludeForRecording(recording);
  const result = await replay(recording, {
    values: distillValues,
    ...(distillSession ? { storageState: distillSession } : {}),
    ...(distillPrelude ? { prelude: distillPrelude } : {}),
    ...(replayAppId ? { lessonsFor: (context) => lessonsFor(replayAppId, context) } : {}),
  });
  if (replayAppId) await foldLessonOutcomes(replayAppId, result.steps, recording.events);
  await dropStaleSession(recording, distillValues, result);
  if (reportPreludeFailure(recording, result)) return;
  if (result.needsReview) {
    console.error('cannot distill — the recording did not replay cleanly.');
    const bad = result.steps.find((s) => !s.ok);
    if (bad) console.error(`  step ${bad.seq} (${bad.action}): ${bad.error}`);
    process.exitCode = 3;
    return;
  }

  const savePath = str(flags.get('save'));

  // ---- second half of the handshake: an answer came back ----
  if (savePath) {
    const parsed = JSON.parse(await readFile(savePath, 'utf8'));
    const request = buildDistillRequest(recording, result);
    const check = validateDistilled(parsed, request.steps.length);

    if (!check.ok) {
      console.error(`distillation is invalid (${check.errors.length} problem(s)):`);
      for (const e of check.errors) console.error(`  ${e}`);
      console.error('\nnothing was written. fix and re-run.');
      process.exitCode = 2;
      return;
    }

    await saveDistilled(hash, check.value!);
    const ing = await ingestRecording(createEmbedder(), recording, result, { distilled: check.value! });

    // The replay that verified this recording IS a run. Recording it gives the
    // flow-drift baseline, turns captured signals into findings, and grows the
    // page graph from what was actually walked.
    const run = await recordRun(result, {
      appId: ing.appId,
      goal: `verify recording ${hash.slice(0, 8)}`,
      mode: 'dry-run',
      stepIds: ing.stepIds,
      selectorIds: ing.selectorIds,
    });

    console.log(`${ing.created ? 'created' : 'updated'} flow  ${ing.slug}`);
    console.log(`  intent      ${check.value!.intent}`);
    console.log(`  steps       ${ing.steps}`);
    console.log(`  segments    ${ing.segments}  <- reusable by future flows`);
    console.log(`  lessons     ${ing.lessons}`);
    console.log(`  bindable    ${ing.chunkWritten ? 'yes' : 'no'}`);
    console.log(`  run         ${run.events} events, ${run.edges} page edge(s)`);
    console.log(`  findings    ${run.findingsNew} new, ${run.findingsSeenAgain} seen before`);

  // Macro mining runs at ingest, per the plan. It is the deterministic backstop
  // for distillation: a distiller only ever sees ONE recording, so it cannot
  // know that this one opens with the same block as the last three.
  const mined = await mineMacros(createEmbedder(), ing.appId);
  const created = mined.macros.filter((m) => !m.deferredTo);
  const deferred = mined.macros.filter((m) => m.deferredTo);
  if (created.length || deferred.length) {
    console.log(`  macros      ${created.length} mined, ${deferred.length} already named`);
    for (const m of deferred) console.log(`                "${m.deferredTo}" now used by ${m.usedBy} flows`);
  }
    return;
  }

  // ---- cached? then there is nothing to ask ----
  const cached = await loadDistilled(hash);
  if (cached && !flags.has('again')) {
    const ing = await ingestRecording(createEmbedder(), recording, result, { distilled: cached });
    console.log(`used cached distillation (${distilledPath(hash)})`);
    console.log(`  intent    ${cached.intent}`);
    console.log(`  segments  ${ing.segments}`);
    console.log('\nre-distill with --again');
    return;
  }

  // ---- first half of the handshake: pause and return ----
  //
  // The app's existing vocabulary goes WITH the request, so a second recording
  // of the same block reuses its name instead of minting a synonym.
  const { rows: appRow } = await getPool().query<{ app_id: string }>(
    'SELECT app_id FROM apps WHERE slug = $1',
    [recording.appSlug],
  );
  const vocabulary = appRow[0]
    ? await fetchVocabulary(appRow[0].app_id)
    : { segments: [], flows: [], facts: [] };

  const request = buildDistillRequest(recording, result, vocabulary);
  await mkdir('.understudy/requests', { recursive: true });
  const out = `.understudy/requests/${hash}.distill.json`;
  await writeFile(out, JSON.stringify(request, null, 2), 'utf8');

  console.log(`NEEDS DISTILLATION — ${request.steps.length} verified steps`);
  if (vocabulary.segments.length) {
    console.log(`\nthis app already knows ${vocabulary.segments.length} segment(s) — reuse their wording where it fits:`);
    for (const v of vocabulary.segments) console.log(`  ${v.slug.padEnd(28)} ${v.intent.slice(0, 60)}`);
  }
  console.log('');
  for (const s of request.steps) {
    const v = s.value !== undefined ? ` = "${s.value}"` : s.valueRef ? ` = <${s.valueRef}>` : '';
    console.log(`  ${String(s.index).padStart(2)}  ${s.action.padEnd(7)} ${(s.role ?? '').padEnd(9)} ${s.name ?? ''}${v}`);
  }
  console.log(`\nrequest written to ${out}`);
  console.log(`answer with:  understudy distill ${hash} --save <your.json>`);
  process.exitCode = 4; // "waiting on a decision", distinct from failure
}

async function cmdMine(positional: string[]) {
  const slug = positional[0] ?? fail('mine needs an app slug');
  const appId = await appIdOrFail(slug);

  const result = await mineMacros(createEmbedder(), appId);
  console.log(
    `scanned ${result.flowsScanned} recorded flow(s), ${result.candidates} shared block(s)` +
      (result.retired ? `, retired ${result.retired} stale macro(s)` : '') +
      '\n',
  );

  if (!result.macros.length) {
    console.log(result.flowsScanned < 2
      ? 'nothing to mine — a block has to appear in at least 2 flows to be a pattern'
      : 'no recurring blocks of 3+ steps');
    return;
  }
  for (const m of result.macros) {
    if (m.deferredTo) {
      console.log(`  ${String(m.length).padStart(2)} steps x${m.usedBy}  already named "${m.deferredTo}" — used_by updated, no macro created`);
    } else {
      console.log(`  ${String(m.length).padStart(2)} steps x${m.usedBy}  ${m.created ? 'mined' : 'updated'} ${m.slug}`);
    }
  }
}

async function cmdTest(positional: string[], flags: Flags) {
  const slug = positional[0] ?? fail('test needs an app slug', 'understudy test saucedemo "log in"');
  const goal = positional.slice(1).join(' ');
  if (!goal) fail('test needs a goal');

  const appId = await appIdOrFail(slug);
  const { rows: app } = await getPool().query<{ base_url: string }>(
    'SELECT base_url FROM apps WHERE app_id = $1', [appId]);

  // --sub-goal is the manual stand-in for the reasoner's decompose. Repeatable.
  let subGoals = all(flags, 'sub-goal');

  // MODE A. Without --reasoner the CLI stays fully deterministic: it plans from
  // whatever sub-goals you typed and never calls a model. With it, decompose
  // and the two judgement callbacks are wired to Bedrock, which is the same
  // pipeline the MCP server runs — only the answers arrive from an API instead
  // of from the agent reading a suspension.
  const reasoner = flags.has('reasoner') ? createReasoner(str(flags.get('reasoner'))) : undefined;

  if (reasoner && !subGoals.length) {
    const vocabulary = await fetchVocabulary(appId, { purpose: 'plan' });
    subGoals = await reasoner.decompose(goal, vocabularyLines(vocabulary));
    console.log(`decomposed by ${reasoner.id}:`);
    for (const sg of subGoals) console.log(`  - ${sg}`);
    console.log('');
  }

  const plan = await buildPlan(createEmbedder(), appId, goal, {
    baseUrl: app[0]!.base_url,
    ...(subGoals.length ? { subGoals } : {}),
    // Rung 5 only exists when someone can answer it. Deterministic runs leave
    // it off, so an unresolved seam blocks rather than being guessed at.
    ...(reasoner
      ? {
          onSeamProbe: async (context: Record<string, unknown>) =>
            (await reasoner.resolve({ kind: 'seam', context })) as {
              steps?: Array<{ action: string; role?: string; name?: string; testId?: string; css?: string; value?: string }>;
            },
        }
      : {}),
    ...(flags.has('allow-purchases')
      ? { env: { allowsPurchases: true, allowsIrreversible: true, name: 'cli --allow-purchases' } }
      : {}),
  });

  console.log(`target: ${describeTarget()}`);
  console.log(`goal:   "${goal}"\n`);

  for (const sg of plan.subGoals) {
    console.log(`SUB-GOAL  "${sg.subGoal}"`);
    if (sg.bound) {
      console.log(`  bound   ${sg.bound.distance.toFixed(4)}  ${sg.bound.slug} (${sg.bound.steps} steps)`);
      console.log(`          ${sg.bound.intent.slice(0, 76)}`);
    } else {
      console.log(`  GAP     nothing legal bound (top=${sg.topDistance?.toFixed(4) ?? 'n/a'})`);
    }
    // Rejections are the interesting part: this is where a candidate that
    // retrieved WELL was refused on state grounds.
    for (const r of sg.rejected) {
      console.log(`  reject  ${r.distance.toFixed(4)}  ${r.slug} — ${r.why}`);
    }
    for (const c of sg.context.slice(0, 2)) {
      console.log(`  context ${c.distance.toFixed(4)}  [${c.kind}] ${c.text.slice(0, 62)}`);
    }
    console.log('');
  }

  for (const seam of plan.seams) {
    console.log(`SEAM rung ${seam.rung} ${seam.from} -> ${seam.to}: ${seam.kind}`);
    console.log(`     ${seam.detail}${seam.steps.length ? ` [+${seam.steps.length} bridging step(s)]` : ''}`);
  }
  if (plan.seams.length) console.log('');

  // BLOCKED is checked first: "I know how and I am not allowed" is a more
  // specific and more useful answer than "I could not bind anything", and a
  // safety refusal leaves the sub-goal unbound as a side effect.
  if (plan.blocked) {
    console.log(`BLOCKED — ${plan.blocked}`);
    console.log('  re-run with --allow-purchases only if that is genuinely safe here.');
    process.exitCode = 5;
    return;
  }
  if (plan.unbound.length) {
    console.log(`NOT RUNNABLE — ${plan.unbound.length} sub-goal(s) bound to nothing.`);
    console.log('  this is the gap loop: record a flow for it, then try again.');
    process.exitCode = 4;
    return;
  }

  if (flags.has('dry-run')) {
    console.log('dry run — plan is executable, stopping before the browser.');
    return;
  }

  const exec = await executePlan(plan, app[0]!.base_url, slug, {
    values: valuesFromFlags(flags),
    ...(flags.has('headed') ? { headless: false } : {}),
    // Without a reasoner an unexpected page is recorded and the run carries on;
    // with one, it gets judged. Same escalation the MCP server surfaces.
    ...(reasoner ? { onDecision: (decision) => reasoner.resolve(decision) } : {}),
  });

  console.log(`EXECUTED ${exec.flowsRun.join(' -> ')}`);
  console.log(`  ${exec.result.ok ? 'PASSED' : 'FAILED'} in ${(exec.result.durationMs / 1000).toFixed(1)}s`);
  for (const st of exec.result.steps) {
    if (st.ok && !st.ambiguousByName && !st.roundTripMismatch) continue;
    const note = st.error ?? (st.ambiguousByName ? `ambiguous: ${st.ambiguousByName.matched} by name` : 'value did not survive');
    console.log(`  step ${st.seq} ${st.action}: ${note}`);
  }
  console.log(`  path: ${exec.result.sigSequence.join('  ->  ')}`);

  const run = await recordRun(exec.result, { appId, goal, mode: 'execute' });
  console.log(`  findings ${run.findingsNew} new, ${run.findingsSeenAgain} seen before`);
  if (run.health?.quarantined.length) {
    console.log(`  QUARANTINED ${run.health.quarantined.length} selector(s): ${run.health.quarantined.join(', ')}`);
    console.log('              3+ failures and no successes — dropped from recall until one works');
  }
  if (run.health?.released.length) {
    console.log(`  released ${run.health.released.length} selector(s): ${run.health.released.join(', ')}`);
  }

  const d = run.drift;
  if (d?.firstRun) {
    console.log('  drift    first run of this goal — nothing to compare against yet');
  } else if (d?.changed) {
    console.log(`  DRIFT    path changed vs the last ${d.baselineRuns} passing run(s):`);
    for (const step of d.diff) {
      const mark = step.change === 'added' ? '  + ' : step.change === 'removed' ? '  - '
                 : step.change === 'changed' ? '  ~ ' : '    ';
      const extra = step.was ? `   (was ${step.was})` : '';
      console.log(`         ${mark}${step.sig}${extra}`);
    }
    console.log('           recorded as a flow_drift finding — whether it is a bug is a judgement call');
  } else if (d) {
    console.log(`  drift    none (matches the last ${d.baselineRuns} passing run(s))`);
  }
  if (!exec.result.ok) process.exitCode = 1;
}

async function cmdEmit(positional: string[], flags: Flags) {
  const slug = positional[0] ?? fail('emit needs an app slug', 'understudy emit saucedemo log-in-as-standard-user');
  const flowSlug = positional[1] ?? fail('emit needs a flow slug', 'understudy flows <slug> to list them');

  const framework = (str(flags.get('framework')) ?? 'playwright-ts') as Framework;
  if (framework !== 'playwright-ts' && framework !== 'cypress-js') {
    fail(`unknown framework '${framework}'`, 'playwright-ts | cypress-js');
  }

  const out = await emitFlow(slug, flowSlug, framework);

  const target = str(flags.get('out'));
  if (target) {
    await writeFile(target, out.code, 'utf8');
    console.log(`wrote ${target}`);
  } else {
    console.log(out.code);
  }

  if (out.requiredValues.length) {
    console.log(`\nthis test needs values it deliberately does not contain:`);
    for (const r of out.requiredValues) {
      console.log(`  export ${r.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}=…   (${r})`);
    }
  }
  if (out.warnings.length) {
    console.log(`\n${out.warnings.length} warning(s):`);
    for (const w of out.warnings) console.log(`  ${w}`);
  }
}

/**
 * Write knowledge by hand, from a JSON batch.
 *
 * A file rather than flags because these are multi-line prose with structured
 * triggers, and because a batch is the unit the operating contract asks for:
 * gather what you learned, confirm the list, write it once.
 */
/**
 * Record a goal that something other than the executor drove.
 *
 * `--failed` rather than `--passed` because the honest default for "I ran this
 * and I am telling you about it" is that it worked; a failure is the thing
 * worth spelling out.
 */
async function cmdAttribute(positional: string[], flags: Flags) {
  const slug = positional[0] ?? fail('attribute needs an app slug');
  const goal = positional.slice(1).join(' ') || fail('attribute needs a goal');
  const appId = await appIdOrFail(slug);

  const drivenBy = str(flags.get('driven-by'));
  const note = str(flags.get('note'));

  const out = await recordAttributedRun({
    appId,
    goal,
    passed: !flags.has('failed'),
    sigSequence: all(flags, 'sig'),
    ...(drivenBy ? { drivenBy } : {}),
    ...(note ? { note } : {}),
  });

  console.log(`recorded run ${out.runId}  mode=attributed  status=${flags.has('failed') ? 'failed' : 'passed'}`);
  if (out.drift) {
    console.log(
      out.drift.baselineRuns === 0
        ? 'first run of this goal — nothing to compare against yet'
        : out.drift.changed
          ? `DRIFT vs the last ${out.drift.baselineRuns} passing run(s)`
          : `drift none (matches the last ${out.drift.baselineRuns} passing run(s))`,
    );
  } else {
    console.log('drift not measured — pass --sig <fingerprint> per step to lay down a baseline');
  }
}

async function cmdRemember(positional: string[]) {
  const slug = positional[0] ?? fail('remember needs an app slug');
  const file = positional[1] ?? fail('remember needs a JSON file: understudy remember <slug> <file>');
  const appId = await appIdOrFail(slug);

  let input: RememberInput;
  try {
    input = JSON.parse(await readFile(file, 'utf8')) as RememberInput;
  } catch (err) {
    return fail(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Validate before the embedder loads — a bad batch should cost nothing, and
  // every problem is reported at once so one pass is enough to fix it.
  const problems = validateRemember(input);
  if (problems.length) {
    console.error(`nothing written — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 2;
    return;
  }

  const out = await remember(createEmbedder(), appId, input);
  console.log(`facts     ${out.facts.written} written, ${out.facts.alreadyPresent} already present`);
  console.log(`lessons   ${out.lessons.written} written, ${out.lessons.alreadyPresent} already present`);
  console.log(`findings  ${out.findings.written} written, ${out.findings.reoccurred} re-occurred`);
}

async function cmdFlows(positional: string[]) {
  const slug = positional[0] ?? fail('flows needs an app slug');
  const appId = await appIdOrFail(slug);
  const { rows } = await getPool().query<{
    slug: string; source: string; steps: string; destructive: boolean; needs_review: boolean; corrections: unknown[];
  }>(
    `SELECT f.slug, f.source, f.destructive, f.needs_review, f.corrections,
            (SELECT count(*) FROM flow_steps fs WHERE fs.flow_id = f.flow_id)::STRING AS steps
     FROM flows f WHERE f.app_id = $1 ORDER BY f.source, f.slug`,
    [appId],
  );
  for (const r of rows) {
    const marks = [
      r.destructive ? 'DESTRUCTIVE' : '',
      r.needs_review ? 'needs_review' : '',
      Array.isArray(r.corrections) && r.corrections.length ? `${r.corrections.length} correction(s)` : '',
    ].filter(Boolean).join(' ');
    console.log(`  ${r.source.padEnd(8)} ${r.slug.padEnd(46)} ${String(r.steps).padStart(2)} steps  ${marks}`);
  }
}

async function cmdFindings(positional: string[], flags: Flags) {
  const slug = positional[0] ?? fail('findings needs an app slug');
  const appId = await appIdOrFail(slug);

  // Mechanical filter first. Asking a model whether someone else's telemetry
  // endpoint is our bug wastes a call and the reader's attention.
  if (!flags.has('no-filter')) {
    const filtered = await suppressThirdParty(appId);
    if (filtered.suppressed) {
      console.log(`suppressed ${filtered.suppressed} finding(s) from other origins: ${filtered.hosts.join(', ')}`);
      console.log('  (these never touched the app under test — --no-filter to keep them)\n');
    }
  }

  const findings = await listOpenFindings(appId, {
    ...(flags.has('all') ? { includeSuppressed: true } : {}),
  });

  if (!findings.length) {
    console.log('no open findings');
  }
  for (const f of findings) {
    console.log(`${f.severity.toUpperCase().padEnd(6)} ${f.kind.padEnd(14)} x${String(f.occurrences).padStart(3)}  ${f.findingId.slice(0, 8)}`);
    console.log(`       ${f.statement.slice(0, 96)}`);
    // The correlation with intent is the whole reason a finding is worth more
    // than a log line.
    if (f.goal) console.log(`       while: "${f.goal}"${f.duringStep !== undefined ? ` (step ${f.duringStep})` : ''}`);
  }

  const summary = await triageSummary(appId);
  console.log(`\n${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join('  ')}`);
}

async function cmdRecall(positional: string[], flags: Flags) {
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
    case 'test':
      await cmdTest(rest, flags);
      break;
    case 'findings':
      await cmdFindings(rest, flags);
      break;
    case 'emit':
      await cmdEmit(rest, flags);
      break;
    case 'remember':
      await cmdRemember(rest);
      break;
    case 'attribute':
      await cmdAttribute(rest, flags);
      break;
    case 'flows':
      await cmdFlows(rest);
      break;
    case 'mine':
      await cmdMine(rest);
      break;
    case 'distill':
      await cmdDistill(rest, flags);
      break;
    case 'ingest':
      await cmdIngest(rest, flags);
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
