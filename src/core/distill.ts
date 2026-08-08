/**
 * Distillation — the pause-and-ask handshake, and what comes back.
 *
 * Deterministic code cannot call into a Claude Code session, so it never calls:
 * it pauses and returns. Distillation has NO live state (no open browser), so
 * the pause is a clean stateless split across two calls, resumable across a
 * process restart:
 *
 *     promote(hash)        → needs_distillation + request payload
 *        ← the agent (or Bedrock) distills →
 *     save(hash, json)     → validate → ingest → done
 *
 * THE MODEL ANNOTATES; IT DOES NOT AUTHOR STEPS.
 *
 * The steps are already captured by the recorder and PROVEN by replay. Asking a
 * model to re-emit them would let it silently rewrite a verified selector or
 * invent an action that never happened, and nothing downstream could tell. So
 * the request hands over numbered, verified steps and the response may only
 * reference them BY INDEX. A distillation can partition and name; it cannot
 * fabricate. `DistilledSegment.stepRange` was always this shape — "segments are
 * boundaries, not copies".
 *
 * That constraint is what makes it safe to let an agent do this at all.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RawRecording } from './recording.js';
import type { ReplayResult } from './replay.js';
import type { Vocabulary } from './vocabulary.js';

export const DISTILLED_DIR =
  process.env.UNDERSTUDY_DISTILLED_DIR ?? resolve('.understudy/distilled');

/** One verified step, as handed to the distiller. */
export interface DistillStep {
  index: number;
  action: string;
  role?: string;
  name?: string;
  value?: string;
  valueRef?: string;
  /** Page fingerprint after this step — the state boundary segments cut on. */
  sigAfter?: string;
  url: string;
}

export interface DistillRequest {
  recordingHash: string;
  appSlug: string;
  startUrl: string;
  steps: DistillStep[];
  /**
   * What this app already calls things.
   *
   * Without it, a second recording of the same login block gets a synonym
   * instead of the existing name, and the two compete for the same bind slot
   * forever after. The distiller is told to REUSE these words where the same
   * thing recurs.
   */
  vocabulary: Vocabulary;
  /** Human-readable instructions. The schema below is the contract. */
  instructions: string;
  schema: Record<string, unknown>;
}

/** What the distiller must return. Validated before anything is written. */
export interface Distilled {
  intent: string;
  preconditions: string[];
  outcome: string;
  segments: Array<{
    slug: string;
    title: string;
    intent: string;
    /** Inclusive start, exclusive end, into the steps array handed over. */
    stepRange: [number, number];
    preconditions?: string[];
    outcome?: string;
  }>;
  candidateLessons?: Array<{ kind: string; title: string; body: string; trigger: Record<string, unknown> }>;
  corrections?: Array<{ rule: string; detail: string; stepIndex?: number }>;
}

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['intent', 'preconditions', 'outcome', 'segments'],
  properties: {
    intent: { type: 'string', description: 'What this whole flow is FOR, in the user\'s language. Not a list of steps.' },
    preconditions: { type: 'array', items: { type: 'string' }, description: 'What must already be true, e.g. "authenticated as a standard user".' },
    outcome: { type: 'string', description: 'The state the app is in afterwards.' },
    segments: {
      type: 'array',
      description: 'Reusable chunks. A segment belongs to the APP, not to this recording — a login block cut from a checkout recording must be reusable by every future flow.',
      items: {
        type: 'object',
        required: ['slug', 'title', 'intent', 'stepRange'],
        properties: {
          slug: { type: 'string', description: 'kebab-case, stable, e.g. "log-in-standard-user"' },
          title: { type: 'string' },
          intent: { type: 'string', description: 'What this segment achieves, phrased as a goal someone would ask for.' },
          stepRange: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: '[start, end) indices into the steps given. Never invent steps.' },
          preconditions: { type: 'array', items: { type: 'string' } },
          outcome: { type: 'string' },
        },
      },
    },
    candidateLessons: {
      type: 'array',
      description: 'Conditional fixes: "when X, do Y first". Only if the recording actually shows one.',
      items: { type: 'object', required: ['kind', 'title', 'body', 'trigger'] },
    },
    corrections: {
      type: 'array',
      description: 'What you judged wrong or redundant in the raw recording, and why.',
      items: { type: 'object', required: ['rule', 'detail'] },
    },
  },
};

const INSTRUCTIONS = `You are distilling a VERIFIED browser recording into reusable memory.

The steps below were captured from a real session and every one of them was
replayed successfully. They are ground truth.

YOUR JOB IS TO ANNOTATE AND PARTITION, NOT TO AUTHOR.
  · Do NOT restate, reorder, or invent steps. Reference them by index only.
  · Segments are [start, end) ranges over the step list given.
  · Segments should cut on MEANINGFUL boundaries — a change of page state
    (see sigAfter) is usually one.

What matters most:
  · intent — what this flow is FOR, phrased the way someone would ASK for it
    ("log in as a standard user"), never a description of the mechanics
    ("fill two textboxes and click a button").
  · segments — a segment belongs to the APP, not to this recording. A login
    block cut out of a checkout recording must be reusable by every future
    flow, so name and scope it accordingly.
  · preconditions — what must already be true. This is what lets a planner
    reject a segment that cannot run from where it currently is.

USE THE APP'S EXISTING VOCABULARY.
The request includes every segment this app already has. If a block of steps
here does the same thing as one of those, REUSE its exact slug and phrasing
rather than inventing a synonym. "Sign in to the app" and "Authenticate as a
member" as two separate segments is a corpus defect: they compete for the same
bind slot, and a planner searching for one will not find the other.
Only invent new wording when the thing genuinely is new.

Only report a lesson or a correction if the recording actually shows one.
Inventing them is worse than leaving the arrays empty.`;

