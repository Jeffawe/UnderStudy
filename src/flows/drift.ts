/**
 * Flow drift: did this run take a different path through the app than before?
 *
 *   last week:  /login → /inventory → /cart → /checkout → /complete
 *   today:      /login → /inventory → /cart → /promo-upsell → /checkout → /complete
 *                                             ^^^^^^^^^^^^^ never seen before
 *
 * A text diff over page fingerprints — no model, no screenshots. A normal test
 * suite can't do this: it has no memory of what the flow looked like before.
 *
 * Reported as a finding, not a failure: a new page in checkout might be a bug
 * or a feature someone shipped on purpose, and deciding which is a judgement.
 * Ported from the old drift.ts; this file is pure, runs.ts fetches history.
 */

import { createHash } from 'node:crypto';
import type { FindingDraft } from './findings.js';

export interface DriftStep {
  change: 'same' | 'added' | 'removed' | 'changed';
  sig: string;
  /** For 'changed': the sig it replaced. */
  was?: string;
}

export interface Drift {
  /** No earlier passed run to compare with — not drift, just the first time. */
  firstRun: boolean;
  changed: boolean;
  /** Pages no recent run has ever visited. The interesting case. */
  added: string[];
  /** Pages every recent run visited and this one didn't. */
  removed: string[];
  /** Same page, new state (e.g. cart with 2 items instead of 1). Lower signal. */
  stateChanged: string[];
  baseline: string[];
  current: string[];
  diff: DriftStep[];
}

/** `/inventory.html#bf3dd322` → `/inventory.html` */
const pageOf = (sig: string) => sig.slice(0, sig.lastIndexOf('#')) || sig;

/** Longest-common-subsequence diff, so an inserted page lines up legibly. */
function diffSequences(baseline: string[], current: string[]): DriftStep[] {
  const n = baseline.length;
  const m = current.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = baseline[i] === current[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DriftStep[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (baseline[i] === current[j]) {
      out.push({ change: 'same', sig: current[j]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ change: 'removed', sig: baseline[i++]! });
    } else {
      out.push({ change: 'added', sig: current[j++]! });
    }
  }
  while (i < n) out.push({ change: 'removed', sig: baseline[i++]! });
  while (j < m) out.push({ change: 'added', sig: current[j++]! });
  return out;
}

/**
 * A page that was removed and another state of the SAME page added is one
 * change of state, not "a page vanished and a new one appeared".
 */
function collapseSamePage(diff: DriftStep[]): DriftStep[] {
  const out: DriftStep[] = [];
  for (let i = 0; i < diff.length; i++) {
    const a = diff[i]!;
    const b = diff[i + 1];
    const isPair =
      b &&
      ((a.change === 'removed' && b.change === 'added') || (a.change === 'added' && b.change === 'removed')) &&
      pageOf(a.sig) === pageOf(b.sig);
    if (isPair) {
      const [removed, added] = a.change === 'removed' ? [a, b!] : [b!, a];
      out.push({ change: 'changed', sig: added.sig, was: removed.sig });
      i++;
    } else {
      out.push(a);
    }
  }
  return out;
}

/**
 * Compare a path with recent passed runs of the same flow, newest first.
 * Something only counts as new if NO recent run has seen it, so a flow that
 * legitimately alternates between two paths doesn't drift every time.
 */
export function compareToHistory(current: string[], histories: string[][]): Drift {
  const past = histories.filter((h) => h.length > 0);
  if (!past.length) {
    return {
      firstRun: true, changed: false, added: [], removed: [], stateChanged: [],
      baseline: [], current, diff: current.map((sig) => ({ change: 'same' as const, sig })),
    };
  }

  const baseline = past[0]!;
  const diff = collapseSamePage(diffSequences(baseline, current));
  const everSeen = new Set(past.flat());
  const seenInAll = (sig: string) => past.every((h) => h.includes(sig));

  const added = diff.filter((d) => d.change === 'added' && !everSeen.has(d.sig)).map((d) => d.sig);
  const removed = diff.filter((d) => d.change === 'removed' && seenInAll(d.sig)).map((d) => d.sig);
  const stateChanged = diff.filter((d) => d.change === 'changed' && !everSeen.has(d.sig)).map((d) => d.sig);

  return {
    firstRun: false,
    changed: added.length + removed.length + stateChanged.length > 0,
    added, removed, stateChanged, baseline, current, diff,
  };
}

/** Drift as a finding, fingerprinted on WHAT changed so a recurring drift accumulates. */
export function driftFinding(flow: string, drift: Drift): FindingDraft | null {
  if (!drift.changed) return null;
  const statement =
    `flow "${flow}" took a different path` +
    (drift.added.length ? `; new: ${drift.added.join(', ')}` : '') +
    (drift.removed.length ? `; gone: ${drift.removed.join(', ')}` : '') +
    (drift.stateChanged.length ? `; different state: ${drift.stateChanged.join(', ')}` : '');
  const what = [...drift.added, ...drift.removed, ...drift.stateChanged].sort();
  return {
    kind: 'flow_drift',
    // A page nobody has seen before matters more than a page in another state.
    severity: drift.added.length || drift.removed.length ? 'medium' : 'low',
    statement,
    evidence: { baseline: drift.baseline, current: drift.current, added: drift.added, removed: drift.removed, stateChanged: drift.stateChanged },
    fingerprint: createHash('sha1').update(['drift', flow, ...what].join('|')).digest('hex').slice(0, 20),
  };
}
