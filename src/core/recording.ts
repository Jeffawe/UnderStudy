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
  events: RawEvent[];
}

/**
 * Cache key for distillation — CLAUDE.md's day-one guard, so the expensive
 * model call happens once per distinct recording and never again.
 *
 * Deliberately excludes:
 *   ts    wall-clock differs on every capture of the same flow
 *   seq   derivable from position
 *   url   normalized to a route pattern, so a recording captured against
 *         localhost and the same flow captured against staging share a key
 *
 * Values ARE included: filling a different username is a different recording.
 */
export function recordingHash(events: RawEvent[]): string {
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
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 32);
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
    hash: recordingHash(events),
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
