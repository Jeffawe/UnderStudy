/**
 * Planning a goal that may need several flows, pausing to ask an agent when
 * it can't decide alone.
 *
 *   start(goal) ─▶ decompose? ─▶ bind each sub-goal ─▶ safety ─▶ seams ─▶ planned
 *                   (ask)          (recall)                       (ask if stuck)
 *
 * Every question is asked BEFORE a browser opens. Once a plan is complete it
 * runs to the end without pausing; anything odd on the way becomes a finding.
 * So a paused run holds nothing open: its progress lives on its run document,
 * and `answer()` picks it up from there.
 *
 * Questions:
 *   decompose  { subGoals: ["log in as a member", "open the cart"] }
 *   seam       { steps: [{ action: "click", role: "link", name: "Cart" }] }  — or [] if unknown
 */

import { ObjectId } from 'mongodb';
import { collections } from '../store/db.js';
import type { Flow, Run, Step } from '../store/types.js';
import { recall, type FlowMatch } from '../memory/recall.js';
import { vocabulary } from '../memory/vocabulary.js';
import { destructiveControls } from '../memory/notes.js';
import { resolveSeam, acceptSeamAnswer } from './seams.js';
import type { RawRecording } from '../core/recording.js';
import { execute } from '../flows/execute.js';
import { recordRun } from '../flows/runs.js';

export interface PlanRequest {
  app: string;
  goal: string;
  /** Supply the split yourself and skip the decompose question. */
  subGoals?: string[];
  dryRun?: boolean;
  allowPurchases?: boolean;
}

export type PlanState =
  | { status: 'waiting'; runId: string; question: Record<string, unknown> }
  | { status: 'blocked'; runId: string; why: string; detail?: unknown }
  | { status: 'planned'; runId: string; plan: string[]; seams: { before: string; how: string }[]; dryRun: boolean };

const DECOMPOSE_HOW = [
  'Split the goal into the things that must HAPPEN, in the order the app does them.',
  'Phrase each sub-goal in the words of a flow listed below — near-verbatim where one does the thing. Each sub-goal is a search.',
  'Include prerequisites the goal leaves implicit (e.g. log in first, if the next flow needs it).',
  'If one recorded flow already covers the whole goal, one sub-goal naming it beats several naming its parts.',
].join(' ');

const SEAM_HOW = [
  'How do you get from where the first flow ends to where the next begins?',
  'Answer { "steps": [...] } with one click ({action:"click",role,name}) or a goto ({action:"goto",url}).',
  'Answer { "steps": [] } unless you actually KNOW — a one-click answer is saved and reused for every future plan, so a guess becomes a wrong fact.',
  'You can check first: open the app, or look at knownLinksFromHere.',
].join(' ');

export async function start(req: PlanRequest): Promise<PlanState> {
  const { runs } = await collections();
  const now = new Date();
  const run: Run = {
    app: req.app, goal: req.goal, mode: 'run', status: 'waiting', plan: [], steps: [], sigSequence: [],
    events: [], findings: [], durationMs: 0, startedAt: now,
    planning: {
      ...(req.subGoals?.length ? { subGoals: req.subGoals } : {}),
      ...(req.dryRun ? { dryRun: true } : {}),
      ...(req.allowPurchases ? { allowPurchases: true } : {}),
    },
  };
  const { insertedId } = await runs.insertOne(run);
  return advance({ ...run, _id: insertedId });
}

