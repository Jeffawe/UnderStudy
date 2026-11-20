#!/usr/bin/env node
/**
 * understudy — command line. Agents use the MCP server (entry/mcp.ts) instead;
 * both call the same functions underneath.
 *
 * Argument parsing is hand-rolled on purpose: the surface is small, and a
 * parser library would be more code than it saves.
 */

import { recordLive } from '../adapters/recorder/live.js';
import { parseScript } from '../adapters/recorder/script.js';
import { startExtensionRecorder, DEFAULT_PORT, extensionDir, firefoxExtensionDir } from '../adapters/recorder/extension.js';
import { listRecordings, loadRecording, saveRecording } from '../core/recording-store.js';
import { loadSession, saveSession } from '../core/auth-cache.js';
import { buildRecording, type RawRecording } from '../core/recording.js';
import type { ReplayResult } from '../core/replay.js';
import { execute, prove, MissingValuesError } from '../flows/execute.js';
import { destructiveControls, remember } from '../memory/notes.js';
import { start, answer, runPlan, type PlanState } from '../plan/planner.js';
import { distillRequest, saveDistilled } from '../flows/distill.js';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { emitFlow, type Framework } from '../flows/emit.js';
import { recordingFrom, proveAndSave, proveByRun, type ProveAndSave } from '../flows/save.js';
import { recordRun, type RecordedRun } from '../flows/runs.js';
import { recall, type Recall } from '../memory/recall.js';
import { setPlaceholders, appPlaceholders } from '../memory/placeholders.js';
import * as store from '../store/db.js';
import { valueEnvName, readConfig, writeConfig, loadedFrom, HOME, expandHome, writeEnvValues } from '../store/settings.js';

const USAGE = `understudy — learn a web app, then test it by intent

USAGE
  understudy <command> [options]

COMMANDS
  config                where settings come from; set them, or point at an env file
  doctor                check the MongoDB connection, vector search and embedder
  reembed               rebuild every vector with the model now configured
  record <app>          capture a flow in your own Chrome, with the extension
  extension             where the Chrome extension is, and how to load it
  app <app>             an app's settings, e.g. --placeholder email
  import <app> <file>   read an existing Playwright script into a recording
  recordings [app]      list captured recordings
  save <hash> "<name>"  prove a recording by replaying it, then save it as a flow
  flows <app>           list an app's saved flows and how each last ran
  replay <hash>         re-run a recording file headless
  replay <app> <flow>   re-run a saved flow; records the run, drift and findings
  findings <app>        what looked broken, most frequent first
  recall <app> "<goal>" what memory knows about a goal — nothing runs
  run <app> "<goal>"    find the flow that does the goal, and run it
  answer <runId> <json> answer a question a planned run stopped on
  distill <app> <flow>  print a saved flow's steps for an agent to name and split
  remember <app> <file> store facts, lessons and findings from a JSON batch
  emit <app> <flow>     print a saved flow as a Playwright or Cypress test

  MCP server for agents: understudy-mcp (see REASONER.md).

RECORD (in your own Chrome — load extension/ unpacked once, see extension/README.md)
  --port <n>            port the extension talks to (default 7397)

RECORD --new-browser (opt-in: a fresh browser Understudy opens; needs
                      "npx playwright install chromium", ~350 MB)
  --url <baseUrl>       required the first time you use an app; remembered after
  --max-minutes <n>     stop recording after n minutes (default 30)
  --arm-manually        drive to the starting point yourself, unrecorded, then
                        press Enter to start capturing — e.g. to skip the login
  --value REF=value     credentials the saved session is keyed on (repeatable)
  --fresh               ignore any saved session and sign in again

IMPORT
  --url <baseUrl>       resolves goto('/') when the script relies on a baseURL
  --until <n>           keep only the first n steps (stop before a real purchase)

REPLAY and SAVE
  --value REF=value     supply a value the recording deliberately doesn't store,
                        e.g. --value SECRET.password=hunter2 (repeatable)
  --headed              watch it replay
  --allow-purchases     replay a flow marked destructive (refused by default)

SAVE
  --slug <name>         the flow's short name (default: made from the name)
  --intent <text>       what the flow is for, if different from its name
  --force               save even though the proving replay failed

FINDINGS
  --all                 include findings already triaged

RUN
  --sub-goal <text>     plan across several flows, in this order (repeatable)
  --flow <slug>         skip matching and run this flow (for an UNSURE match)
  --dry-run             say which flow would run, and run nothing
  plus --value, --headed, --allow-purchases as for replay

EMIT
  --framework <name>    playwright-ts (default) or cypress-js
  --out <file>          write to a file instead of printing

DISTILL
  --save <file>         store the agent's answer (validated first)

RECALL
  --limit <n>           how many flows and notes to show (default 5)
  --steps               list the known flow's steps

SETTINGS — from the environment, --env-file <path>, the file saved with
"understudy config", or ./.env (first wins)
  MONGODB_URI           local Community or your Atlas mongodb+srv:// string
  EMBED_URL, EMBED_MODEL, EMBED_KEY, EMBED_DIMS   optional embedding model
  UNDERSTUDY_<REF>      login values: a recording's SECRET.password reads
                        UNDERSTUDY_SECRET_PASSWORD (or pass --value)
`;

// --- arguments ---------------------------------------------------------------

/** Values accumulate per key, so repeatable flags (--value) keep every value. */
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

/** Last string value for a flag. */
const str = (v: Array<string | true> | undefined): string | undefined =>
  (v ?? []).filter((x): x is string => typeof x === 'string').at(-1);

/** Every string value for a repeatable flag. */
const all = (flags: Flags, key: string): string[] =>
  (flags.get(key) ?? []).filter((x): x is string => typeof x === 'string');

