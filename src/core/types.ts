/**
 * The pause-and-ask contract. Deterministic code never calls a model: when it
 * reaches a judgement it can't make alone, it suspends with a PendingDecision,
 * and whoever is consulted (an agent over MCP) answers it.
 *
 * Embeddings live in src/store/embed.ts; the distill contract in distill.ts.
 */

export interface PendingDecision {
  kind:
    | 'gap'
    | 'seam'
    | 'unexpected_page'
    // A step that FAILED, as distinct from one that landed somewhere odd. Both
    // used to be sent as 'unexpected_page', which made the stored payloads
    // unreadable and the escalation counts meaningless.
    | 'step_failed'
    | 'visual_diff'
    | 'finding_judgment'
    | 'parameter'
    /**
     * The executor is stuck and wants a human to RECORD the missing piece.
     *
     * Deliberately not 'gap': that word already means a RETRIEVAL gap — top
     * distance at or above GAP_DISTANCE, a statement about the corpus made at
     * planning time (see REASONER.md). This is an execution-time statement
     * about a live browser sitting on a known page, and overloading the word
     * would make the one document that matters ambiguous.
     */
    | 'needs_capture';
  context: Record<string, unknown>;
}

export interface Reasoner {
  readonly id: string;
  /** Break a goal into sub-goals, using the app's own vocabulary. */
  decompose(goal: string, vocabulary: string[]): Promise<string[]>;
  /** Answer a judgment call the deterministic executor can't make alone. */
  resolve(decision: PendingDecision): Promise<Record<string, unknown>>;
}
