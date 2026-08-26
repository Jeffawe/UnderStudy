/**
 * RawRecording — the contract every recording source produces.
 *
 * This is the seam that makes the input side open. A human clicking in a headed
 * browser, a codegen script, a hand-written Playwright suite, or a JSON file
 * handed to us by something else entirely all reduce to this shape, and
 * everything downstream — replay, tracing, distillation, IR, memory — consumes
 * only this. A new source is a new adapter, never a new pipeline.
 *
 * IT IS DATA, NOT CODE. Playwright and Cypress source are things we PRINT at
 * emit time; they are never an input format. Code is lossy in the direction we
 * care about: you cannot swap a value, diff two steps, or re-target a selector
 * in a string of JavaScript.
 */

import { createHash } from 'node:crypto';
import { urlPattern } from './sig.js';

/** Actions the IR can express. Mirrors the `steps.action` CHECK constraint. */
export type RecordedAction =
  | 'goto'
  | 'click'
  | 'fill'
  | 'press'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'upload'
  | 'wait_url'
  // Both were in the schema's action CHECK from the start but missing from this
  // union, so `flow-ir.ts`'s `r.action as RawEvent['action']` was quietly
  // asserting something false — a step read back from the database could hold an
  // action this type said was impossible. `wait_text` is implemented;
  // `dispatch_click` still escalates, but it now does so visibly.
  | 'wait_text'
  | 'dispatch_click'
  // Scroll a nested scroll pane, not the window. Gating controls ("Confirm &
  // Submit" stays disabled until you have read the summary) watch a scroll
  // event on their own container, so `window.scrollTo` never satisfies them
  // and the flow simply cannot be captured past that point without this.
  | 'scroll_container'
  // A visual checkpoint: take a picture here and compare it to the baseline.
  // Carried by the schema's action CHECK from the start; nothing emitted it
  // until the parser learned to read the spec's own checkpoint calls.
  | 'snapshot'
  | 'assert';

/**
 * How we came to believe an event's role and name — the honesty field.
 *
 * Role and name are the system's addressing scheme: selectors dedupe on
 * `(role, name, frame_hint)` and `sig()` fingerprints on `role:name`. Getting
 * them wrong doesn't throw, it silently splits one element into two selector
 * rows and breaks the one-health-score-per-element property.
 *
 *   accname         resolved by Playwright's own accessible-name engine
 *                   against a live element — authoritative
 *   script-literal  read verbatim out of `getByRole('button', {name: 'Login'})`
 *                   — codegen already did the accname work, so this is as good
 *   unresolved      addressed by CSS or test id only; no role/name known
 *                   statically. The replay stage can upgrade these by looking
 *                   at the live element.
 */
export type Resolution =
  | 'accname'
  | 'script-literal'
  // Not from a recording at all: a step the planner invented while splicing,
  // such as the visual checkpoint it adds at each segment boundary.
  | 'synthesized'
  | 'unresolved';

export interface RawEvent {
  /** Position in the recording. Dense, 0-based, assigned by the source. */
  seq: number;
  /** Milliseconds since recording start. Excluded from the hash. */
  ts: number;
  action: RecordedAction;

  role?: string;
  name?: string;
  /** Exact-match intent for the name, as codegen emits `{ exact: true }`. */
  exact?: boolean;

  /**
   * Literal value typed or selected. NEVER a credential — see valueRef.
   * A password field emits `valueRef`, never `value`, so a recording can be
   * committed, shared, or shipped to Cloud without leaking secrets.
   */
  value?: string;
  valueRef?: string;

  /** Fallback addressing when role+name isn't available. */
  css?: string;
  testId?: string;
  /**
   * Which attribute the test id came from — `data-testid`, `data-test`, …
   *
   * Playwright's getByTestId only looks at `data-testid` unless reconfigured
   * globally. saucedemo uses `data-test`, so a recording that stored the bare
   * value replayed against nothing. Storing the attribute makes the locator
   * self-describing instead of dependent on ambient config.
   */
  testIdAttr?: string;
  /** Matched by id SUFFIX, never exact — iframe ids are often generated. */
  frameHint?: string;

  /** URL at the moment of the event. */
  url: string;
  /**
   * The page fingerprint this step produced WHEN IT WAS RECORDED.
   *
   * Carried so execution can answer "am I where I expected to be?" — the sig is
   * computed after every step anyway, so comparing it to this costs nothing and
   * is the difference between noticing the app changed under you and walking
   * blindly into a page the plan never saw.
   */
  expectedSig?: string;
  resolution: Resolution;

  /** Anything the source knew but the IR has no column for. */
  hints?: Record<string, unknown>;
}

/**
 * How a recording gets to its first step — the part deliberately NOT recorded.
 *
 * A recording of "send a message" should not have to contain the login and the
 * intake that precede it. Re-recording them would mint duplicate segments
 * competing for the same bind slot, which is the exact problem slug reuse
 * exists to prevent. So the entry state is DECLARED rather than captured, and
 * replay reproduces it by other means.
 */
