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
import { flowDestructiveReason } from './destructive.js';
import { prove, type Proven } from './execute.js';
import { forgetSessionById } from '../core/auth-cache.js';
import { recordRun, type RecordedRun } from './runs.js';
import { applyPlaceholders, type Applied } from '../memory/placeholders.js';

/** "Log in as a member!" → "log-in-as-a-member" */
export function slugify(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/** A recording's events, as the steps of a flow. Drops recorder bookkeeping and empty fields. */
export function stepsFrom(recording: RawRecording, result?: ReplayResult): Step[] {
  const observed = new Map(result?.steps.map((s) => [s.seq, s.sig]));
  return recording.events.map((e) => {
    const { seq, ts, ...rest } = e;
    const step = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Step;
    const sig = observed.get(seq);
    if (sig) step.expectedSig = sig;
    return step;
  });
}

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
    ...(result.sigSequence.length ? { endState: result.sigSequence.at(-1)! } : {}),
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

  const proven = await prove(recording, { ...(opts.values ? { values: opts.values } : {}), ...(opts.headed ? { headed: true } : {}) });
  let unproven = opts.unproven;
  if (!proven.result.ok) {
    const keep = opts.force || (opts.keepIfFailed ? await opts.keepIfFailed(proven) : false);
    if (!keep) return { saved: false, proven };
    unproven ??= 'its replay failed, and it was kept anyway';
  }
  const saved = await saveFlow(proven.recording, proven.result, { ...opts, ...(unproven ? { unproven } : {}) });
  const { flow, placeholders } = await withPlaceholders(saved);
  const run = await recordRun({ app: flow.app, flow: flow.slug, result: proven.result, steps: flow.steps });
  return { saved: true, verified: proven.result.ok, proven, flow, run, placeholders };
}

/** The app keeps email fields as placeholders? Convert now — after proving, which used the real address. */
async function withPlaceholders(flow: Flow): Promise<{ flow: Flow; placeholders: Applied }> {
  const placeholders = await applyPlaceholders(flow.app, undefined, flow.slug);
  if (!placeholders.converted.length) return { flow, placeholders };
  return { flow: (await (await collections()).flows.findOne({ _id: flow._id! }))!, placeholders };
}

/**
 * An unproven flow that just passed a run is proven now: mark it, and fill in
 * what its missing replay would have recorded — the page each step lands on,
 * and where it starts and ends. `offset` skips steps the run added in front.
 */
export async function proveByRun(app: string, slug: string, result: ReplayResult, offset = 0): Promise<boolean> {
  if (!result.ok) return false;
  const { flows } = await collections();
  const flow = await flows.findOne({ app, slug, proven: false });
  if (!flow) return false;
  const sigAt = new Map(result.steps.map((s) => [s.seq - offset, s.sig]));
  const steps = flow.steps.map((s, i) => (sigAt.get(i) ? { ...s, expectedSig: sigAt.get(i)! } : s));
  const first = offset > 0 ? result.steps.find((s) => s.seq === offset - 1)?.sig : result.sigSequence[0];
  const last = sigAt.get(flow.steps.length - 1);
  await flows.updateOne({ _id: flow._id! }, {
    $set: { steps, ...(first && !flow.startState ? { startState: first } : {}), ...(last ? { endState: last } : {}), updatedAt: new Date() },
    $unset: { proven: '', unprovenBecause: '' },
  });
  return true;
}
