/**
 * Seams — getting from where one bound flow ends to where the next begins.
 *
 * No recording ever contained a seam, because the two sides came from different
 * recordings. This is the join that makes composition possible, and it is the
 * part of the system with the most leverage: rung 3 connects page pairs no
 * recording ever visited together, as a GRAPH QUERY rather than a browser
 * session. That is what exploration pays for.
 *
 * ESCALATE ONLY AS FAR AS NEEDED. Each rung is more expensive and more
 * speculative than the last, so the first that answers wins:
 *
 *   1 sig match       states are already equal          → 0 steps
 *   2 bridge segment  a known segment spans the gap     → splice it (depth <= 2)
 *   3 page graph      page_edges connects the two sigs  → emit that edge's control
 *   4 navigation gap  same origin, different route      → synthetic goto
 *   5 live probe      drive a browser to find out       → NOT IMPLEMENTED
 *
 * Rung 5 ASKS. It needs a live browser, so the reasoner does the probing with
 * its own Playwright access and hands back the steps; we persist them as a
 * bridge segment AND a page_edge, so the next composition over this gap lands
 * on rung 2 or 3 and never probes again. An unresolved seam is otherwise
 * REPORTED, never guessed at — a wrong bridge executes real clicks on a real
 * app.
 */

import { createHash } from 'node:crypto';
import { getPool, tx } from './db.js';
import { toVector } from './recall.js';
import type { RawEvent } from './recording.js';
import type { Embedder } from './types.js';

export type SeamKind =
  | 'contiguous'
  | 'bridge-segment'
  | 'page-graph'
  | 'navigation'
  | 'probed'
  | 'unresolved';

export interface Seam {
  from: string;
  to: string;
  kind: SeamKind;
  detail: string;
  /** Rung reached, for reporting. 1 is free, 5 would be a live probe. */
  rung: number;
  /** Steps to splice between the two flows. Empty for a contiguous seam. */
  steps: RawEvent[];
  /** Flows whose steps were spliced, when rung 2 answered. */
  viaFlows?: string[];
}

export interface SeamEndpoint {
  slug: string;
  endState: string | null;
  startState: string | null;
}

const patternOf = (sig: string) => sig.slice(0, sig.lastIndexOf('#')) || sig;

/** Build a click step out of a selector row — what rung 3 emits. */
function clickStep(
  seq: number,
  sel: { role: string | null; name: string | null; test_id: string | null; css: string | null },
  url: string,
): RawEvent {
  return {
    seq,
    ts: seq,
    action: 'click',
    ...(sel.role ? { role: sel.role } : {}),
    ...(sel.name ? { name: sel.name } : {}),
    ...(sel.test_id ? { testId: sel.test_id } : {}),
    ...(sel.css ? { css: sel.css } : {}),
    url,
    resolution: 'accname',
  };
}

/**
 * Rung 2 — is there a segment that starts where A ends and ends where B starts?
 *
 * Depth 2 allows a pair to chain. Beyond that the plan stops guessing: each
 * extra hop multiplies the chance of executing something nobody intended.
 */
async function bridgeSegment(
  appId: string,
  from: string,
  to: string,
): Promise<{ flowIds: string[]; slugs: string[] } | undefined> {
  const pool = getPool();

  const { rows: direct } = await pool.query<{ flow_id: string; slug: string }>(
    `SELECT flow_id, slug FROM flows
     WHERE app_id = $1 AND start_state = $2 AND end_state = $3
       AND NOT needs_review AND source IN ('sliced','mined')
     ORDER BY (SELECT count(*) FROM flow_steps fs WHERE fs.flow_id = flows.flow_id)
     LIMIT 1`,
    [appId, from, to],
  );
  if (direct[0]) return { flowIds: [direct[0].flow_id], slugs: [direct[0].slug] };

  // Depth 2: A.end -> X -> B.start. Shortest total first.
  const { rows: pair } = await pool.query<{ a_id: string; a_slug: string; b_id: string; b_slug: string }>(
    `SELECT a.flow_id AS a_id, a.slug AS a_slug, b.flow_id AS b_id, b.slug AS b_slug
     FROM flows a
     JOIN flows b ON b.app_id = a.app_id AND b.start_state = a.end_state
     WHERE a.app_id = $1 AND a.start_state = $2 AND b.end_state = $3
       AND NOT a.needs_review AND NOT b.needs_review
       AND a.source IN ('sliced','mined') AND b.source IN ('sliced','mined')
     LIMIT 1`,
    [appId, from, to],
  );
  if (pair[0]) {
    return { flowIds: [pair[0].a_id, pair[0].b_id], slugs: [pair[0].a_slug, pair[0].b_slug] };
  }
  return undefined;
}

