/**
 * Macro mining — discover the refactor nobody did.
 *
 * Steps carry `fingerprint = sha1(action|role|name|url_pattern)`, so two
 * recordings that do the same thing produce byte-identical runs of
 * fingerprints. Find a run of >= 3 that appears in >= 2 flows and you have
 * found a block the app repeats — a login preamble, an address form, an OTP
 * dance — without anyone naming it.
 *
 * This is the deterministic backstop for distillation. A distiller only ever
 * sees ONE recording, so it cannot know that recording B opens with the same
 * twenty steps as recording A. Vocabulary helps it reuse a name when it
 * notices; mining notices whether or not it does.
 *
 * CONTIGUOUS RUNS, NOT SUBSEQUENCES. The master plan says "common
 * subsequences", but a macro has to be RUNNABLE, and a non-contiguous
 * subsequence is not a block you can execute — it is a pattern with holes.
 * So this finds common *substrings* over the fingerprint sequence.
 *
 * IT DEFERS TO NAMED SEGMENTS. If a distilled segment already covers exactly
 * this run of steps, mining bumps its `used_by` and creates nothing. A mined
 * macro can only describe itself mechanically ("a block that recurs"), which
 * retrieves far worse than a real intent — so it must never compete with a
 * segment that has one.
 */

import type pg from 'pg';
import { getPool, tx } from './db.js';
import { toVector } from './recall.js';
import type { Embedder } from './types.js';

/** Shortest run worth calling a macro. Two steps is a coincidence. */
const MIN_LENGTH = 3;
/** A block seen in only one flow is not yet a pattern. */
const MIN_FLOWS = 2;

interface FlowSteps {
  flowId: string;
  slug: string;
  fingerprints: string[];
  stepIds: string[];
  semantics: string[];
  /** sig() after each step — '/overview#ab12cd34'. Route span comes from these. */
  states: Array<string | null>;
}

/** How many step descriptions a macro's text may carry. See macroText. */
const TEXT_STEPS = 6;

/**
 * What a mined macro says about itself.
 *
 * THE OLD TEXT WAS TWO BUGS AT ONCE, and both are the averaging failure this
 * codebase already diagnosed for facts.
 *
 *   1. It opened with "A block of N steps that recurs in M recorded flows",
 *      which is boilerplate: semantically empty, and IDENTICAL across every
 *      macro. Every macro's embedding was dragged toward one shared centroid,
 *      and toward any query, because generic English is near everything.
 *   2. It then concatenated EVERY step's semantic. A 29-step macro became a
 *      wall of "Go to …; Click the "Login"; Fill the textbox …", which averages
 *      into a vector that is mediocre for every query and wrong for some. That
 *      is how "cancel my weight loss subscription" bound at 0.7915 to a block
 *      that neither cancels nor subscribes — it merely contains the word-shapes
 *      of a weight loss flow.
 *
 * So: no preamble, the ROUTE SPAN first (where this block takes you is the most
 * intent-like thing mining can honestly know), then a capped, deduplicated set
 * of the steps that actually name something. Mining still does not know what a
 * block is FOR — nothing here pretends otherwise — but it can describe what it
 * does without smearing.
 */