function fail(message: string, hint?: string): never {
  console.error(`error: ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

/** --value REF=value, repeatable → { REF: value }. */
function valuesFromFlags(flags: Flags): Record<string, string> {
  const values: Record<string, string> = {};
  for (const v of all(flags, 'value')) {
    const eq = v.indexOf('=');
    if (eq < 0) fail('--value must be REF=value');
    values[v.slice(0, eq)] = v.slice(eq + 1);
  }
  return values;
}

// --- apps --------------------------------------------------------------------

/**
 * An app's base URL, remembered in MongoDB after first use so the app name
 * alone is enough next time. Without MONGODB_URI it simply uses --url.
 */
async function resolveBaseUrl(slug: string, flag: string | undefined): Promise<string> {
  if (!process.env.MONGODB_URI) {
    return flag ?? fail(`no base URL for '${slug}'`, 'pass --url (or set MONGODB_URI so it is remembered)');
  }
  const { apps } = await store.collections();
  if (flag) {
    await apps.updateOne(
      { slug },
      { $set: { 'urls.default': flag }, $setOnInsert: { slug, name: slug, createdAt: new Date() } },
      { upsert: true },
    );
    return flag;
  }
  const known = (await apps.findOne({ slug }))?.urls.default;
  return known ?? fail(`no base URL for '${slug}'`, 'pass --url the first time you use an app');
}

// --- doctor / reembed --------------------------------------------------------

/**
 * Is everything connected? Connects to MongoDB, creates any missing
 * collections and indexes, checks the embedding model with one real request,
 * and reports whether vector search is ready. Same against local and Atlas.
 */
async function cmdDoctor() {
  console.log(`MongoDB    ${store.describeUri()}  (database: ${process.env.MONGODB_DB ?? 'understudy'})`);
  const db = await store.connect();
  console.log(`server     ${(await db.admin().serverInfo()).version}`);
  await store.ensureSchema();
  console.log('schema     collections and indexes present');

  const { embedderConfig, embed } = await import('../store/embed.js');
  const cfg = embedderConfig();
  if (!cfg) {
    console.log('embedder   none configured — search will match names only (set EMBED_KEY for Voyage)');
  } else {
    const [v] = await embed(['understudy doctor'], 'query', cfg);
    console.log(`embedder   ${cfg.model} at ${new URL(cfg.url).host} — ok, ${v!.length} numbers per vector`);
  }

  // Replay needs the headless browser; recording happens in your own Chrome.
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
    console.log('browser    headless Chromium ready (replay)');
  } catch {
    console.log('browser    headless Chromium MISSING — replay needs it: npx playwright install --only-shell chromium');
    process.exitCode = 1;
  }
  if (!existsSync(chromium.executablePath())) {
    console.log('           (full Chromium not installed — only needed for record --new-browser and --headed)');
  }

  const states = await store.waitForVectorIndexes(60_000).catch(() => store.vectorIndexStates());
  for (const s of states) {
    console.log(`vector     ${s.collection.padEnd(6)} ${s.queryable ? 'ready' : `NOT READY (${s.status})`}`);
  }
  if (!states.every((s) => s.queryable)) {
    console.log('\nvector search is not ready yet — a new index can take a minute; run doctor again.');
    process.exitCode = 1;
  }
}

async function cmdReembed() {
  const { reembed } = await import('../store/reembed.js');
  const r = await reembed();
  console.log(`re-embedded ${r.flows} flows and ${r.notes} notes with ${r.model}`);
}

// --- config ------------------------------------------------------------------

/**
 * understudy config                          where settings come from (no secrets shown)
 * understudy config --env-file <path>        read settings from this env file from now on
 * understudy config set KEY=value [...]      write settings into that env file
 * understudy config --clear                  forget the saved env file
 */
async function cmdConfig(positional: string[], flags: Flags) {
  const [sub, ...pairs] = positional;
  const cfg = readConfig();

  if (flags.has('clear')) {
    delete cfg.envFile;
    console.log(`saved ${await writeConfig(cfg)} — no env file remembered`);
    return;
  }
  const chosen = str(flags.get('env-file'));
  if (chosen) {
    cfg.envFile = resolvePath(expandHome(chosen));
    console.log(`saved ${await writeConfig(cfg)} — settings will be read from ${cfg.envFile}`);
    if (!existsSync(cfg.envFile)) console.log('  (that file does not exist yet — create it, or use `understudy config set KEY=value`)');
  }

  if (sub === 'set') {
    if (!pairs.length || pairs.some((p) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(p))) {
      fail('config set needs KEY=value pairs', 'understudy config set MONGODB_URI="mongodb+srv://…" EMBED_KEY=…');
    }
    const values = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
    const file = await writeEnvValues(values).catch((e: Error) => fail(e.message));
    console.log(`wrote ${pairs.map((p) => p.slice(0, p.indexOf('='))).join(', ')} to ${file}`);
    return;
  }
  if (sub) fail(`unknown: config ${sub}`, 'understudy config [set KEY=value …] [--env-file <path>] [--clear]');
  if (chosen) return;

  // Show where everything comes from — never the secrets themselves.
  const shown = (k: string) => (process.env[k] ? 'set' : 'not set');
  console.log(`config file   ${join(HOME, 'config.json')}${existsSync(join(HOME, 'config.json')) ? '' : ' (none yet)'}`);
  console.log(`env file      ${cfg.envFile ?? 'none saved — use --env-file <path> or `config set`'}`);
  console.log(`read now      ${loadedFrom.length ? loadedFrom.join(', ') : 'no env files (only the environment)'}`);
  console.log(`MONGODB_URI   ${process.env.MONGODB_URI ? store.describeUri() : 'not set'}`);
  const defaulted = !process.env.EMBED_URL && !process.env.EMBED_MODEL && process.env.EMBED_KEY;
  console.log(`EMBED_URL     ${process.env.EMBED_URL || (defaulted ? 'not set — Voyage, the default' : 'not set (goals match flow names, not meaning)')}`);
  console.log(`EMBED_MODEL   ${process.env.EMBED_MODEL || (defaulted ? 'not set — voyage-4-lite, the default' : 'not set')}`);
  console.log(`EMBED_KEY     ${shown('EMBED_KEY')}`);
  const logins = Object.keys(process.env).filter((k) => k.startsWith('UNDERSTUDY_') && !['UNDERSTUDY_HOME'].includes(k) && !k.endsWith('_DIR'));
  console.log(`login values  ${logins.length ? logins.join(', ') : 'none (a recording\'s SECRET.password reads UNDERSTUDY_SECRET_PASSWORD)'}`);
}

// --- record ------------------------------------------------------------------

/**
 * Wait for Enter in the terminal. Deliberately not anything on the page: an
 * in-page control would itself be recorded as the first step.
 */
function waitForEnter(prompt: string): Promise<void> {
  if (!process.stdin.isTTY) {
    fail('--arm-manually needs a terminal to read the Enter keypress from');
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
    process.stdin.once('end', finish);
  });
}

function printEvents(recording: RawRecording) {
  for (const e of recording.events) {
    const value = e.value !== undefined ? ` = "${e.value}"` : e.valueRef ? ` = <${e.valueRef}>` : '';
    console.log(`  ${String(e.seq).padStart(2)}  ${e.action.padEnd(7)} ${(e.role ?? '').padEnd(9)} ${e.name ?? ''}${value}`);
  }
}

async function cmdRecord(positional: string[], flags: Flags) {
  const slug = positional[0] ?? fail('record needs an app name', 'understudy record myapp');
  // The extension is the recorder. The fresh-browser one is opt-in, because it
  // needs Playwright's full Chromium (~350 MB), which isn't installed by default
  // — replay only needs the headless build.
  if (!flags.has('new-browser')) return cmdRecordExtension(slug, flags);
  if (!existsSync(chromium.executablePath())) {
    fail(
      "--new-browser needs Playwright's full Chromium (~350 MB), which isn't installed",
      'install it with: npx playwright install chromium   — or record in your own Chrome with the extension (the default)',
    );
  }
  const baseUrl = await resolveBaseUrl(slug, str(flags.get('url')));
  const values = valuesFromFlags(flags);
  const armManually = flags.has('arm-manually');

  console.log(`recording ${slug} at ${baseUrl}`);

  // A saved session only makes sense when capture starts late: if the login is
  // part of what we're recording, restoring one would skip the very steps the
  // recording exists to capture.
  const cached = armManually && !flags.has('fresh') ? await loadSession(slug, values) : undefined;
  if (cached) console.log(`session: restored (saved ${cached.savedAt})`);
  else if (armManually) console.log('session: none — sign in yourself before pressing Enter');
  console.log();

  const recording = await recordLive({
    appSlug: slug,
    startUrl: baseUrl,
    ...(cached ? { storageState: cached.storageState } : {}),
    ...(flags.has('max-minutes') ? { maxMinutes: Number(str(flags.get('max-minutes'))) } : {}),
    ...(armManually
      ? {
          armWhen: () =>
            waitForEnter(
              'drive to the point you want to start from — nothing is being recorded yet.\n' +
                'press Enter here to begin capturing.',
            ),
          // Saved at arm time: this is the state the recording claims to start
          // from, and the steps that follow may well log out of it.
          onArmed: async ({ context, sig }) => {
            console.log(`\narmed at ${sig}\n`);
            const path = await saveSession(context, slug, values, sig);
            if (path) console.log(`session saved  ${path}`);
            return { sessionSaved: Boolean(path) };
          },
        }
      : {}),
  });

  if (!recording.events.some((e) => e.action !== 'goto')) {
    console.error('\nnothing was recorded — no actions beyond the opening navigation. Not saved.');
    process.exitCode = 2;
    return;
  }

  const { path, existed } = await saveRecording(recording);
  console.log(`\ncaptured ${recording.events.length} events`);
  printEvents(recording);

  const approximate = recording.events.filter((e) => e.resolution === 'unresolved').length;
  if (approximate) console.log(`\n${approximate} step(s) have approximate role/name — replay will resolve them.`);
  if (recording.entry?.requiresSession) {
    console.log(`\nthis recording starts from a signed-in browser (${recording.entry.startState}).`);
    console.log('  replay restores the saved session for these --value credentials.');
  }
  console.log(`\nhash  ${recording.hash}${existed ? '  (identical recording already existed)' : ''}`);
  console.log(`saved ${path}`);
}

/**
 * Record in the Chrome you already have open: this waits for the Understudy
 * extension, which records the tab you start it on (see extension/README.md).
 */
async function cmdRecordExtension(slug: string, flags: Flags) {
  const port = Number(str(flags.get('port')) ?? DEFAULT_PORT);
  const rec = await startExtensionRecorder({ appSlug: slug, port }).catch((e: Error) =>
    fail(`couldn't listen on port ${port}: ${e.message}`, 'another recording may be waiting — or pass --port and set the same port in the extension'),
  );
  console.log(`waiting for the Understudy extension (${rec.url})`);
  console.log(`  in Chrome: go to where the flow starts, click the Understudy icon, then "Record from this page".`);
  console.log(`  (extension not loaded yet? understudy extension — it says where it is and how)`);
  console.log(`  stop from the extension when you're done (or press Ctrl+C here to stop and keep what was recorded).\n`);

  const onSigint = () => rec.stop();
  process.once('SIGINT', onSigint);
  const out = await rec.done;
  process.off('SIGINT', onSigint);

  if (!out.started || !out.recording.events.some((e) => e.action !== 'goto')) {
    console.error('nothing was recorded — no actions beyond opening the page. Not saved.');
    process.exitCode = 2;
    return;
  }
  const { path, existed } = await saveRecording(out.recording);
  console.log(`captured ${out.recording.events.length} events`);
  printEvents(out.recording);
  if (out.droppedUploads) {
    console.log(`\n${out.droppedUploads} file upload(s) NOT recorded — a page can't say which file was chosen.`);
    console.log('  write that part as a Playwright script and `understudy import` it instead.');
  }
  if (out.saveAs) {
    // Ticked "Save as a flow when I stop": prove and save it now, here.
    console.log(`\nsaving it as "${out.saveAs}" (you ticked "Save as a flow when I stop")\n`);
    await saveAndReport(out.recording, out.saveAs, { values: valuesFromFlags(flags) });
    return;
  }
  if (out.sessionPath) {
    console.log(out.recording.entry?.requiresSession
      ? '\nyou said you were signed in: replay starts from your sign-in (saved locally, 0600).'
      : '\nthe tab\'s sign-in was copied; `save` keeps it only if the flow turns out to need it.');
  }
  console.log(`\nhash  ${out.recording.hash}${existed ? '  (identical recording already existed)' : ''}`);
  console.log(`saved ${path}`);
  console.log(`\nnext: understudy save ${out.recording.hash} "<what this flow does>"`);
}

