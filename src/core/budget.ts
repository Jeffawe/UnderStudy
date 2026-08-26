/**
 * What a run is allowed to spend before it stops and asks for help.
 *
 * THE THING BEING BUDGETED IS NOT WHAT YOU MIGHT EXPECT. In Mode B the executor
 * calls no model at all — the host agent is the reasoner, so every "expensive"
 * moment is a round trip to a session Understudy cannot see inside. It cannot
 * read the agent's token usage, its context window, or its bill.
 *
 * What it CAN observe is exactly what it causes: the bytes it hands the reasoner
 * and the bytes that come back. Every decision funnels through one place, so
 * metering there is complete by construction. That estimate is the PRIMARY
 * signal, for four reasons in descending order of force:
 *
 *   1. Observability — a budget you cannot measure is a request, not a budget.
 *   2. Determinism — run behaviour must not depend on an unverifiable claim
 *      from the thing being budgeted. Same reason the distiller references
 *      steps by index and the recorder trusts in-page accname over a later guess.
 *   3. Incentive — the agent is the party that benefits from the budget not
 *      tripping. A self-report is the fox counting the hens.
 *   4. Sufficiency — the proxy is monotonic in the real cost, because every
 *      token the agent spends here is downstream of a payload we handed it.
 *
 * It under-counts the agent's own deliberation, which is why it is tuned to
 * trip EARLY rather than exactly. A self-reported figure is accepted as a
 * refinement and folded in with `max()`, so it can only ever make the budget
 * trip sooner. That asymmetry is the safety property — the same fail-closed
 * idiom as `redactValue`.
 */

import type { PendingDecision, Reasoner } from './types.js';

export interface BudgetLimits {
  /** Reasoner round trips, of any kind. */
  decisions: number;
  /** Wall clock for the whole run. */
  minutes: number;
  /** Estimated tokens exchanged with the reasoner. */
  tokens: number;
  /** Tries per step before the step is treated as stuck. */
  stepAttempts: number;
}

/**
 * A picture is worth about this many tokens, and this is the correction that
 * matters most.
 *
 * A `visual_diff` payload is a few hundred characters of FILE PATHS and then
 * instructs the agent to go open three PNGs per checkpoint. Estimating from
 * characters alone under-counts it by two orders of magnitude — on precisely
 * the decision kind that dominates real spend. Anthropic's own rule of thumb
 * for a full-page screenshot is roughly this.
 */
const TOKENS_PER_IMAGE = 1500;

/** Rough and deliberately cheap: ~4 characters per token holds for English and JSON. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  // A malformed budget must not silently become zero — that would escalate on
  // the first decision and read as a mysterious hang-and-ask.
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function limitsFromEnv(): BudgetLimits {
  return {
    // 1 = try once, exactly today's behaviour. Opting IN to retries keeps this
    // change invisible to every existing flow until someone asks for it.
    stepAttempts: envInt('UNDERSTUDY_MAX_STEP_ATTEMPTS', 1),
    decisions: envInt('UNDERSTUDY_MAX_DECISIONS', 25),
    minutes: envInt('UNDERSTUDY_MAX_RUN_MINUTES', 30),
    tokens: envInt('UNDERSTUDY_MAX_DECISION_TOKENS', 120_000),
  };
}

/** How many image paths a payload hands over, which the character count misses. */
function countImages(payload: unknown): number {
  const json = JSON.stringify(payload ?? {});
  return (json.match(/\.(png|jpe?g|webp)\b/gi) ?? []).length;
}

export class RunBudget {
  readonly limits: BudgetLimits;
  readonly startedAt = Date.now();

  #decisions = 0;
  #proxyTokens = 0;
  #reportedTokens = 0;

  constructor(limits: BudgetLimits = limitsFromEnv()) {
    this.limits = limits;
  }

  get decisions(): number {
    return this.#decisions;
  }

  /** The figure the budget is actually judged on. */
  get tokens(): number {
    return Math.max(this.#proxyTokens, this.#reportedTokens);
  }

  get elapsedMinutes(): number {
    return (Date.now() - this.startedAt) / 60_000;
  }

  /** Record one reasoner round trip. */
  note(spec: { ask: string; payload: unknown; answer: unknown }): void {
    this.#decisions++;
    this.#proxyTokens +=
      estimateTokens(spec.ask) +
      estimateTokens(JSON.stringify(spec.payload ?? {})) +
      estimateTokens(JSON.stringify(spec.answer ?? {})) +
      countImages(spec.payload) * TOKENS_PER_IMAGE;
  }

  /**
   * Accept the agent's own figure. Monotonic and `max()`-only, so a self-report
   * can bring the budget forward but never push it back.
   */
  selfReport(totalTokens: number): void {
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) return;
    this.#reportedTokens = Math.max(this.#reportedTokens, Math.floor(totalTokens));
  }

  /** The reason this run should stop asking and start delegating, if any. */
  exceeded(): string | undefined {
    if (this.#decisions > this.limits.decisions) {
      return `decision budget spent (${this.#decisions} of ${this.limits.decisions})`;
    }
    if (this.tokens > this.limits.tokens) {
      const how = this.#reportedTokens > this.#proxyTokens ? 'reported' : 'estimated';
      return `token budget spent (~${this.tokens} ${how} of ${this.limits.tokens})`;
    }
    if (this.elapsedMinutes > this.limits.minutes) {
      return `time budget spent (${this.elapsedMinutes.toFixed(1)} of ${this.limits.minutes} minutes)`;
    }
    return undefined;
  }
}

/**
 * Meter a reasoner without it knowing.
 *
 * A DECORATOR, NOT A HOOK INSIDE THE ADAPTER. `host-agent.ts#ask` is the right
 * choke point for Mode B, but Mode A answers through a different adapter
 * entirely; wrapping once in the pipeline covers both, keeps each adapter about
 * transport, and makes the budget per-RUN rather than per-process. It also
 * meters `decompose`, which ships the whole vocabulary and is routinely the
 * single largest payload in the system.
 */
export function withBudget<R extends Reasoner>(reasoner: R, budget: RunBudget): R {
  // DELEGATES VIA THE PROTOTYPE CHAIN rather than returning a fresh literal.
  // A plain object would drop every method the interface does not name —
  // `markIngested`, `markDelivered` — and, worse, would silently fail an
  // `instanceof HostAgentReasoner` check, so the adapter-specific bookkeeping
  // would quietly never run. Nothing would report it.
  const metered: R = Object.create(reasoner);

  metered.decompose = async (goal: string, vocabulary: string[]): Promise<string[]> => {
    const answer = await reasoner.decompose(goal, vocabulary);
    budget.note({ ask: goal, payload: vocabulary, answer });
    return answer;
  };

  metered.resolve = async (decision: PendingDecision): Promise<Record<string, unknown>> => {
    const answer = await reasoner.resolve(decision);
    budget.note({ ask: decision.kind, payload: decision.context, answer });
    return answer;
  };

  return metered;
}
