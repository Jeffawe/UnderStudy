/**
 * BedrockReasoner — Mode A. The reasoner is an API call, not the agent you are
 * talking to.
 *
 * `HostAgentReasoner` next door answers by SUSPENDING: it writes a pending
 * `context_requests` row and holds a promise open until a second tool call
 * arrives. This one answers in ~2s. Both satisfy the same two-method
 * interface, so `session.ts` composes either without knowing which it has —
 * that substitutability is the entire reason `Reasoner` exists as a type.
 *
 * WHAT THE HOST AGENT HAS THAT THIS DOESN'T: a browser and a human. That is not
 * a gap to paper over, it is the thing that decides how each question gets
 * answered here. Rung 5's seam probe literally means "go drive the browser and
 * report what you find"; this adapter cannot, so it answers from what it was
 * given and RETURNS NOTHING when that isn't enough. An unresolved seam blocks
 * execution, which is the correct outcome — the alternative is worse than
 * failing, because `persistProbedBridge` writes a probe result back into the
 * page graph as memory, so a guess becomes a permanent wrong answer that every
 * later run inherits.
 *
 * Fail closed, and only where refusing is cheap. That is the same instinct as
 * destructive marking failing open: both pick the direction where being wrong
 * costs least.
 */

import { callJSON, reasonerModel } from '../bedrock/client.js';
import type { PendingDecision, Reasoner } from '../../core/types.js';

const DECOMPOSE_SYSTEM = `You split a testing goal into ordered sub-goals against a web app whose
memory you are shown.

THE VOCABULARY IS THE POINT. You are given what this app already calls things —
its segments, flows and facts. Each sub-goal you emit is about to be used as a
SEMANTIC SEARCH QUERY against exactly that memory. A sub-goal phrased in words
the corpus does not use retrieves nothing, and the run stops. So prefer the
app's existing phrasing over your own, near-verbatim where a listed segment
already does the thing.

Emit the smallest number of sub-goals that covers the goal:
  · One sub-goal per thing that must HAPPEN, not per UI interaction. "Log in as
    a standard user" is one sub-goal, not three (two fills and a click).
  · Include prerequisites the user left implicit. Someone asking to "check out"
    on an app that requires login means log in first — the corpus has a segment
    for it and the plan needs it as its own step.
  · Order matters: each sub-goal starts from the state the previous one leaves.

If the goal is already atomic and matches one listed segment, one sub-goal is
the right answer. Do not pad.`;

const DECOMPOSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['subGoals'],
  properties: {
    subGoals: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description: "Ordered sub-goals, phrased in the app's own vocabulary.",
    },
  },
};

const SEAM_SYSTEM = `Two segments need to run back to back, and the system has no recorded path
between them. Every cheaper way of finding one has already failed: no shared
page fingerprint, no bridge segment, no edge in the page graph, no navigation.

You are being asked whether you can name the steps that get from the first
state to the second.

ANSWER "no" UNLESS YOU ACTUALLY KNOW. Whatever steps you return are WRITTEN
BACK INTO MEMORY as a permanent bridge and reused by every future run without
being asked again. A plausible guess therefore does not fail once — it becomes
a wrong fact the system trusts forever. An empty array is a clean outcome: the
plan blocks, and a human records the real path.

Return steps only when the transition is genuinely obvious from the state names
and slugs — a link whose accessible name IS the destination, or a step already
implied by the segments you were shown. Anything requiring you to imagine the
page: return [].`;

const SEAM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['steps', 'reasoning'],
  properties: {
    reasoning: { type: 'string', description: 'Why you can or cannot name this path. One or two sentences.' },
    steps: {
      type: 'array',
      description: 'The bridging steps, or [] if you do not actually know.',
      items: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', description: 'click | fill | goto | press' },
          role: { type: 'string', description: 'ARIA role, e.g. link, button' },
          name: { type: 'string', description: 'Accessible name of the target.' },
          testId: { type: 'string' },
          css: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
  },
};

const UNEXPECTED_PAGE_SYSTEM = `A step landed on a page other than the one it produced when recorded. Page
fingerprints cover the URL pattern, title, landmarks and the top interactive
element names, so they move for cosmetic reasons as well as real ones.

Decide whether the run should continue or abort.

  continue — the page is recognisably the SAME place doing the same job, and
    the difference is incidental: a new banner, a reordered nav, a cookie
    notice, a changed heading.
  abort — the run is somewhere else. A different route, an error or empty
    state, an unexpected login wall, or anything you cannot identify.

BIAS TO ABORT. Continuing means driving the remaining steps against a page
nobody has verified, and those steps may click things. Aborting costs one
failed run that someone reads; continuing wrongly can do something nobody
asked for. When genuinely torn, abort and say why.`;