/** Answer the run's open question, and carry on planning. */
export async function answer(runId: string, reply: unknown): Promise<PlanState> {
  const { runs, flows } = await collections();
  const run = await runs.findOne({ _id: new ObjectId(runId) });
  if (!run) throw new Error(`no run ${runId}`);
  if (run.status !== 'waiting' || !run.question) throw new Error(`run ${runId} isn't waiting for an answer (it is ${run.status})`);
  const planning = run.planning ?? {};
  const q = run.question as { kind: string; before?: number };

  if (q.kind === 'decompose') {
    const subGoals = (reply as { subGoals?: unknown })?.subGoals;
    if (!Array.isArray(subGoals) || !subGoals.length || subGoals.some((g) => typeof g !== 'string' || !g.trim())) {
      throw new Error('answer must be { "subGoals": ["…", "…"] } — at least one, in order');
    }
    planning.subGoals = subGoals.map((g: string) => g.trim());
  } else if (q.kind === 'seam') {
    const i = q.before!;
    const [from, to] = await Promise.all([
      flows.findOne({ app: run.app, slug: planning.bound![i - 1]! }),
      flows.findOne({ app: run.app, slug: planning.bound![i]! }),
    ]);
    const accepted = await acceptSeamAnswer(run.app, from!, to!, reply);
    if ('problems' in accepted) throw new Error(accepted.problems.join('; '));
    if (!accepted.steps.length) {
      return block(run, `no known way from ${from!.slug} to ${to!.slug} — record the step between them, or plan with different sub-goals`);
    }
    planning.seams = { ...planning.seams, [String(i)]: { steps: accepted.steps, how: 'answered by the agent' } };
  }

  await runs.updateOne({ _id: run._id }, { $set: { planning }, $unset: { question: '' } });
  return advance({ ...run, planning });
}

async function ask(run: Run, question: Record<string, unknown>): Promise<PlanState> {
  const { runs } = await collections();
  await runs.updateOne({ _id: run._id! }, { $set: { status: 'waiting', question, planning: run.planning! } });
  return { status: 'waiting', runId: run._id!.toHexString(), question };
}

async function block(run: Run, why: string, detail?: unknown): Promise<PlanState> {
  const { runs } = await collections();
  await runs.updateOne(
    { _id: run._id! },
    { $set: { status: 'blocked', blockedBecause: why, endedAt: new Date(), planning: run.planning! }, $unset: { question: '' } },
  );
  return { status: 'blocked', runId: run._id!.toHexString(), why, ...(detail ? { detail } : {}) };
}

/** Do as much planning as possible without help; stop at the first question. */
async function advance(run: Run): Promise<PlanState> {
  const planning = (run.planning ??= {});
  const { flows } = await collections();

  // 1. Split the goal.
  if (!planning.subGoals) {
    return ask(run, { kind: 'decompose', goal: run.goal, how: DECOMPOSE_HOW, vocabulary: await vocabulary(run.app) });
  }

  // 2. Bind each sub-goal to the flow that does it. Only a KNOWN match binds.
  if (!planning.bound) {
    const bound: string[] = [];
    for (const sub of planning.subGoals) {
      const r = await recall(run.app, sub);
      if (r.verdict !== 'known' || !r.best) {
        const close = r.flows.slice(0, 3).map((f: FlowMatch) => ({ slug: f.slug, title: f.title, score: Number(f.score.toFixed(3)) }));
        return block(run, `no flow clearly does "${sub}" (${r.why}) — rephrase it in the app's words, or record it`, { subGoal: sub, closest: close });
      }
      // Two sub-goals that bind the same flow back to back are one step of the plan.
      if (bound.at(-1) !== r.best.slug) bound.push(r.best.slug);
    }
    planning.bound = bound;
  }

  const plan = await Promise.all(planning.bound.map((slug) => flows.findOne({ app: run.app, slug })));
  if (plan.some((f) => !f)) return block(run, 'a bound flow no longer exists — plan again');
  const chain = plan as Flow[];

  // 3. Safety: refuse anything that commits something real, unless allowed.
  if (!planning.allowPurchases) {
    const risky = chain.find((f) => f.destructive);
    if (risky) return block(run, `${risky.slug} is destructive (${risky.destructiveBecause}) — allow purchases to run it`);
    const controls = await destructiveControls(run.app);
    for (const f of chain) {
      const hit = f.steps.find((s) => s.name && ['click', 'press', 'dispatch_click'].includes(s.action) && controls.has(s.name.toLowerCase()));
      if (hit) return block(run, `${f.slug} clicks "${hit.name}", which a fact says commits something real: ${controls.get(hit.name!.toLowerCase())}`);
    }
  }

  // 4. The first flow must be able to start from a cold browser (or a saved session).
  const first = chain[0]!;
  if (first.preconditions.includes('authenticated') && !first.requiresSession) {
    return block(run, `${first.slug} needs a signed-in browser — add a sub-goal that logs in, before it`);
  }

  // 5. Seams between consecutive flows.
  planning.seams ??= {};
  for (let i = 1; i < chain.length; i++) {
    if (planning.seams[String(i)]) continue;
    const seam = await resolveSeam(run.app, chain[i - 1]!, chain[i]!);
    if (!seam.resolved) {
      return ask(run, { kind: 'seam', before: i, how: SEAM_HOW, ...seam.evidence });
    }
    planning.seams[String(i)] = { steps: seam.steps, how: seam.how };
  }

  // Planned.
  const { runs } = await collections();
  await runs.updateOne({ _id: run._id! }, { $set: { status: 'planned', plan: planning.bound, planning }, $unset: { question: '' } });
  return {
    status: 'planned',
    runId: run._id!.toHexString(),
    plan: planning.bound,
    seams: Object.entries(planning.seams).map(([i, s]) => ({ before: planning.bound![Number(i)]!, how: s.how })),
    dryRun: Boolean(planning.dryRun),
  };
}

