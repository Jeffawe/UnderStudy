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
  }>(
    `SELECT f.flow_id, f.slug, fs.ordinal, s.step_id, s.fingerprint, s.semantic
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
    };
    f.fingerprints.push(r.fingerprint);
    f.stepIds.push(r.step_id);
    f.semantics.push(r.semantic);
    flows.set(r.flow_id, f);
  }

  if (flows.size < MIN_FLOWS) {
    return { flowsScanned: flows.size, candidates: 0, macros: [] };
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

    const slug = `macro-${c.key.slice(0, 8)}-${c.length}`;
    // Mechanical text, honestly labelled. Mining knows a block RECURS; it does
    // not know what the block is for. The distiller can rename it later.
    const text =
      `A block of ${c.length} steps that recurs in ${usedBy} recorded flows: ` +
      semantics.join('; ');

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

  return { flowsScanned: flows.size, candidates: candidates.length, macros };
}
