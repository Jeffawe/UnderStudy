/**
 * The app's own vocabulary — what it already calls things.
 *
 * Used at BOTH ends of the system, deliberately by the same function:
 *
 *   distill time  so a second recording of the same login block reuses the
 *                 existing wording instead of minting a synonym. Two segments
 *                 that mean one thing fragment retrieval, compete for the same
 *                 bind slot, and quietly break "a login block captured while
 *                 recording checkout is reusable by every future flow".
 *
 *   test time     so `decompose` can rewrite a goal INTO this vocabulary before
 *                 recall runs. That is the documented answer to the polarity
 *                 problem: "sign in to the app" retrieves badly, "Log in as a
 *                 standard user" retrieves well, and the difference is whether
 *                 the query speaks the corpus's language.
 *
 * One source of truth for both, so the words the distiller writes are exactly
 * the words the planner later searches with.
 */

import { getPool } from './db.js';

export interface VocabularySegment {
  slug: string;
  title: string;
  intent: string;
  steps: number;
  preconditions: string[];
  outcome: string | null;
}

export interface Vocabulary {
  /** Reusable segments — the primary vocabulary, what a sub-goal binds to. */
  segments: VocabularySegment[];
  /** Whole recorded flows, for coarser matches. */
  flows: Array<{ slug: string; title: string; intent: string }>;
  /** What is known to be true about the app, phrased as the corpus phrases it. */
  facts: string[];
}

/**
 * Fetch it. Deliberately SQL and nothing else — no embedding, no model. This
 * runs before the reasoner is consulted, and it must be cheap enough to run on
 * every goal.
 */
export async function fetchVocabulary(appId: string, limits = { facts: 40 }): Promise<Vocabulary> {
  const pool = getPool();

  const { rows: segments } = await pool.query<{
    slug: string;
    title: string;
    intent: string;
    steps: string | number;
    preconditions: string[];
    outcome: string | null;
  }>(
    `SELECT f.slug, f.title, f.intent, f.preconditions, f.outcome,
            (SELECT count(*) FROM flow_steps fs WHERE fs.flow_id = f.flow_id) AS steps
     FROM flows f
     WHERE f.app_id = $1 AND f.source = 'sliced' AND NOT f.needs_review
     ORDER BY f.slug`,
    [appId],
  );

  const { rows: flows } = await pool.query<{ slug: string; title: string; intent: string }>(
    `SELECT slug, title, intent FROM flows
     WHERE app_id = $1 AND source = 'recorded' AND NOT needs_review
     ORDER BY slug`,
    [appId],
  );

  // Boundary facts first: they are the ones that say what is NOT known or NOT
  // safe, which is the context most likely to change a decision.
  const { rows: facts } = await pool.query<{ statement: string }>(
    `SELECT statement FROM facts
     WHERE app_id = $1 AND superseded_by IS NULL
     ORDER BY (kind = 'boundary') DESC, observed_count DESC
     LIMIT $2`,
    [appId, limits.facts],
  );

  return {
    segments: segments.map((s) => ({
      slug: s.slug,
      title: s.title,
      intent: s.intent,
      steps: Number(s.steps),
      preconditions: Array.isArray(s.preconditions) ? s.preconditions : [],
      outcome: s.outcome,
    })),
    flows,
    facts: facts.map((f) => f.statement),
  };
}
