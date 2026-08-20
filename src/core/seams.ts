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
import { selectorIdentity } from './selector-identity.js';
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
  /** Needed to ask whether this segment navigates itself — see rung 1b. */
  flowId?: string;
}

/**
 * Does this flow open by navigating?
 *
 * A segment whose first step is a `goto` reaches its own starting page from
 * wherever execution happens to be, so there is nothing for a bridge to do.
 */
/**
 * Are these two flows ADJACENT SLICES OF THE SAME RECORDING?
 *
 * Segments do not copy steps — they share the parent recording's rows through
 * `flow_steps`. So if segment A occupies parent ordinals [i..j] and segment B
 * begins at j+1, then running A and then B is exactly running the parent from
 * i to k. The recording already proved that sequence end to end, which means
 * NO BRIDGE CAN BE NEEDED, whatever the two fingerprints say.
 *
 * This exists because the fingerprints frequently DON'T agree, for a reason
 * that is not a real gap: `sig()` is state-granular, so a segment boundary
 * lands on two different fingerprints of the same page (a request appears on
 * /overview, a menu opens, a validation message renders). Observed on
 * providernow: decomposing one hair loss intake into its seven own segments
 * produced two "unresolved" seams between slices that are literally
 * consecutive in the recording they were cut from — each one a live-probe
 * request for a bridge across nothing.
 *
 * Returns the parent's slug when they are adjacent, else null.
 */
async function adjacentInSameRecording(
  fromFlowId: string,
  toFlowId: string,
): Promise<string | null> {
  const { rows } = await getPool().query<{ slug: string; a_end: string; b_start: string }>(
    `WITH a AS (
       SELECT pfs.flow_id AS parent, max(pfs.ordinal) AS a_end
       FROM flow_steps afs
       JOIN flow_steps pfs ON pfs.step_id = afs.step_id
       JOIN flows p ON p.flow_id = pfs.flow_id AND p.source = 'recorded'
       WHERE afs.flow_id = $1
       GROUP BY pfs.flow_id
     ), b AS (
       SELECT pfs.flow_id AS parent, min(pfs.ordinal) AS b_start
       FROM flow_steps bfs
       JOIN flow_steps pfs ON pfs.step_id = bfs.step_id
       JOIN flows p ON p.flow_id = pfs.flow_id AND p.source = 'recorded'
       WHERE bfs.flow_id = $2
       GROUP BY pfs.flow_id
     )
     SELECT f.slug, a.a_end::string, b.b_start::string
     FROM a JOIN b ON b.parent = a.parent
     JOIN flows f ON f.flow_id = a.parent
     WHERE b.b_start = a.a_end + 1
     LIMIT 1`,
    [fromFlowId, toFlowId],
  );
  return rows[0]?.slug ?? null;
}

