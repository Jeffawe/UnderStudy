/**
 * The three roles that need a model. Everything else in the system is
 * deterministic code.
 *
 * Embedder and Distiller are functions: known input shape, known output shape,
 * cacheable, runnable unattended. The Reasoner is an agent: it loops, decides
 * what to do next, and can stop and ask a human. That difference is why the
 * Reasoner can be the host agent (Claude Code) and the other two can't.
 *
 * See PLAN.md.
 */

import type { Distilled, DistillRequest } from './distill.js';

export interface Embedder {
  /**
   * Stable identifier, written to the `meta` table on first use and checked on
   * every connect. Titan and mxbai are both 1024-dim but occupy unrelated
   * vector spaces — mixing them returns confident nonsense with no error, so
   * this guard is the only thing standing between you and a silently corrupt
   * corpus.
   */
  readonly id: string;

  /** Vector length. Must match the VECTOR(n) column — 1024. */
  readonly dims: number;

  /**
   * Embed text being STORED (chunk text: flow intents, step semantics, facts).
   *
   * Split from embedQuery because asymmetric models exist: mxbai wants a
   * retrieval prefix on queries but not on documents. Getting it backwards
   * doesn't error — retrieval just quietly gets worse. Two named methods make
   * that mistake impossible to make silently.
   */
  embedDocument(text: string): Promise<number[]>;

  /** Embed text being SEARCHED WITH (a sub-goal, a user's question). */
  embedQuery(text: string): Promise<number[]>;
}

/**
 * The distiller ANNOTATES; it does not author steps.
 *
 * This interface used to take a recording as a string and return a flow
 * containing `steps[]` — i.e. the model re-emitting the actions. `distill.ts`
 * superseded that: the steps are already captured by the recorder and PROVEN by
 * replay, so handing them back to a model to restate lets it silently rewrite a
 * verified selector or invent an action that never happened, with nothing
 * downstream able to tell. The request now hands over numbered, verified steps
 * and the response may only reference them BY INDEX.
 *
 * So the contract is `DistillRequest -> Distilled`, and both live in
 * `distill.ts` beside the schema and the validator that enforce them. The
 * import is type-only, so the circularity is erased at runtime.
 */
export interface Distiller {
  readonly id: string;
  distill(request: DistillRequest): Promise<Distilled>;
}

export interface PendingDecision {
  kind: 'gap' | 'seam' | 'unexpected_page' | 'finding_judgment' | 'parameter';
  context: Record<string, unknown>;
}

export interface Reasoner {
  readonly id: string;
  /** Break a goal into sub-goals, using the app's own vocabulary. */
  decompose(goal: string, vocabulary: string[]): Promise<string[]>;
  /** Answer a judgment call the deterministic executor can't make alone. */
  resolve(decision: PendingDecision): Promise<Record<string, unknown>>;
}
