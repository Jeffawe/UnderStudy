/**
 * Live recorder — a human drives a headed browser, we capture intent.
 *
 * This replaces `playwright codegen` rather than wrapping it. Codegen's only
 * output is source code in one of five languages; it never exposes the
 * structured actions it derives internally. We want the data, so we listen for
 * it ourselves.
 *
 * DIVISION OF LABOUR:
 *   the injected script  what happened, on which element, AND what that element
 *                        is — role and accessible name, computed in-page and
 *                        synchronously by a spec-compliant accname bundle
 *   Playwright           fallback only, when that bundle failed to load
 *
 * Resolving from Node is a LAST RESORT because it loses a race it cannot win:
 * clicking usually destroys the element clicked ("Add to cart" becomes
 * "Remove"; a submit re-renders the page), and an async exposeBinding call
 * cannot block the page's default action. codegen gets correct names precisely
 * by computing them in-page at event time; this does the same.
 */

import { type BrowserContext, type CDPSession, type Page } from 'playwright';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { openLease, type BrowserLease } from '../../core/browser.js';
import { computeSig, parseAria } from '../../core/sig.js';
import type { StorageState } from '../../core/auth-cache.js';
import {
  buildRecording,
  redactValue,
  type RawEvent,
  type RawRecording,
  type RecordedAction,
  type RecordingEntry,
  type Resolution,
} from '../../core/recording.js';
import { INJECTED_LISTENER, STAMP_ATTR } from './injected.js';
import { ACCNAME_BUNDLE } from './accname-bundle.js';

/** What the in-page script sends us. */
interface WireEvent {
  seq: number;
  action: RecordedAction;
  stamp: number;
  url: string;
  hintRole: string;
  hintName: string;
  /** Which path produced hintRole/hintName in the page. */
  resolvedBy?: 'accname' | 'heuristic';
  css?: string;
  testId?: string;
  testIdAttr?: string;
  inputType?: string;
  frameHint?: string;
  value?: string;
  label?: string;
  /** Files on a file input. The page can count them; it cannot name them. */
  fileCount?: number;
}

export interface LiveRecordOptions {
  appSlug: string;
  startUrl: string;
  /** Resolved automatically when omitted; recording is inherently interactive. */
  headless?: boolean;
  /** Stop after this long even if the window is still open. */
  maxMinutes?: number;
  /**
   * Start the browser from a saved session instead of a cold one.
   *
   * Opaque here on purpose: the recorder does not read the session cache, it is
   * handed a payload. Same reasoning as `lessonsFor` and `visualCheck` on
   * ReplayOptions — capture stays ignorant of where things are stored.
   */
  storageState?: StorageState;
  /**
   * Hold capture until this resolves, so the operator can reach the starting
   * point without recording how they got there.
   *
   * THE LISTENER IS GATED, NOT INJECTED LATE. `addInitScript` only runs on new
   * documents, so a listener installed after the page has loaded never runs at
   * all. Instead it is installed as usual and its events are discarded until
   * this resolves — which also means there is no "did arming work?" failure
   * mode, because nothing about the page setup changes.
   */
  armWhen?: (page: Page) => Promise<void>;
  /**
   * Drive the page programmatically instead of waiting for a human.
   *
   * Not a test hook — this is how an EXISTING Playwright script becomes a
   * recording. A script's `.click()` dispatches the same DOM events a human
   * click does, so the identical listener captures both. Provide this and the
   * recorder stops when the callback returns rather than when a window closes.
   */
  drive?: (page: Page) => Promise<void>;
  /**
   * Called once, at the moment capture arms, with the browser that got there.
   *
   * This is the only point at which the session is worth saving: the operator
   * has finished logging in, and nothing recorded has run yet — so it is
   * exactly the state the recording claims to start from. Saving at the END
   * would bank whatever the recorded steps did to the session, up to and
   * including logging out of it.
   */
  onArmed?: (info: {
    context: BrowserContext;
    page: Page;
    sig: string;
  }) => Promise<{ sessionSaved?: boolean } | void>;
  /**
   * Record in a browser someone else owns, instead of launching one.
   *
   * The lease is never closed here — the owner closes it.
   */
  lease?: BrowserLease;
  /**
   * Walk a prelude AFTER the capture machinery is installed and BEFORE arming.
   *
   * THIS IS WHY IT LIVES HERE AND NOT IN THE CALLER. `addInitScript` only runs
   * on new documents, so a listener installed after the prelude has navigated
   * never runs on the page the operator is looking at — silently. Ordering the
   * install before the prelude is the whole correctness argument, and a caller
   * that had to remember it would eventually forget.
   *
   * The gate does the rest: capture is disarmed throughout, exactly as it is
   * while a human drives to a starting point by hand. A prelude is just that
   * journey, driven programmatically.
   */
  beforeArm?: (lease: BrowserLease) => Promise<void>;
  /**
   * The flow slugs `beforeArm` walked, recorded on the recording as its entry
   * condition. Kept separate from the callback so what gets WRITTEN DOWN is a
   * plain list, not something inferred from a function that already ran.
   */
  preludeSlugs?: string[];
  origin?: string;
  source?: RawRecording['source'];
}