async function opensWithGoto(flowId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ action: string }>(
    `SELECT s.action FROM flow_steps fs JOIN steps s ON s.step_id = fs.step_id
     WHERE fs.flow_id = $1 ORDER BY fs.ordinal LIMIT 1`,
    [flowId],
  );
  return rows[0]?.action === 'goto';
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

  // --- rung 1a: adjacent slices of the same recording ----------------------
  //
  // Cheaper and MORE certain than comparing fingerprints: the recording itself
  // is the evidence. Checked before rung 1b because it is direct proof rather
  // than an inference about how the destination behaves.
  if (from.flowId && to.flowId) {
    const parent = await adjacentInSameRecording(from.flowId, to.flowId);
    if (parent) {
      return {
        ...base,
        kind: 'contiguous',
        rung: 1,
        detail: `adjacent slices of the same recording (${parent}) — the gap is a fingerprint artefact, not a real one`,
        steps: [],
      };
    }
  }

  // --- rung 1b: the destination navigates itself ---------------------------
  //
  // A live probe found this one. Login ends on /overview and the rash segment
  // starts on /overview, but with a different fingerprint — six distinct
  // /overview sigs have been recorded, because the page renders request status
  // and notifications that change over time. No bridge exists because none is
  // needed: the segment's first step is `goto /select-condition`.
  //
  // Without this the honest probe answer ("no steps") is indistinguishable
  // from "I could not work it out", and both block. That is the wrong shape:
  // fail-closed should mean "I do not know", not "I know it is vacuous".
  if (to.flowId && (await opensWithGoto(to.flowId))) {
    return {
      ...base,
      kind: 'contiguous',
      rung: 1,
      detail: 'destination opens with its own goto — it navigates itself, no bridge needed',
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
/**
 * Everything the server already knows about a gap, gathered for whoever has to
 * answer rung 5.
 *
 * The probe request used to carry four strings: two slugs and two opaque
 * fingerprints. Nobody can answer from that, so the operating contract tells
 * the reasoner to go and look — which in practice meant four hand-written SQL
 * queries per seam, re-deriving facts this process was holding when it built
 * the request.
 *
 * The cost of NOT sending it is not just round trips, it is wrong answers.
 * Whatever comes back is persisted into the page graph and reused forever
 * without being asked again, so an under-informed reasoner guessing plausibly
 * is the worst case here. Handed the destination's actual first steps, the
 * honest answer ("that click has no accessible name, I cannot express this")
 * is visible immediately; handed two hashes, "just navigate to /overview" looks
 * reasonable and would be wrong.
 *
 * Deliberately capped: this is evidence for one decision, not a database dump.
 */
export async function seamEvidence(
  appId: string,
  from: { slug: string; flowId?: string; endState: string },
  to: { slug: string; flowId?: string; startState: string },
): Promise<Record<string, unknown>> {
  const pool = getPool();

  const stepsOf = async (flowId: string, end: 'first' | 'last') => {
    const { rows } = await pool.query<{ ordinal: string; action: string; semantic: string }>(
      `SELECT fs.ordinal::STRING, s.action, s.semantic
       FROM flow_steps fs JOIN steps s ON s.step_id = fs.step_id
       WHERE fs.flow_id = $1
       ORDER BY fs.ordinal ${end === 'first' ? 'ASC' : 'DESC'}
       LIMIT 3`,
      [flowId],
    );
    const out = rows.map((r) => `${r.ordinal}. ${r.semantic}`);
    return end === 'first' ? out : out.reverse();
  };

  // Edges out of the state we are stuck in. This is the rung-3 evidence, and
  // it is what turns "how do I get there" into a graph question.
  const { rows: edges } = await pool.query<{ to_sig: string; via: string | null }>(
    `SELECT p2.sig AS to_sig, nullif(concat_ws(' ', sel.role, sel.name), ' ') AS via
     FROM page_edges pe
     JOIN pages p1 ON p1.page_id = pe.from_page
     JOIN pages p2 ON p2.page_id = pe.to_page
     LEFT JOIN selectors sel ON sel.selector_id = pe.via_selector
     WHERE pe.app_id = $1 AND p1.sig = $2
     LIMIT 12`,
    [appId, from.endState],
  );

  // Segments that touch either end. A named segment beats a bare click, so if
  // one of these spans the gap it is the answer and no probing is needed.
  const { rows: touching } = await pool.query<{ slug: string; start_state: string; end_state: string }>(
    `SELECT slug, start_state, end_state FROM flows
     WHERE app_id = $1 AND source IN ('sliced','mined')
       AND (start_state = $2 OR end_state = $3)
     LIMIT 8`,
    [appId, from.endState, to.startState],
  );

  const pattern = (sig: string) => sig.slice(0, sig.lastIndexOf('#')) || sig;

  return {
    sourceEndsWith: from.flowId ? await stepsOf(from.flowId, 'last') : [],
    destinationOpensWith: to.flowId ? await stepsOf(to.flowId, 'first') : [],
    sameRoute: pattern(from.endState) === pattern(to.startState),
    route: { from: pattern(from.endState), to: pattern(to.startState) },
    knownEdgesFromHere: edges.map((e) => ({ to: e.to_sig, via: e.via ?? '(unnamed control)' })),
    segmentsTouchingEitherEnd: touching.map((t) => ({
      slug: t.slug, startState: t.start_state, endState: t.end_state,
    })),
    howToAnswer:
      'Return [] unless you actually know. Whatever you return is written into the page graph as a ' +
      'permanent bridge and reused without being asked again — a plausible guess does not fail once, ' +
      'it becomes a wrong fact the system trusts. If the bridging control has no accessible name, it ' +
      'cannot be expressed as {role, name}: say so and return [] rather than approximating it.',
  };
}

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
        // A probed bridge step with nothing to identify it by gets no selector
        // row — sharing one would corrupt every other unnamed element on the
        // app. See src/core/selector-identity.ts.
        const identity = selectorIdentity({
          role: step.role ?? '',
          name: step.name ?? '',
          frameHint: '',
          testId: step.testId ?? null,
          css: step.css ?? null,
        });
        if (identity) {
          const { rows: sel } = await client.query<{ selector_id: string }>(
            `INSERT INTO selectors (app_id, identity, role, name, frame_hint, test_id, css, fragility, observed_only)
             VALUES ($1,$6,$2,$3,'',$4,$5,'stable',false)
             ON CONFLICT (app_id, identity) DO UPDATE SET last_seen_at = now()
             RETURNING selector_id`,
            [appId, step.role ?? '', step.name ?? '', step.testId ?? null, step.css ?? null, identity],
          );
          selectorId = sel[0]!.selector_id;
          lastSelector = selectorId;
        }
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