/** One recording for the whole plan: each flow's steps, joined by its seam. */
export async function recordingForPlan(runId: string): Promise<{ run: Run; recording: RawRecording; steps: Step[] }> {
  const { runs, flows } = await collections();
  const run = await runs.findOne({ _id: new ObjectId(runId) });
  if (!run || run.status !== 'planned') throw new Error(`run ${runId} isn't planned (it is ${run?.status ?? 'missing'})`);
  const chain = (await Promise.all(run.plan.map((slug) => flows.findOne({ app: run.app, slug })))) as Flow[];
  const first = chain[0]!;

  const steps: Step[] = [];
  chain.forEach((flow, i) => {
    if (i > 0) steps.push(...(run.planning?.seams?.[String(i)]?.steps ?? []));
    // A segment cut from the middle of a recording doesn't open its own page.
    if (i === 0 && flow.steps[0]?.action !== 'goto' && flow.steps[0]?.url) {
      steps.push({ action: 'goto', value: flow.steps[0].url, url: flow.steps[0].url, resolution: 'synthesized' });
    }
    steps.push(...flow.steps);
  });

  const recording: RawRecording = {
    version: 1, source: 'import', origin: `plan:${run.plan.join('+')}`, appSlug: run.app,
    startUrl: first.startUrl, createdAt: new Date().toISOString(), hash: `plan-${runId}`,
    ...(first.requiresSession
      ? { entry: { requiresSession: true, ...(first.startState ? { startState: first.startState } : {}), ...(first.session ? { session: first.session } : {}) } }
      : {}),
    events: steps.map((s, seq) => ({ ...s, seq, ts: seq })),
  };
  return { run, recording, steps };
}

/**
 * Run a planned run: one recording for the whole plan, with lessons, and the
 * outcome written onto the same run document.
 */
export async function runPlan(runId: string, opts: { values?: Record<string, string>; headed?: boolean } = {}) {
  const { run, recording, steps } = await recordingForPlan(runId);
  const executed = await execute(recording, { ...opts, useLessons: true });
  const recorded = await recordRun({
    app: run.app, flow: run.plan.join('+'), plan: run.plan, goal: run.goal, mode: 'run',
    result: executed.result, steps, runId: run._id!,
  });
  return { executed, recorded, plan: run.plan };
}
