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

import { chromium, type BrowserContext, type Page } from 'playwright';
import { parseAria } from '../../core/sig.js';
import {
  buildRecording,
  redactValue,
  type RawEvent,
  type RawRecording,
  type RecordedAction,
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
}

export interface LiveRecordOptions {
  appSlug: string;
  startUrl: string;
  /** Resolved automatically when omitted; recording is inherently interactive. */
  headless?: boolean;
  /** Stop after this long even if the window is still open. */
  maxMinutes?: number;
  /**
   * Drive the page programmatically instead of waiting for a human.
   *
   * Not a test hook — this is how an EXISTING Playwright script becomes a
   * recording. A script's `.click()` dispatches the same DOM events a human
   * click does, so the identical listener captures both. Provide this and the
   * recorder stops when the callback returns rather than when a window closes.
   */
  drive?: (page: Page) => Promise<void>;
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

export async function recordLive(opts: LiveRecordOptions): Promise<RawRecording> {
  const {
    appSlug,
    startUrl,
    maxMinutes = 30,
    drive,
    // A driven capture needs no window; a human one is the whole point of a window.
    headless = Boolean(drive),
    source = drive ? 'script' : 'live',
    origin = drive ? 'driven' : 'headed-browser',
  } = opts;

  const browser = await chromium.launch({ headless });
  const context: BrowserContext = await browser.newContext();

  const events: RawEvent[] = [];
  const startedAt = Date.now();
  let closed = false;

  // The binding must exist before the init script runs, or the page calls a
  // function that isn't there.
  await context.exposeBinding('__understudyEmit', async ({ page }, wire: WireEvent) => {
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
    const valued =
      wire.value !== undefined
        ? redactValue(fieldHint, wire.value, wire.inputType, secretSignal)
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

  const page = await context.newPage();

  // The opening navigation is a step in its own right — a replay has to start
  // somewhere, and it is not implied by any click.
  events.push({
    seq: 0,
    ts: 0,
    action: 'goto',
    value: startUrl,
    url: startUrl,
    resolution: 'script-literal',
  });

  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

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
  await page.waitForTimeout(250);

  await browser.close().catch(() => {});

  // seq is reassigned densely: events arrive over a binding and a slow
  // resolution can land out of order relative to a fast one.
  const ordered = events
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map((e, i) => ({ ...e, seq: i }));

  return buildRecording({ source, origin, appSlug, startUrl }, ordered);
}
