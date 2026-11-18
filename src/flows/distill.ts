/**
 * Distilling a saved flow: hand an agent its numbered steps, take back names
 * and segments, validate, store.
 *
 *   distillRequest(app, flow)          → steps + the app's vocabulary + instructions
 *   saveDistilled(app, flow, answer)   → validated; every problem at once; nothing
 *                                        written unless the whole answer is clean
 *
 * No replay here: a saved flow was already proven when it was saved, so its
 * steps and the page each one reached are on record.
 */

import { buildDistillRequest, validateDistilled, type Distilled, type DistillRequest } from '../core/distill.js';
import type { ReplayResult } from '../core/replay.js';
import { collections, ensureSchema } from '../store/db.js';
import { embed, embedderConfig } from '../store/embed.js';
import type { Flow, Precondition } from '../store/types.js';
import { vocabulary } from '../memory/vocabulary.js';
import { remember } from '../memory/notes.js';
import { flowDestructiveReason } from './destructive.js';
import { recordingFrom } from './save.js';

async function loadFlow(app: string, slug: string): Promise<Flow> {
  const { flows } = await collections();
  const flow = await flows.findOne({ app, slug });
  if (!flow) throw new Error(`no flow '${slug}' for app '${app}'`);
  if (flow.kind !== 'recording') throw new Error(`'${slug}' is a segment — distill the recording it came from (${flow.from?.flow})`);
  return flow;
}

export async function distillRequest(app: string, slug: string): Promise<DistillRequest & { flow: string }> {
  const flow = await loadFlow(app, slug);
  // Every saved step passed when it was proven; its expectedSig is the page it reached.
  const proven = { steps: flow.steps.map((s, seq) => ({ seq, ok: true, ...(s.expectedSig ? { sig: s.expectedSig } : {}) })) } as ReplayResult;
  return { flow: slug, ...buildDistillRequest(recordingFrom(flow), proven, await vocabulary(app)) };
}

export interface DistillSaved {
  flow: string;
  segments: { slug: string; steps: number; replaced: boolean }[];
  lessons: { written: number; alreadyKnown: number };
}

export async function saveDistilled(app: string, slug: string, answer: unknown): Promise<DistillSaved> {
  const flow = await loadFlow(app, slug);
  const check = validateDistilled(answer, flow.steps.length);
  const errors = [...check.errors];
  const d = check.value;
  if (d?.segments.some((s) => s.slug === slug)) errors.push(`a segment can't have the same slug as the flow it is cut from ("${slug}")`);
  if (errors.length || !d) throw new Error(`nothing written — fix these and send it again:\n- ${errors.join('\n- ')}`);

  await ensureSchema();
  const c = await collections();
  const now = new Date();

  const segmentDocs = d.segments.map((s) => segmentFrom(flow, s));
  const parentText = searchTextOf(flow.title, d.intent, d.outcome);
  // One request embeds the parent and every segment.
  const vectors = embedderConfig() ? await embed([parentText, ...segmentDocs.map((s) => s.searchText)], 'document') : [];

  await c.flows.updateOne(
    { app, slug },
    {
      $set: {
        intent: d.intent, outcome: d.outcome, preconditions: d.preconditions as Precondition[],
        corrections: (d.corrections ?? []).map((x) => `${x.rule}: ${x.detail}${x.stepIndex !== undefined ? ` (step ${x.stepIndex})` : ''}`),
        searchText: parentText, ...(vectors[0] ? { embedding: vectors[0] } : {}), updatedAt: now,
      },
    },
  );

  const saved: DistillSaved['segments'] = [];
  for (const [i, seg] of segmentDocs.entries()) {
    // Reusing an existing slug REPLACES that segment: segments belong to the
    // app, so the same block from a new recording merges instead of competing.
    const existed = await c.flows.findOne({ app, slug: seg.slug }, { projection: { kind: 1 } });
    if (existed && existed.kind !== 'segment') throw new Error(`"${seg.slug}" is already a recorded flow's slug — pick another for the segment`);
    const unset: Record<string, ''> = {};
    if (!vectors[i + 1]) unset.embedding = '';
    if (!seg.destructiveBecause) unset.destructiveBecause = '';
    await c.flows.updateOne(
      { app, slug: seg.slug },
      { $set: { ...seg, ...(vectors[i + 1] ? { embedding: vectors[i + 1]! } : {}), updatedAt: now }, $setOnInsert: { createdAt: now }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { upsert: true },
    );
    saved.push({ slug: seg.slug, steps: seg.steps.length, replaced: Boolean(existed) });
  }

  const lessons = d.candidateLessons?.length
    ? (await remember(app, {
        lessons: d.candidateLessons.map((l) => ({ title: l.title, text: l.body, kind: l.kind, trigger: l.trigger })),
      })).lessons
    : { written: 0, alreadyKnown: 0 };

  return { flow: slug, segments: saved, lessons };
}

const searchTextOf = (title: string, intent: string, outcome?: string) =>
  [title, intent !== title ? intent : '', outcome ?? ''].filter(Boolean).join('. ');

/** A segment is a copy of a range of its parent's steps, with its own name. */
function segmentFrom(parent: Flow, s: Distilled['segments'][number]): Omit<Flow, '_id' | 'createdAt' | 'updatedAt' | 'embedding'> {
  const [start, end] = s.stepRange;
  const steps = parent.steps.slice(start, end);
  const why = flowDestructiveReason(steps);
  // Where it begins: the page the step BEFORE it reached (or the parent's start).
  const startState = start === 0 ? parent.startState : parent.steps[start - 1]?.expectedSig;
  const endState = steps.at(-1)?.expectedSig;
  return {
    app: parent.app, slug: s.slug, title: s.title, intent: s.intent, kind: 'segment',
    from: { flow: parent.slug, steps: [start, end] },
    preconditions: (s.preconditions ?? []) as Precondition[],
    outcome: s.outcome ?? '',
    destructive: Boolean(why), ...(why ? { destructiveBecause: why } : {}),
    corrections: [], recording: parent.recording,
    startUrl: steps[0]?.url ?? parent.startUrl,
    // Only the very first segment can use the parent's saved session; a later
    // one starts mid-flow and needs the flows before it in the same plan.
    requiresSession: start === 0 && parent.requiresSession,
    ...(start === 0 && parent.session ? { session: parent.session } : {}),
    ...(startState ? { startState } : {}), ...(endState ? { endState } : {}),
    steps, searchText: searchTextOf(s.title, s.intent, s.outcome),
  };
}
