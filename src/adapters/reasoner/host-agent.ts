/**
 * HostAgentReasoner — Mode B. The reasoner is the agent you are talking to.
 *
 * Deterministic code cannot call into a Claude Code session, so this adapter
 * does not compute anything. It SUSPENDS: writes a pending `context_requests`
 * row, hands back a promise, and waits for the agent to answer through a second
 * tool call.
 *
 * The executor never learns which adapter it has. It writes:
 *
 *     const subGoals = await reasoner.decompose(goal, vocabulary);
 *
 * and in Mode A that resolves from a Bedrock call in ~2s, while here it
 * resolves whenever `answer()` arrives — seconds or minutes later. Same
 * signature, same await, entirely different mechanics. That is the whole point
 * of the adapter boundary.
 *
 * WHY IN-MEMORY, unlike distillation. Distilling has no live state, so it splits
 * cleanly across two independent calls. A run holds an OPEN BROWSER sitting on a
 * particular page; that cannot be serialised, so the process must stay alive and
 * hold the promise. A dead process therefore abandons its runs — recorded in
 * `runs.status`, and a deliberate trade rather than an oversight.
 */

import { randomUUID } from 'node:crypto';
import { getPool } from '../../core/db.js';
import type { PendingDecision, Reasoner } from '../../core/types.js';
import type { Vocabulary } from '../../core/vocabulary.js';

export interface SuspendedRequest {
  requestId: string;
  kind: 'decision';
  /** What the agent is being asked, in one line. */
  ask: string;
  reason: string;
  payload: Record<string, unknown>;
}

type Deferred = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export class HostAgentReasoner implements Reasoner {
  readonly id = 'host-agent';

  #pending = new Map<string, Deferred>();
  #request: SuspendedRequest | undefined;
  /** Resolves the moment a new request goes pending, so a caller can return. */
  #announce: ((r: SuspendedRequest) => void) | undefined;

  constructor(
    private readonly appId: string,
    private readonly runId?: string,
  ) {}

  /** The request currently waiting for an answer, if any. */
  get pending(): SuspendedRequest | undefined {
    return this.#request;
  }

  /**
   * Wait until either a request goes pending or `settled` finishes.
   *
   * This is what lets a tool call return promptly: `run_plan` must NOT block
   * waiting for a human, so it races the pipeline against its own next
   * suspension and returns whichever happens first.
   */
  async nextSuspensionOr<T>(settled: Promise<T>): Promise<{ suspended: SuspendedRequest } | { done: T }> {
    if (this.#request) return { suspended: this.#request };

    const suspension = new Promise<{ suspended: SuspendedRequest }>((resolve) => {
      this.#announce = (r) => resolve({ suspended: r });
    });
    return Promise.race([suspension, settled.then((done) => ({ done }))]);
  }

  /** Answer the outstanding request and let the pipeline continue. */
  answer(requestId: string, value: unknown): boolean {
    const deferred = this.#pending.get(requestId);
    if (!deferred) return false;

    this.#pending.delete(requestId);
    this.#request = undefined;
    void this.#mark(requestId, value);
    deferred.resolve(value);
    return true;
  }

  /** Abandon everything outstanding — used when a run is cancelled. */
  abandon(reason: string): void {
    for (const [, d] of this.#pending) d.reject(new Error(reason));
    this.#pending.clear();
    this.#request = undefined;
  }

  async decompose(goal: string, vocabulary: string[]): Promise<string[]> {
    const answer = await this.#ask({
      ask: `Split this goal into sub-goals, phrased in the app's own vocabulary: "${goal}"`,
      reason:
        'A goal phrased in the user\'s words retrieves badly. Rewriting it into the ' +
        'vocabulary the corpus already uses is what makes recall find the right segments.',
      payload: {
        goal,
        vocabulary,
        expects: { subGoals: ['string, one per step, in the vocabulary above'] },
      },
    });

    const subGoals = (answer as { subGoals?: unknown })?.subGoals;
    if (!Array.isArray(subGoals) || !subGoals.every((s) => typeof s === 'string' && s.trim())) {
      throw new Error('decompose expected { subGoals: string[] }');
    }
    return subGoals as string[];
  }

  async resolve(decision: PendingDecision): Promise<Record<string, unknown>> {
    const answer = await this.#ask({
      ask: `The executor needs a decision: ${decision.kind}`,
      reason: 'Deterministic code cannot make this judgement call.',
      payload: { kind: decision.kind, ...decision.context },
    });
    return (answer ?? {}) as Record<string, unknown>;
  }

  // -------------------------------------------------------------------------

  async #ask(spec: { ask: string; reason: string; payload: Record<string, unknown> }): Promise<unknown> {
    const requestId = randomUUID();

    // The row is durability and visibility: you can see what a run is waiting
    // on from SQL, even though the promise itself lives in this process.
    await getPool()
      .query(
        `INSERT INTO context_requests (request_id, app_id, run_id, kind, status, reason, ask, payload)
         VALUES ($1,$2,$3,'decision','pending',$4,$5,$6)`,
        [requestId, this.appId, this.runId ?? null, spec.reason, spec.ask, JSON.stringify(spec.payload)],
      )
      .catch(() => {
        // A missing row must not sink a run; the in-memory deferred is what
        // actually gates execution.
      });

    const request: SuspendedRequest = { requestId, kind: 'decision', ...spec };
    this.#request = request;

    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });

    this.#announce?.(request);
    this.#announce = undefined;

    return promise;
  }

  /**
   * Record the answer on the request row.
   *
   * There is no `answered_at` column — `status` plus the stored `answer` is the
   * record. Writing to a column that does not exist would have failed silently
   * inside the catch below, which is exactly the kind of quiet no-op worth not
   * shipping.
   */
  async #mark(requestId: string, answer: unknown): Promise<void> {
    await getPool()
      .query(
        `UPDATE context_requests SET status = 'answered', answer = $2 WHERE request_id = $1`,
        [requestId, JSON.stringify(answer ?? null)],
      )
      .catch(() => {});
  }
}

/** Flatten a Vocabulary into the lines a reasoner should phrase goals in. */
export function vocabularyLines(v: Vocabulary): string[] {
  return [
    ...v.segments.map((s) => `segment: ${s.intent} (${s.slug})`),
    ...v.flows.map((f) => `flow: ${f.intent || f.title} (${f.slug})`),
    ...v.facts.slice(0, 20).map((f) => `fact: ${f}`),
  ];
}
