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

import { type Frame, type Locator, type Page } from 'playwright';
import { openLease, type BrowserLease } from './browser.js';
import { computeSig, urlPattern, waitForAriaStable } from './sig.js';
import { acceptBaseline, captureCheckpoint, worthJudging, VISUAL_SEVERE, type VisualCheck } from './visual.js';
import type { RawEvent, RawRecording } from './recording.js';
import type { StorageState } from './auth-cache.js';
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
  /** Result of a visual checkpoint, when this step was one. */
  visual?: VisualCheck;
  /** Lessons whose trigger matched this step, and therefore fired. */
  lessonsApplied?: Array<{ lessonId: string; kind: string; title: string }>;
  /** Set when the step needed more than one try. Absent means it passed first time. */
  attempts?: number;
  /** Set when a human took this step over rather than the executor running it. */
  viaHandoff?: boolean;
  /**
   * Set when role+name matched several elements and something more specific
   * had to disambiguate. Feeds `selectors.fragility` — a name that is not
   * unique is a latent flake even when the step passes.
   */
  ambiguousByName?: { matched: number; disambiguatedBy: string };
  /**
   * Set when role+name matched NOTHING and a captured fallback (test id or
   * css) found the element instead. This is the other half of "raw CSS is the
   * last resort" — a role means nothing when the app renders the control as a
   * bare div/span with no ARIA semantics, which getByRole can never match no
   * matter how accurately the name was captured.
   */
  roleHadNoMatch?: { fellBackTo: string };
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
  /** Visual checkpoints taken this run, judged or not. */
  visualChecks: VisualCheck[];
  /** Outcomes for the prelude steps, if any were walked. */
  preludeSteps?: StepOutcome[];
  /**
   * False when the prelude itself failed.
   *
   * Distinct from `ok` on purpose: a prelude that will not replay is an
   * ENVIRONMENT failure — the corpus it references has rotted, or the app
   * changed upstream of what we are verifying. Reporting that as `needsReview`
   * would quarantine a recording whose own steps never ran and were never in
   * question.
   */
  preludeOk?: boolean;
  /**
   * Every point a human took over.
   *
   * A run that needed one is NOT a clean pass, and reporting it as one would
   * manufacture exactly the kind of proof this codebase refuses to manufacture
   * elsewhere. Callers surface this alongside the verdict.
   */
  handoffs: HandoffRecord[];
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
  /**
   * Start from a saved browser session rather than a cold one.
   *
   * Handed in as a payload, never read from disk here — replay stays ignorant
   * of storage, exactly as it does for lessons and visual baselines.
   *
   * A SESSION MAY ONLY SATISFY WHAT WAS NOT RECORDED. Passing one to verify a
   * recording whose own steps are the login would let ingest "prove" a flow it
   * never ran. Callers decide; replay cannot tell the difference.
   */
  storageState?: StorageState;
  /**
   * Run in a browser someone else owns, instead of launching one.
   *
   * This is what lets a prelude replay and a live capture share ONE context:
   * server-side wizard progress is not in `storageState`, so the only way to
   * start a recording past an intake is to walk it in the very context that is
   * about to be recorded. A lease passed here is never closed by replay.
   *
   * `storageState` is ignored when a lease is supplied — the lease's context
   * already exists and seeding it is the lease owner's decision.
   */
  lease?: BrowserLease;
  /**
   * Steps to walk BEFORE the recording's own, to reach the state it starts from.
   *
   * Resolved by the caller from `entry.prelude`, never looked up here — replay
   * stays ignorant of the database exactly as it does for lessons and sessions.
   * A recording captured with `record --after` holds only the tail, and this is
   * what makes it replayable: a saved session carries a login, but wizard
   * progress is server-side and has to be walked.
   *
   * Accounted for SEPARATELY from the recording's steps. They are how we got to
   * the starting line, not part of what is being verified.
   */
  prelude?: RawEvent[];
  /**
   * Hand a stuck run to a human, and continue with what they reached.
   *
   * A CALLBACK OF ITS OWN, not another `onDecision` kind, because the request
   * carries live `storageState` and every PendingDecision payload is written
   * verbatim into `context_requests.payload`. Keeping the shapes separate is
   * what makes it impossible to leak a session token into the database by
   * adding a field.
   *
   * Omitted means no handoff: the run fails where it always did.
   */
  onHandoff?: (request: HandoffRequest) => Promise<HandoffOutcome>;
  /**
   * How many times to try a step, and when to stop asking and delegate.
   *
   * Read from the environment by the caller, so replay holds no policy.
   */
  budget?: { stepAttempts?: number; exceeded?: () => string | undefined };
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
   * Turn visual checkpoints on. Opt-in because it only means something when
   * the reasoner can actually look at an image — Bedrock's adapter answers
   * from text alone, so capturing for it would produce files nobody reads.
   */
  visualCheck?: { appSlug: string; runId: string };
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

