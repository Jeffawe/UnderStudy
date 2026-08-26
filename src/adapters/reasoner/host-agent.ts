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
  /**
   * Which QUEUE this belongs to, not which question it is.
   *
   * `record_flow` has been in the schema CHECK since the first migration and had
   * never been written. It is what makes
   * `WHERE kind='record_flow' AND status='pending'` a real, operator-visible
   * queue of "runs waiting for a human to record something" — the stated reason
   * for writing the row at all.
   */
  kind: 'decision' | 'record_flow';
  /** The decision kind, so an answer can be validated against the question. */
  decisionKind?: PendingDecision['kind'];
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

  /**
   * Why an answer does not fit the question it was given.
   *
   * `decompose` used to THROW on a shape mismatch, which killed the run — a
   * typo in one tool call and twenty minutes of execution was gone. Since the
   * request now carries its own kind, the mismatch can be described and asked
   * again instead.
   */
  static misfit(kind: PendingDecision['kind'] | undefined, value: unknown): string | undefined {
    const v = (value ?? {}) as Record<string, unknown>;
    if (kind === 'gap') {
      const ok = Array.isArray(v.subGoals) && v.subGoals.every((x) => typeof x === 'string' && x.trim());
      return ok ? undefined : 'expected { subGoals: string[] }';
    }
    if (kind === 'needs_capture') {
      if (typeof v.recordingHash === 'string' && v.recordingHash.trim()) return undefined;
      if (v.action === 'skip' || v.action === 'abort') return undefined;
      return "expected { recordingHash: \"…\" }, or { action: 'skip' | 'abort' }";
    }
    if (kind === 'visual_diff') {
      return Array.isArray(v.verdicts) ? undefined : 'expected { verdicts: [...] }';
    }
    return undefined;
  }

  /** The kind of the outstanding question, for validating what comes back. */
  get pendingKind(): PendingDecision['kind'] | undefined {
    return this.#request?.decisionKind;
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
      decisionKind: 'gap',
    });

    // Still guarded, but this is now the LAST line of defence rather than the
    // only one: `resumeRun` validates the shape before it ever reaches here and
    // re-asks, so a mistyped answer costs one more question, not the run.
    const subGoals = (answer as { subGoals?: unknown })?.subGoals;
    if (!Array.isArray(subGoals) || !subGoals.every((s) => typeof s === 'string' && s.trim())) {
      throw new Error('decompose expected { subGoals: string[] }');
    }
    return subGoals as string[];
  }

  async resolve(decision: PendingDecision): Promise<Record<string, unknown>> {
    const wantsCapture = decision.kind === 'needs_capture';
    const answer = await this.#ask({
      ask: wantsCapture
        ? 'The executor is stuck and needs a flow RECORDED before it can continue'
        : `The executor needs a decision: ${decision.kind}`,
      reason: wantsCapture
        ? 'No amount of retrying reaches this state — a human has to drive it once.'
        : 'Deterministic code cannot make this judgement call.',
      payload: { kind: decision.kind, ...decision.context },
      ...(wantsCapture ? { kind: 'record_flow' as const } : {}),
      decisionKind: decision.kind,
    });
    return (answer ?? {}) as Record<string, unknown>;
  }

  /** Mark the request as handed to the agent — the 'delivered' the schema always had. */
  async markDelivered(requestId: string): Promise<void> {
    await getPool()
      .query(
        // Guarded on 'pending' so a fast answer is never clobbered by a slow
        // delivery write landing after it.
        `UPDATE context_requests SET status = 'delivered'
         WHERE request_id = $1 AND status = 'pending'`,
        [requestId],
      )
      .catch(() => {});
  }

  /**
   * Record what the answer actually PRODUCED, once it has been applied.
   *
   * Addressed by RUN rather than by request id, because the id is consumed
   * inside `resolve()` and threading it back out would mean leaking the
   * suspension mechanics into the pipeline. The newest answered `record_flow`
   * row for a run is unambiguously the one that just came back — a run only
   * ever has one outstanding.
   */
  async markIngested(produced: Record<string, unknown>): Promise<void> {
    if (!this.runId) return;
    await getPool()
      .query(
        `UPDATE context_requests SET status = 'ingested', produced = $2
         WHERE request_id = (
           SELECT request_id FROM context_requests
           WHERE run_id = $1 AND kind = 'record_flow' AND status = 'answered'
           ORDER BY created_at DESC LIMIT 1
         )`,
        [this.runId, JSON.stringify(produced)],
      )
      .catch(() => {});
  }

  // -------------------------------------------------------------------------

  async #ask(spec: {
    ask: string;
    reason: string;
    payload: Record<string, unknown>;
    kind?: 'decision' | 'record_flow';
    decisionKind?: PendingDecision['kind'];
  }): Promise<unknown> {
    const requestId = randomUUID();
    const kind = spec.kind ?? 'decision';

    // The row is durability and visibility: you can see what a run is waiting
    // on from SQL, even though the promise itself lives in this process.
    await getPool()
      .query(
        `INSERT INTO context_requests (request_id, app_id, run_id, kind, status, reason, ask, payload)
         VALUES ($1,$2,$3,$4,'pending',$5,$6,$7)`,
        [requestId, this.appId, this.runId ?? null, kind, spec.reason, spec.ask, JSON.stringify(spec.payload)],
      )
      .catch(() => {
        // A missing row must not sink a run; the in-memory deferred is what
        // actually gates execution.
      });

    const request: SuspendedRequest = {
      requestId,
      kind,
      ask: spec.ask,
      reason: spec.reason,
      payload: spec.payload,
      ...(spec.decisionKind ? { decisionKind: spec.decisionKind } : {}),
    };
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
