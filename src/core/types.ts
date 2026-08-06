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

export interface DistilledStep {
  action: string;
  role?: string;
  name?: string;
  testId?: string;
  css?: string;
  frameHint?: string;
  valueRef?: string;
  valueParam?: string;
  args?: Record<string, unknown>;
  semantic: string;
  stateAfter?: string;
}

export interface DistilledSegment {
  slug: string;
  title: string;
  intent: string;
  /** Indices into the flat steps[] array — segments are boundaries, not copies. */
  stepRange: [number, number];
}

export interface DistilledFlow {
  intent: string;
  preconditions: string[];
  outcome: string;
  steps: DistilledStep[];
  segments: DistilledSegment[];
  candidateLessons: Array<{ kind: string; title: string; body: string; trigger: Record<string, unknown> }>;
  /** What the distiller fixed in the raw recording, and why. */
  corrections: Array<{ rule: string; detail: string; stepIndex?: number }>;
}

export interface Distiller {
  readonly id: string;
  distill(recording: string, context: string): Promise<DistilledFlow>;
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