/** Why the executor gave up on doing this itself. */
export type HandoffTrigger =
  | 'step_attempts'
  | 'unimplemented_action'
  | 'unresolved_seam'
  | 'budget';

export interface HandoffRequest {
  trigger: HandoffTrigger;
  /** Step the run is stuck on. */
  seq: number;
  reason: string;
  url: string;
  sig: string;
  expectedSig?: string;
  /**
   * The paused browser's state, for seeding the window the human will drive.
   *
   * NEVER put this in a PendingDecision — it is a live credential and that
   * payload is written to a JSONB column. The handoff implementation writes it
   * to a 0600 file and hands over the PATH.
   */
  storageState: StorageState;
  failed?: { action: string; target?: string; error: string; attempts: number };
}

/**
 * What came back from a human who was asked to record the missing piece.
 *
 * `adopt` is the default and the only mode built, deliberately. The handoff
 * window shares the paused run's SERVER-SIDE session, so by the time the human
 * closes it the wizard has already advanced. Re-driving their captured steps
 * in the run's own browser would walk an already-advanced flow — locators gone,
 * and any side effect applied twice. So the run adopts the state they reached
 * and continues from the NEXT step; the captured steps are still recorded, they
 * are simply not executed again.
 */
export type HandoffOutcome =
  | {
      action: 'adopt';
      steps: RawEvent[];
      url: string;
      sig?: string;
      storageState?: StorageState;
      recordingHash?: string;
    }
  | { action: 'skip' }
  | { action: 'abort'; reason?: string };

export interface HandoffRecord {
  seq: number;
  trigger: HandoffTrigger;
  reason: string;
  recordingHash?: string;
  steps: number;
  url: string;
}

/** Lesson kinds that mean "this page resolves late" — settle before acting. */
const SETTLE_KINDS = new Set(['wait', 'timing']);

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

  // APPLY THE SCOPE. The parser splits a chain into scope + target on purpose —
  // `page.getByRole('navigation').getByText('Login')` addresses "Login" INSIDE
  // the navigation landmark — and then this function used to ignore the scope
  // entirely, searching the whole page instead. Mostly that passed by luck with
  // an ambiguous match; for a relative target like `locator('xpath=..')` it
  // resolves from the document root and matches nothing at all.
  const scope = event.hints?.scope;
  let base: Page | Frame | Locator = root;
  if (Array.isArray(scope)) {
    for (const raw of scope) {
      if (typeof raw !== 'string') continue;
      const value = raw.slice(raw.indexOf('=') + 1);
      if (!value) continue;
      if (raw.startsWith('role=')) base = base.getByRole(value as Parameters<Page['getByRole']>[0]);
      else if (raw.startsWith('css=')) base = base.locator(value);
      else if (raw.startsWith('name=')) base = base.getByText(value);
    }
  }

  // A name written as a regex in the source stays a regex here. `event.name`
  // holds the SOURCE, which for something like `Minoxidil 2\.5mg` is not the
  // accessible name and would match nothing as a literal.
  const name: string | RegExp = event.hints?.nameRegex
    ? new RegExp(event.name!, String(event.hints.nameFlags ?? ''))
    : event.name!;

  if (event.role && event.name) {
    locator = base.getByRole(event.role as Parameters<Page['getByRole']>[0], {
      name,
      ...(event.exact ? { exact: true } : {}),
    });
  } else if (event.name) {
    locator = base.getByText(name, event.exact ? { exact: true } : {});
  } else if (event.role) {
    locator = base.getByRole(event.role as Parameters<Page['getByRole']>[0]);
  } else if (event.css) {
    locator = base.locator(event.css);
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
    locator = base.locator(`[${attr}="${event.testId.replace(/"/g, '\\"')}"]`);
  }
  if (!locator && event.css) locator = base.locator(event.css);
  if (!locator) return undefined;

  // FILTER BEFORE NTH — that is the order the source wrote them in, and the
  // two do not commute. `locator('label').filter({hasText:/^No$/}).nth(1)` is
  // "the second label saying No"; applying nth first would give "the second
  // label on the page, if it happens to say No".
  const hasText = event.hints?.hasText as string | undefined;
  if (hasText !== undefined) {
    locator = locator.filter({
      hasText: event.hints?.hasTextRegex
        ? new RegExp(hasText, String(event.hints.hasTextFlags ?? ''))
        : hasText,
    });
  }

  const nth = (event.hints?.nth as number | undefined) ?? undefined;
  if (nth !== undefined) locator = nth < 0 ? locator.last() : locator.nth(nth);
  return locator;
}