/**
 * understudy app <app>                          the app's settings
 * understudy app <app> --placeholder email      keep its email fields as placeholders
 * understudy app <app> --no-placeholders        stop doing that for new flows
 */
async function cmdApp(positional: string[], flags: Flags) {
  const app = positional[0] ?? fail('app needs an app name', 'understudy app myapp --placeholder email');
  const kinds = all(flags, 'placeholder');
  if (!kinds.length && !flags.has('no-placeholders')) {
    const current = await appPlaceholders(app);
    console.log(`${app}: placeholders ${current.length ? current.join(', ') : 'passwords only (the default)'}`);
    return;
  }
  const out = await setPlaceholders(app, flags.has('no-placeholders') ? [] : kinds).catch((e: Error) => fail(e.message));
  console.log(`${app}: placeholders ${out.placeholders.length ? out.placeholders.join(', ') + ' (and passwords)' : 'passwords only'}`);
  for (const c of out.converted) {
    console.log(`  ${c.placeholder.padEnd(14)} now used by ${c.flows.length} flow(s): ${c.flows.slice(0, 4).join(', ')}${c.flows.length > 4 ? ', …' : ''}`);
    console.log(`  ${''.padEnd(14)} value in ${c.valueIn}`);
  }
  if (out.envFile) console.log(`moved the address(es) into ${out.envFile} — memory no longer holds them`);
  else if (out.placeholders.includes('email') && !out.converted.length) console.log('no email fields with stored addresses in its flows — new ones will be converted when saved');
}