/**
 * Ask Playwright what the stamped element actually is.
 *
 * Returns undefined when the element is gone — a click that navigates can tear
 * it down before we get here. That is not a failure: the event still records,
 * flagged `unresolved`, carrying the in-page hints, and the replay stage can
 * upgrade it by looking at the live element. Recording a step with a weaker
 * name beats dropping the step.
 */
async function resolveStamped(
  page: Page,
  stamp: number,
): Promise<{ role: string; name: string | null } | undefined> {
  try {
    const locator = page.locator(`[${STAMP_ATTR}="${stamp}"]`).first();
    if ((await locator.count()) === 0) return undefined;
    const snapshot = await locator.ariaSnapshot({ timeout: 1000 });
    return parseAria(snapshot)[0];
  } catch {
    return undefined;
  }
}

// Read per call, not once at import. A module-level constant would freeze the
// override before any caller could set it, which is a footgun for anything that
// wants its own directory — a check, or a run recording into a scratch corpus.
const fixturesDir = () => process.env.UNDERSTUDY_FIXTURES_DIR ?? resolve('.understudy/fixtures');

/**
 * One CDP session per page, reused.
 *
 * `DOM.getFileInfo` lives in the DOM domain and answers nothing until it is
 * enabled, and opening a session per uploaded file would be wasteful on a form
 * that takes several.
 */
const cdpSessions = new WeakMap<Page, Promise<CDPSession>>();

async function cdpFor(page: Page): Promise<CDPSession> {
  let session = cdpSessions.get(page);
  if (!session) {
    session = page
      .context()
      .newCDPSession(page)
      .then(async (opened) => {
        await opened.send('DOM.enable').catch(() => {});
        return opened;
      });
    cdpSessions.set(page, session);
  }
  return session;
}

/**
 * The real paths behind a file input.
 *
 * THIS IS THE ONE THING THE PAGE CANNOT TELL US. The DOM masks a file input's
 * value to `C:\fakepath\<name>` and `File` exposes only `.name`, both
 * deliberately, so that a page cannot learn where a person keeps their files.
 * The recorder is not a page, though — it owns the browser, and Chrome will
 * answer the question over the DevTools protocol.
 *
 * Chromium-only, which costs nothing here: every browser Understudy opens is
 * Chromium. Returns [] rather than throwing, because an upload we cannot
 * resolve should drop one step, not kill a recording someone is halfway
 * through.
 */
