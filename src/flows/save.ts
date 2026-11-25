/**
 * Saving a recording as a flow — turning a capture into memory.
 *
 * The recording must have replayed cleanly first (the caller proves it), so
 * what's stored is a flow that is known to work, not a story about one. Each
 * step keeps the page it landed on during that proof as its `expectedSig`,
 * which is how a later replay notices it ended up somewhere unexpected.
 *
 * Saving the same name again replaces the flow — re-record, re-save, done.
 */

import type { RawRecording } from '../core/recording.js';
import type { ReplayResult } from '../core/replay.js';
import type { Flow, Step } from '../store/types.js';
import { collections, ensureSchema } from '../store/db.js';
import { embed, embedderConfig } from '../store/embed.js';
import { commitSteps, flowDestructiveReason, type CommitStep } from './destructive.js';
import { execute, prove, type Executed, type Proven } from './execute.js';
import { destructiveControls } from '../memory/notes.js';
import { forgetSessionById } from '../core/auth-cache.js';
import { recordRun, type RecordedRun } from './runs.js';
import { applyPlaceholders, type Applied } from '../memory/placeholders.js';

/** "Log in as a member!" → "log-in-as-a-member" */
export function slugify(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/**
 * The page a step really ran on, when the replay saw it and the step's own
 * `url` is only a guess. A script is read without running it, so each of its
 * steps carries the address of the last `goto` before it — "Pay Now" stamped
 * with the page three clicks earlier. That address feeds the step's
 * fingerprint, the payment-site check and seam questions, so the first replay
 * that sees the truth replaces it. Recorded steps already have the truth.
 */
function observedUrl(step: Pick<Step, 'action' | 'resolution'>, at: string | undefined): string | undefined {
  return at && step.resolution === 'script-literal' && step.action !== 'goto' ? at : undefined;
}

/** A recording's events, as the steps of a flow. Drops recorder bookkeeping and empty fields. */
export function stepsFrom(recording: RawRecording, result?: ReplayResult): Step[] {
  const observed = new Map(result?.steps.map((s) => [s.seq, s]));
  return recording.events.map((e) => {
    const { seq, ts, ...rest } = e;
    const step = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Step;
    const outcome = observed.get(seq);
    if (outcome?.sig) step.expectedSig = outcome.sig;
    const url = observedUrl(step, outcome?.at);
    if (url) step.url = url;
    return step;
  });
}

/** The index of the step a stopped replay stopped before, if it stopped. */
const stoppedAt = (recording: RawRecording, result: ReplayResult) =>
  result.stoppedBefore === undefined ? undefined : recording.events.findIndex((e) => e.seq === result.stoppedBefore);

/** Turn a flow back into a recording that replay can run. */
export function recordingFrom(flow: Flow): RawRecording {
  return {
    version: 1,
    source: 'import',
    origin: `flow:${flow.slug}`,
    appSlug: flow.app,
    startUrl: flow.startUrl,
    createdAt: flow.updatedAt.toISOString(),
    hash: flow.recording,
    ...(flow.requiresSession
      ? { entry: { requiresSession: true, ...(flow.startState ? { startState: flow.startState } : {}), ...(flow.session ? { session: flow.session } : {}) } }
      : {}),
    events: flow.steps.map((s, i) => ({ ...s, seq: i, ts: i })),
  };
}

export interface SaveOptions {
  title: string;
  /** Defaults to slugify(title). */
  slug?: string;
  /** What the flow is for, if different from the title. */
  intent?: string;
  /** 'agent' when an agent drove it and handed over the script. Default 'user'. */
  madeBy?: 'user' | 'agent';
  /** Set when it's being kept without a passing replay: why. Marks the flow unproven. */
  unproven?: string;
}

export async function saveFlow(recording: RawRecording, result: ReplayResult, opts: SaveOptions): Promise<Flow> {
  await ensureSchema(); // also refuses to mix embedding models
  const { apps, flows } = await collections();
  const app = recording.appSlug;
  const slug = opts.slug ?? slugify(opts.title);
  if (!slug) throw new Error(`can't make a flow name from "${opts.title}" — pass --slug`);

  const steps = stepsFrom(recording, result);
  const why = flowDestructiveReason(steps);
  const upTo = stoppedAt(recording, result);
  const intent = opts.intent ?? opts.title;
  const searchText = [opts.title, intent !== opts.title ? intent : ''].filter(Boolean).join('. ');
  const [embedding] = embedderConfig() ? await embed([searchText], 'document') : [];
  const now = new Date();

  const flow: Omit<Flow, '_id' | 'createdAt'> = {
    app,
    slug,
    title: opts.title,
    intent,
    kind: 'recording',
    madeBy: opts.madeBy ?? 'user',
    preconditions: recording.entry?.requiresSession ? ['authenticated'] : [],
    outcome: '',
    destructive: Boolean(why),
    ...(why ? { destructiveBecause: why } : {}),
    corrections: [],
    recording: recording.hash,
    startUrl: recording.startUrl,
    requiresSession: Boolean(recording.entry?.requiresSession),
    ...(recording.entry?.session ? { session: recording.entry.session } : {}),
    ...(result.sigSequence[0] ? { startState: recording.entry?.startState ?? result.sigSequence[0] } : {}),
    // A replay that stopped before the commit never saw where the flow ends.
    ...(result.sigSequence.length && upTo === undefined ? { endState: result.sigSequence.at(-1)! } : {}),
    ...(upTo !== undefined && !opts.unproven ? { provenUpTo: upTo } : {}),
    steps,
    searchText,
    ...(embedding ? { embedding } : {}),
    ...(opts.unproven ? { proven: false, unprovenBecause: opts.unproven } : {}),
    updatedAt: now,
  };

  // Replace, not merge: a re-saved flow must not keep a stale embedding or
  // destructive mark from the previous version.
  const unset: Record<string, ''> = {};
  if (!embedding) unset.embedding = '';
  if (!why) unset.destructiveBecause = '';
  if (!recording.entry?.session) unset.session = '';
  if (!opts.unproven) { unset.proven = ''; unset.unprovenBecause = ''; }
  if (upTo === undefined || opts.unproven) unset.provenUpTo = '';
  if (upTo !== undefined) unset.endState = '';
  await flows.updateOne(
    { app, slug },
    { $set: flow, $setOnInsert: { createdAt: now }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { upsert: true },
  );

  // Make sure the app exists, remembering where it lives.
  await apps.updateOne(
    { slug: app },
    { $setOnInsert: { slug: app, name: app, urls: { default: new URL(recording.startUrl).origin }, createdAt: now } },
    { upsert: true },
  );

  return (await flows.findOne({ app, slug }))!;
}

export interface ProveAndSave extends SaveOptions {
  /** Login values, if not in the environment as UNDERSTUDY_<REF>. */
  values?: Record<string, string>;
  headed?: boolean;
  /**
   * false: keep it without replaying it — e.g. it ends in a real purchase, or
   * the caller already knows it works. It's saved as unproven; the first run
   * that passes proves it.
   */
  verify?: boolean;
  /** Keep it even though the replay failed (saved as unproven). */
  force?: boolean;
  /** Asked when the replay fails: keep it anyway, as unproven? (The terminal asks the user.) */
  keepIfFailed?: (proven: Proven) => Promise<boolean>;
}

export type SaveOutcome =
  | { saved: false; proven: Proven }
  | { saved: true; verified: boolean; proven?: Proven; flow: Flow; run?: RecordedRun; placeholders: Applied };

/**
 * What `save` does, for the CLI and the MCP server alike: prove the recording
 * (replaying it headless, working out whether it needs to start signed in),
 * then store it as a flow and record that first run. A recording that fails
 * its replay is only kept if the caller says so (force / keepIfFailed), and
 * then as unproven. With verify: false there's no replay at all.
 */
export async function proveAndSave(recording: RawRecording, opts: ProveAndSave): Promise<SaveOutcome> {
  if (opts.verify === false) {
    // No replay, so nothing can say whether a copied sign-in is needed. Unless
    // the user said it is (ticked "I'm signed in here"), don't keep it.
    let rec = recording;
    if (rec.entry?.session && !rec.entry.requiresSession) {
      await forgetSessionById(rec.appSlug, rec.entry.session);
      const { session: _gone, ...rest } = rec.entry;
      rec = { ...rec };
      if (Object.keys(rest).length) rec.entry = rest;
      else delete rec.entry;
    }
    const none = { ok: true, steps: [], sigSequence: [], signals: [], durationMs: 0 } as unknown as ReplayResult;
    const flow = await saveFlow(rec, none, { ...opts, unproven: opts.unproven ?? 'saved without a replay' });
    return { saved: true, verified: false, ...(await withPlaceholders(flow)) };
  }

  // PROVE IT, BUT DON'T BUY ANYTHING. A flow that commits something real is
  // replayed up to its first commit step, whose control is checked and never
  // pressed. Saving used to replay the whole thing, purchase included.
  const commit = await firstStop(recording.appSlug, stepsFrom(recording));
  const proven = await prove(recording, {
    ...(opts.values ? { values: opts.values } : {}), ...(opts.headed ? { headed: true } : {}),
    ...(commit ? { stopBefore: recording.events[commit.index]!.seq } : { endChecks: true }),
  });
  let unproven = opts.unproven;
  if (!proven.result.ok) {
    const keep = opts.force || (opts.keepIfFailed ? await opts.keepIfFailed(proven) : false);
    if (!keep) return { saved: false, proven };
    unproven ??= 'its replay failed, and it was kept anyway';
  }
  const saved = await saveFlow(proven.recording, proven.result, { ...opts, ...(unproven ? { unproven } : {}) });
  const { flow, placeholders } = await withPlaceholders(saved);
  const run = await recordRun({ app: flow.app, flow: flow.slug, result: proven.result, steps: flow.steps, ...(flow.proven === false ? { unproven: true } : {}) });
  return { saved: true, verified: proven.result.ok, proven, flow, run, placeholders };
}

/** The app keeps email fields as placeholders? Convert now — after proving, which used the real address. */
async function withPlaceholders(flow: Flow): Promise<{ flow: Flow; placeholders: Applied }> {
  const placeholders = await applyPlaceholders(flow.app, undefined, flow.slug);
  if (!placeholders.converted.length) return { flow, placeholders };
  return { flow: (await (await collections()).flows.findOne({ _id: flow._id! }))!, placeholders };
}

/**
 * The first step a proof must not do: one that commits something real
 * (counting what facts say), or one only a person can do.
 */
async function firstStop(app: string, steps: Step[]): Promise<CommitStep | undefined> {
  const commit = commitSteps(steps, await destructiveControls(app))[0];
  const human = steps.findIndex((s) => s.action === 'human');
  if (human >= 0 && (!commit || human < commit.index)) {
    return { index: human, reason: `a step only a person can do: ${steps[human]!.value ?? 'unnamed'}` };
  }
  return commit;
}

/**
 * An unproven flow that just passed a run is proven now: mark it, and fill in
 * what its missing replay would have recorded — the page each step lands on,
 * and where it starts and ends. `offset` skips steps the run added in front.
 *
 * A run that stopped before the flow's commit step proves it that far
 * (`provenUpTo`); a full run that passes proves the rest, and clears it.
 */
export async function proveByRun(app: string, slug: string, result: ReplayResult, offset = 0): Promise<boolean> {
  if (!result.ok) return false;
  const { flows } = await collections();
  const flow = await flows.findOne({ app, slug, $or: [{ proven: false }, { provenUpTo: { $exists: true } }] });
  if (!flow) return false;

  const stopped = result.stoppedBefore === undefined ? undefined : result.stoppedBefore - offset;
  // Stopped before this flow began: none of it ran.
  if (stopped !== undefined && stopped < 0) return false;
  const partial = stopped !== undefined && stopped < flow.steps.length;
  // Proven this far already — a partial run can't add anything.
  if (partial && flow.proven !== false) return false;

  const outcomes = new Map(result.steps.map((s) => [s.seq - offset, s]));
  const steps = flow.steps.map((s, i) => {
    const o = outcomes.get(i);
    const url = observedUrl(s, o?.at);
    return { ...s, ...(o?.sig ? { expectedSig: o.sig } : {}), ...(url ? { url } : {}) };
  });
  const first = offset > 0 ? result.steps.find((s) => s.seq === offset - 1)?.sig : result.sigSequence[0];
  const last = partial ? undefined : outcomes.get(flow.steps.length - 1)?.sig;
  await flows.updateOne({ _id: flow._id! }, {
    $set: {
      steps, ...(first && !flow.startState ? { startState: first } : {}), ...(last ? { endState: last } : {}),
      ...(partial ? { provenUpTo: stopped } : {}), updatedAt: new Date(),
    },
    $unset: { proven: '', unprovenBecause: '', ...(partial ? {} : { provenUpTo: '' }) },
  });
  return true;
}

export interface ProvedFlow extends Executed {
  flow: Flow;
  /** The commit step it stopped before, when the flow has one. */
  commit?: CommitStep;
  run: RecordedRun;
  /** True when this run changed what the flow is proven to do. */
  newlyProven: boolean;
}

/**
 * Prove a saved flow where it stands — the way out for one kept with
 * `verify: false` because it ends in a real purchase. A flow with a commit step
 * is replayed up to it, and the commit's control is checked but never pressed;
 * any other flow is simply run. Either way the run is recorded.
 */
export async function proveFlow(app: string, slug: string, opts: { values?: Record<string, string>; headed?: boolean } = {}): Promise<ProvedFlow> {
  const { flows } = await collections();
  const flow = await flows.findOne({ app, slug });
  if (!flow) throw new Error(`no flow '${slug}' for app '${app}'`);
  const commit = await firstStop(app, flow.steps);
  const recording = recordingFrom(flow);
  const executed = await execute(recording, {
    ...opts, useLessons: true,
    ...(commit ? { stopBefore: recording.events[commit.index]!.seq } : {}),
  });
  const run = await recordRun({
    app, flow: slug, result: executed.result, steps: flow.steps, mode: 'replay',
    ...(flow.proven === false ? { unproven: true } : {}),
  });
  const newlyProven = await proveByRun(app, slug, executed.result);
  return { ...executed, flow: (await flows.findOne({ _id: flow._id! }))!, ...(commit ? { commit } : {}), run, newlyProven };
}

/**
 * Steps that can be added to a saved flow by hand — mostly to fix up flows
 * saved before these existed. Only ones that need no locator: a wait, or a
 * person's step. Anything that clicks is recorded, never typed in.
 */
const ADDABLE: Record<string, readonly string[]> = {
  human: ['untilText', 'untilUrl', 'untilResponse'],
  // A check of what the page shows — how a flow should end. Addressed by
  // role + name, which is a look, not a click.
  assert: ['assert'],
  wait_response: ['method', 'status', 'field', 'equals', 'above'],
  wait_url: [],
  wait_text: [],
};

export interface StepToAdd {
  /** Goes in front of the step at this index; the flow's length appends. */
  before: number;
  /** As stored: { action, value, hints? }. */
  step: Record<string, unknown>;
}

/** Every problem with these additions at once, or the steps to insert. */
export function checkAdditions(flow: Pick<Flow, 'steps' | 'startUrl'>, adds: StepToAdd[]): { steps: { before: number; step: Step }[]; problems: string[] } {
  const problems: string[] = [];
  const steps: { before: number; step: Step }[] = [];
  adds.forEach((a, i) => {
    const at = `add[${i}]`;
    const { action, value, hints } = (a.step ?? {}) as { action?: unknown; value?: unknown; hints?: unknown };
    if (!Number.isInteger(a.before) || a.before < 0 || a.before > flow.steps.length) {
      problems.push(`${at}.before must be a step index from 0 to ${flow.steps.length}`);
    }
    const allowed = typeof action === 'string' ? ADDABLE[action] : undefined;
    if (!allowed) return problems.push(`${at}.step.action must be one of ${Object.keys(ADDABLE).join(', ')}`);
    const { role, name } = (a.step ?? {}) as { role?: unknown; name?: unknown };
    const kind = (hints as { assert?: unknown } | undefined)?.assert;
    const isAssert = action === 'assert';
    if (isAssert) {
      if (typeof role !== 'string' || typeof name !== 'string' || !name.trim()) problems.push(`${at}.step: an assert needs role and name, e.g. {"role":"heading","name":"Visit booked"}`);
      if (!['visible', 'hidden', 'checked', 'unchecked', 'text', 'contains'].includes(String(kind))) problems.push(`${at}.step.hints.assert must be visible, hidden, checked, unchecked, text or contains`);
    }
    const needsValue = !isAssert || kind === 'text' || kind === 'contains';
    if (needsValue && (typeof value !== 'string' || !value.trim())) {
      problems.push(`${at}.step.value is required: ${action === 'human' ? 'what the person does' : action === 'wait_response' ? 'the address' : isAssert ? 'the text to expect' : 'what to wait for'}`);
    }
    if (hints !== undefined && (typeof hints !== 'object' || hints === null || Array.isArray(hints))) problems.push(`${at}.step.hints must be an object`);
    const extra = Object.keys((hints as object | undefined) ?? {}).filter((k) => !allowed.includes(k));
    if (extra.length) problems.push(`${at}.step.hints can't have ${extra.join(', ')}${allowed.length ? ` (it can have ${allowed.join(', ')})` : ''}`);
    const prev = flow.steps[Math.min(a.before, flow.steps.length) - 1];
    steps.push({
      before: a.before,
      step: {
        action: action as Step['action'],
        ...(typeof value === 'string' && value.trim() ? { value: value.trim() } : {}),
        ...(isAssert && typeof role === 'string' ? { role } : {}), ...(isAssert && typeof name === 'string' ? { name } : {}),
        url: prev?.url ?? flow.startUrl, resolution: 'synthesized',
        ...(hints && Object.keys(hints).length ? { hints: hints as Record<string, unknown> } : {}),
      },
    });
  });
  return { steps, problems };
}

/**
 * Add steps to a saved flow. It is unproven afterwards — a run that passes
 * proves it again — and segments cut from it keep pointing at the same steps.
 */
export async function editFlow(app: string, slug: string, adds: StepToAdd[]): Promise<Flow> {
  const { flows } = await collections();
  const flow = await flows.findOne({ app, slug });
  if (!flow) throw new Error(`no flow '${slug}' for app '${app}'`);
  if (flow.kind !== 'recording') throw new Error(`'${slug}' is a segment — add the steps to the flow it was cut from (${flow.from?.flow})`);
  if (!adds.length) throw new Error('nothing to add');
  const { steps: inserts, problems } = checkAdditions(flow, adds);
  if (problems.length) throw new Error(`nothing changed — fix these and send it again:\n- ${problems.join('\n- ')}`);

  // Last first, so each index still means the step it meant.
  const sorted = [...inserts].sort((a, b) => b.before - a.before);
  const steps = [...flow.steps];
  for (const { before, step } of sorted) steps.splice(before, 0, step);
  const why = flowDestructiveReason(steps);
  const now = new Date();
  await flows.updateOne({ _id: flow._id! }, {
    $set: {
      steps, proven: false, unprovenBecause: `edited: ${inserts.length} step(s) added — the next passing run proves it`,
      destructive: Boolean(why), ...(why ? { destructiveBecause: why } : {}), updatedAt: now,
    },
    $unset: { provenUpTo: '', ...(why ? {} : { destructiveBecause: '' }) },
  });

  // A segment AFTER an insertion moves along; one an insertion lands INSIDE
  // gets the step too, and must be proven again like its parent.
  for (const seg of await flows.find({ app, kind: 'segment', 'from.flow': slug }).toArray()) {
    let [start, end] = seg.from!.steps;
    const segSteps = [...seg.steps];
    let changed = false;
    for (const { before, step } of sorted) {
      if (before <= start) { start++; end++; }
      else if (before < end) { segSteps.splice(before - start, 0, step); end++; changed = true; }
    }
    await flows.updateOne({ _id: seg._id! }, {
      $set: {
        'from.steps': [start, end], steps: segSteps, updatedAt: now,
        ...(changed ? { proven: false, unprovenBecause: `its flow '${slug}' was edited — the next passing run proves it` } : {}),
      },
    });
  }
  return (await flows.findOne({ _id: flow._id! }))!;
}
