/**
 * Execution — run a plan.
 *
 * THERE IS ONE EXECUTOR, NOT TWO.
 *
 * Replaying a recording and running a bound plan are the same operation:
 * resolve a locator, act, settle, fingerprint, capture signals. So rather than
 * writing a second step walker that would drift from the first, this
 * reconstructs IR steps out of the database into exactly the shape `replay()`
 * already consumes, and hands them over.
 *
 * The practical payoff is that everything replay learned the hard way —
 * ambiguity detection, the testIdAttr fix, settle-before-fingerprint, the
 * round-trip assertion, signal correlation by step — applies to real execution
 * for free, and cannot rot separately.
 */

import { getPool } from './db.js';
import { replay, type ReplayOptions, type ReplayResult } from './replay.js';
import { buildRecording, type RawEvent, type RawRecording } from './recording.js';
import { eventsForFlow } from './flow-ir.js';
import type { Plan } from './plan.js';
import { lessonsFor, foldLessonOutcomes } from './lessons.js';

export interface ExecuteResult {
  result: ReplayResult;
  /** The synthesized recording that was executed — useful for emitting code. */
  recording: RawRecording;
  flowsRun: string[];
}

/**
 * Splice the plan's bound flows into one runnable sequence and execute it.
 *
 * Refuses a blocked or partially-bound plan rather than running the part it
 * understands: a half-executed plan leaves the app in a state nobody asked
 * for, which is worse than not starting.
 */
export async function executePlan(
  plan: Plan,
  startUrl: string,
  appSlug: string,
  opts: ReplayOptions = {},
): Promise<ExecuteResult> {
  if (plan.blocked) throw new Error(`refusing to execute: ${plan.blocked}`);
  if (plan.unbound.length) {
    throw new Error(
      `refusing to execute: ${plan.unbound.length} sub-goal(s) bound to nothing (${plan.unbound.join('; ')})`,
    );
  }

  const events: RawEvent[] = [];
  const flowsRun: string[] = [];

  // Seams are indexed by the flow they lead INTO, so a bridge is spliced
  // immediately before its destination.
  const seamBefore = new Map<string, (typeof plan.seams)[number]>();
  for (const seam of plan.seams) seamBefore.set(seam.to, seam);

  for (const sub of plan.subGoals) {
    if (!sub.bound) continue;

    // A seam that could not be resolved must NOT be executed through. Running
    // the two halves back to back would start the second flow from a state it
    // was never recorded in — which is how a plan quietly does the wrong thing
    // rather than failing.
    const seam = seamBefore.get(sub.bound.slug);

    // AN UNRESOLVED SEAM USED TO THROW HERE, while events were still being
    // ASSEMBLED — before any browser existed. That is why it could only ever
    // fail the run: there was no live state to hand anyone.
    //
    // Marking the destination's first step instead defers the same refusal to
    // run time, where the executor is sitting on a real page and can ask a
    // human to record the bridge. Nothing is loosened: with no handoff wired
    // the step still fails, which is the old behaviour with a better message.
    // `hints` is free-form and survives splicing, so this needs no new action
    // and no schema CHECK change.
    const gapBefore =
      seam && seam.kind === 'unresolved'
        ? { from: seam.from, to: seam.to, detail: seam.detail }
        : undefined;

    if (seam?.steps.length) {
      for (const e of seam.steps) {
        events.push({ ...e, seq: events.length, ts: events.length });
      }
    }

    const flowEvents = await eventsForFlow(sub.bound.flowId, events.length);

    // A bound flow that begins with its own `goto` is self-contained. Splicing
    // a second one mid-plan would throw away the state the previous flow just
    // established — the seam already told us whether that is needed.
    const isFirst = events.length === 0;
    let firstOfFlow = true;
    for (const e of flowEvents) {
      if (!isFirst && e.action === 'goto') continue;
      events.push({
        ...e,
        seq: events.length,
        ts: events.length,
        ...(firstOfFlow && gapBefore
          ? { hints: { ...(e.hints ?? {}), seamGapBefore: gapBefore } }
          : {}),
      });
      firstOfFlow = false;
    }
    flowsRun.push(sub.bound.slug);

    // A VISUAL CHECKPOINT AT EVERY SEGMENT BOUNDARY.
    //
    // Recorded checkpoints only exist where whoever wrote the original spec
    // happened to put one, so a novel composition could run end to end with no
    // visual coverage at all — and a novel composition is exactly the case
    // nobody has ever looked at.
    //
    // The boundary is the right place, and one shot per segment is the right
    // density. A segment already IS the unit of reuse and its end already IS a
    // state boundary as far as sig() is concerned; shooting every step instead
    // would produce sixty images and drown the judge.
    //
    // KEYED BY SLUG, which is what makes the baseline reusable: every goal that
    // ends up running `provide-shipping-address` compares against the same
    // reference, no matter which flow it was spliced into. Visual memory then
    // belongs to the segment, exactly as step memory does.
    if (opts.visualCheck && events[events.length - 1]?.action !== 'snapshot') {
      // Skipped when the segment already ends in a recorded checkpoint —
      // shooting the same page twice teaches nothing and costs a settle.
      const last = events[events.length - 1];
      events.push({
        seq: events.length,
        ts: events.length,
        action: 'snapshot',
        value: sub.bound.slug,
        url: last?.url ?? startUrl,
        resolution: 'synthesized',
      });
    }
  }

  const recording = buildRecording(
    { source: 'import', origin: `plan:${plan.goal}`, appSlug, startUrl },
    events,
  );

  const result = await replay(recording, {
    ...opts,
    // Bind lesson lookup to this app. replay stays ignorant of the database.
    lessonsFor: opts.lessonsFor ?? ((context) => lessonsFor(plan.appId, context)),
  });

  // Bookkeeping: a lesson that fires constantly and never helps is noise with a
  // trigger attached, and only the ratio shows that. Shared with the CLI replay
  // paths — this loop used to live only here, which is why lessons fired during
  // a verification replay were never counted.
  await foldLessonOutcomes(plan.appId, result.steps, recording.events);

  return { result, recording, flowsRun };
}
