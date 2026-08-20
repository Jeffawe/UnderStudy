/**
 * recall() — semantic retrieval over the memory plane.
 *
 * One ANN scan returns every kind of knowledge at once: segments, facts,
 * lessons, findings. That is deliberate, and it's why `kind` is NOT a vector
 * index prefix column — adding it would fragment the index and make a mixed
 * retrieval into N scans. `app_id` is the only prefix; everything else is
 * filtered after the scan, which is what the over-fetch pays for.
 *
 * The shape is: over-fetch wide → re-rank on signals the index can't express →
 * cut to the requested size. The re-rank is arithmetic, not a model.
 *
 * THE DISTANCE IS THE CONFIDENCE SIGNAL. `top_distance` and `margin` are the
 * two numbers gap detection runs on, so they are reported RAW — the re-rank
 * reorders results but never rewrites the distances used to decide "do I
 * actually know this?". Mixing those up would let a health bonus disguise a
 * chunk the system has never really seen.
 */

import type pg from 'pg';
import { getPool } from './db.js';
import type { Embedder } from './types.js';

/** How many rows to pull from the ANN scan before re-ranking. */
const OVER_FETCH = 60;

/**
 * Re-rank weights. Score is a DISTANCE — lower is better — so a bonus
 * subtracts and a penalty adds.
 */
const W_HEALTH = 0.15; // proven selectors beat unproven ones
const W_RECENCY = 0.1; // fresh knowledge beats stale knowledge
const W_DESTRUCTIVE = 0.5; // in an env that forbids spend, push these away
const RECENCY_TAU_DAYS = 14; // e-folding time for the recency bonus

/**
 * GAP DETECTION — "do I actually know this?"
 *
 * Two independent signals, because they catch different failures:
 *   · topDistance too far  → nothing in memory resembles the goal
 *   · margin too small     → five things matched equally well, which is
 *                            ambiguity wearing confidence's clothes
 *
 * Both are measured over BINDABLE rows only — see RecallResult.topDistance.
 *
 * PROVISIONAL. Measured on a 9-chunk synthetic saucedemo corpus
 * (`npm run recall:check`, 2026-08-06):
 *
 *   known   "test login"                  0.8586
 *   known   "sign in to the app"          0.8014
 *   known   "buy something and check out" 0.7789
 *   unknown "configure SAML idp"          0.9628
 *   unknown "export quarterly revenue"    1.0589
 *
 * Known clusters ≤0.86, unknown ≥0.96, and the band between is empty — so the
 * plan's 0.85 sits just INSIDE the known cluster and would reject "test login",
 * the most canonical query in the demo. 0.92 is the midpoint of the observed
 * gap. Re-derive both numbers against the real corpus once `explore` has run;
 * a 9-row corpus cannot validate a margin computed over the top 5.
 */
export const GAP_DISTANCE = 0.92;
export const GAP_MARGIN = 0.05;

/** True when the goal should trigger an ask instead of a guess. */
export function isGap(r: Pick<RecallResult, 'topDistance' | 'margin'>): boolean {
  if (r.topDistance === null) return true;
  if (r.topDistance > GAP_DISTANCE) return true;
  return r.margin !== null && r.margin < GAP_MARGIN;
}

export type ChunkKind =
  | 'flow'
  | 'segment'
  | 'step'
  | 'lesson'
  | 'selector'
  | 'fact'
  | 'finding'
  | 'session_summary'
  | 'answer';

export interface RecalledChunk {
  chunkId: string;
  kind: ChunkKind;
  refId: string;
  flowId: string | null;
  text: string;
  meta: Record<string, unknown>;
  health: number;
  destructive: boolean;
  updatedAt: Date;
  /** Raw L2 distance from the ANN scan. The confidence signal. */
  distance: number;
  /** Distance after re-rank. Ordering only — never a confidence claim. */
  score: number;
}