function macroText(semantics: string[], states: Array<string | null>): string {
  const route = states
    .map((s) => s?.split('#')[0])
    .filter((p): p is string => Boolean(p));
  const from = route[0];
  const to = route[route.length - 1];

  const span = from && to ? (from === to ? `Within ${from}` : `From ${from} to ${to}`) : 'Recorded steps';

  // Named controls carry the meaning; a bare "Click the element" carries none.
  // Dedupe because intake forms repeat "None of the above" and "No" many times,
  // and a repeated phrase would otherwise dominate the average.
  const named = [...new Set(semantics.filter((s) => /"[^"]+"/.test(s)))];
  const chosen = (named.length ? named : [...new Set(semantics)]).slice(0, TEXT_STEPS);

  return `${span}: ${chosen.join('; ')}`;
}

interface Candidate {
  key: string;
  length: number;
  /** flow_id -> offset at which the run starts in that flow. */
  occurrences: Map<string, number>;
}

export interface MinedMacro {
  slug: string;
  length: number;
  usedBy: number;
  created: boolean;
  /** Set when an existing named segment already covered this run. */
  deferredTo?: string;
}

export interface MineResult {
  flowsScanned: number;
  candidates: number;
  macros: MinedMacro[];
  /** Macros deleted because this pass no longer found their block. */
  retired: number;
}

/**
 * Every contiguous window of length >= MIN_LENGTH, keyed by its fingerprint
 * run. O(n^2) per flow, which the plan notes is ~2ms at this size — brute force
 * is the right call for a corpus of tens of flows.
 */
function windowsOf(flow: FlowSteps): Map<string, number> {
  const out = new Map<string, number>();
  const n = flow.fingerprints.length;
  for (let start = 0; start + MIN_LENGTH <= n; start++) {
    for (let end = start + MIN_LENGTH; end <= n; end++) {
      const key = flow.fingerprints.slice(start, end).join('>');
      // First occurrence wins: if a flow repeats a block internally, one
      // position is enough to splice from.
      if (!out.has(key)) out.set(key, start);
    }
  }
  return out;
}

/**
 * Drop candidates that are strictly contained in a longer candidate covering
 * the same flows. Without this, a 20-step login block also reports as 18
 * shorter sub-blocks and the corpus fills with nested near-duplicates.
 */
function maximalOnly(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.length - a.length);
  const kept: Candidate[] = [];

  for (const c of sorted) {
    const flowsOf = (x: Candidate) => [...x.occurrences.keys()].sort().join(',');
    const subsumed = kept.some(
      (k) => k.key.includes(c.key) && flowsOf(k) === flowsOf(c),
    );
    if (!subsumed) kept.push(c);
  }
  return kept;
}

export async function mineMacros(embedder: Embedder, appId: string): Promise<MineResult> {
  const pool = getPool();

  // Mine over RECORDED flows only. Segments are slices of those same flows, so
  // including them would rediscover every segment as a "shared" block with its
  // own parent.
  const { rows } = await pool.query<{
    flow_id: string;
    slug: string;
    ordinal: number;
    step_id: string;
    fingerprint: string;
    semantic: string;
    state_after: string | null;
  }>(
    `SELECT f.flow_id, f.slug, fs.ordinal, s.step_id, s.fingerprint, s.semantic, s.state_after
     FROM flows f
     JOIN flow_steps fs ON fs.flow_id = f.flow_id
     JOIN steps s ON s.step_id = fs.step_id
     WHERE f.app_id = $1 AND f.source = 'recorded' AND NOT f.needs_review
     ORDER BY f.flow_id, fs.ordinal`,
    [appId],
  );

  const flows = new Map<string, FlowSteps>();
  for (const r of rows) {
    const f = flows.get(r.flow_id) ?? {
      flowId: r.flow_id,
      slug: r.slug,
      fingerprints: [],
      stepIds: [],
      semantics: [],
      states: [],
    };
    f.fingerprints.push(r.fingerprint);
    f.stepIds.push(r.step_id);
    f.semantics.push(r.semantic);
    f.states.push(r.state_after);
    flows.set(r.flow_id, f);
  }

  if (flows.size < MIN_FLOWS) {
    return { flowsScanned: flows.size, candidates: 0, macros: [], retired: 0 };
  }

  // Count how many distinct flows contain each window.
  const byKey = new Map<string, Candidate>();
  for (const flow of flows.values()) {
    for (const [key, offset] of windowsOf(flow)) {
      const c = byKey.get(key) ?? { key, length: key.split('>').length, occurrences: new Map() };
      c.occurrences.set(flow.flowId, offset);
      byKey.set(key, c);
    }
  }

  const shared = [...byKey.values()].filter((c) => c.occurrences.size >= MIN_FLOWS);
  const candidates = maximalOnly(shared);

  // What runs of steps do existing NAMED segments already cover? A mined macro
  // must never compete with a segment that has a real intent.
  const { rows: segRows } = await pool.query<{ flow_id: string; slug: string; fps: string[] }>(
    `SELECT f.flow_id, f.slug,
            array_agg(s.fingerprint ORDER BY fs.ordinal) AS fps
     FROM flows f
     JOIN flow_steps fs ON fs.flow_id = f.flow_id
     JOIN steps s ON s.step_id = fs.step_id
     WHERE f.app_id = $1 AND f.source = 'sliced' AND NOT f.needs_review
     GROUP BY f.flow_id, f.slug`,
    [appId],
  );
  const namedByKey = new Map(segRows.map((r) => [r.fps.join('>'), { flowId: r.flow_id, slug: r.slug }]));

  const macros: MinedMacro[] = [];

  for (const [i, c] of candidates.entries()) {
    const usedBy = c.occurrences.size;
    const already = namedByKey.get(c.key);

    if (already) {
      // A human-meaningful name beats a mechanical one. Record that the block
      // recurs and leave the segment alone.
      await pool.query('UPDATE flows SET used_by = $2, updated_at = now() WHERE flow_id = $1', [
        already.flowId,
        usedBy,
      ]);
      macros.push({ slug: already.slug, length: c.length, usedBy, created: false, deferredTo: already.slug });
      continue;
    }

    // Take the step rows from the first flow that contains the run. They are
    // shared through flow_steps, exactly as distilled segments share them —
    // a macro is another view over the same steps, not a copy of them.
    const [firstFlowId, offset] = [...c.occurrences.entries()][0]!;
    const source = flows.get(firstFlowId)!;
    const stepIds = source.stepIds.slice(offset, offset + c.length);
    const semantics = source.semantics.slice(offset, offset + c.length);
    const states = source.states.slice(offset, offset + c.length);

    const slug = `macro-${c.key.slice(0, 8)}-${c.length}`;
    // Describes what the block DOES, without boilerplate and without smearing
    // every step into one average. The "recurs in N flows" bookkeeping lives in
    // the title and the chunk meta, where it informs without being embedded.
    const text = macroText(semantics, states);

    const vector = await embedder.embedDocument(text);

    const created = await tx(async (client: pg.PoolClient) => {
      const { rows: mr } = await client.query<{ flow_id: string }>(
        `INSERT INTO flows (app_id, slug, title, intent, source, is_macro, used_by)
         VALUES ($1,$2,$3,$4,'mined',true,$5)
         ON CONFLICT (app_id, slug) DO UPDATE
           SET used_by = excluded.used_by, intent = excluded.intent, updated_at = now()
         RETURNING flow_id`,
        [appId, slug, `Recurring block (${c.length} steps)`, text, usedBy],
      );
      const macroId = mr[0]!.flow_id;

      await client.query('DELETE FROM flow_steps WHERE flow_id = $1', [macroId]);
      for (const [ordinal, stepId] of stepIds.entries()) {
        await client.query(
          'INSERT INTO flow_steps (flow_id, step_id, ordinal) VALUES ($1,$2,$3)',
          [macroId, stepId, ordinal],
        );
      }

      await client.query(
        `DELETE FROM memory_chunks WHERE app_id = $1 AND kind = 'segment' AND ref_id = $2`,
        [appId, macroId],
      );
      await client.query(
        `INSERT INTO memory_chunks (app_id, kind, ref_id, flow_id, text, meta, health, embedding)
         VALUES ($1,'segment',$2,$2,$3,$4,0.5,$5::VECTOR(1024))`,
        [appId, macroId, text, JSON.stringify({ source: 'mined', usedBy, length: c.length }), toVector(vector)],
      );
      return true;
    });

    macros.push({ slug, length: c.length, usedBy, created });
    // Bound the work: mining a large corpus should not write hundreds of rows
    // in one pass.
    if (i > 50) break;
  }

  // RETIRE MACROS THIS PASS NO LONGER FINDS.
  //
  // Mining was insert-or-update only, so a macro survived forever once written
  // — including after the block it described stopped recurring. Two of them
  // (a 29-step and a 33-step block, mined 2026-08-14) outlived the corpus that
  // produced them and kept their original text, which is how a stale,
  // boilerplate-worded chunk was still winning retrieval a week later. Nothing
  // referenced them; they were simply never cleaned up.
  //
  // Safe to delete rather than tombstone: a mined macro owns no steps of its
  // own (flow_steps points at the recorded flow's rows), so this removes a view
  // over steps, never the steps themselves. Segments and recordings are
  // untouched — `is_macro` is the guard.
  // THE CHUNK MUST GO FIRST. memory_chunks.ref_id is not a foreign key, so
  // deleting the flow does not cascade to it — it leaves an ORPHANED chunk that
  // is invisible to every join, permanent in the vector index, and still
  // winning retrieval. That is not hypothetical: retiring the two stale macros
  // dropped their flows and the 29-step block kept answering "cancel my weight
  // loss subscription" at 0.7915 out of a row nothing pointed at any more.
  const keptSlugs = macros.map((m) => m.slug);
  const retired = await tx(async (client: pg.PoolClient) => {
    const { rows: doomed } = await client.query<{ flow_id: string }>(
      `SELECT flow_id FROM flows
       WHERE app_id = $1 AND is_macro AND source = 'mined'
         AND NOT (slug = ANY($2::STRING[]))`,
      [appId, keptSlugs],
    );
    if (!doomed.length) return 0;

    const ids = doomed.map((d) => d.flow_id);
    await client.query(
      `DELETE FROM memory_chunks WHERE app_id = $1 AND ref_id = ANY($2::UUID[])`,
      [appId, ids],
    );
    const { rowCount } = await client.query(
      `DELETE FROM flows WHERE flow_id = ANY($1::UUID[])`,
      [ids],
    );
    return rowCount ?? 0;
  });

  return { flowsScanned: flows.size, candidates: candidates.length, macros, retired };
}