/** Where the Chrome extension is, and how to load it — it ships inside the package. */
function cmdExtension() {
  console.log(`Chrome, Edge, Brave and other Chromium browsers:\n  ${extensionDir()}\n`);
  console.log('  1. open the extensions page (chrome://extensions, edge://extensions, …) and turn on Developer mode');
  console.log('  2. click "Load unpacked" and choose the folder above');
  console.log('  3. pin it (puzzle-piece icon) so it is one click away');
  const firefox = firefoxExtensionDir();
  if (existsSync(join(firefox, 'manifest.json'))) {
    console.log(`\nFirefox:\n  ${firefox}\n`);
    console.log('  open about:debugging#/runtime/this-firefox → "Load Temporary Add-on…" → choose manifest.json in that folder');
    console.log('  (Firefox removes temporary add-ons when it restarts)');
  }
  console.log('\nSafari: use `understudy record <app> --new-browser` instead (needs: npx playwright install chromium)');
  console.log('\nthen record with: understudy record <app>');
}

// --- import ------------------------------------------------------------------

async function cmdImport(positional: string[], flags: Flags) {
  const slug = positional[0] ?? fail('import needs an app name', 'understudy import myapp tests/login.spec.ts');
  const file = positional[1] ?? fail('import needs a script path');

  // A script may rely on a baseURL from playwright.config, so goto('/') has no
  // origin. The app's remembered base URL fills that in.
  const fallback = str(flags.get('url')) ?? (await resolveBaseUrl(slug, undefined).catch(() => undefined));
  const { recording: parsed, warnings } = await parseScript(file, slug, fallback);

  // --until keeps the proven prefix — e.g. everything before a real purchase.
  const until = str(flags.get('until'));
  const recording = until
    ? buildRecording(
        { source: parsed.source, origin: parsed.origin, appSlug: parsed.appSlug, startUrl: parsed.startUrl },
        parsed.events.slice(0, Number(until)),
      )
    : parsed;
  if (until) console.log(`kept ${recording.events.length} of ${parsed.events.length} steps (--until ${until})\n`);

  if (!recording.events.length) {
    console.error(`no Playwright actions found in ${file} — expected calls like page.getByRole(...).click()`);
    process.exitCode = 2;
    return;
  }

  console.log(`parsed ${recording.events.length} events from ${file}\n`);
  printEvents(recording);

  // A clean import with warnings is NOT a clean import: each one is a step
  // that was dropped, and replay will fail somewhere after it.
  if (warnings.length) {
    console.log(`\n${warnings.length} call(s) could not be mapped:`);
    for (const w of warnings.slice(0, 10)) console.log(`  ${w}`);
  }

  const { path, existed } = await saveRecording(recording);
  console.log(`\nhash  ${recording.hash}${existed ? '  (identical recording already existed)' : ''}`);
  console.log(`saved ${path}`);
}

// --- replay ------------------------------------------------------------------

/**
 * Run a recording with everything around it (saved session, lessons, stale
 * sessions) via flows/execute.ts, and say what's worth knowing as it goes.
 */
async function executeWithReport(recording: RawRecording, flags: Flags, opts: { useLessons: boolean }): Promise<ReplayResult> {
  const values = valuesFromFlags(flags);
  const x = await withLoginValues(values, (v) => execute(recording, { values: v, headed: flags.has('headed'), useLessons: opts.useLessons }))
    .catch((e: Error) => fail(e.message));
  if (x.sessionRestoredFrom) console.log(`session: restored (saved ${x.sessionRestoredFrom})`);
  if (x.staleSession) {
    console.log('the restored session did not land where it was recorded, and has been discarded.');
    console.log(`  expected ${x.staleSession.expected}, saw ${x.staleSession.observed}`);
    console.log('  re-record with --arm-manually to refresh it.\n');
  }
  if (x.lessons?.fired) console.log(`lessons  ${x.lessons.fired} fired, ${x.lessons.helped} on steps that have failed before\n`);
  return x.result;
}

