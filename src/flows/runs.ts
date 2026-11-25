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
import { stepFingerprint } from '../core/fingerprint.js';

/** `/inventory.html#bf3dd322` → `/inventory.html` */
const pageOf = (sig: string) => sig.slice(0, sig.lastIndexOf('#')) || sig;

/** How many recent passed runs drift compares with. */
const LOOKBACK = 5;

export interface RecordedRun {
  runId: ObjectId;
  drift: Drift;
  findings: FindingDraft[];
  /** It passed on a changed path: kept out of history until that's accepted. */
  pending?: true;
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
  /** The flows run, in order, when it was more than one. Defaults to [flow]. */
  plan?: string[];
  /**
   * A flow in this run is unproven. If the run fails, what it saw may come from
   * the recording being wrong (landing on a page the flow never meant to), not
   * the app — its findings say so.
   */
  unproven?: boolean;
  /** Fill in this existing run (one that was planned first) instead of adding a new one. */
  runId?: ObjectId;
  startedAt?: Date;
  /** Where each flow of the plan starts in the steps. Defaults to [0]. */
  starts?: number[];
}): Promise<RecordedRun> {
  const { app, flow, result, steps } = opts;
  const plan = opts.plan ?? [flow];
  const c = await collections();
  const now = new Date();

  // 1. Drift, against the most recent passed runs of this flow — however it
  // was started, it walked the same steps.
  const history = await c.runs
    .find({ app, plan, mode: { $in: ['replay', 'run'] }, status: 'passed', stoppedBefore: { $exists: false }, accepted: { $ne: false }, ...(opts.runId ? { _id: { $ne: opts.runId } } : {}) }, { projection: { sigSequence: 1 } })
    .sort({ startedAt: -1 })
    .limit(LOOKBACK)
    .toArray();
  // A failed run stops early; comparing its short path would report every
  // page it never reached as "gone", which is noise, not drift.
  // A run that stopped before its commit step is just as short, on purpose.
  const drift: Drift = !result.ok
    ? { ...compareToHistory([], []), firstRun: false, notCompared: 'the run failed, so its path is incomplete' }
    : result.stoppedBefore !== undefined
      ? { ...compareToHistory([], []), firstRun: false, notCompared: `it stopped before step ${result.stoppedBefore}, its commit, so its path is incomplete` }
      : compareToHistory(result.sigSequence, history.map((h) => h.sigSequence));

  // 2. Findings.
  const name = plan.join(' + ');
  const drafts = extractFindings(result, name);
  if (opts.unproven && !result.ok) {
    for (const d of drafts) d.evidence = { ...d.evidence, fromUnprovenFlow: 'a failed run of an unproven flow — may be the recording, not the app' };
  }
  const fromDrift = driftFinding(name, drift);
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

  // 4. The run. One whose path changed waits to be accepted before it
  // counts as history — see Run.accepted.
  const changedPath = result.ok && !drift.firstRun && (drift.changed || result.steps.some((s) => s.unexpectedPage));
  const run: Run = {
    app,
    goal: opts.goal ?? flow,
    mode: opts.mode ?? 'replay',
    status: result.ok ? 'passed' : 'failed',
    plan,
    steps: result.steps.map((s) => {
      const step = steps[s.seq];
      return {
        seq: s.seq, action: s.action, ok: s.ok,
        ...(s.sig ? { sig: s.sig } : {}),
        ...(s.error ? { error: s.error } : {}),
        // Identifies "this kind of step" across runs — how a lesson knows a step like it has failed before.
        ...(step ? { fingerprint: stepFingerprint({ ...step, seq: s.seq, ts: 0 }) } : {}),
      };
    }),
    sigSequence: result.sigSequence,
    ...(result.stoppedBefore !== undefined ? { stoppedBefore: result.stoppedBefore } : {}),
    ...(changedPath ? { accepted: false as const } : {}),
    starts: opts.starts ?? [0],
    events: result.signals.slice(0, 200).map((s) => ({ ...s })),
    findings: drafts.map((d) => d.fingerprint),
    durationMs: result.durationMs,
    startedAt: opts.startedAt ?? new Date(now.getTime() - result.durationMs),
    endedAt: now,
  };
  if (opts.runId) {
    // A planned run: keep its question history and planning, add what happened.
    await c.runs.updateOne({ _id: opts.runId }, { $set: run, $unset: { question: '' } });
    return { runId: opts.runId, drift, findings: drafts, ...(changedPath ? { pending: true as const } : {}) };
  }
  const { insertedId } = await c.runs.insertOne(run);
  return { runId: insertedId, drift, findings: drafts, ...(changedPath ? { pending: true as const } : {}) };
}

/**
 * A changed path was triaged `expected`: the runs that took it join the
 * history, and the newest one's pages become what each of its flows expects
 * step by step — so the change is accepted once, not flagged on every run.
 */
export async function acceptPaths(app: string, fingerprints: string[]): Promise<{ runs: number; flows: string[] }> {
  if (!fingerprints.length) return { runs: 0, flows: [] };
  const c = await collections();
  const pending = await c.runs.find({ app, accepted: false, findings: { $in: fingerprints } }).sort({ startedAt: 1 }).toArray();
  if (!pending.length) return { runs: 0, flows: [] };
  await c.runs.updateMany({ _id: { $in: pending.map((r) => r._id!) } }, { $unset: { accepted: '' } });

  const newest = pending.at(-1)!;
  const updated: string[] = [];
  for (const [i, slug] of newest.plan.entries()) {
    const flow = await c.flows.findOne({ app, slug });
    if (!flow) continue;
    const start = newest.starts?.[i] ?? 0;
    const sigAt = new Map(newest.steps.filter((s) => s.sig).map((s) => [s.seq - start, s.sig!]));
    const steps = flow.steps.map((s, j) => (sigAt.has(j) ? { ...s, expectedSig: sigAt.get(j)! } : s));
    const last = sigAt.get(flow.steps.length - 1);
    await c.flows.updateOne({ _id: flow._id! }, { $set: { steps, ...(last ? { endState: last } : {}), updatedAt: new Date() } });
    updated.push(slug);
  }
  return { runs: pending.length, flows: updated };
}
