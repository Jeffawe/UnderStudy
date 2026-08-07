/**
 * Replay — re-run a RawRecording headless, and watch everything.
 *
 * Three jobs, and only the first is obvious:
 *
 *  1. VERIFY. A recording that will not reproduce must never become memory.
 *     PLAN.md's rule: won't replay → `needs_review`, never promoted. Bad
 *     memory is worse than no memory, because the agent acts on it confidently.
 *
 *  2. ENRICH. Per-step page fingerprint, console errors, network responses with
 *     bodies. All of it captured unconditionally and with no model involved,
 *     which is what makes findings detection free and what gives flow-drift its
 *     baseline.
 *
 *  3. CONFIRM ADDRESSING. Names are computed in-page at capture, but a name
 *     that resolved then may not resolve now. Replay is where a locator is
 *     proven to still find exactly one element.
 *
 * THE STEP WALKER HERE IS THE EXECUTOR'S STEP WALKER. Running a recording and
 * running a bound plan are the same operation — resolve a locator, act, compute
 * sig(), compare, capture. This is not scaffolding for the recorder; it is the
 * first half of the thing that runs tests.
 */

import { chromium, type Browser, type Frame, type Locator, type Page } from 'playwright';
import { computeSig, waitForAriaStable } from './sig.js';
import type { RawEvent, RawRecording } from './recording.js';

export interface StepOutcome {
  seq: number;
  action: string;
  ok: boolean;
  /** Why it failed, in one line. */
  error?: string;
  /** Page fingerprint AFTER the step. Concatenated into sigSequence. */
  sig?: string;
  durationMs: number;
  /** How many elements the locator matched. 1 is healthy; >1 is ambiguous. */
  matched?: number;
  /** Set when a filled value did not survive being written. */
  roundTripMismatch?: { expected: string; actual: string };
  /**
   * Set when role+name matched several elements and something more specific
   * had to disambiguate. Feeds `selectors.fragility` — a name that is not
   * unique is a latent flake even when the step passes.
   */
  ambiguousByName?: { matched: number; disambiguatedBy: string };
}

export interface CapturedSignal {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'http';
  /** Step this happened during — the correlation that makes signals useful. */
  duringStep: number;
  text: string;
  url?: string;
  status?: number;
  body?: string;
}

export interface ReplayResult {
  hash: string;
  ok: boolean;
  /** True when the recording must NOT be promoted to memory. */
  needsReview: boolean;
  steps: StepOutcome[];
  /** The observed path of page fingerprints — the flow-drift baseline. */
  sigSequence: string[];
  signals: CapturedSignal[];
  durationMs: number;
}

export interface ReplayOptions {
  /**
   * Values for `valueRef` steps, e.g. `{ 'SECRET.password': 'hunter2' }`.
   *
   * Recordings deliberately never store credentials, so a recording containing
   * a password CANNOT replay without them. That is the tradeoff working as
   * designed, and an unresolved ref fails the step loudly rather than filling
   * an empty string and producing a confusing downstream failure.
   */
  values?: Record<string, string>;
  headless?: boolean;
  /** Per-step timeout. */
  timeoutMs?: number;
  /** Capture response bodies for non-2xx and JSON responses. */
  captureBodies?: boolean;
}

/** Bodies above this are truncated — a findings fingerprint needs the shape, not the payload. */
const MAX_BODY = 4000;

/**
 * Build a locator from an IR step, best addressing first.
 *
 * Order matters and mirrors fragility: a test id is stable by contract,
 * role+name is stable by meaning, raw CSS is the last resort because it breaks
 * on any markup change. `hints.nth` is applied last — it is positional, which
 * is exactly the brittleness this project exists to reduce, so it is only ever
 * a narrowing of something already selected.
 */