/** `replay <hash>` runs a recording file; `replay <app> <flow>` runs a saved flow and records the run. */
async function cmdReplay(positional: string[], flags: Flags) {
  if (positional.length >= 2) return cmdReplayFlow(positional[0]!, positional[1]!, flags);

  const hash = positional[0] ?? fail('replay needs a recording hash, or an app and a flow', 'understudy recordings · understudy flows <app>');
  const recording = await loadRecording(hash).catch(() => fail(`no recording '${hash}'`, 'understudy recordings'));
  const result = await executeWithReport(recording, flags, { useLessons: false });
  printReplay(result);
  if (!result.ok) process.exitCode = 3;
}

async function cmdReplayFlow(app: string, slug: string, flags: Flags) {
  await runSavedFlow(app, slug, flags, { mode: 'replay' });
}

/**
 * Run one saved flow: the safety gate, the replay, and recording the run.
 * Shared by `replay <app> <flow>` and `run <app> "<goal>"`.
 */
async function runSavedFlow(app: string, slug: string, flags: Flags, how: { mode: 'replay' | 'run'; goal?: string }) {
  const { flows } = await store.collections();
  const flow = await flows.findOne({ app, slug });
  if (!flow) fail(`no flow '${slug}' for app '${app}'`, `understudy flows ${app}`);

  // The safety gate: a destructive flow does something real every time it runs.
  if (!flags.has('allow-purchases')) {
    if (flow.destructive) {
      fail(`'${slug}' is marked destructive (${flow.destructiveBecause}) — running it may place a real order`, 'pass --allow-purchases if that is genuinely fine');
    }
    const controls = await destructiveControls(app);
    const hit = flow.steps.find((s) => s.name && ['click', 'press', 'dispatch_click'].includes(s.action) && controls.has(s.name.toLowerCase()));
    if (hit) fail(`'${slug}' clicks "${hit.name}", which a fact says commits something real: ${controls.get(hit.name!.toLowerCase())}`, 'pass --allow-purchases if that is genuinely fine');
  }

  console.log(`running ${app}/${slug} — ${flow.title}\n`);
  if (flow.proven === false) console.log(`note: '${slug}' is UNPROVEN (${flow.unprovenBecause}) — this run will tell.\n`);
  const result = await executeWithReport(recordingFrom(flow), flags, { useLessons: true });
  printReplay(result);
  const run = await recordRun({
    app, flow: slug, result, steps: flow.steps, mode: how.mode, ...(how.goal ? { goal: how.goal } : {}), ...(flow.proven === false ? { unproven: true } : {}),
  });
  if (await proveByRun(app, slug, result)) console.log(`\nproven   '${slug}' passed, so it's no longer marked unproven`);
  printRunReport(run);
  if (!result.ok) process.exitCode = 3;
}

// --- recall / run ------------------------------------------------------------

