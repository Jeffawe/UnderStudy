/**
 * Distillation — an agent annotates a saved flow and splits it into segments.
 *
 * Optional. A flow is stored and runnable without it; distilling adds what a
 * person would say the flow is FOR (intent, preconditions, outcome), cuts it
 * into reusable segments (e.g. "log in as a member" out of a checkout
 * recording, so other goals can reuse it), and may suggest lessons.
 *
 * THE AGENT ANNOTATES; IT DOES NOT AUTHOR STEPS. The steps were captured by
 * the recorder and proven by replay; the request numbers them and the answer
 * may only refer to them BY INDEX. It can partition and name, never fabricate.
 * That constraint is what makes it safe to let an agent do this at all.
 *
 * This file is the contract: the request, the answer's schema, and the
 * validator. src/flows/distill.ts builds requests from MongoDB and saves answers.
 */

import { triggerProblems } from './trigger.js';
import type { RawRecording } from './recording.js';
import type { ReplayResult } from './replay.js';
/**
 * What the app already knows, handed to the distiller so it reuses existing
 * segment slugs instead of inventing synonyms. Built from MongoDB in phase 4.
 */
export interface Vocabulary {
  /** Reusable segments — the primary vocabulary, what a sub-goal binds to. */
  segments: Array<{
    slug: string;
    title: string;
    intent: string;
    steps: number;
    preconditions: string[];
    outcome: string | null;
    requires?: string[];
    establishes?: string[];
  }>;
  /** Whole recorded flows, for coarser matches. */
  flows: Array<{ slug: string; title: string; intent: string; requires?: string[]; establishes?: string[] }>;
  /** App states already named by some flow's requires/establishes — reuse these words. */
  states?: string[];
  /** What is known to be true about the app, phrased as the corpus phrases it. */
  facts: string[];
}

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
  requires?: string[];
  establishes?: string[];
  segments: Array<{
    slug: string;
    title: string;
    intent: string;
    /** Inclusive start, exclusive end, into the steps array handed over. */
    stepRange: [number, number];
    preconditions?: string[];
    outcome?: string;
    requires?: string[];
    establishes?: string[];
  }>;
  candidateLessons?: Array<{ kind: string; title: string; body: string; trigger: Record<string, unknown> }>;
  corrections?: Array<{ rule: string; detail: string; stepIndex?: number }>;
}

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['intent', 'preconditions', 'outcome', 'segments'],
  properties: {
    intent: { type: 'string', description: 'What this whole flow is FOR, in the user\'s language. Not a list of steps.' },
    preconditions: { type: 'array', items: { type: 'string', enum: ['authenticated', 'not authenticated'] }, description: 'Exactly "authenticated" or "not authenticated" — nothing else. Empty if neither matters.' },
    outcome: { type: 'string', description: 'The state the app is in afterwards.' },
    requires: { type: 'array', items: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }, description: 'App states that must already be true for this to work, kebab-case ("member-has-active-bundle"). Reuse vocabulary.states.' },
    establishes: { type: 'array', items: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }, description: 'App states this makes true, in the same words a flow that needs them would use.' },
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
          preconditions: { type: 'array', items: { type: 'string', enum: ['authenticated', 'not authenticated'] } },
          outcome: { type: 'string' },
          requires: { type: 'array', items: { type: 'string' } },
          establishes: { type: 'array', items: { type: 'string' } },
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

const INSTRUCTIONS = `Name this recording and cut it into reusable segments. Every step below replayed; refer to steps by index only — never add, change or reorder them.
- intent: what it is FOR, as someone would ask ("log in as a member"), not the mechanics.
- segments: [start, end) ranges, cut where the page changes (sigAfter). A segment belongs to the app: if one in vocabulary does the same thing, reuse its slug.
- preconditions: exactly "authenticated" or "not authenticated", or none. Other app state goes in requires / establishes, kebab-case, reusing vocabulary.states.
- candidateLessons, corrections: only if the recording shows one. Empty beats invented.`;

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

/** A state name: kebab-case, short enough to be a name rather than a sentence. */
export const STATE_NAME = /^(?=.{2,60}$)[a-z0-9]+(-[a-z0-9]+)*$/;

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
  const preconditionProblem = (at: string, v: unknown) => {
    if (v === undefined) return;
    if (!Array.isArray(v) || v.some((p) => p !== 'authenticated' && p !== 'not authenticated')) {
      push(`${at} must be an array of exactly "authenticated" or "not authenticated" (got ${JSON.stringify(v)})`);
    }
  };
  if (!Array.isArray(d.preconditions)) push('preconditions must be an array');
  else preconditionProblem('preconditions', d.preconditions);
  const stateProblem = (at: string, v: unknown) => {
    if (v === undefined) return;
    if (!Array.isArray(v)) return push(`${at} must be an array of state names`);
    for (const x of v) {
      if (typeof x !== 'string' || !STATE_NAME.test(x)) push(`${at}: "${String(x)}" must be a kebab-case state name, e.g. "member-has-active-bundle"`);
    }
  };
  stateProblem('requires', d.requires);
  stateProblem('establishes', d.establishes);

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
    preconditionProblem(`${at}.preconditions`, s.preconditions);
    stateProblem(`${at}.requires`, s.requires);
    stateProblem(`${at}.establishes`, s.establishes);
    const range = s.stepRange;
    if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => Number.isInteger(n))) {
      push(`${at}.stepRange must be [start, end) integers`);
      return;
    }
    const [start, end] = range as [number, number];
    if (start < 0 || end > stepCount) push(`${at}.stepRange [${start},${end}) is outside 0..${stepCount}`);
    if (start >= end) push(`${at}.stepRange [${start},${end}) is empty or inverted`);
  });

  // Ingest writes these straight into `lessons`, so a bad trigger here is a
  // lesson that fires everywhere or nowhere. Validated like every other writer.
  if (d.candidateLessons !== undefined && !Array.isArray(d.candidateLessons)) {
    push('candidateLessons must be an array');
  } else {
    (d.candidateLessons as unknown[] | undefined)?.forEach((raw, i) => {
      const l = (raw ?? {}) as Record<string, unknown>;
      for (const field of ['kind', 'title', 'body'] as const) {
        if (typeof l[field] !== 'string' || !(l[field] as string).trim()) push(`candidateLessons[${i}].${field} is required`);
      }
      for (const p of triggerProblems(l.trigger)) push(`candidateLessons[${i}].${p}`);
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [], value: d as unknown as Distilled };
}