/**
 * Wait until the URL has stopped changing.
 *
 * Deliberately polling rather than `waitForLoadState`: these are client-side
 * route changes, so there is no document load to wait on — the URL simply
 * changes a few hundred milliseconds after the action that caused it. Requiring
 * a quiet period rather than a single reading is what distinguishes "settled"
 * from "has not started yet".
 */
async function waitForUrlSettled(
  page: Page,
  opts: { mayNavigate?: boolean } = {},
  quietMs = 400,
  budgetMs = 5000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let last = page.url();
  let unchangedSince = Date.now();

  // A NAVIGATION HAS TO BE GIVEN TIME TO START.
  //
  // "Unchanged for 400ms" is trivially true in the instant after a click, so
  // without this the function returned before the redirect began and the sig
  // was taken on the page being LEFT. That is not theoretical: it put
  // `/auth/otp` in as the end state of the login segment, and because segments
  // dedupe by slug that wrong boundary overwrote a correct one and broke a
  // composition that had been working.
  //
  // Only for actions that can navigate — adding a second to every fill would
  // cost a minute on a sixty-step recording for nothing.
  const graceUntil = opts.mayNavigate ? Date.now() + 1200 : 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(50);
    const now = page.url();
    if (now !== last) {
      last = now;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= quietMs && Date.now() >= graceUntil) {
      return;
    }
  }
}