/** Load a flow's steps as executable events. */
async function eventsFor(flowId: string, startSeq: number): Promise<RawEvent[]> {
  const { rows } = await getPool().query<{
    action: string; role: string | null; name: string | null; test_id: string | null;
    css: string | null; frame_hint: string | null; value_ref: string | null;
    args: Record<string, unknown>; state_after: string | null;
  }>(
    `SELECT s.action, sel.role, sel.name, sel.test_id, sel.css, sel.frame_hint,
            s.value_ref, s.args, s.state_after
     FROM flow_steps fs
     JOIN steps s ON s.step_id = fs.step_id
     LEFT JOIN selectors sel ON sel.selector_id = s.selector_id
     WHERE fs.flow_id = $1 ORDER BY fs.ordinal`,
    [flowId],
  );

  return rows.map((r, i) => {
    const args = r.args ?? {};
    const literal = typeof args.value === 'string' ? args.value : undefined;
    return {
      seq: startSeq + i,
      ts: startSeq + i,
      action: r.action as RawEvent['action'],
      ...(r.role ? { role: r.role } : {}),
      ...(r.name ? { name: r.name } : {}),
      ...(literal !== undefined ? { value: literal } : {}),
      ...(r.value_ref ? { valueRef: r.value_ref } : {}),
      ...(r.test_id ? { testId: r.test_id } : {}),
      ...(r.css ? { css: r.css } : {}),
      ...(r.frame_hint ? { frameHint: r.frame_hint } : {}),
      url: r.state_after ?? '',
      resolution: 'accname' as const,
    };
  });
}

export async function resolveSeam(
  appId: string,
  from: SeamEndpoint,
  to: SeamEndpoint,
  baseUrl: string,
): Promise<Seam> {
  const base = { from: from.slug, to: to.slug };

  if (!from.endState || !to.startState) {
    return { ...base, kind: 'unresolved', rung: 0, detail: 'missing start or end state', steps: [] };
  }

  // --- rung 1: the states already match -----------------------------------
  if (from.endState === to.startState) {
    return {
      ...base,
      kind: 'contiguous',
      rung: 1,
      detail: 'states match — concatenate, no bridging steps',
      steps: [],
    };
  }

  // --- rung 2: a known segment spans the gap -------------------------------
  const bridge = await bridgeSegment(appId, from.endState, to.startState);
  if (bridge) {
    const steps: RawEvent[] = [];
    for (const flowId of bridge.flowIds) {
      steps.push(...(await eventsFor(flowId, steps.length)));
    }
    return {
      ...base,
      kind: 'bridge-segment',
      rung: 2,
      detail: `spliced ${bridge.slugs.join(' -> ')} (${steps.length} steps)`,
      steps,
      viaFlows: bridge.slugs,
    };
  }

  // --- rung 3: the page graph already connects them ------------------------
  //
  // This is the rung exploration pays for: it links page pairs no recording
  // ever visited together, as a graph query rather than a browser session.
  const { rows: edge } = await getPool().query<{
    role: string | null; name: string | null; test_id: string | null; css: string | null;
  }>(
    `SELECT sel.role, sel.name, sel.test_id, sel.css
     FROM page_edges e
     JOIN pages pf ON pf.page_id = e.from_page
     JOIN pages pt ON pt.page_id = e.to_page
     JOIN selectors sel ON sel.selector_id = e.via_selector
     WHERE e.app_id = $1 AND pf.sig = $2 AND pt.sig = $3
     LIMIT 1`,
    [appId, from.endState, to.startState],
  );
  if (edge[0]) {
    return {
      ...base,
      kind: 'page-graph',
      rung: 3,
      detail: `page graph connects them via "${edge[0].name ?? edge[0].test_id ?? edge[0].css}"`,
      steps: [clickStep(0, edge[0], patternOf(from.endState))],
    };
  }

  // --- rung 4: same origin, different route --------------------------------
  const fromPattern = patternOf(from.endState);
  const toPattern = patternOf(to.startState);
  if (fromPattern !== toPattern) {
    const url = new URL(toPattern, baseUrl).toString();
    return {
      ...base,
      kind: 'navigation',
      rung: 4,
      detail: `navigate ${fromPattern} -> ${toPattern}`,
      steps: [
        { seq: 0, ts: 0, action: 'goto', value: url, url, resolution: 'script-literal' },
      ],
    };
  }

  // --- rung 5 would be a live probe. We do not guess. ----------------------
  return {
    ...base,
    kind: 'unresolved',
    rung: 5,
    detail:
      `same route ${fromPattern} but different state (${from.endState} -> ${to.startState}); ` +
      'resolving this needs a live probe',
    steps: [],
  };
}

