/**
 * Recording what happened when a flow ran.
 *
 * Every replay of a saved flow — including the one that proves it on save —
 * goes through recordRun, which:
 *   1. compares the path taken with recent passed runs   (drift)
 *   2. turns captured errors into findings, deduped       (findings)
 *   3. adds the pages it passed through to the page map   (pages)
 *   4. stores the run itself                              (runs)
 */

import type { ObjectId } from 'mongodb';
import type { ReplayResult } from '../core/replay.js';
import type { Run, Step } from '../store/types.js';
import { collections } from '../store/db.js';
import { compareToHistory, driftFinding, type Drift } from './drift.js';
import { extractFindings, saveFindings, type FindingDraft } from './findings.js';

/** `/inventory.html#bf3dd322` → `/inventory.html` */
const pageOf = (sig: string) => sig.slice(0, sig.lastIndexOf('#')) || sig;

/** How many recent passed runs drift compares with. */
const LOOKBACK = 5;

export interface RecordedRun {
  runId: ObjectId;
  drift: Drift;
  findings: FindingDraft[];
}

export async function recordRun(opts: {
  app: string;
  flow: string;
  result: ReplayResult;
  /** The flow's steps, for naming the links between pages. */
  steps: Step[];
  /** 'replay' when a flow was named; 'run' when it was found from a goal. */
  mode?: 'replay' | 'run';
  /** What was asked for. Defaults to the flow's slug. */
  goal?: string;
  startedAt?: Date;
}): Promise<RecordedRun> {
  const { app, flow, result, steps } = opts;
  const c = await collections();
  const now = new Date();

  // 1. Drift, against the most recent passed runs of this flow — however it
  // was started, it walked the same steps.
  const history = await c.runs
    .find({ app, plan: [flow], mode: { $in: ['replay', 'run'] }, status: 'passed' }, { projection: { sigSequence: 1 } })
    .sort({ startedAt: -1 })
    .limit(LOOKBACK)
    .toArray();
  // A failed run stops early; comparing its short path would report every
  // page it never reached as "gone", which is noise, not drift.
  const drift = result.ok
    ? compareToHistory(result.sigSequence, history.map((h) => h.sigSequence))
    : compareToHistory([], []);

  // 2. Findings.
  const drafts = extractFindings(result, flow);
  const fromDrift = driftFinding(flow, drift);
  if (fromDrift) drafts.push(fromDrift);
  await saveFindings(c.findings, app, drafts, now);

  // 3. Pages, and the control that led from one to the next.
  let prev: string | undefined;
  for (const outcome of result.steps) {
    const sig = outcome.sig;
    if (!sig) continue;
    const step = steps[outcome.seq];
    const via = step?.role && step.name ? { role: step.role, name: step.name } : undefined;
    await c.pages.updateOne(
      { app, sig },
      { $set: { lastSeen: now }, $setOnInsert: { app, sig, urlPattern: pageOf(sig), links: [], firstSeen: now } },
      { upsert: true },
    );
    // A link belongs to the page it leaves FROM: "on prev, clicking `via` leads to sig".
    if (prev && prev !== sig && via) {
      await c.pages.updateOne({ app, sig: prev }, { $addToSet: { links: { to: sig, via } } });
    }
    prev = sig;
  }

  // 4. The run.
  const run: Run = {
    app,
    goal: opts.goal ?? flow,
    mode: opts.mode ?? 'replay',
    status: result.ok ? 'passed' : 'failed',
    plan: [flow],
    steps: result.steps.map((s) => ({
      seq: s.seq, action: s.action, ok: s.ok,
      ...(s.sig ? { sig: s.sig } : {}),
      ...(s.error ? { error: s.error } : {}),
    })),
    sigSequence: result.sigSequence,
    events: result.signals.slice(0, 200).map((s) => ({ ...s })),
    findings: drafts.map((d) => d.fingerprint),
    durationMs: result.durationMs,
    startedAt: opts.startedAt ?? new Date(now.getTime() - result.durationMs),
    endedAt: now,
  };
  const { insertedId } = await c.runs.insertOne(run);
  return { runId: insertedId, drift, findings: drafts };
}