function printRecall(r: Recall, showSteps = false) {
  const verdict = { known: 'KNOWN', unsure: 'UNSURE', unknown: "DON'T KNOW" }[r.verdict];
  console.log(`${verdict} — ${r.why}  (matched by ${r.method})\n`);
  if (r.flows.length) {
    console.log('flows');
    for (const f of r.flows) {
      const marks = [f.proven === false && 'UNPROVEN', f.destructive && 'DESTRUCTIVE', f.requiresSession && 'needs session', f.kind === 'segment' && 'segment'].filter(Boolean).join(', ');
      console.log(`  ${f.score.toFixed(3)}  ${f.slug.padEnd(32)} ${f.title}${marks ? `  [${marks}]` : ''}`);
    }
  }
  if (r.notes.length) {
    console.log('\nnotes');
    for (const n of r.notes) console.log(`  ${n.score.toFixed(3)}  ${n.kind.padEnd(6)} ${n.text.slice(0, 100)}`);
  }
  if (r.best && r.steps) {
    console.log(`\n${r.best.slug}: ${r.steps.length} steps${showSteps ? '' : '  (--steps to list them)'}`);
    if (showSteps) {
      for (const s of r.steps) {
        const target = s.role && s.name ? `${s.role} "${s.name}"` : s.testId ? `[test id ${s.testId}]` : s.css ? `[${s.css}]` : '';
        const what = s.placeholder ? `= <${s.placeholder}>` : s.value !== undefined ? `= "${s.value}"` : '';
        console.log(`  ${String(s.n).padStart(3)}  ${s.action.padEnd(7)} ${target}${s.nth !== undefined ? ` (#${s.nth})` : ''} ${what}`.trimEnd());
      }
    }
  }
  for (const need of r.needs ?? []) {
    console.log(`needs    ${need.placeholder} — from ${need.readFrom.join(' or ')}: ${need.set ? 'set' : 'NOT SET'}`);
  }
}

/** What memory knows about a goal. A database query: no browser, nothing runs. */
async function cmdRecall(positional: string[], flags: Flags) {
  const [app, ...goalWords] = positional;
  if (!app || !goalWords.length) fail('recall needs an app and a goal', 'understudy recall myapp "log in"');
  printRecall(await recall(app, goalWords.join(' '), { withSteps: true, limit: Number(str(flags.get('limit')) ?? 5) }), flags.has('steps'));
}

/**
 * Run a goal: find the flow that does it, check it's safe, run it. Only a
 * KNOWN match runs on its own — an unsure one is shown so you can pick, and an
 * unknown one is a cue to record it, never a guess.
 */
async function cmdRun(positional: string[], flags: Flags) {
  const [app, ...goalWords] = positional;
  if (!app || !goalWords.length) fail('run needs an app and a goal', 'understudy run myapp "log in"');
  const goal = goalWords.join(' ');

  const picked = str(flags.get('flow'));
  if (picked) return runSavedFlow(app, picked, flags, { mode: 'run', goal });

  // Several sub-goals: plan across flows, bridging the seams between them.
  const subGoals = all(flags, 'sub-goal');
  if (subGoals.length) {
    const state = await start({
      app, goal, subGoals,
      ...(flags.has('dry-run') ? { dryRun: true } : {}),
      ...(flags.has('allow-purchases') ? { allowPurchases: true } : {}),
    });
    return reportPlan(state, flags);
  }

  const r = await recall(app, goal);
  printRecall(r);

  if (r.verdict !== 'known' || !r.best) {
    console.log(
      r.verdict === 'unsure'
        ? `\nnot running — no flow is clearly this goal, and it may not be in memory at all.\n` +
            `  if one of the flows above IS it:  understudy run ${app} "${goal}" --flow <slug>\n` +
            `  if none is:                       understudy record ${app}`
        : `\nnot running — nothing in memory does this. Record it: understudy record ${app}`,
    );
    process.exitCode = 4;
    return;
  }
  if (flags.has('dry-run')) {
    console.log(`\ndry run — would run ${r.best.slug}${r.best.destructive ? ' (DESTRUCTIVE: needs --allow-purchases)' : ''}`);
    return;
  }
  console.log();
  await runSavedFlow(app, r.best.slug, flags, { mode: 'run', goal });
}

/** Show where planning got to, and run it if it's complete. */
async function reportPlan(state: PlanState, flags: Flags) {
  if (state.status === 'waiting') {
    console.log(`run ${state.runId} is waiting for an answer:\n`);
    console.log(JSON.stringify(state.question, null, 1));
    console.log(`\nanswer it:  understudy answer ${state.runId} '<json>'`);
    process.exitCode = 5;
    return;
  }
  if (state.status === 'blocked') {
    console.log(`BLOCKED — ${state.why}`);
    if (state.detail) console.log(JSON.stringify(state.detail, null, 1));
    process.exitCode = 4;
    return;
  }
  console.log(`plan     ${state.plan.join('  →  ')}`);
  for (const s of state.seams) console.log(`seam     before ${s.before}: ${s.how}`);
  if (state.dryRun) {
    console.log('\ndry run — nothing ran');
    return;
  }
  console.log();
  const values = valuesFromFlags(flags);
  const { executed, recorded, nowProven } = await withLoginValues(values, (v) => runPlan(state.runId, { values: v, headed: flags.has('headed') }))
    .catch((e: Error) => fail(e.message));
  if (executed.lessons?.fired) console.log(`lessons  ${executed.lessons.fired} fired, ${executed.lessons.helped} on steps that have failed before\n`);
  printReplay(executed.result);
  printRunReport(recorded);
  for (const slug of nowProven) console.log(`proven   '${slug}' passed, so it's no longer marked unproven`);
  if (!executed.result.ok) process.exitCode = 3;
}

/** Answer a planning question: understudy answer <runId> '{"steps":[…]}' */
async function cmdAnswer(positional: string[], flags: Flags) {
  const [runId, json] = positional;
  if (!runId || !json) fail('answer needs a run id and a JSON answer', `understudy answer <runId> '{"subGoals":["…"]}'`);
  let reply: unknown;
  try { reply = JSON.parse(json); } catch { fail('the answer must be JSON'); }
  await reportPlan(await answer(runId, reply).catch((e: Error) => fail(e.message)), flags);
}

/**
 * distill <app> <flow>                   print the request for an agent to answer
 * distill <app> <flow> --save <file>     store the agent's answer from a JSON file
 */
async function cmdDistill(positional: string[], flags: Flags) {
  const [app, flow] = positional;
  if (!app || !flow) fail('distill needs an app and a saved flow', 'understudy distill myapp checkout');
  const file = str(flags.get('save'));
  if (!file) {
    console.log(JSON.stringify(await distillRequest(app, flow).catch((e: Error) => fail(e.message)), null, 1));
    return;
  }
  const saved = await saveDistilled(app, flow, JSON.parse(await readFile(file, 'utf8'))).catch((e: Error) => fail(e.message));
  console.log(`distilled ${app}/${saved.flow}`);
  for (const s of saved.segments) console.log(`  segment ${s.slug.padEnd(32)} ${s.steps} steps${s.replaced ? '  (replaced the existing one)' : ''}`);
  if (saved.lessons.written || saved.lessons.alreadyKnown) console.log(`  lessons ${saved.lessons.written} new, ${saved.lessons.alreadyKnown} already known`);
}

/** remember <app> <file.json> — a batch of { facts, lessons, findings, reached }. */
async function cmdRemember(positional: string[]) {
  const [app, file] = positional;
  if (!app || !file) fail('remember needs an app and a JSON file', 'understudy remember myapp learned.json');
  const r = await remember(app, JSON.parse(await readFile(file, 'utf8'))).catch((e: Error) => fail(e.message));
  console.log(`facts    ${r.facts.written} new, ${r.facts.alreadyKnown} already known`);
  console.log(`lessons  ${r.lessons.written} new, ${r.lessons.alreadyKnown} already known`);
  console.log(`findings ${r.findings}`);
  console.log(`reached  ${r.reached}`);
}

function printReplay(result: ReplayResult) {
  console.log(`replay ${result.ok ? 'PASSED' : 'FAILED'} in ${(result.durationMs / 1000).toFixed(1)}s\n`);
  for (const s of result.steps) {
    const notes = [
      s.ambiguousByName && `ambiguous: ${s.ambiguousByName.matched} by name, resolved via ${s.ambiguousByName.disambiguatedBy}`,
      s.roleHadNoMatch && `role matched nothing, fell back to ${s.roleHadNoMatch.fellBackTo}`,
      s.roundTripMismatch && `value did not survive: wrote "${s.roundTripMismatch.expected}", read "${s.roundTripMismatch.actual}"`,
      s.error,
    ].filter(Boolean).join('; ');
    console.log(`  ${String(s.seq).padStart(2)}  ${s.ok ? 'ok  ' : 'FAIL'}  ${s.action.padEnd(7)} ${(s.sig ?? '').padEnd(28)} ${notes}`);
  }
  console.log(`\npath: ${result.sigSequence.join('  ->  ')}`);

  if (result.signals.length) {
    console.log(`\n${result.signals.length} signal(s) captured:`);
    for (const g of result.signals.slice(0, 12)) {
      console.log(`  [step ${g.duringStep}] ${g.kind}${g.status ? ' ' + g.status : ''}  ${g.text.slice(0, 90)}`);
    }
  }
}

/** What recording the run added: drift against earlier runs, and findings. */
function printRunReport(run: RecordedRun) {
  const { drift } = run;
  if (drift.firstRun) console.log('\ndrift    first passed run — this path is now the baseline');
  else if (!drift.changed) console.log('\ndrift    same path as recent runs');
  else {
    console.log('\ndrift    PATH CHANGED');
    for (const s of drift.added) console.log(`  new      ${s}`);
    for (const s of drift.removed) console.log(`  gone     ${s}`);
    for (const s of drift.stateChanged) console.log(`  state    ${s}`);
  }
  console.log(`findings ${run.findings.length ? `${run.findings.length} raised or seen again (understudy findings <app>)` : 'none'}`);
  console.log(`run      ${run.runId.toHexString()}`);
}

// --- save / flows / findings -------------------------------------------------

/** What proving found out about signing in, for a recording made from a tab. */
function signInNote(recording: RawRecording, signIn: 'not needed' | 'needed' | 'no session to try'): string | undefined {
  if (!recording.entry?.session) return undefined;
  if (recording.entry.requiresSession) return 'used, as you said you were signed in when recording';
  if (signIn === 'needed') return 'needed — it failed in an empty browser and passed signed in, so it keeps your session';
  return 'not needed — the session copied when you started recording was deleted';
}

/**
 * Prove a recording by replaying it, then save it as a flow. A recording that
 * doesn't replay cleanly is refused — memory only holds flows known to work.
 */
async function cmdSave(positional: string[], flags: Flags) {
  const [hash, ...titleWords] = positional;
  if (!hash || !titleWords.length) {
    fail('save needs a recording hash and a name', 'understudy save <hash> "log in as a member"');
  }
  const recording = await loadRecording(hash).catch(() => fail(`no recording '${hash}'`, 'understudy recordings'));
  const slug = str(flags.get('slug'));
  const intent = str(flags.get('intent'));
  await saveAndReport(recording, titleWords.join(' '), {
    values: valuesFromFlags(flags), headed: flags.has('headed'),
    verify: !flags.has('no-verify'), force: flags.has('force'),
    ...(slug ? { slug } : {}), ...(intent ? { intent } : {}),
  });
}

/** Ask a yes/no question in the terminal. No terminal (piped, scripted): the answer is no. */
async function askYesNo(question: string, byDefault = false): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const answer = (await ask(`${question} ${byDefault ? '[Y/n]' : '[y/N]'} `)).trim();
  return answer ? /^y(es)?$/i.test(answer) : byDefault;
}

/** Ask for a line in the terminal. */
async function ask(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Ask for a line without showing it (a password): each key shows as *. */
function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve) => {
    let typed = '';
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(typed);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') { // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (typed) { typed = typed.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (ch < ' ') continue;
        typed += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Run something that needs login values; if some are missing (nothing ran
 * yet), ask for them in the terminal and run it again. Each one can be typed
 * — hidden if it's a secret — or put in the env file, then Enter. Typed
 * values can be saved to the env file so they aren't asked for again.
 * No terminal: the error says where to put them, and nothing is asked.
 */
async function withLoginValues<T>(values: Record<string, string>, attempt: (values: Record<string, string>) => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await attempt(values);
    } catch (e) {
      if (!(e instanceof MissingValuesError) || !process.stdin.isTTY) throw e;
      values = { ...values, ...(await askForValues(e)) };
    }
  }
}

