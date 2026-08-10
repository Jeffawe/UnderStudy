/**
 * Flow drift — did this run take a different path than it used to?
 *
 * Every run records its sequence of page fingerprints. Compare against previous
 * runs of the same goal:
 *
 *   run 47:  /login -> /inventory -> /cart -> /checkout-one -> /complete
 *   run 52:  /login -> /inventory -> /cart -> /promo-upsell -> /checkout-one -> /complete
 *                                             ^^^^^^^^^^^^^ never seen before
 *
 * A TEXT DIFF. No model, no pixels. Visual drift is explicitly out of scope;
 * this is structural, over sigs.
 *
 * A conventional suite cannot do this at all — it has no memory of what the
 * flow looked like last week. The page graph is that memory, and `sig_sequence`
 * is the record. Until now it was write-only: recorded on every run and never
 * once read back.
 *
 * DETECTION IS FREE, JUDGEMENT IS THE REASONER. Drift is reported as a fact —
 * a new step in a checkout could be a bug or could be a feature shipped on
 * purpose, and deciding which is not something arithmetic can do.
 */

import { createHash } from 'node:crypto';
import { getPool } from './db.js';

export interface DriftStep {
  change: 'same' | 'added' | 'removed' | 'changed';
  sig: string;
  /** The sig this replaced, when change is 'changed'. */
  was?: string;
}

/** `/inventory.html#bf3dd322` -> `/inventory.html`. */
const patternOf = (sig: string) => sig.slice(0, sig.lastIndexOf('#')) || sig;

/**
 * Collapse a removed+added pair on the SAME page into one 'changed' entry.
 *
 * sig() is state-granular by design: `/inventory.html` has four sigs in this
 * corpus alone (empty cart, one item, menu open, …). A raw sig diff therefore
 * reports an ordinary state difference as "a page disappeared and a different
 * one appeared", which is both noisy and wrong about what happened. A page that
 * genuinely never existed before is a different and much more interesting
 * event than the same page in another state.
 */
