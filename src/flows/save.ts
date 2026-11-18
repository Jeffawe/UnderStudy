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
import { prove } from './execute.js';
import { recordRun } from './runs.js';
import { applyPlaceholders } from '../memory/placeholders.js';

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
    updatedAt: now,
  };

  // Replace, not merge: a re-saved flow must not keep a stale embedding or
  // destructive mark from the previous version.
  const unset: Record<string, ''> = {};
  if (!embedding) unset.embedding = '';
  if (!why) unset.destructiveBecause = '';
  if (!recording.entry?.session) unset.session = '';
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
  /** Save even though the proving replay failed (it stays marked by its failing run). */
  force?: boolean;
}

/**
 * What `save` does, for the CLI and the MCP server alike: prove the recording
 * (replaying it headless, working out whether it needs to start signed in),
 * then — only if it passed — store it as a flow and record that first run.
 */
export async function proveAndSave(recording: RawRecording, opts: ProveAndSave) {
  const proven = await prove(recording, { ...(opts.values ? { values: opts.values } : {}), ...(opts.headed ? { headed: true } : {}) });
  if (!proven.result.ok && !opts.force) return { saved: false as const, proven };
  let flow = await saveFlow(proven.recording, proven.result, opts);
  // The app keeps email fields as placeholders? Convert now — AFTER proving,
  // so proving used the real address and needed no settings.
  const placeholders = await applyPlaceholders(flow.app, undefined, flow.slug);
  if (placeholders.converted.length) flow = (await (await collections()).flows.findOne({ _id: flow._id! }))!;
  const run = await recordRun({ app: flow.app, flow: flow.slug, result: proven.result, steps: flow.steps });
  return { saved: true as const, proven, flow, run, placeholders };
}