async function askForValues(e: MissingValuesError): Promise<Record<string, string>> {
  console.log(`\n${e.missing.length === 1 ? 'a login value is' : 'login values are'} needed to replay this, and not set — nothing has run yet.`);
  console.log(`type it, or add it to ${e.envFile} and press Enter.  (Ctrl+C to stop)\n`);
  const typed: Record<string, string> = {};
  const toSave: Record<string, string> = {};
  for (const m of e.missing) {
    const secret = /^SECRET\./i.test(m.placeholder) || /pass|secret|token|key/i.test(m.placeholder);
    const question = `  ${m.placeholder}${secret ? ' (hidden)' : ''}: `;
    const value = secret ? await askHidden(question) : (await ask(question)).trim();
    if (!value) continue; // they put it in the env file — the retry re-reads it
    typed[m.placeholder] = value;
    toSave[m.setOneOf[0]!] = value;
  }
  if (Object.keys(toSave).length) {
    const keys = Object.keys(toSave).join(', ');
    if (await askYesNo(`\n  save ${keys} to ${e.envFile} so you're not asked again?`, true)) {
      const file = await writeEnvValues(toSave).catch((err: Error) => {
        console.log(`  couldn't save it: ${err.message} — using it for this run only`);
      });
      if (file) console.log(`  saved to ${file} (readable only by you)`);
    }
  }
  console.log();
  return typed;
}

/**
 * Prove a recording and keep it as a flow, saying what happened. Used by
 * `save`, and by `record` when the extension's "Save as a flow when I stop" is ticked.
 */
