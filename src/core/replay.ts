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
import { computeSig, urlPattern, waitForAriaStable } from './sig.js';
import type { RawEvent, RawRecording } from './recording.js';
import type { PendingDecision } from './types.js';

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
   * Set when the page after this step is NOT the page the step recorded.
   *
   * This is the executor's "unexpected page" signal — where PLAN.md escalates
   * to the reasoner. It is NOT automatically a failure: an app can legitimately
   * gain a banner or a cookie prompt. It is a fact worth carrying, and the
   * judgement about what it means belongs to the reasoner.
   */
  unexpectedPage?: { expected: string; observed: string };
  /** Lessons whose trigger matched this step, and therefore fired. */
  lessonsApplied?: Array<{ lessonId: string; kind: string; title: string }>;
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

export interface Escalation {
  step: number;
  kind: PendingDecision['kind'];
  question: Record<string, unknown>;
  answer: Record<string, unknown>;
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
  /** Every point the executor stopped and asked, with what came back. */
  escalations: Escalation[];
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
  /**
   * Called when the executor cannot decide alone. Deliberately a callback
   * rather than the Reasoner interface, so replay stays decoupled from who is
   * answering — Bedrock, the host agent, or nobody at all.
   *
   * Omitted means NO ESCALATION: the run records what it saw and carries on,
   * which is right for a verification replay and wrong for a real test.
   */
  onDecision?: (decision: PendingDecision) => Promise<Record<string, unknown>>;
  /**
   * Lessons that apply to a step, looked up before it runs.
   *
   * A callback again, so replay does not need to know about the database or
   * which app it is running. Omitted means lessons are not consulted — correct
   * for verifying a raw recording, wrong for a real run.
   */
  lessonsFor?: (context: {
    url_pattern?: string; action?: string; role?: string; name?: string;
  }) => Promise<Array<{ lessonId: string; kind: string; title: string; body: string }>>;
}

/** What a decision may tell the executor to do. */
export type DecisionAction = 'continue' | 'abort' | 'retry';

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
  const {
    values = {}, headless = true, timeoutMs = 10_000, captureBodies = true,
    onDecision, lessonsFor,
  } = opts;
  const escalations: Escalation[] = [];

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
  /** Route of the page we are on, so a lesson can be scoped to one page. */
  let lastPattern: string | undefined;

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

    // WHAT HAVE WE LEARNED ABOUT THIS STEP? Consulted BEFORE acting, because a
    // lesson's whole purpose is "do Y first".
    let applied: Array<{ lessonId: string; kind: string; title: string; body: string }> = [];
    if (lessonsFor) {
      // For a goto the relevant page is the one being navigated TO — there is
      // no previous page on the first step, and a lesson about a landing page
      // would never fire if we only ever looked backwards.
      const contextPattern =
        event.action === 'goto' && (event.value ?? event.url)
          ? urlPattern(event.value ?? event.url)
          : lastPattern;

      applied = await lessonsFor({
        ...(contextPattern ? { url_pattern: contextPattern } : {}),
        action: event.action,
        ...(event.role ? { role: event.role } : {}),
        ...(event.name ? { name: event.name } : {}),
      }).catch(() => []);

      if (applied.length) {
        outcome.lessonsApplied = applied.map((l) => ({ lessonId: l.lessonId, kind: l.kind, title: l.title }));
      }
      // A `wait` lesson exists because something on this page renders late.
      // Settling before the action is the cheapest possible form of "do Y first".
      if (applied.some((l) => l.kind === 'wait')) {
        await waitForAriaStable(page, 2000).catch(() => {});
      }
    }

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
      lastPattern = sig.urlPattern;
      if (sigSequence[sigSequence.length - 1] !== sig.sig) sigSequence.push(sig.sig);

      // AM I WHERE I EXPECTED TO BE?
      //
      // Both sides of this comparison already existed and were being discarded:
      // the step recorded the sig it produced, and we compute the sig after
      // every step regardless. Not comparing them meant execution could walk
      // into a page the plan had never seen and notice nothing until a locator
      // happened to miss.
      if (event.expectedSig && event.expectedSig !== sig.sig) {
        outcome.unexpectedPage = { expected: event.expectedSig, observed: sig.sig };

        // THE ESCALATION. An unexpected page is not automatically wrong — an
        // app may have gained a banner — but continuing blindly is how a run
        // does something nobody asked for. Deterministic code cannot judge it,
        // so it asks. With nobody to ask, it records and carries on.
        if (onDecision) {
          const question = {
            step: event.seq,
            action: event.action,
            target: event.name ?? event.testId ?? event.css,
            expected: event.expectedSig,
            observed: sig.sig,
            semantic: `after ${event.action} on "${event.name ?? '?'}"`,
          };
          const answer = await onDecision({ kind: 'unexpected_page', context: question });
          escalations.push({ step: event.seq, kind: 'unexpected_page', question, answer });

          if (answer.action === 'abort') {
            outcome.error = `aborted by reasoner: ${String(answer.reason ?? 'unexpected page')}`;
            outcome.ok = false;
          }
        }
      }
    } catch (err) {
      outcome.error = (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);
    }

    // A step that FAILED is the other place judgement is needed: a missing
    // element may be rot to heal or a genuine gap to ask about, and only the
    // selector's health tells them apart.
    if (!outcome.ok && onDecision && outcome.error && !outcome.error.startsWith('aborted by reasoner')) {
      const question = {
        step: event.seq,
        action: event.action,
        target: event.name ?? event.testId ?? event.css,
        error: outcome.error,
        matched: outcome.matched,
      };
      const answer = await onDecision({ kind: 'unexpected_page', context: question });
      escalations.push({ step: event.seq, kind: 'unexpected_page', question, answer });
      if (answer.action === 'continue') {
        outcome.ok = true;
        outcome.error = `${outcome.error} (continued by reasoner)`;
      }
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
    escalations,
  };
}
