/**
 * What makes a selector row ONE ELEMENT.
 *
 * The health model, quarantine, and `execute`'s locator rebuild all rest on
 * "one row per element". Two earlier migrations fixed that key being too WEAK
 * — role/name/frame_hint were nullable, and SQL never treats NULL as equal to
 * NULL, so the constraint was inert and one element became many rows (db/02,
 * db/04).
 *
 * Making them NOT NULL DEFAULT '' then made the key too STRONG in the opposite
 * direction: every element with no accessible name now had the SAME key.
 * Measured on providernow before this fix: 92 steps collapsed onto 2 selector
 * rows, one of which held 52 genuinely different elements — the OTP digit
 * boxes, "I accept", "Raised bumps", the Services nav div and the review pane,
 * all as a single "element" with a single health score.
 *
 * That is not only a metrics problem. `execute.ts` reads `css` and `test_id`
 * FROM THIS TABLE when it rebuilds a locator, so all 52 were being handed
 * `.review-pane` — one element's selector, applied to fifty-one others.
 *
 * So identity is the best STABLE discriminator available, in priority order:
 *
 *   1. an accessible name  — semantic, survives refactors, the right answer
 *   2. a test id           — explicitly put there to identify the element
 *   3. a css selector      — brittle, but it does distinguish
 *   4. nothing             — then the element is NOT IDENTIFIED, and the
 *                            honest response is no row at all rather than a
 *                            shared one that corrupts every element it merges
 *
 * Rule 1 is byte-identical to the old key, so named elements — the overwhelming
 * majority, and every element the system reasons about well — dedupe exactly as
 * before. Only the unnamed ones change behaviour.
 */

export interface SelectorIdentityInput {
  role?: string | null;
  name?: string | null;
  frameHint?: string | null;
  testId?: string | null;
  css?: string | null;
}

/**
 * The dedupe key, or `null` when the element cannot be identified at all.
 *
 * A `null` return is meaningful and must not be papered over: it means "do not
 * write a selector row for this". The step still executes — its addressing
 * lives in `steps.args` (nth, hasText) — it simply does not claim to be a
 * known, health-tracked element, because it is not one.
 */
export function selectorIdentity(el: SelectorIdentityInput): string | null {
  const role = el.role ?? '';
  const name = el.name ?? '';
  const frame = el.frameHint ?? '';

  if (name) return `${role}|${name}|${frame}`;
  if (el.testId) return `${role}|${frame}|#testid:${el.testId}`;
  if (el.css) return `${role}|${frame}|#css:${el.css}`;
  return null;
}
