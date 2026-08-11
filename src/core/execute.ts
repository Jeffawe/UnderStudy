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
import type { Plan } from './plan.js';
import { lessonsFor, markApplied } from './lessons.js';

interface StepRow {
  action: string;
  role: string | null;
  name: string | null;
  test_id: string | null;
  css: string | null;
  frame_hint: string | null;
  value_ref: string | null;
  args: Record<string, unknown>;
  semantic: string;
  state_after: string | null;
}

/**
 * Reconstruct the IR for a flow, in order.
 *
 * The inverse of ingest: `args.value` holds the literal that was typed,
 * `value_ref` holds the reference to something we deliberately never stored.
 */
async function eventsForFlow(flowId: string, startingSeq: number): Promise<RawEvent[]> {
  const { rows } = await getPool().query<StepRow>(
    `SELECT s.action, sel.role, sel.name, sel.test_id, sel.css, sel.frame_hint,
            s.value_ref, s.args, s.semantic, s.state_after
     FROM flow_steps fs
     JOIN steps s ON s.step_id = fs.step_id
     LEFT JOIN selectors sel ON sel.selector_id = s.selector_id
     WHERE fs.flow_id = $1
     ORDER BY fs.ordinal`,
    [flowId],
  );

  return rows.map((r, i) => {
    const args = (r.args ?? {}) as Record<string, unknown>;
    const literal = typeof args.value === 'string' ? args.value : undefined;

    return {
      seq: startingSeq + i,
      ts: startingSeq + i,
      action: r.action as RawEvent['action'],
      // '' is how the schema encodes "no role/name" — turn it back into absence
      // so the locator builder falls through to test id or css.
      ...(r.role ? { role: r.role } : {}),
      ...(r.name ? { name: r.name } : {}),
      ...(literal !== undefined ? { value: literal } : {}),
      ...(r.value_ref ? { valueRef: r.value_ref } : {}),
      ...(r.test_id ? { testId: r.test_id } : {}),
      ...(args.testIdAttr ? { testIdAttr: String(args.testIdAttr) } : {}),
      ...(r.css ? { css: r.css } : {}),
      ...(r.frame_hint ? { frameHint: r.frame_hint } : {}),
      ...(args.exact ? { exact: true } : {}),
      ...(typeof args.nth === 'number' ? { hints: { nth: args.nth } } : {}),
      // state_after is the fingerprint this step PRODUCED when recorded — an
      // expectation, not a URL. It was being loaded and then assigned to `url`,
      // which threw the expectation away and put a sig where a URL belongs.
      ...(r.state_after ? { expectedSig: r.state_after } : {}),
      url: '',
      resolution: 'accname' as const,
    };
  });
}

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
    if (seam && seam.kind === 'unresolved') {
      throw new Error(
        `refusing to execute: unresolved seam ${seam.from} -> ${seam.to} (${seam.detail})`,
      );
    }
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
    for (const e of flowEvents) {
      if (!isFirst && e.action === 'goto') continue;
      events.push({ ...e, seq: events.length, ts: events.length });
    }
    flowsRun.push(sub.bound.slug);
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
  // trigger attached, and only the ratio shows that.
  for (const step of result.steps) {
    if (!step.lessonsApplied?.length) continue;
    await markApplied(step.lessonsApplied.map((l) => l.lessonId), step.ok);
  }

  return { result, recording, flowsRun };
}