/**
 * Rung 5 — persist what a live probe discovered.
 *
 * PLAN.md: "Rung 5's result is written back as both a bridge segment and a
 * page_edge, so the next composition lands on rung 2 or 3." That write-back is
 * the whole point: probing is the expensive rung, and it should only ever
 * happen once per gap.
 *
 * The steps come from the reasoner, which drove a real browser to find them.
 * They are stored exactly as a distilled segment would be — same tables, same
 * shape — so nothing downstream can tell the difference or needs to.
 */
export async function persistProbedBridge(
  embedder: Embedder,
  appId: string,
  from: string,
  to: string,
  steps: Array<{ action: string; role?: string; name?: string; testId?: string; css?: string; value?: string }>,
): Promise<{ slug: string; flowId: string }> {
  const slug = `bridge-${createHash('sha1').update(`${from}->${to}`).digest('hex').slice(0, 10)}`;
  const intent = `Get from ${from} to ${to}`;
  const vector = await embedder.embedDocument(`${intent}. Discovered by live probe.`);

  return tx(async (client) => {
    const { rows: fr } = await client.query<{ flow_id: string }>(
      `INSERT INTO flows (app_id, slug, title, intent, source, start_state, end_state)
       VALUES ($1,$2,$3,$4,'sliced',$5,$6)
       ON CONFLICT (app_id, slug) DO UPDATE
         SET intent = excluded.intent, start_state = excluded.start_state,
             end_state = excluded.end_state, updated_at = now()
       RETURNING flow_id`,
      [appId, slug, `Bridge: ${from} -> ${to}`, intent, from, to],
    );
    const flowId = fr[0]!.flow_id;
    await client.query('DELETE FROM flow_steps WHERE flow_id = $1', [flowId]);

    let lastSelector: string | null = null;
    for (const [ordinal, step] of steps.entries()) {
      let selectorId: string | null = null;
      if (step.action !== 'goto') {
        const { rows: sel } = await client.query<{ selector_id: string }>(
          `INSERT INTO selectors (app_id, role, name, frame_hint, test_id, css, fragility, observed_only)
           VALUES ($1,$2,$3,'',$4,$5,'stable',false)
           ON CONFLICT (app_id, role, name, frame_hint) DO UPDATE SET last_seen_at = now()
           RETURNING selector_id`,
          [appId, step.role ?? '', step.name ?? '', step.testId ?? null, step.css ?? null],
        );
        selectorId = sel[0]!.selector_id;
        lastSelector = selectorId;
      }

      const { rows: sr } = await client.query<{ step_id: string }>(
        `INSERT INTO steps (app_id, action, selector_id, args, semantic, state_after, fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING step_id`,
        [
          appId,
          step.action,
          selectorId,
          JSON.stringify(step.value !== undefined ? { value: step.value } : {}),
          `${step.action} ${step.name ?? step.css ?? ''}`.trim(),
          ordinal === steps.length - 1 ? to : null,
          createHash('sha1').update([step.action, step.role ?? '', step.name ?? '', from].join('|')).digest('hex').slice(0, 16),
        ],
      );
      await client.query('INSERT INTO flow_steps (flow_id, step_id, ordinal) VALUES ($1,$2,$3)', [
        flowId,
        sr[0]!.step_id,
        ordinal,
      ]);
    }

    // The page edge too, so rung 3 can answer next time even if the segment is
    // later re-cut. via_selector is part of the primary key, so an edge whose
    // cause we cannot name is simply not representable.
    if (lastSelector) {
      const pageId = async (sig: string) => {
        const { rows } = await client.query<{ page_id: string }>(
          `INSERT INTO pages (app_id, sig, url_pattern, title) VALUES ($1,$2,$3,'')
           ON CONFLICT (app_id, sig) DO UPDATE SET last_seen_at = now() RETURNING page_id`,
          [appId, sig, sig.slice(0, sig.lastIndexOf('#')) || sig],
        );
        return rows[0]!.page_id;
      };
      await client.query(
        `INSERT INTO page_edges (app_id, from_page, to_page, via_selector, kind)
         VALUES ($1,$2,$3,$4,'inferred_from_run') ON CONFLICT DO NOTHING`,
        [appId, await pageId(from), await pageId(to), lastSelector],
      );
    }

    await client.query(
      `DELETE FROM memory_chunks WHERE app_id = $1 AND kind = 'segment' AND ref_id = $2`,
      [appId, flowId],
    );
    await client.query(
      `INSERT INTO memory_chunks (app_id, kind, ref_id, flow_id, text, meta, health, embedding)
       VALUES ($1,'segment',$2,$2,$3,$4,0.5,$5::VECTOR(1024))`,
      [appId, flowId, intent, JSON.stringify({ source: 'probed', from, to }), toVector(vector)],
    );

    return { slug, flowId };
  });
}