/**
 * Kinds that can be RUN. A sub-goal binds to one of these or to nothing.
 *
 * The executor already switches on `kind` to decide whether it's walking a
 * whole flow, a segment, or a single step — this is that same distinction,
 * made once here instead of re-derived at every call site.
 *
 * Everything else is CONTEXT: a fact states that something is true, a lesson
 * says what to do first, a finding says something is broken. All three inform
 * execution; none of them IS execution. They have no steps to walk.
 */
export const EXECUTABLE_KINDS = ['flow', 'segment', 'step'] as const;

export const isExecutable = (k: ChunkKind): boolean =>
  (EXECUTABLE_KINDS as readonly string[]).includes(k);

export interface RecallResult {
  /** Everything retrieved, re-ranked. Both lists below are drawn from this. */
  chunks: RecalledChunk[];
  /**
   * Executable hits, best first. This is what a sub-goal binds to.
   */
  bindable: RecalledChunk[];
  /**
   * Facts, lessons, findings — retrieved alongside rather than competing for
   * the bind slot. The planner passes these to the reasoner as context.
   */
  context: RecalledChunk[];
  /**
   * Raw distance of the best BINDABLE hit. Gap detection: `> threshold` means
   * "I don't know how to do this" and triggers asking rather than guessing.
   *
   * Measured over bindable rows specifically, because a fact can easily be the
   * closest thing in the corpus while the nearest runnable segment is far
   * away — reporting the fact's distance would claim confidence about a goal
   * the system cannot actually carry out.
   */
  topDistance: number | null;
  /**
   * dist[4] − dist[0] across the bindable set. A small margin means five
   * runnable things matched equally well, which is ambiguity, not confidence —
   * it triggers an ask even when topDistance looks fine.
   */
  margin: number | null;
  /** Rows the ANN scan returned before filtering and cutting. */
  scanned: number;
}

export interface RecallOptions {
  /** Restrict to these kinds. Omitted means all — the usual case at planning time. */
  kinds?: ChunkKind[];
  /** Results to return after re-rank. */
  limit?: number;
  /**
   * False when the target environment forbids purchases or irreversible
   * actions, which penalizes destructive chunks so a safe alternative wins if
   * one exists. It does NOT filter them out — the safety gate decides that,
   * and it needs to see them to say why it refused.
   */
  allowsSpend?: boolean;
  /** Override the scan width. */
  overFetch?: number;
}

interface ScanRow {
  chunk_id: string;
  kind: ChunkKind;
  ref_id: string;
  flow_id: string | null;
  text: string;
  meta: Record<string, unknown>;
  health: number;
  destructive: boolean;
  updated_at: Date;
  dist: number;
}

/** pgvector literal. `<->` needs a vector, and a JS array won't bind as one. */
export const toVector = (v: number[]): string => `[${v.join(',')}]`;

/**
 * Retrieve for a query string. Embeds with embedQuery — NOT embedDocument —
 * because mxbai is asymmetric and using the wrong one silently degrades every
 * distance in the result, including the ones gap detection trusts.
 */