async function saveAndReport(recording: RawRecording, title: string, opts: Omit<ProveAndSave, 'title' | 'keepIfFailed'>) {
  if (opts.verify === false) console.log('saving without a replay — it will be marked unproven until a run passes\n');
  else console.log(`proving ${recording.hash} by replaying it…\n`);
  // No lessons: what gets saved is what the recording does on its own. Proving
  // also works out whether it needs to start signed in (flows/execute.ts: prove).
  let printed = false;
  const out = await withLoginValues(opts.values ?? {}, (values) => proveAndSave(recording, {
    title, ...opts, values,
    keepIfFailed: async (proven) => {
      printReplay(proven.result);
      printed = true;
      console.log('\nthe replay failed, so this would not normally be kept.');
      return askYesNo('keep it anyway, marked unproven (the first run that passes proves it)?');
    },
  })).catch((e: Error) => fail(e.message));

  if (out.proven && !printed) printReplay(out.proven.result);
  const note = out.proven ? signInNote(recording, out.proven.signIn) : undefined;
  if (note) console.log(`\nsign-in  ${note}`);
  if (!out.saved) {
    console.error('\nnot saved — the recording did not replay cleanly' + (recording.entry?.session ? ', signed in or not' : '') + '.');
    console.error('  fix it or re-record; or keep it anyway with --force (or --no-verify to skip the replay), marked unproven.');
    process.exitCode = 3;
    return;
  }
  const { flow } = out;
  for (const c of out.placeholders.converted) console.log(`\nemail    uses ${c.placeholder} (value in ${c.valueIn}) — this app keeps emails out of memory`);
  console.log(`\nsaved    ${flow.app}/${flow.slug}  (${flow.steps.length} steps${flow.embedding ? ', searchable by meaning' : ''})`);
  if (flow.proven === false) console.log(`         UNPROVEN — ${flow.unprovenBecause}. The first run that passes proves it.`);
  if (flow.destructive) console.log(`         DESTRUCTIVE — ${flow.destructiveBecause}. Replays need --allow-purchases.`);
  if (out.run) printRunReport(out.run);
  console.log(`\nreplay it any time:  understudy replay ${flow.app} ${flow.slug}`);
}

async function cmdFlows(positional: string[]) {
  const app = positional[0] ?? fail('flows needs an app name', 'understudy flows myapp');
  const { flows, runs } = await store.collections();
  const rows = await flows.find({ app }, { projection: { embedding: 0, steps: 0 } }).sort({ slug: 1 }).toArray();
  if (!rows.length) {
    console.log(`no flows for '${app}' yet — record one, then \`understudy save <hash> "<name>"\``);
    return;
  }
  for (const f of rows) {
    const last = await runs.find({ app, plan: [f.slug] }).sort({ startedAt: -1 }).limit(1).next();
    const status = last ? `${last.status} ${last.startedAt.toISOString().slice(0, 16).replace('T', ' ')}` : 'never run';
    const marks = [f.proven === false && 'UNPROVEN', f.destructive && 'DESTRUCTIVE', f.requiresSession && 'needs session', f.kind === 'segment' && 'segment', f.madeBy === 'agent' && 'made by an agent']
      .filter(Boolean).join(', ');
    console.log(`  ${f.slug.padEnd(32)} ${status.padEnd(24)} ${f.title}${marks ? `  [${marks}]` : ''}`);
  }
}

async function cmdFindings(positional: string[], flags: Flags) {
  const app = positional[0] ?? fail('findings needs an app name', 'understudy findings myapp');
  const { findings } = await store.collections();
  const filter = flags.has('all') ? { app } : { app, status: 'open' as const };
  const rows = await findings.find(filter).sort({ occurrences: -1, lastSeen: -1 }).limit(50).toArray();
  if (!rows.length) {
    console.log(flags.has('all') ? `no findings for '${app}'` : `no open findings for '${app}' (--all to include triaged ones)`);
    return;
  }
  for (const f of rows) {
    console.log(`  ${f.severity.padEnd(6)} ×${String(f.occurrences).padEnd(4)} ${f.kind.padEnd(14)} ${f.statement.slice(0, 110)}${f.evidence?.fromUnprovenFlow ? '  [from an unproven flow — may be the recording]' : ''}`);
  }
}

/** emit <app> <flow> — print a saved flow as a Playwright or Cypress test. */
async function cmdEmit(positional: string[], flags: Flags) {
  const [app, slug] = positional;
  if (!app || !slug) fail('emit needs an app and a flow', 'understudy emit myapp log-in --framework cypress-js');
  const framework = (str(flags.get('framework')) ?? 'playwright-ts') as Framework;
  if (framework !== 'playwright-ts' && framework !== 'cypress-js') fail('--framework must be playwright-ts or cypress-js');
  const { flows } = await store.collections();
  const flow = await flows.findOne({ app, slug });
  if (!flow) fail(`no flow '${slug}' for app '${app}'`, `understudy flows ${app}`);
  const out = emitFlow(flow, framework);
  const file = str(flags.get('out'));
  if (file) {
    await writeFile(file, out.code);
    console.log(`wrote ${file}`);
  } else console.log(out.code);
  for (const w of out.warnings) console.error(`warning: ${w}`);
  if (out.requiredValues.length) console.error(`reads from the environment: ${out.requiredValues.map(valueEnvName).join(', ')}`);
}

// --- recordings --------------------------------------------------------------

async function cmdRecordings(positional: string[]) {
  const rows = await listRecordings(positional[0]);
  if (!rows.length) console.log('no recordings yet — try `understudy record <app>`');
  for (const r of rows) {
    console.log(`  ${r.hash}  ${r.appSlug.padEnd(14)} ${String(r.events).padStart(3)} events  ${r.source.padEnd(6)}  ${r.createdAt}`);
  }
}

// --- main --------------------------------------------------------------------

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  if (!command || flags.has('help') || flags.has('h')) {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case 'doctor': return cmdDoctor();
    case 'config': return cmdConfig(rest, flags);
    case 'extension': return cmdExtension();
    case 'app': return cmdApp(rest, flags);
    case 'reembed': return cmdReembed();
    case 'record': return cmdRecord(rest, flags);
    case 'import': return cmdImport(rest, flags);
    case 'recordings': return cmdRecordings(rest);
    case 'replay': return cmdReplay(rest, flags);
    case 'save': return cmdSave(rest, flags);
    case 'flows': return cmdFlows(rest);
    case 'findings': return cmdFindings(rest, flags);
    case 'recall': return cmdRecall(rest, flags);
    case 'run': return cmdRun(rest, flags);
    case 'answer': return cmdAnswer(rest, flags);
    case 'distill': return cmdDistill(rest, flags);
    case 'remember': return cmdRemember(rest);
    case 'emit': return cmdEmit(rest, flags);
    default: fail(`unknown command '${command}'`, 'understudy --help');
  }
}

main()
  .catch((err) => {
    console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => store.close());
