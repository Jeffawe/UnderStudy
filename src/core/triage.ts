/**
 * Triage — deciding what a finding MEANS.
 *
 * Detection is free and already done: console errors, non-2xx bodies, failed
 * requests, round-trip mismatches and flow drift are captured on every run with
 * no model involved. What was missing is the other half — nothing ever moved a
 * finding off `open`, so noise accumulated and outvoted signal. In this corpus
 * three of five findings were third-party analytics 401s sitting at 29
 * occurrences, while the one arguably real observation sat at 1.
 *
 * THE DISTINCTION THAT MATTERS (PLAN.md):
 *
 *   lesson   "when X, do Y first"   -> the AGENT adapts
 *   finding  "X is wrong"           -> the APP gets fixed
 *
 * "The same observation is a lesson if you accept it and a finding if you
 * don't." So triage routes a finding to one or the other, and `promoted_to` is
 * the path by which the system learns to work AROUND something rather than
 * re-encountering it forever.
 *
 * MECHANICAL FIRST, JUDGEMENT SECOND. A finding whose request went to a
 * different origin than the app under test is almost certainly not about the
 * app. That is a filter, not a judgement, and it should cost nothing — asking a
 * model whether someone else's telemetry endpoint is our bug is a waste of a
 * model call and of the reader's attention.
 */

import { getPool, tx } from './db.js';

export type Disposition = 'triaged_lesson' | 'triaged_issue' | 'wontfix' | 'fixed';

export interface OpenFinding {
  findingId: string;
  kind: string;
  severity: string;
  statement: string;
  occurrences: number;
  evidence: Record<string, unknown>;
  /** The goal that was executing when this fired — the correlation with intent. */
  goal?: string;
  /** Which step, when known. */
  duringStep?: number;
  firstSeen: string;
  lastSeen: string;
}

export async function listOpenFindings(
  appId: string,
  opts: { limit?: number; includeSuppressed?: boolean } = {},
): Promise<OpenFinding[]> {
  const { rows } = await getPool().query<{
    finding_id: string; kind: string; severity: string; statement: string;
    occurrences: number; evidence: Record<string, unknown>;
    first_seen_at: string; last_seen_at: string;
  }>(
    `SELECT finding_id, kind, severity, statement, occurrences, evidence,
            first_seen_at, last_seen_at
     FROM findings
     WHERE app_id = $1 AND ($2 OR status = 'open')
     ORDER BY
       CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
       occurrences DESC
     LIMIT $3`,
    [appId, opts.includeSuppressed ?? false, opts.limit ?? 50],
  );

  return rows.map((r) => ({
    findingId: r.finding_id,
    kind: r.kind,
    severity: r.severity,
    statement: r.statement,
    occurrences: Number(r.occurrences),
    evidence: r.evidence ?? {},
    ...(typeof r.evidence?.goal === 'string' ? { goal: r.evidence.goal } : {}),
    ...(typeof r.evidence?.duringStep === 'number' ? { duringStep: r.evidence.duringStep } : {}),
    firstSeen: r.first_seen_at,
    lastSeen: r.last_seen_at,
  }));
}

/**
 * Suppress findings whose traffic never touched the app under test.
 *
 * Third-party telemetry, ad networks and error reporters fail constantly and
 * have nothing to do with whether the app works. Left open they dominate the
 * list by occurrence count and bury the one finding that matters.
 *
 * Deliberately conservative: only findings with a URL in evidence, only when
 * that URL parses, and only when the origin genuinely differs. Anything
 * ambiguous is left for a human — a suppressed real defect is far worse than a
 * surviving piece of noise.
 */