function collapseSamePage(diff: DriftStep[]): DriftStep[] {
  const out: DriftStep[] = [];
  for (let i = 0; i < diff.length; i++) {
    const a = diff[i]!;
    const b = diff[i + 1];
    const pair =
      b &&
      ((a.change === 'removed' && b.change === 'added') ||
        (a.change === 'added' && b.change === 'removed')) &&
      patternOf(a.sig) === patternOf(b.sig);

    if (pair) {
      const removed = a.change === 'removed' ? a : b!;
      const added = a.change === 'added' ? a : b!;
      out.push({ change: 'changed', sig: added.sig, was: removed.sig });
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export interface Drift {
  goal: string;
  /** Runs compared against, newest first. */
  baselineRuns: number;
  current: string[];
  baseline: string[];
  changed: boolean;
  /** The aligned diff, for display. */
  diff: DriftStep[];
  /** Pages that never appeared in any recent run. The interesting case. */
  added: string[];
  /** Pages that every recent run had and this one did not. */
  removed: string[];
  /** Same page, different state — lower signal than added/removed. */
  stateChanged: string[];
  /** True when this goal has no history yet — not drift, just a first run. */
  firstRun: boolean;
}

/**
 * Longest-common-subsequence diff over two sig sequences.
 *
 * Subsequence rather than substring here, unlike macro mining: a drift diff is
 * for a human to READ, and alignment across an inserted step is exactly what
 * makes "one new page appeared in the middle" legible. Macros needed contiguity
 * because they must be runnable; a diff has no such constraint.
 */
function diffSequences(baseline: string[], current: string[]): DriftStep[] {
  const n = baseline.length;
  const m = current.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = baseline[i] === current[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
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
      out.push({ change: 'removed', sig: baseline[i]! });
      i++;
    } else {
      out.push({ change: 'added', sig: current[j]! });
      j++;
    }
  }
  while (i < n) out.push({ change: 'removed', sig: baseline[i++]! });
  while (j < m) out.push({ change: 'added', sig: current[j++]! });
  return out;
}

/**
 * Compare a run's path against the last N runs of the same goal.
 *
 * The baseline is the most recent PASSED run: comparing against a failure would
 * report the failure's truncated path as "removed steps", which is noise rather
 * than drift.
 */
export async function detectDrift(
  appId: string,
  goal: string,
  current: string[],
  opts: { runId?: string; lookback?: number } = {},
): Promise<Drift> {
  const { rows } = await getPool().query<{ sig_sequence: string[] }>(
    `SELECT sig_sequence FROM runs
     WHERE app_id = $1 AND goal = $2 AND status = 'passed'
       AND ($3::UUID IS NULL OR run_id <> $3::UUID)
     ORDER BY started_at DESC
     LIMIT $4`,
    [appId, goal, opts.runId ?? null, opts.lookback ?? 5],
  );

  const histories = rows
    .map((r) => (Array.isArray(r.sig_sequence) ? r.sig_sequence : []))
    .filter((h) => h.length > 0);

  if (!histories.length) {
    return {
      goal,
      baselineRuns: 0,
      current,
      baseline: [],
      changed: false,
      diff: current.map((sig) => ({ change: 'same' as const, sig })),
      added: [],
      removed: [],
      stateChanged: [],
      firstRun: true,
    };
  }

  const baseline = histories[0]!;
  const diff = collapseSamePage(diffSequences(baseline, current));

  // Only report a sig as genuinely new if NO recent run has taken it — a flow
  // that legitimately alternates between two paths should not drift every time.
  //
  // Applied SYMMETRICALLY. Filtering `added` but not `removed` made alternation
  // handling one-directional: A->B->C after a baseline of A->C reported nothing,
  // but A->C after A->B->C reported B as removed. Same alternation, drift in
  // only one direction.
  const everSeen = new Set(histories.flat());
  const seenInAll = (sig: string) => histories.every((h) => h.includes(sig));

  const added = diff.filter((d) => d.change === 'added' && !everSeen.has(d.sig)).map((d) => d.sig);
  const removed = diff.filter((d) => d.change === 'removed' && seenInAll(d.sig)).map((d) => d.sig);
  const changed = diff
    .filter((d) => d.change === 'changed' && !everSeen.has(d.sig))
    .map((d) => d.sig);

  return {
    goal,
    baselineRuns: histories.length,
    current,
    baseline,
    changed: added.length > 0 || removed.length > 0 || changed.length > 0,
    diff,
    added,
    removed,
    stateChanged: changed,
    firstRun: false,
  };
}

/**
 * Record drift as a finding, so it accumulates and can be triaged like any
 * other "X is wrong" — or dismissed as an intentional change.
 */
export async function recordDrift(
  appId: string,
  drift: Drift,
  runId?: string,
): Promise<{ written: boolean; occurrences: number }> {
  if (!drift.changed) return { written: false, occurrences: 0 };

  const statement =
    `flow for "${drift.goal}" changed path` +
    (drift.added.length ? `; new: ${drift.added.join(', ')}` : '') +
    (drift.removed.length ? `; gone: ${drift.removed.join(', ')}` : '') +
    (drift.stateChanged.length ? `; different state: ${drift.stateChanged.join(', ')}` : '');

  // Fingerprint on WHAT changed, not on the whole path, so a recurring drift
  // accumulates instead of minting a finding every run.
  //
  // HASHED, not truncated. Slicing to 60 chars put the goal first and the
  // discriminating part last, so any goal longer than ~55 characters had its
  // added/removed list cut off entirely and every distinct drift on that goal
  // collided into one finding.
  const fingerprint = createHash('sha1')
    .update(['drift', drift.goal, ...[...drift.added, ...drift.removed, ...drift.stateChanged].sort()].join('|'))
    .digest('hex')
    .slice(0, 20);

  const { rows } = await getPool().query<{ occurrences: number }>(
    `INSERT INTO findings (app_id, kind, severity, statement, evidence, fingerprint,
                           first_run_id, last_run_id)
     VALUES ($1,'flow_drift',$6,$2,$3,$4,$5,$5)
     ON CONFLICT (app_id, fingerprint) DO UPDATE
       SET occurrences = findings.occurrences + 1,
           last_run_id = excluded.last_run_id,
           last_seen_at = now(),
           evidence = excluded.evidence
     RETURNING occurrences`,
    [
      appId,
      statement,
      JSON.stringify({
        baseline: drift.baseline,
        current: drift.current,
        added: drift.added,
        removed: drift.removed,
        stateChanged: drift.stateChanged,
      }),
      fingerprint,
      runId ?? null,
      // A page nobody has ever seen is a bigger deal than the same page in a
      // different state.
      drift.added.length || drift.removed.length ? 'medium' : 'low',
    ],
  );

  return { written: true, occurrences: rows[0]?.occurrences ?? 1 };
}