export async function recall(
  embedder: Embedder,
  appId: string,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallResult> {
  const vec = await embedder.embedQuery(query);
  return recallByVector(appId, vec, opts);
}

/** Same retrieval against an already-embedded vector — avoids re-embedding. */
export async function recallByVector(
  appId: string,
  queryVector: number[],
  opts: RecallOptions = {},
  client?: pg.PoolClient,
): Promise<RecallResult> {
  const { kinds, limit = 10, allowsSpend = true, overFetch = OVER_FETCH } = opts;

  const runner = client ?? getPool();
  const literal = toVector(queryVector);

  // The ANN scan is its own CTE so LIMIT applies to the vector search itself.
  // Filtering inside that scan would cut rows the index already ranked and
  // leave fewer than requested; filtering after it is what over-fetch is for.
  //
  // Quarantined selectors are dropped here rather than in JS because the join
  // is cheap on 60 rows and a quarantined element should never reach the
  // re-rank at all — it isn't a low-confidence answer, it's a known-broken one.
  const { rows } = await runner.query<ScanRow>(
    `WITH ann AS (
       SELECT chunk_id, kind, ref_id, flow_id, text, meta,
              health, destructive, updated_at,
              embedding <-> $1::VECTOR(1024) AS dist
       FROM memory_chunks
       WHERE app_id = $2
       ORDER BY embedding <-> $1::VECTOR(1024)
       LIMIT $3
     )
     SELECT * FROM ann
     WHERE ($4::STRING[] IS NULL OR kind = ANY($4::STRING[]))
       AND NOT EXISTS (
         SELECT 1 FROM selectors s
         WHERE s.selector_id = ann.ref_id
           AND ann.kind = 'selector'
           AND s.quarantined
       )
     ORDER BY dist`,
    [literal, appId, overFetch, kinds ?? null],
  );

  const now = Date.now();
  const ranked: RecalledChunk[] = rows
    .map((r) => {
      const ageDays = (now - new Date(r.updated_at).getTime()) / 86_400_000;

      // Exponential, not linear: knowledge goes stale fast at first and then
      // plateaus. A linear decay would eventually make old-but-still-correct
      // memory score worse than a fresh wrong guess.
      const recency = Math.exp(-Math.max(ageDays, 0) / RECENCY_TAU_DAYS);

      const score =
        Number(r.dist) -
        W_HEALTH * Number(r.health) -
        W_RECENCY * recency +
        (r.destructive && !allowsSpend ? W_DESTRUCTIVE : 0);

      return {
        chunkId: r.chunk_id,
        kind: r.kind,
        refId: r.ref_id,
        flowId: r.flow_id,
        text: r.text,
        meta: r.meta ?? {},
        health: Number(r.health),
        destructive: r.destructive,
        updatedAt: new Date(r.updated_at),
        distance: Number(r.dist),
        score,
      };
    })
    .sort((a, b) => a.score - b.score);

  // Split BEFORE slicing. Facts are often the closest thing in the corpus, so
  // cutting to `limit` first can leave zero runnable rows and make a goal look
  // like a gap purely because context crowded it out of the window.
  // A MINED MACRO IS NEVER WHAT A GOAL BINDS TO.
  //
  // Macros are stored with kind 'segment', so kind alone made them bindable —
  // and this has now bitten the planner four separate times (see plan.ts: a
  // 0.4124 match losing to a 0.8936 macro; a macro bound for a cart goal it
  // never touches; "reset my password" and "log in as a member" both taken from
  // real named segments by the login preamble block).
  //
  // Improving their text was necessary and fixed the pathological case — a
  // 29-step blob that matched "cancel my weight loss subscription" at 0.7915 —
  // but it cannot fix this, and made it sharper: crisper mechanical text
  // competes BETTER against real intents. That is the actual problem. Mining
  // knows a block recurs; it cannot know what it is for. A description of
  // mechanics should never outrank a description of purpose, at any distance.
  //
  // This is the module's own stated rule ("it must never compete with a segment
  // that has one") finally applied where it was always needed. Macros stay in
  // `chunks` and keep their rows, so the seam ladder — which selects them
  // directly via source IN ('sliced','mined') — is unaffected. They lose the
  // right to ANSWER a goal, not the right to exist.
  const isMined = (c: RecalledChunk) => c.meta?.source === 'mined';

  const bindable = ranked.filter((c) => isExecutable(c.kind) && !isMined(c)).slice(0, limit);
  const context = ranked.filter((c) => !isExecutable(c.kind) || isMined(c)).slice(0, limit);

  // Both numbers come from RAW distances over the BINDABLE set. The re-rank
  // decides what to show; it does not get to claim confidence it didn't earn,
  // and neither does a fact standing in for a segment nobody can run.
  const topDistance = bindable.length ? bindable[0]!.distance : null;
  const margin =
    bindable.length >= 5 ? bindable[4]!.distance - bindable[0]!.distance : null;

  return {
    chunks: ranked.slice(0, limit),
    bindable,
    context,
    topDistance,
    margin,
    scanned: rows.length,
  };
}