function locatorFor(root: Page | Frame, event: RawEvent): Locator | undefined {
  let locator: Locator | undefined;

  if (event.role && event.name) {
    locator = root.getByRole(event.role as Parameters<Page['getByRole']>[0], {
      name: event.name,
      ...(event.exact ? { exact: true } : {}),
    });
  } else if (event.name) {
    locator = root.getByText(event.name, event.exact ? { exact: true } : {});
  } else if (event.role) {
    locator = root.getByRole(event.role as Parameters<Page['getByRole']>[0]);
  } else if (event.css) {
    locator = root.locator(event.css);
  }

  // Test id is a FALLBACK, not the first choice: role+name is what the whole
  // system keys on (selector dedupe, sig(), binding), so replay should prove
  // that addressing works rather than quietly succeeding by another route.
  //
  // Built as an explicit attribute selector rather than getByTestId, which
  // only consults `data-testid` unless reconfigured globally — saucedemo uses
  // `data-test`, so every step resolved to nothing until this was recorded.
  if (!locator && event.testId) {
    const attr = event.testIdAttr ?? 'data-testid';
    locator = root.locator(`[${attr}="${event.testId.replace(/"/g, '\\"')}"]`);
  }
  if (!locator && event.css) locator = root.locator(event.css);
  if (!locator) return undefined;

  const nth = (event.hints?.nth as number | undefined) ?? undefined;
  if (nth !== undefined) locator = nth < 0 ? locator.last() : locator.nth(nth);
  return locator;
}

/** Resolve a step's value, whether literal or a reference. */
function valueFor(event: RawEvent, values: Record<string, string>): string | undefined {
  if (event.value !== undefined) return event.value;
  if (event.valueRef === undefined) return undefined;
  return values[event.valueRef];
}