export async function suppressThirdParty(
  appId: string,
): Promise<{ suppressed: number; hosts: string[] }> {
  const pool = getPool();

  const { rows: appRows } = await pool.query<{ base_url: string }>(
    'SELECT base_url FROM apps WHERE app_id = $1',
    [appId],
  );
  if (!appRows[0]) return { suppressed: 0, hosts: [] };

  let appOrigin: string;
  try {
    appOrigin = new URL(appRows[0].base_url).origin;
  } catch {
    return { suppressed: 0, hosts: [] };
  }

  const { rows } = await pool.query<{ finding_id: string; evidence: Record<string, unknown> }>(
    `SELECT finding_id, evidence FROM findings WHERE app_id = $1 AND status = 'open'`,
    [appId],
  );

  const hosts = new Set<string>();
  const toSuppress: string[] = [];

  for (const r of rows) {
    const url = r.evidence?.url;
    if (typeof url !== 'string') continue;
    try {
      const origin = new URL(url).origin;
      if (origin === appOrigin) continue;
      hosts.add(new URL(url).hostname);
      toSuppress.push(r.finding_id);
    } catch {
      // Unparseable URL: leave it alone rather than guessing.
    }
  }

  if (toSuppress.length) {
    await pool.query(
      `UPDATE findings
         SET status = 'wontfix',
             evidence = jsonb_set(evidence, '{triage}',
               '{"by":"origin-filter","reason":"request went to a different origin than the app under test"}')
       WHERE finding_id = ANY($1::UUID[])`,
      [toSuppress],
    );
  }

  return { suppressed: toSuppress.length, hosts: [...hosts] };
}

export interface TriageDecision {
  disposition: Disposition;
  reason: string;
  /** Required for triaged_lesson — what the agent should do instead. */
  lesson?: {
    kind: string;
    title: string;
    body: string;
    /** Predicate matched EXACTLY at execution time: url, action, role, name. */
    trigger: Record<string, unknown>;
  };
  /** Issue URL, once filed. */
  externalRef?: string;
}

/**
 * Apply a decision.
 *
 * `triaged_lesson` is the one that changes future behaviour: it writes a real
 * `lessons` row and links it through `promoted_to`, which is how an observation
 * the app will NOT fix becomes something the agent routes around. Without it a
 * finding can only ever be an complaint.
 */
export async function applyTriage(
  appId: string,
  findingId: string,
  decision: TriageDecision,
): Promise<{ status: Disposition; lessonId?: string }> {
  if (decision.disposition === 'triaged_lesson' && !decision.lesson) {
    throw new Error('triaged_lesson requires a lesson — what should the agent do instead?');
  }

  return tx(async (client) => {
    let lessonId: string | undefined;

    if (decision.lesson) {
      const { rows } = await client.query<{ lesson_id: string }>(
        `INSERT INTO lessons (app_id, kind, title, body, trigger, source, confidence)
         VALUES ($1,$2,$3,$4,$5,'promoted_finding',0.6)
         RETURNING lesson_id`,
        [
          appId,
          decision.lesson.kind,
          decision.lesson.title,
          decision.lesson.body,
          JSON.stringify(decision.lesson.trigger ?? {}),
        ],
      );
      lessonId = rows[0]!.lesson_id;
    }

    const { rowCount } = await client.query(
      `UPDATE findings
         SET status = $2,
             promoted_to = coalesce($3, promoted_to),
             external_ref = coalesce($4, external_ref),
             evidence = jsonb_set(evidence, '{triage}', $5::JSONB)
       WHERE finding_id = $1 AND app_id = $6`,
      [
        findingId,
        decision.disposition,
        lessonId ?? null,
        decision.externalRef ?? null,
        JSON.stringify({ by: 'reasoner', reason: decision.reason }),
        appId,
      ],
    );
    if (!rowCount) throw new Error(`no finding ${findingId} on this app`);

    return { status: decision.disposition, ...(lessonId ? { lessonId } : {}) };
  });
}

/** Counts by status, for a one-line summary. */
export async function triageSummary(appId: string): Promise<Record<string, number>> {
  const { rows } = await getPool().query<{ status: string; n: number }>(
    'SELECT status, count(*) AS n FROM findings WHERE app_id = $1 GROUP BY status',
    [appId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}