const UNEXPECTED_PAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['action', 'reason'],
  properties: {
    action: { type: 'string', enum: ['continue', 'abort'] },
    reason: { type: 'string', description: 'One sentence, naming what you compared.' },
  },
};

/** Kinds declared on `PendingDecision` but not yet raised by any call site. */
const GENERIC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['answer', 'reason'],
  properties: {
    answer: { type: 'object', description: 'Whatever the executor asked for, as an object.' },
    reason: { type: 'string' },
  },
};

export class BedrockReasoner implements Reasoner {
  readonly id: string;

  constructor(private readonly model: string = reasonerModel()) {
    this.id = model;
  }

  /**
   * THE ONE MODEL CALL IN PLANNING — everything after it is arithmetic, so the
   * quality of these sub-goals decides whether the run finds anything at all.
   * Worth `high` effort on a call that happens once per run.
   */
  async decompose(goal: string, vocabulary: string[]): Promise<string[]> {
    const { value } = await callJSON<{ subGoals?: unknown }>({
      model: this.model,
      system: DECOMPOSE_SYSTEM,
      user:
        `GOAL: ${goal}\n\n` +
        (vocabulary.length
          ? `WHAT THIS APP ALREADY KNOWS:\n${vocabulary.map((v) => `  ${v}`).join('\n')}`
          : 'THIS APP HAS NO MEMORY YET — phrase sub-goals in plain, literal terms.'),
      schema: DECOMPOSE_SCHEMA,
      maxTokens: 2000,
      effort: 'high',
    });

    const subGoals = value.subGoals;
    if (!Array.isArray(subGoals) || !subGoals.every((s) => typeof s === 'string' && s.trim())) {
      throw new Error('decompose expected { subGoals: string[] }');
    }
    return subGoals as string[];
  }

  async resolve(decision: PendingDecision): Promise<Record<string, unknown>> {
    switch (decision.kind) {
      case 'seam':
        return this.#seam(decision.context);
      case 'unexpected_page':
        return this.#unexpectedPage(decision.context);
      default:
        return this.#generic(decision);
    }
  }

  // -------------------------------------------------------------------------

  async #seam(context: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { value } = await callJSON<{ steps?: unknown[]; reasoning?: string }>({
      model: this.model,
      system: SEAM_SYSTEM,
      user:
        `FROM segment "${String(context.fromSlug)}", which leaves the app in: ${String(context.fromState)}\n` +
        `TO   segment "${String(context.toSlug)}", which must start from: ${String(context.toState)}`,
      schema: SEAM_SCHEMA,
      maxTokens: 1500,
      effort: 'high',
    });

    // An answer with reasoning but no steps is the expected outcome, not an
    // error — plan.ts leaves the seam unresolved and blocks.
    return { steps: Array.isArray(value.steps) ? value.steps : [], reasoning: value.reasoning ?? '' };
  }

  async #unexpectedPage(context: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { value } = await callJSON<{ action?: string; reason?: string }>({
      model: this.model,
      system: UNEXPECTED_PAGE_SYSTEM,
      user:
        `STEP ${String(context.step)}: ${String(context.semantic ?? context.action)}\n` +
        `TARGET:   ${String(context.target ?? 'unknown')}\n` +
        `EXPECTED: ${String(context.expected)}\n` +
        `OBSERVED: ${String(context.observed)}\n\n` +
        'A fingerprint is "<url pattern>#<hash of title, landmarks and top control names>". ' +
        'A matching URL pattern with a different hash means the same route changed shape.',
      schema: UNEXPECTED_PAGE_SCHEMA,
      maxTokens: 1000,
      effort: 'medium',
    });

    // Anything other than an explicit "continue" aborts. The schema constrains
    // this to two values, so this is belt-and-braces on the side that is safe
    // to be wrong on.
    const action = value.action === 'continue' ? 'continue' : 'abort';
    return { action, reason: value.reason ?? 'no reason given' };
  }

  async #generic(decision: PendingDecision): Promise<Record<string, unknown>> {
    const { value } = await callJSON<{ answer?: Record<string, unknown>; reason?: string }>({
      model: this.model,
      system:
        'You are answering a judgement call that deterministic code in a browser-testing ' +
        'agent cannot make. Answer only from what you are given; say so in `reason` when ' +
        'the information is insufficient rather than inventing a plausible answer.',
      user: `DECISION KIND: ${decision.kind}\n\nCONTEXT:\n${JSON.stringify(decision.context, null, 1)}`,
      schema: GENERIC_SCHEMA,
      maxTokens: 2000,
      effort: 'medium',
    });

    return { ...(value.answer ?? {}), reason: value.reason ?? '' };
  }
}