export async function replay(
  recording: RawRecording,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const { values = {}, headless = true, timeoutMs = 10_000, captureBodies = true } = opts;

  const browser: Browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const steps: StepOutcome[] = [];
  const sigSequence: string[] = [];
  const signals: CapturedSignal[] = [];
  const startedAt = Date.now();

  // `currentStep` is what turns a pile of console noise into evidence: it is
  // the correlation between a signal and the intent that was executing when it
  // fired. A 500 is interesting; a 500 *during checkout* is a finding.
  let currentStep = -1;

  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    signals.push({ kind: 'console', duringStep: currentStep, text: msg.text().slice(0, 500) });
  });

  page.on('pageerror', (err) => {
    signals.push({ kind: 'pageerror', duringStep: currentStep, text: String(err).slice(0, 500) });
  });

  page.on('requestfailed', (req) => {
    signals.push({
      kind: 'requestfailed',
      duringStep: currentStep,
      text: req.failure()?.errorText ?? 'request failed',
      url: req.url(),
    });
  });

  page.on('response', async (res) => {
    const status = res.status();
    const contentType = res.headers()['content-type'] ?? '';
    const interesting = status >= 400 || contentType.includes('application/json');
    if (!interesting) return;

    let body: string | undefined;
    if (captureBodies && status >= 400) {
      // Bodies can fail to read on redirects and aborted requests; a missing
      // body should never take down the replay.
      body = await res.text().then((t) => t.slice(0, MAX_BODY)).catch(() => undefined);
    }

    signals.push({
      kind: 'http',
      duringStep: currentStep,
      text: `${res.request().method()} ${status}`,
      url: res.url(),
      status,
      ...(body ? { body } : {}),
    });
  });

  for (const event of recording.events) {
    currentStep = event.seq;
    const stepStart = Date.now();
    const outcome: StepOutcome = { seq: event.seq, action: event.action, ok: false, durationMs: 0 };

    try {
      if (event.action === 'goto') {
        const url = valueFor(event, values) ?? event.url;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        outcome.ok = true;
      } else {
        // frame_hint is matched by SUFFIX, never exactly — iframe ids are
        // routinely generated per session, and an exact match would fail on
        // every run but the one that recorded it.
        const root: Page | Frame = event.frameHint
          ? (page.frames().find((f) => f.url().includes(event.frameHint!) || f.name().endsWith(event.frameHint!)) ?? page)
          : page;

        let locator = locatorFor(root, event);
        if (!locator) throw new Error('step has no usable locator (no role, name, css or testId)');

        // Count first: a locator matching several elements is a latent flake,
        // and knowing that is worth more than the step passing by luck.
        outcome.matched = await locator.count();

        // AMBIGUITY IS NOT SUCCESS.
        //
        // "Add to cart" is the accessible name of six different buttons on
        // saucedemo. Falling back to .first() makes the step pass by luck and
        // records a locator that will pick a different product the moment the
        // list reorders. When a more specific addressing was captured, use it
        // to disambiguate — and remember that role+name alone was insufficient,
        // because that is exactly what `selectors.fragility` needs to know.
        if (outcome.matched > 1 && (event.testId || event.css)) {
          const attr = event.testIdAttr ?? 'data-testid';
          const specific = event.testId
            ? root.locator(`[${attr}="${event.testId.replace(/"/g, '\\"')}"]`)
            : root.locator(event.css!);
          const specificCount = await specific.count();
          if (specificCount === 1) {
            outcome.ambiguousByName = { matched: outcome.matched, disambiguatedBy: event.testId ? attr : 'css' };
            locator = specific;
            outcome.matched = 1;
          }
        }

        if (outcome.matched === 0) throw new Error('locator matched no elements');
        const target = outcome.matched > 1 ? locator.first() : locator;

        switch (event.action) {
          case 'click':
            await target.click({ timeout: timeoutMs });
            break;
          case 'fill': {
            const value = valueFor(event, values);
            if (value === undefined) {
              throw new Error(
                `no value for ${event.valueRef ?? 'field'} — pass it via --value ${event.valueRef}=…`,
              );
            }
            await target.fill(value, { timeout: timeoutMs });

            // ROUND-TRIP ASSERTION, generated rather than written by hand: the
            // IR knows what went into which field, so it can check the value
            // survived. Fields that silently reformat or reject input are a
            // real defect class and this is free to detect.
            const actual = await target.inputValue({ timeout: 2000 }).catch(() => undefined);
            if (actual !== undefined && actual !== value) {
              outcome.roundTripMismatch = { expected: value, actual };
            }
            break;
          }
          case 'press':
            await target.press(valueFor(event, values) ?? 'Enter', { timeout: timeoutMs });
            break;
          case 'check':
            await target.check({ timeout: timeoutMs });
            break;
          case 'uncheck':
            await target.uncheck({ timeout: timeoutMs });
            break;
          case 'select': {
            const value = valueFor(event, values);
            if (value === undefined) throw new Error('select step has no value');
            await target.selectOption(value, { timeout: timeoutMs });
            break;
          }
          case 'upload': {
            const value = valueFor(event, values);
            if (value === undefined) throw new Error('upload step has no file path');
            await target.setInputFiles(value, { timeout: timeoutMs });
            break;
          }
          default:
            throw new Error(`replay does not implement action '${event.action}'`);
        }
        outcome.ok = true;
      }

      // Settle before fingerprinting: a sig taken mid-transition describes a
      // state that never existed. Same lesson as explore.
      await waitForAriaStable(page, 1500);
      const sig = await computeSig(page);
      outcome.sig = sig.sig;
      if (sigSequence[sigSequence.length - 1] !== sig.sig) sigSequence.push(sig.sig);
    } catch (err) {
      outcome.error = (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);
    }

    outcome.durationMs = Date.now() - stepStart;
    steps.push(outcome);

    // Stop at the first failure. Every later step assumes state this one was
    // supposed to produce, so continuing yields cascading noise rather than
    // more information.
    if (!outcome.ok) break;
  }

  await browser.close().catch(() => {});

  const failed = steps.filter((s) => !s.ok);
  return {
    hash: recording.hash,
    ok: failed.length === 0 && steps.length === recording.events.length,
    // The gate. Anything that did not fully reproduce is quarantined from
    // memory rather than partially ingested.
    needsReview: failed.length > 0 || steps.length !== recording.events.length,
    steps,
    sigSequence,
    signals,
    durationMs: Date.now() - startedAt,
  };
}
