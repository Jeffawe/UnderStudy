/**
 * Does running this flow commit something real — a purchase, a deletion?
 *
 * Inferred from evidence, never asked. It FAILS OPEN: no signal means not
 * destructive. A false positive only blocks a harmless test until someone says
 * it's fine; asking about every flow is how a tool gets switched off.
 *
 * Two signals today, both readable from the steps alone:
 *   1. a control whose name commits something ("Place order", "Delete")
 *   2. the flow reaches a payment provider's site
 * The old version had three more that need stored knowledge (exploration
 * boundaries, facts, other destructive flows). They return with the safety
 * gate in phase 3 — see `git show legacy-cockroach:src/core/destructive.ts`.
 */

import type { Step } from '../store/types.js';

const COMMIT_WORDS =
  /\b(pay|purchase|buy|place order|order now|checkout|check out|confirm|delete|remove account|reset|deactivate|destroy|publish|subscribe|charge|submit order)\b/i;

const PAYMENT_HOSTS =
  /(^|\.)(stripe|paypal|braintree|adyen|checkout|squareup|klarna|worldpay|authorize)\.(com|net|io)$/i;

/**
 * Only these actions can commit anything. Typing into "Confirm password" or
 * ticking "Delete my data after 30 days" doesn't; clicking "Confirm" does.
 * (The old version judged every step, so a "Confirm password" field marked a
 * whole signup flow destructive.)
 */
const COMMITTING_ACTIONS = new Set(['click', 'press', 'dispatch_click']);

/** Why this step is destructive, or null if nothing says it is. */
export function destructiveReason(step: Pick<Step, 'action' | 'name' | 'url'>): string | null {
  const name = (step.name ?? '').trim();
  if (name && COMMITTING_ACTIONS.has(step.action) && COMMIT_WORDS.test(name)) {
    return `commit-shaped control "${name}"`;
  }
  try {
    const host = new URL(step.url).hostname;
    if (PAYMENT_HOSTS.test(host)) return `reaches payment site ${host}`;
  } catch {
    // not a URL we can judge
  }
  return null;
}

/** The first reason any step in the flow is destructive, or null. */
export function flowDestructiveReason(steps: Pick<Step, 'action' | 'name' | 'url'>[]): string | null {
  for (const [i, s] of steps.entries()) {
    const why = destructiveReason(s);
    if (why) return `step ${i}: ${why}`;
  }
  return null;
}