/** Actions that can trigger a navigation, and therefore need the grace above. */
const NAVIGATING_ACTIONS = new Set(['click', 'press', 'goto', 'select']);

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
    values = {}, headless = true, timeoutMs = 10_000, captureBodies = true, visualCheck,
    onDecision, lessonsFor, storageState, prelude, onHandoff, budget,
  } = opts;
  const maxAttempts = Math.max(1, budget?.stepAttempts ?? 1);
  const handoffs: HandoffRecord[] = [];
  const escalations: Escalation[] = [];
  const visualChecks: VisualCheck[] = [];

  // OWNERSHIP IS THE CALLER'S, NOT THE LEASE'S. A lease handed in belongs to
  // whoever opened it and may well be replayed into again — closing it here
  // would tear down the context a prelude just walked, one line before the
  // recorder was going to capture from it.
  const ownsLease = !opts.lease;
  const lease = opts.lease ?? await openLease({ headless, ...(storageState ? { storageState } : {}) });
  const page = lease.page;

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

  // The prelude is walked through the SAME step walker — a prelude step that
  // silently behaved differently from a recorded one would be a second executor,
  // which is the thing this file exists not to have.
  const walk: Array<{ event: RawEvent; isPrelude: boolean }> = [
    ...(prelude ?? []).map((event) => ({ event, isPrelude: true })),
    ...recording.events.map((event) => ({ event, isPrelude: false })),
  ];

  const preludeSteps: StepOutcome[] = [];
  let preludeFailed = false;

  for (let i = 0; i < walk.length; i++) {
    const { event, isPrelude } = walk[i]!;
    currentStep = event.seq;
    // Checked per step, so the wall-clock limit is honoured even on a run that
    // never asks a question.
    const budgetSpent = budget?.exceeded?.();
    /** Set the instant an action goes out, so a retry cannot double-submit. */
    let dispatched = false;
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
      // A `wait` or `timing` lesson exists because something on this page
      // resolves late. Settling before the action is the cheapest possible
      // form of "do Y first".
      //
      // `timing` is included because that is what a distiller naturally calls
      // it: the OTP lesson ("the code is validated asynchronously after the
      // last digit, clicking Sign in immediately submits stale state") was
      // written as `timing`, matched the step perfectly, and then did nothing
      // — the lesson was right and the handler was too narrow to act on it.
      if (applied.some((l) => SETTLE_KINDS.has(l.kind))) {
        await waitForAriaStable(page, 2000).catch(() => {});
      }
    }

    // THE ATTEMPT LOOP IS PURE CONTROL FLOW, not a reasoner round trip.
    // Retrying by asking would make every retry human-speed, which is the
    // opposite of the point — the budget exists to REDUCE escalations.
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      outcome.ok = false;
      delete outcome.error;

      try {
        // AN UNRESOLVED SEAM MEANS "I DO NOT KNOW HOW TO GET FROM HERE TO
        // THERE". Executing through it would start the next segment from a
        // state it was never recorded in — a plan quietly doing the wrong thing
        // rather than failing. Refusing here, with a browser open, is what lets
        // a human record the bridge instead of the run simply dying.
        const gap = event.hints?.seamGapBefore as
          | { from: string; to: string; detail?: string }
          | undefined;
        if (gap) {
          throw new Error(
            `unresolved seam ${gap.from} -> ${gap.to}${gap.detail ? ` (${gap.detail})` : ''}`,
          );
        }

        if (event.action === 'goto') {
          const url = valueFor(event, values) ?? event.url;
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          outcome.ok = true;
        } else if (event.action === 'wait_url' || event.action === 'wait_text') {
          // BOTH ARE PURE WAITS, so they are implemented here rather than left
          // to escalate. Handing a human a browser and asking them to record a
          // *wait* would be an absurd use of the handoff, and these are five
          // lines. `dispatch_click` genuinely needs a decision and still
          // escalates.
          const expected = valueFor(event, values) ?? '';
          if (!expected) throw new Error(`${event.action} has no value to wait for`);

          if (event.action === 'wait_url') {
            // Substring, not equality: recordings carry concrete URLs while the
            // thing worth waiting for is the route.
            await page.waitForURL((u) => u.href.includes(expected), { timeout: timeoutMs });
          } else {
            await page.getByText(expected).first().waitFor({ state: 'visible', timeout: timeoutMs });
          }
          outcome.ok = true;
        } else if (event.action === 'snapshot') {
          // A checkpoint addresses no element — it is a moment, not a target.
          // Settle first for the same reason sig() does: a picture taken
          // mid-transition shows a layout that never existed, and would fail
          // against every baseline including one taken from itself.
          await waitForUrlSettled(page, { mayNavigate: true });
          await waitForAriaStable(page, 1500);

          if (visualCheck) {
            const check = await captureCheckpoint(page, {
              appSlug: visualCheck.appSlug,
              runId: visualCheck.runId,
              seq: event.seq,
              label: event.value ?? `step-${event.seq}`,
            });
            visualChecks.push(check);
            outcome.visual = check;

            // SEVERE MEANS STOP. A third of the page changing is not a moved
            // button; it is a blank render or an error screen, and sig() can
            // miss both because landmarks survive. Driving the remaining steps
            // into that produces cascading noise, not information.
            if (!check.isNew && (check.ratio ?? 0) >= VISUAL_SEVERE) {
              outcome.ok = false;
              outcome.error =
                `visual checkpoint "${check.label}" changed by ` +
                `${((check.ratio ?? 0) * 100).toFixed(1)}% — stopping rather than running on`;
            } else {
              outcome.ok = true;
            }
          } else {
            // Visual checking is opt-in: without a reasoner able to look at an
            // image there is nobody to judge the result, and an unjudged diff is
            // just a file on disk.
            outcome.ok = true;
          }
        } else {
          // frame_hint is matched by SUFFIX, never exactly — iframe ids are
          // routinely generated per session, and an exact match would fail on
          // every run but the one that recorded it.
          const root: Page | Frame = event.frameHint
            ? (page.frames().find((f) => f.url().includes(event.frameHint!) || f.name().endsWith(event.frameHint!)) ?? page)
            : page;

          let locator = locatorFor(root, event);
          if (!locator) throw new Error('step has no usable locator (no role, name, css or testId)');

          // WAIT BEFORE COUNTING. `count()` is an instant poll — it does not
          // auto-wait the way click()/fill() do. Against a server-rendered page
          // that is invisible; against a client-rendered app the element simply
          // has not been created yet, so every step failed in milliseconds with
          // "locator matched no elements" and the 10s step timeout below never
          // came into play.
          //
          // Waiting for `attached` rather than `visible` on purpose: a step may
          // legitimately target something present but not visible (the sr-only
          // radio inputs in these intake forms are exactly that).
          await locator
            .first()
            .waitFor({ state: 'attached', timeout: timeoutMs })
            .catch(() => {
              // Genuinely absent. Fall through — count() reports 0 and the
              // existing "matched no elements" error is still the right one.
            });

          // Count second: a locator matching several elements is a latent flake,
          // and knowing that is worth more than the step passing by luck.
          outcome.matched = await locator.count();

          // ROLE CAN MATCH NOTHING BY DESIGN, NOT JUST BY DRIFT.
          //
          // getByRole() excludes elements with no real ARIA semantics — a plain
          // div/span used as a click target (no button, no link, no aria-*) is
          // "generic" and Playwright's role engine will never surface it, no
          // matter how accurately the name was captured live. That is not page
          // drift to report and give up on; a test id or raw css captured on the
          // same step addresses the same element a different way, and this is
          // exactly the "last resort" locatorFor's own docstring describes but
          // never actually reached for. Only tried when the primary attempt used
          // role — a locator already built from testId or css failing means the
          // element is actually gone, and retrying it here would be pointless.
          if (outcome.matched === 0 && event.role) {
            const attr = event.testIdAttr ?? 'data-testid';

            // Tried in order of how much each is worth trusting, and the visible
            // TEXT is the one that survives a redesign: a css path captured
            // before class-name escaping shipped can be syntactically invalid
            // (Tailwind's `hover:` and `[16px]`), and re-escaping it after the
            // fact cannot be done safely — splitting `py-3.5` on the dot that
            // separates classes produces two classes that were never there. Text
            // needs no such repair, and for a div-as-button the accessible name
            // IS what the user clicked on.
            const candidates: Array<{ how: string; locator: Locator }> = [
              ...(event.testId
                ? [{ how: attr, locator: root.locator(`[${attr}="${event.testId.replace(/"/g, '\\"')}"]`) }]
                : []),
              ...(event.css ? [{ how: 'css', locator: root.locator(event.css) }] : []),
              ...(event.name ? [{ how: 'text', locator: root.getByText(event.name, { exact: true }) }] : []),
            ];

            for (const candidate of candidates) {
              await candidate.locator
                .first()
                .waitFor({ state: 'attached', timeout: timeoutMs })
                // An invalid selector throws here rather than reporting nothing,
                // and that must not abort the replay — the next candidate is
                // exactly what it should fall through to.
                .catch(() => {});
              const count = await candidate.locator.count().catch(() => 0);
              if (count > 0) {
                outcome.roleHadNoMatch = { fellBackTo: candidate.how };
                locator = candidate.locator;
                outcome.matched = count;
                break;
              }
            }
          }

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
            // Guarded for the same reason the fallback chain above is: an
            // unescaped Tailwind class path throws instead of matching nothing,
            // and failing to disambiguate is not a reason to fail the step —
            // it just means the ambiguity stands and gets reported.
            const specificCount = await specific.count().catch(() => 0);
            if (specificCount === 1) {
              outcome.ambiguousByName = { matched: outcome.matched, disambiguatedBy: event.testId ? attr : 'css' };
              locator = specific;
              outcome.matched = 1;
            }
          }

          if (outcome.matched === 0) throw new Error('locator matched no elements');
          const target = outcome.matched > 1 ? locator.first() : locator;

          // Past this line the app may have been changed. Everything above is
          // addressing, which is safe to try again; nothing below is.
          dispatched = true;

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
            case 'scroll_container': {
              // TWO PHRASINGS, because scroll gates come in two shapes and the
              // IR should be able to say which one it means.
              //
              //   value 'bottom'/'top' — the TARGET IS THE PANE. Set its own
              //     scrollTop. This is the "scroll the summary to the end"
              //     gate, where the thing to scroll has no landmark inside it
              //     worth addressing and is reached by CSS.
              //   no value            — the TARGET IS CONTENT INSIDE the pane.
              //     Ask Playwright to bring it into view and let it work out
              //     which ancestor actually scrolls. Preferred where a real
              //     element marks the end of the content, because it survives
              //     the pane's class names changing.
              const where = valueFor(event, values);
              if (where === 'bottom' || where === 'top') {
                // Typed structurally rather than as `Element`: this project's
                // tsconfig has no DOM lib, and the two properties used are the
                // whole contract.
                await target.evaluate(
                  (el: { scrollTop: number; scrollHeight: number }, edge: string) => {
                    el.scrollTop = edge === 'bottom' ? el.scrollHeight : 0;
                  },
                  where,
                );
              } else {
                await target.scrollIntoViewIfNeeded({ timeout: timeoutMs });
              }

              // The gate is driven by a scroll LISTENER, and listeners are
              // routinely throttled to an animation frame or debounced. Setting
              // scrollTop and clicking in the same tick lands the click while the
              // control is still disabled — which fails as "element is not
              // enabled", pointing at the button rather than at the scroll that
              // never registered. Two frames is enough for rAF-based handlers
              // and costs nothing on flows that don't need it.
              await page.waitForTimeout(120);
              break;
            }
            default:
              throw new Error(`replay does not implement action '${event.action}'`);
          }
          outcome.ok = true;
        }

        // Settle before fingerprinting: a sig taken mid-transition describes a
        // state that never existed. Same lesson as explore.
        //
        // THE URL HAS TO SETTLE FIRST, and the aria budget alone does not
        // guarantee it. A click that signs in returns quickly, then the client
        // router pushes a new route a beat later — so the fingerprint was taken
        // on the page being LEFT. That is not a cosmetic error: the sig after a
        // segment's last step becomes its `end_state`, so the redirect got
        // attributed to the NEXT segment and every state boundary shifted by one
        // transition. The planner then rejects the semantically right segment
        // ("starts at /overview, execution is at /auth/otp") and binds its
        // neighbour instead.
        await waitForUrlSettled(page, { mayNavigate: NAVIGATING_ACTIONS.has(event.action) });
        await waitForAriaStable(page, 1500);
        const sig = await computeSig(page);
        outcome.sig = sig.sig;
        lastPattern = sig.urlPattern;

        // PRELUDE SIGS ARE NOT PART OF THE FLOW'S PATH. `sigSequence[0]` becomes
        // the flow's `start_state` at ingest and `[last]` its `end_state`, so
        // letting the prelude in shifts the whole boundary — and the consecutive-
        // dedupe just below would additionally SWALLOW the recording's real first
        // sig whenever it equals the prelude's last, silently, which is exactly
        // the off-by-one the comment above is about.
        if (!isPrelude && sigSequence[sigSequence.length - 1] !== sig.sig) {
          sigSequence.push(sig.sig);
        }

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

      if (outcome.ok || attempt === maxAttempts) break;

      // A RETRY IS ONLY SAFE BEFORE THE ACTION WENT OUT. Re-clicking a button
      // that navigated and then failed its fingerprint check submits twice.
      // Retries are for ADDRESSING failures — "locator matched no elements", an
      // attach timeout — which are the ones that actually heal on a second look.
      if (dispatched) break;

      // A refusal is not a flake. Retrying an unresolved seam just waits.
      if (event.hints?.seamGapBefore) break;

      // Without settling, attempt 2 fails identically in zero milliseconds and
      // the whole loop is theatre.
      await waitForAriaStable(page, 1500).catch(() => {});
      outcome.attempts = attempt + 1;
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
      const answer = await onDecision({ kind: 'step_failed', context: question });
      escalations.push({ step: event.seq, kind: 'step_failed', question, answer });
      if (answer.action === 'continue') {
        outcome.ok = true;
        outcome.error = `${outcome.error} (continued by reasoner)`;
      }
    }

    // THE HANDOFF. The executor has run out of ways to do this itself, so it
    // asks a human to do the piece it cannot and carries on from wherever they
    // got to. A prelude step is excluded: the prelude is how we reached the
    // starting line, and a human patching it would be patching the wrong thing.
    if (!outcome.ok && onHandoff && !isPrelude) {
      const trigger: HandoffTrigger = outcome.error?.includes('does not implement action')
        ? 'unimplemented_action'
        : event.hints?.seamGapBefore
          ? 'unresolved_seam'
          : budgetSpent
            ? 'budget'
            : 'step_attempts';

      const here = await computeSig(page).catch(() => ({ sig: '(unknown)' }));
      const request: HandoffRequest = {
        trigger,
        seq: event.seq,
        reason: budgetSpent ?? outcome.error ?? 'step failed',
        url: page.url(),
        sig: here.sig,
        ...(event.expectedSig ? { expectedSig: event.expectedSig } : {}),
        storageState: await lease.context.storageState(),
        failed: {
          action: event.action,
          ...(event.name ?? event.testId ?? event.css
            ? { target: event.name ?? event.testId ?? event.css! }
            : {}),
          error: outcome.error ?? 'step failed',
          attempts: outcome.attempts ?? 1,
        },
      };

      const handed = await onHandoff(request);

      if (handed.action === 'adopt') {
        // ADOPT, DO NOT RE-DRIVE. The handoff window shared this run's
        // server-side session, so the work is already done over there. Replaying
        // the captured steps here would walk a flow that has already moved on —
        // locators gone, side effects applied twice.
        if (handed.storageState) await lease.reseed(handed.storageState);
        await page.goto(handed.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
        await waitForUrlSettled(page, { mayNavigate: true });
        await waitForAriaStable(page, 1500);
        const landed = await computeSig(page);

        // A handoff can take ten minutes, which is long enough for the session
        // it was seeded from to expire. Verifying rather than assuming turns
        // that into an ordinary escalation instead of a confusing failure later.
        if (handed.sig && handed.sig !== landed.sig) {
          outcome.error =
            `handoff landed on ${landed.sig}, not the ${handed.sig} it reported`;
          outcome.ok = false;
        } else {
          outcome.ok = true;
          outcome.viaHandoff = true;
          delete outcome.error;
          if (sigSequence[sigSequence.length - 1] !== landed.sig) sigSequence.push(landed.sig);
          outcome.sig = landed.sig;
          lastPattern = landed.urlPattern;
        }

        handoffs.push({
          seq: event.seq,
          trigger,
          reason: request.reason,
          ...(handed.recordingHash ? { recordingHash: handed.recordingHash } : {}),
          steps: handed.steps.length,
          url: handed.url,
        });

        // A SEAM HANDOFF IS DIFFERENT FROM EVERY OTHER ONE. What the human
        // recorded is the BRIDGE — how to get from the previous segment's end
        // to this segment's start. This step is the destination's first step
        // and has still not run. Clearing the marker and re-entering the same
        // index runs it, now from the right place; marking it done would skip
        // a real step and quietly shorten the flow.
        if (outcome.ok && trigger === 'unresolved_seam') {
          delete (event.hints as Record<string, unknown>).seamGapBefore;
          i--;
          continue;
        }
      } else if (handed.action === 'abort') {
        outcome.error = `aborted at handoff: ${handed.reason ?? 'declined'}`;
      }
      // 'skip' leaves the failure exactly as it was — the run stops below.
    }

    outcome.durationMs = Date.now() - stepStart;
    (isPrelude ? preludeSteps : steps).push(outcome);

    // Stop at the first failure. Every later step assumes state this one was
    // supposed to produce, so continuing yields cascading noise rather than
    // more information.
    if (!outcome.ok) {
      preludeFailed = isPrelude;
      break;
    }
  }

  // THE VISUAL VERDICT, ONCE, AT THE END.
  //
  // Deliberately not per-checkpoint: a visual diff is a quality signal, not a
  // safety one, so there is nothing to protect by stopping. Suspending mid-run
  // would hold an open browser while a human-speed judge thinks, and a run
  // cannot survive its process dying. Batching also lets the judge read the
  // whole story — a diff at step 12 often only makes sense given step 40.
  //
  // The severe case already aborted above, where stopping did buy something.
  const judgeable = worthJudging(visualChecks);
  if (judgeable.length && onDecision) {
    const question = {
      checkpoints: judgeable.map((c) => ({
        label: c.label,
        step: c.seq,
        changedFraction: Number((c.ratio ?? 0).toFixed(4)),
        ...(c.resized ? { resized: true } : {}),
        baselineImage: c.baselinePath,
        currentImage: c.currentPath,
        ...(c.diffPath ? { diffImage: c.diffPath } : {}),
      })),
      expects: {
        verdicts: '[{ label, verdict: "regression" | "expected" | "noise", why }]',
        note:
          'OPEN THE IMAGE FILES before answering — the paths above are real files on ' +
          'disk and the changed fraction alone cannot tell a moved timestamp from a ' +
          'missing button. regression -> recorded as a finding; expected -> the current ' +
          'shot becomes the new baseline so it stops firing; noise -> ignored, baseline kept.',
      },
    };
    const answer: Record<string, unknown> = await onDecision({
      kind: 'visual_diff',
      context: question,
    }).catch(() => ({}));
    escalations.push({ step: -1, kind: 'visual_diff', question, answer });

    // ACCEPTING A BASELINE IS THE POINT. Without it an intentional redesign
    // fires on every run forever, which is exactly how visual testing gets
    // switched off.
    const verdicts = Array.isArray(answer.verdicts) ? answer.verdicts : [];
    for (const raw of verdicts) {
      const v = raw as { label?: string; verdict?: string };
      if (v.verdict !== 'expected') continue;
      const check = judgeable.find((c) => c.label === v.label);
      if (check) await acceptBaseline(check).catch(() => {});
    }
  }

  if (ownsLease) await lease.close();

  const failed = steps.filter((s) => !s.ok);

  // A prelude that did not replay means the recording's own steps NEVER RAN.
  // Calling that `needsReview` would quarantine a recording nothing was learned
  // about, so it is reported as its own condition and `ok` is simply false.
  const preludeOk = !preludeFailed;
  return {
    hash: recording.hash,
    ...(prelude?.length ? { preludeSteps, preludeOk } : {}),
    ok: preludeOk && failed.length === 0 && steps.length === recording.events.length,
    // The gate. Anything that did not fully reproduce is quarantined from
    // memory rather than partially ingested.
    needsReview: preludeOk && (failed.length > 0 || steps.length !== recording.events.length),
    steps,
    sigSequence,
    signals,
    durationMs: Date.now() - startedAt,
    escalations,
    visualChecks,
    handoffs,
  };
}
