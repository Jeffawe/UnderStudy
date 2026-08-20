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

/**
 * Why the vocabulary is being fetched. It changes which FACTS come back.
 *
 *   'distill'  everything. The distiller is naming a recording and may want the
 *              page map to phrase a segment consistently with the app's wording.
 *
 *   'plan'     authored facts only. `decompose` needs SEGMENT and FLOW names to
 *              phrase sub-goals against; it does not need the site's link graph,
 *              and on a real corpus that graph is the bulk of the payload.
 *              Measured on providernow: 22 mechanical claims = 6,477 chars of a
 *              9,007-char fact payload, i.e. 72% of it, none of which helps
 *              phrase a sub-goal — and it grows with every page explored.
 */
export type VocabularyPurpose = 'distill' | 'plan';

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
export async function fetchVocabulary(
  appId: string,
  opts: { facts?: number; purpose?: VocabularyPurpose } = {},
): Promise<Vocabulary> {
  const { facts: factLimit = 40, purpose = 'distill' } = opts;
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
  //
  // For planning, drop the mechanically-generated page-map claims. `explore`
  // groups an aria snapshot into claims and stores the grouping key in
  // `scope.key`, so the presence of that key is exactly "a crawler wrote this",
  // and its absence is exactly "a person or the distiller wrote this".
  //
  // Note this is NOT the same as filtering on kind or source: the authored fact
  // "Visit History is served at /uploaded-documents" is also kind='structure'
  // AND source='explored', and filtering on either would have discarded it.
  const onlyAuthored = purpose === 'plan' ? "AND (scope->'key') IS NULL" : '';
  const { rows: facts } = await pool.query<{ statement: string }>(
    `SELECT statement FROM facts
     WHERE app_id = $1 AND superseded_by IS NULL ${onlyAuthored}
     ORDER BY (kind = 'boundary') DESC, observed_count DESC
     LIMIT $2`,
    [appId, factLimit],
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