/**
 * Build the payload handed to whoever is distilling.
 *
 * Only steps that REPLAYED are included — an unverified step must never reach
 * the model, or it can end up named, segmented, and bound like a real one.
 */
export function buildDistillRequest(
  recording: RawRecording,
  replayResult: ReplayResult,
  vocabulary: Vocabulary = { segments: [], flows: [], facts: [] },
): DistillRequest {
  const okSeqs = new Set(replayResult.steps.filter((s) => s.ok).map((s) => s.seq));
  const sigBySeq = new Map(replayResult.steps.map((s) => [s.seq, s.sig]));

  const steps: DistillStep[] = recording.events
    .filter((e) => okSeqs.has(e.seq))
    .map((e, index) => ({
      index,
      action: e.action,
      ...(e.role ? { role: e.role } : {}),
      ...(e.name ? { name: e.name } : {}),
      ...(e.value !== undefined ? { value: e.value } : {}),
      ...(e.valueRef ? { valueRef: e.valueRef } : {}),
      ...(sigBySeq.get(e.seq) ? { sigAfter: sigBySeq.get(e.seq)! } : {}),
      url: e.url,
    }));

  return {
    recordingHash: recording.hash,
    appSlug: recording.appSlug,
    startUrl: recording.startUrl,
    steps,
    vocabulary,
    instructions: INSTRUCTIONS,
    schema: SCHEMA,
  };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value?: Distilled;
}

/**
 * Validate a distillation before ANY of it is written.
 *
 * The server validates, not the agent — PLAN.md is explicit that a mismatch
 * returns errors and the agent retries. This is the only thing standing between
 * a malformed or hallucinated distillation and the corpus, so it checks
 * structure AND the index arithmetic that keeps segments honest.
 */
export function validateDistilled(input: unknown, stepCount: number): ValidationResult {
  const errors: string[] = [];
  const push = (m: string) => errors.push(m);

  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['distillation must be a JSON object'] };
  }
  const d = input as Record<string, unknown>;

  if (typeof d.intent !== 'string' || !d.intent.trim()) push('intent is required and must be a non-empty string');
  if (typeof d.outcome !== 'string' || !d.outcome.trim()) push('outcome is required and must be a non-empty string');
  if (!Array.isArray(d.preconditions)) push('preconditions must be an array of strings');
  else if (d.preconditions.some((p) => typeof p !== 'string')) push('preconditions must contain only strings');

  if (!Array.isArray(d.segments)) {
    push('segments must be an array');
    return { ok: false, errors };
  }

  const slugs = new Set<string>();
  d.segments.forEach((raw, i) => {
    const s = raw as Record<string, unknown>;
    const at = `segments[${i}]`;

    for (const field of ['slug', 'title', 'intent'] as const) {
      if (typeof s[field] !== 'string' || !(s[field] as string).trim()) push(`${at}.${field} is required`);
    }
    if (typeof s.slug === 'string') {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.slug)) push(`${at}.slug must be kebab-case, got "${s.slug}"`);
      if (slugs.has(s.slug)) push(`${at}.slug "${s.slug}" is duplicated`);
      slugs.add(s.slug);
    }

    // The index arithmetic is the part that actually keeps a distillation
    // honest: a range outside the verified steps would let the model reference
    // something that was never recorded or never replayed.
    const range = s.stepRange;
    if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => Number.isInteger(n))) {
      push(`${at}.stepRange must be [start, end) integers`);
      return;
    }
    const [start, end] = range as [number, number];
    if (start < 0 || end > stepCount) push(`${at}.stepRange [${start},${end}) is outside 0..${stepCount}`);
    if (start >= end) push(`${at}.stepRange [${start},${end}) is empty or inverted`);
  });

  return errors.length ? { ok: false, errors } : { ok: true, errors: [], value: d as unknown as Distilled };
}

// ---- cache -----------------------------------------------------------------
// Keyed by recording hash, so a recording distilled once is never distilled
// again. CLAUDE.md's day-one guard: distillation is the expensive call.

export const distilledPath = (hash: string): string => join(DISTILLED_DIR, `${hash}.json`);

export async function saveDistilled(hash: string, distilled: Distilled): Promise<string> {
  await mkdir(DISTILLED_DIR, { recursive: true });
  const path = distilledPath(hash);
  await writeFile(path, JSON.stringify(distilled, null, 2), 'utf8');
  return path;
}

export async function loadDistilled(hash: string): Promise<Distilled | undefined> {
  const path = distilledPath(hash);
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, 'utf8')) as Distilled;
}