async function uploadedPaths(page: Page, stamp: number): Promise<string[]> {
  try {
    const cdp = await cdpFor(page);
    const handle = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('[${STAMP_ATTR}="${stamp}"]').files`,
    });
    const objectId = handle?.result?.objectId;
    if (!objectId) return [];

    const props = await cdp.send('Runtime.getProperties', { objectId, ownProperties: true });
    const paths: string[] = [];
    for (const prop of props?.result ?? []) {
      // A FileList's own properties are its numeric indices plus 'length'.
      if (!/^\d+$/.test(prop.name)) continue;
      const fileId = prop.value?.objectId;
      if (!fileId) continue;
      const info = (await cdp.send('DOM.getFileInfo', { objectId: fileId })) as { path?: string };
      if (info?.path) paths.push(info.path);
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * Copy an uploaded file into the corpus and return the path to store.
 *
 * A recording that points at `/Users/someone/Desktop/photo.png` replays
 * exactly once, on one machine — which contradicts the rule that a recording
 * must replay. Copying the file in makes the recording self-contained. Naming
 * it by content hash means the same photo recorded ten times is stored once,
 * and two different files that share a basename cannot collide.
 */
async function stashFixture(absolute: string): Promise<string> {
  const bytes = await readFile(absolute);
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const dir = fixturesDir();
  const target = join(dir, `${digest}-${basename(absolute)}`);
  await mkdir(dir, { recursive: true });
  if (!existsSync(target)) await writeFile(target, bytes);
  // Relative, so the value means the same thing from the repo root whoever
  // replays it.
  return relative(process.cwd(), target);
}

export async function recordLive(opts: LiveRecordOptions): Promise<RawRecording> {
  const {
    appSlug,
    startUrl,
    maxMinutes = 30,
    drive,
    storageState,
    armWhen,
    beforeArm,
    preludeSlugs,
    onArmed,
    // A driven capture needs no window; a human one is the whole point of a window.
    headless = Boolean(drive),
    source = drive ? 'script' : 'live',
    origin = drive ? 'driven' : 'headed-browser',
  } = opts;

  const ownsLease = !opts.lease;
  const lease =
    opts.lease ?? (await openLease({ headless, ...(storageState ? { storageState } : {}) }));
  const { browser, context } = lease;

  const events: RawEvent[] = [];
  const startedAt = Date.now();
  let closed = false;

  // The capture gate. Armed immediately unless the caller wants to reach a
  // starting point first — see `armWhen`. Events that arrive while this is
  // false are dropped, which is what makes "record the tail, not the whole
  // journey" possible without touching the injected listener at all.
  let armed = !(armWhen || beforeArm);

  // The binding must exist before the init script runs, or the page calls a
  // function that isn't there.
  await context.exposeBinding('__understudyEmit', async ({ page }, wire: WireEvent) => {
    // Dropped, not merely unrecorded: the listener keeps computing names and
    // stamping elements throughout, so arming costs nothing and cannot half-work.
    if (!armed) return;

    // The page now computes role and name with a spec-compliant accname
    // implementation, synchronously, while the element still exists. That is
    // authoritative — Playwright's own answer is only consulted when the page
    // had to fall back to its heuristic.
    const inPageIsAuthoritative = wire.resolvedBy === 'accname';
    const resolved = inPageIsAuthoritative
      ? undefined
      : await resolveStamped(page, wire.stamp);

    const role = inPageIsAuthoritative ? wire.hintRole : resolved?.role ?? wire.hintRole;
    const name = inPageIsAuthoritative ? wire.hintName : resolved?.name ?? wire.hintName;
    const resolution: Resolution =
      inPageIsAuthoritative || resolved ? 'accname' : 'unresolved';

    // Detection looks at every addressing hint, but the REF SLUG comes from the
    // name alone — joining all three produced `SECRET.password_password_password`
    // from a field named "Password" with id "#password".
    const fieldHint = name || wire.testId || wire.css || 'field';
    const secretSignal = [name, wire.css, wire.testId].filter(Boolean).join(' ');
    // A press event's value is a KEY NAME ('Enter'), not something the user
    // typed — redacting it turns pressing Enter in a password field into
    // `valueRef: SECRET.password`, and replay then tries to press a key called
    // by the password itself. Only typed input can be a credential.
    // AN UPLOAD'S VALUE IS A PATH, NOT A CREDENTIAL, so it must never reach
    // redactValue — a file input labelled "Upload your ID photo" trips
    // SECRET_HINTS on the word 'id' and would be stored as a valueRef, leaving
    // replay hunting for a password that was never a password.
    let uploaded: string | undefined;
    if (wire.action === 'upload') {
      const paths = await uploadedPaths(page, wire.stamp);
      // Nothing resolvable: drop the step. Recording an upload we cannot point
      // at is exactly the silent-corruption failure this branch exists to end.
      if (!paths.length) return;
      uploaded = (await Promise.all(paths.map(stashFixture))).join('\n');
    }

    const valued =
      uploaded !== undefined
        ? { value: uploaded }
        : wire.value !== undefined
          ? wire.action === 'press'
            ? { value: wire.value }
            : redactValue(fieldHint, wire.value, wire.inputType, secretSignal)
          : {};

    events.push({
      seq: events.length,
      ts: Date.now() - startedAt,
      action: wire.action,
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...valued,
      ...(wire.css ? { css: wire.css } : {}),
      ...(wire.testId ? { testId: wire.testId } : {}),
      ...(wire.testIdAttr ? { testIdAttr: wire.testIdAttr } : {}),
      ...(wire.frameHint ? { frameHint: wire.frameHint } : {}),
      url: wire.url,
      resolution,
    });
  });

  // Order matters: the accname bundle must exist before the listener runs, or
  // the listener silently falls back to its heuristic for the first page.
  await context.addInitScript(ACCNAME_BUNDLE);
  await context.addInitScript(INJECTED_LISTENER);

  const page = lease.page;

  // The opening navigation is a step in its own right — a replay has to start
  // somewhere, and it is not implied by any click. When capture is armed later,
  // the opening step is wherever the operator armed it, so it is pushed there
  // instead of here.
  if (armed) {
    events.push({
      seq: 0,
      ts: 0,
      action: 'goto',
      value: startUrl,
      url: startUrl,
      resolution: 'script-literal',
    });
  }

  // A prelude's own first step is a goto, so navigating here as well would be a
  // second navigation racing the first for no purpose.
  if (!beforeArm) await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

  let entry: RecordingEntry | undefined;

  // THE PRELUDE RUNS HERE: after the listener and the accname bundle are
  // installed, before the gate opens. Its events are dropped exactly as a
  // human's are while driving to a starting point by hand.
  if (beforeArm) await beforeArm(lease);

  if (armWhen || beforeArm) {
    // Closing the window is the stop signal everywhere else, so it has to be
    // one here too. Without this race, shutting the browser while we are still
    // waiting to be armed leaves the arm promise pending forever and the
    // process hanging with nothing on screen to explain why.
    const abandoned = new Promise<'abandoned'>((resolve) => {
      const give = () => resolve('abandoned');
      page.once('close', give);
      context.once('close', give);
      browser.once('disconnected', give);
    });

    const outcome = await Promise.race([
      (armWhen ? armWhen(page) : Promise.resolve()).then(() => 'armed' as const),
      abandoned,
    ]);

    if (outcome === 'abandoned') {
      if (ownsLease) await lease.close();
      // No events at all — the caller's "nothing was recorded" guard reports
      // it and refuses to save, which is exactly right.
      return buildRecording({ source, origin, appSlug, startUrl }, []);
    }

    // Drain before arming, not after. Events dispatched in the page just before
    // the operator armed are still in flight over the binding, and a gate read
    // at handler time would let them through — capturing the last click of the
    // journey we were trying not to record.
    await page
      .evaluate('window.__understudyFlush && window.__understudyFlush()')
      .catch(() => {});
    await page.waitForTimeout(300).catch(() => {});

    const here = page.url();
    const { sig } = await computeSig(page);
    armed = true;

    events.push({
      seq: 0,
      ts: 0,
      action: 'goto',
      value: here,
      url: here,
      // The arming fingerprint rides on step 0 as an ordinary expectation, so
      // replay's existing "am I where I expected to be?" check catches a stale
      // or missing session for free — and escalates it like any other
      // unexpected page, instead of failing later on a locator with no
      // explanation. An expired session serves the login page at the URL that
      // used to be the account page, which is precisely the case a URL
      // comparison cannot see and sig() can.
      expectedSig: sig,
      resolution: 'script-literal',
    });

    const armedInfo = onArmed ? await onArmed({ context, page, sig }) : undefined;

    // `requiresSession` is a claim about REPLAY: can a cold browser reach step
    // 0 by itself? Restoring a session says no. So does SAVING one — the caller
    // only banks a session when credentials were supplied and a login happened,
    // which is the manual-login case and replays no better than the restored
    // one. Arming on a page reachable without either needs nothing, and saying
    // it does would block replay for no reason.
    const needsSession = Boolean(storageState) || Boolean(armedInfo?.sessionSaved);
    entry = {
      startState: sig,
      ...(needsSession ? { requiresSession: true } : {}),
      ...(preludeSlugs?.length ? { prelude: preludeSlugs } : {}),
    };
  }

  if (drive) {
    await drive(page);
    // Bindings resolve asynchronously; a final action can still be in flight.
    await page.waitForTimeout(400);
  } else {
    console.log('recording — drive the app in the browser window.');
    console.log('close the browser when you are done.\n');

    // Closing the window is the stop signal. There is no "done" button to click
    // because any such control would itself be recorded.
    await new Promise<void>((resolve) => {
      const finish = () => {
        if (closed) return;
        closed = true;
        resolve();
      };
      page.on('close', finish);
      context.on('close', finish);
      browser.on('disconnected', finish);
      setTimeout(finish, maxMinutes * 60_000);
    });
  }

  // Flush any field still holding an unemitted value — typically the last one
  // typed, which nothing ever blurred.
  for (const p of context.pages()) {
    // A string, not a closure: no DOM lib needed in a Node project, and no
    // esbuild __name helper to be serialized into the page.
    await p.evaluate('window.__understudyFlush && window.__understudyFlush()').catch(() => {});
  }
  await page.waitForTimeout(250).catch(() => {});

  if (ownsLease) await lease.close();

  // seq is reassigned densely: events arrive over a binding and a slow
  // resolution can land out of order relative to a fast one.
  const ordered = events
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map((e, i) => ({ ...e, seq: i }));

  return buildRecording(
    { source, origin, appSlug, startUrl, ...(entry ? { entry } : {}) },
    ordered,
  );
}