export interface RecordingEntry {
  /**
   * The page fingerprint observed at the moment capture began.
   *
   * An assertion, not a hint: replay checks it before step 0, because a
   * recording whose steps were captured somewhere other than where replay
   * starts is a recording that describes a page nobody is looking at.
   */
  startState?: string;
  /**
   * Step 0 is not a login — replay must restore a saved session first.
   *
   * Set when capture began from an already-authenticated browser, which is the
   * whole point of arming late. Without it, replaying such a recording lands on
   * a login page and fails on a locator that was never going to be there, with
   * nothing explaining why.
   */
  requiresSession?: boolean;
  /**
   * Flow slugs replayed, in order, in the capture context before capture armed.
   *
   * BY REFERENCE, NEVER INLINED STEPS. A saved session can carry a login past
   * replay because login state lives in cookies; wizard progress does not, so
   * the only way to start a recording past an intake is to actually walk it.
   * Copying those steps into the recording would re-record the intake and mint
   * a duplicate segment competing for the same bind slot — the exact problem
   * slug reuse exists to prevent. A reference also means fixing the referenced
   * segment once fixes every recording built on top of it.
   */
  prelude?: string[];
}

export interface RawRecording {
  /** Bump when the shape changes incompatibly. */
  version: 1;
  source: 'live' | 'script' | 'import';
  /** Where the source came from — a file path, or 'headed-browser'. */
  origin: string;
  appSlug: string;
  startUrl: string;
  createdAt: string;
  /** Distillation cache key. See recordingHash. */
  hash: string;
  /** Absent for a recording that starts from a blank browser at `startUrl`. */
  entry?: RecordingEntry;
  events: RawEvent[];
}

/**
 * Cache key for distillation — BUILDING.md's day-one guard, so the expensive
 * model call happens once per distinct recording and never again.
 *
 * Deliberately excludes:
 *   ts    wall-clock differs on every capture of the same flow
 *   seq   derivable from position
 *   url   normalized to a route pattern, so a recording captured against
 *         localhost and the same flow captured against staging share a key
 *
 * Values ARE included: filling a different username is a different recording.
 *
 * THE ENTRY CONDITION IS PART OF THE KEY. The same tail steps captured from a
 * restored session and from a cold browser replay differently and are not the
 * same recording — without this they would collide, and `saveRecording` would
 * report `existed: true` and silently keep the first. `startState` is
 * deliberately NOT included: it is an observation that can shift with a banner,
 * and a cache key that moves on cosmetic change is not a cache key.
 *
 * The line that decides is DECLARATION vs OBSERVATION. `requiresSession` and
 * `prelude` are claims the operator made about how to reach step 0, and they
 * change how the recording must be executed. `startState` is something the
 * browser reported. The first kind belongs in the key; the second does not.
 *
 * The prelude is hashed as the ORDERED LIST OF SLUGS, never the referenced
 * flows' steps. So identical tail steps captured after `[log-in]` and after
 * `[log-in, complete-intake]` are correctly different recordings, while later
 * fixing the login segment does not move the hash and does not orphan a
 * distillation that was paid for.
 */
export function recordingHash(events: RawEvent[], entry?: RecordingEntry): string {
  const normalized = events.map((e) => [
    e.action,
    e.role ?? '',
    e.name ?? '',
    e.value ?? e.valueRef ?? '',
    e.css ?? '',
    e.testId ?? '',
    e.frameHint ?? '',
    urlPattern(e.url),
  ]);

  // Byte-identical to the old form when there is no entry condition, so every
  // recording captured before this existed keeps the hash it already has.
  // ORDER OF INSERTION IS LOAD-BEARING: `requiresSession` first, `prelude` only
  // when non-empty, so a recording that predates preludes still serializes to
  // exactly the bytes it always did. `auth:check` gate 1 rehashes every
  // recording on disk and is what catches a regression here.
  const extras: Record<string, unknown> = {};
  if (entry?.requiresSession) extras.requiresSession = true;
  if (entry?.prelude?.length) extras.prelude = entry.prelude;

  const payload = Object.keys(extras).length
    ? JSON.stringify([normalized, extras])
    : JSON.stringify(normalized);

  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** Assemble a recording and stamp its hash. */
export function buildRecording(
  meta: Omit<RawRecording, 'version' | 'hash' | 'createdAt' | 'events'>,
  events: RawEvent[],
): RawRecording {
  return {
    version: 1,
    ...meta,
    createdAt: new Date().toISOString(),
    hash: recordingHash(events, meta.entry),
    events,
  };
}

/** Field names that mean "this is a secret" — matched against role/name/css. */
const SECRET_HINTS = /pass(word|wd)?|secret|token|otp|cvv|ssn|api[-_ ]?key/i;

/**
 * Decide whether a typed value is a credential.
 *
 * Fails CLOSED: anything that looks secret is redacted to a valueRef. A false
 * positive costs one hard-coded value that the distiller turns into a
 * parameter anyway; a false negative writes a password into a corpus that gets
 * committed to git and pushed to CockroachDB Cloud.
 */
export function redactValue(
  fieldHint: string,
  value: string,
  inputType?: string,
  secretSignal = fieldHint,
): { value?: string; valueRef?: string } {
  if (inputType === 'password' || SECRET_HINTS.test(secretSignal)) {
    const slug =
      fieldHint.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'secret';
    return { valueRef: `SECRET.${slug}` };
  }
  return { value };
}
