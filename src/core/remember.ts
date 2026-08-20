/**
 * Writing to memory by hand.
 *
 * Everything else that writes knowledge does so as a SIDE EFFECT of something
 * bigger: `explore` writes facts because it crawled, `ingest` writes lessons
 * because it distilled, `triage` writes a lesson because it promoted a finding.
 * There was no way to simply record something you learned — which sits badly
 * with the operating contract, whose whole "add to memory as you work" section
 * assumes you can.
 *
 * So: one entry point, taking all three kinds at once. Batched deliberately —
 * the contract says to gather what you learned and put the whole list at a
 * natural pause rather than interrupting per row, and an API that takes one
 * item at a time quietly pushes you the other way.
 *
 * VALIDATION IS THIS MODULE'S JOB, and it reports EVERY problem at once rather
 * than dying on the first — the same contract `save_distilled` uses, for the
 * same reason: a caller fixing a batch should need one round trip, not six.
 * Nothing is written unless the whole batch validates.
 */

import { getPool, tx, ensureMeta } from './db.js';
import type { Embedder } from './types.js';

/** Must match the CHECK constraints in db/schema.sql. */
const FACT_KINDS = ['structure', 'capability', 'entity', 'auth', 'environment', 'boundary', 'constraint'] as const;
const FINDING_KINDS = ['console_error', 'network_error', 'data_mismatch', 'persistence',
  'nondeterminism', 'flow_drift', 'perf', 'addressability', 'other'] as const;
const SEVERITIES = ['high', 'medium', 'low', 'unknown'] as const;

export interface RememberFact {
  kind: (typeof FACT_KINDS)[number];
  statement: string;
  scope?: Record<string, unknown>;
  /** Defaults to 0.9: a person or the reasoner asserted this deliberately. */
  confidence?: number;
}

export interface RememberLesson {
  kind: string;
  title: string;
  body: string;
  /** Structured predicate, matched by EXACT containment at execution time. */
  trigger: Record<string, unknown>;
  fixSnippet?: string;
  confidence?: number;
}

export interface RememberFinding {
  kind: (typeof FINDING_KINDS)[number];
  severity: (typeof SEVERITIES)[number];
  statement: string;
  /** Stable dedupe key across runs. Required — findings accumulate by it. */
  fingerprint: string;
  evidence?: Record<string, unknown>;
}

export interface RememberInput {
  facts?: RememberFact[];
  lessons?: RememberLesson[];
  findings?: RememberFinding[];
}

export interface RememberResult {
  facts: { written: number; alreadyPresent: number };
  lessons: { written: number; alreadyPresent: number };
  findings: { written: number; reoccurred: number };
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Every problem in the batch, so one round trip is enough to fix it. */
export function validateRemember(input: RememberInput): string[] {
  const problems: string[] = [];
  const { facts = [], lessons = [], findings = [] } = input;

  if (!facts.length && !lessons.length && !findings.length) {
    problems.push('nothing to write: facts, lessons and findings are all empty');
  }

  facts.forEach((f, i) => {
    if (!nonEmpty(f?.statement)) problems.push(`facts[${i}].statement is required`);
    if (!FACT_KINDS.includes(f?.kind)) {
      problems.push(`facts[${i}].kind "${f?.kind}" is not one of ${FACT_KINDS.join(', ')}`);
    }
    if (f?.scope !== undefined && (typeof f.scope !== 'object' || f.scope === null || Array.isArray(f.scope))) {
      problems.push(`facts[${i}].scope must be an object`);
    }
    // `scope.key` is how explore marks a MECHANICALLY generated page-map claim,
    // and the planning vocabulary filters on exactly that. An authored fact
    // carrying one would silently hide itself from every future decompose.
    if (f?.scope && 'key' in f.scope) {
      problems.push(`facts[${i}].scope must not contain "key" — that marks a crawler-generated claim and hides the fact from planning`);
    }
  });

  lessons.forEach((l, i) => {
    if (!nonEmpty(l?.kind)) problems.push(`lessons[${i}].kind is required`);
    if (!nonEmpty(l?.title)) problems.push(`lessons[${i}].title is required`);
    if (!nonEmpty(l?.body)) problems.push(`lessons[${i}].body is required`);
    if (typeof l?.trigger !== 'object' || l.trigger === null || Array.isArray(l.trigger)) {
      problems.push(`lessons[${i}].trigger must be an object`);
    } else if (!Object.keys(l.trigger).length) {
      // An empty trigger is JSONB-contained by EVERY step context, so the
      // lesson would fire on all of them. That is never what anyone means.
      problems.push(`lessons[${i}].trigger is empty — it would match every step`);
    }
  });

  findings.forEach((f, i) => {
    if (!nonEmpty(f?.statement)) problems.push(`findings[${i}].statement is required`);
    if (!nonEmpty(f?.fingerprint)) problems.push(`findings[${i}].fingerprint is required (it is the dedupe key across runs)`);
    if (!FINDING_KINDS.includes(f?.kind)) {
      problems.push(`findings[${i}].kind "${f?.kind}" is not one of ${FINDING_KINDS.join(', ')}`);
    }
    if (!SEVERITIES.includes(f?.severity)) {
      problems.push(`findings[${i}].severity "${f?.severity}" is not one of ${SEVERITIES.join(', ')}`);
    }
  });

  return problems;
}

export async function remember(
  embedder: Embedder,
  appId: string,
  input: RememberInput,
): Promise<RememberResult> {
  const problems = validateRemember(input);
  if (problems.length) throw new Error(problems.join('\n'));

  const pool = getPool();
  const { facts = [], lessons = [], findings = [] } = input;
  const result: RememberResult = {
    facts: { written: 0, alreadyPresent: 0 },
    lessons: { written: 0, alreadyPresent: 0 },
    findings: { written: 0, reoccurred: 0 },
  };

  if (facts.length) await ensureMeta(embedder);

  for (const f of facts) {
    // Same merge rule as explore: a repeat sighting is confirmation, not a
    // second row.
    const { rowCount } = await pool.query(
      `UPDATE facts SET observed_count = observed_count + 1, last_verified_at = now()
       WHERE app_id = $1 AND statement = $2 AND superseded_by IS NULL`,
      [appId, f.statement],
    );
    if (rowCount) {
      result.facts.alreadyPresent++;
      continue;
    }

    // Embed OUTSIDE the transaction — it is the slow part, and holding a
    // transaction open across it invites the 40001 retries tx() exists to absorb.
    const vec = await embedder.embedDocument(f.statement);

    // The fact and its chunk go in TOGETHER. A fact with no chunk is invisible
    // to recall() forever, and nothing ever reports it missing.
    await tx(async (c) => {
      const { rows } = await c.query<{ fact_id: string }>(
        `INSERT INTO facts (app_id, kind, statement, scope, source, confidence)
         VALUES ($1,$2,$3,$4,'user_said',$5) RETURNING fact_id`,
        [appId, f.kind, f.statement, JSON.stringify(f.scope ?? {}), f.confidence ?? 0.9],
      );
      await c.query(
        `INSERT INTO memory_chunks (app_id, kind, ref_id, text, meta, embedding)
         VALUES ($1,'fact',$2,$3,$4,$5::VECTOR(1024))`,
        [appId, rows[0]!.fact_id, f.statement,
         JSON.stringify({ fact_kind: f.kind, ...(f.scope ?? {}) }), `[${vec.join(',')}]`],
      );
    });
    result.facts.written++;
  }

  for (const l of lessons) {
    // Deduped on title. Lessons have no natural key, and re-asserting one
    // should not quietly double it — a lesson stored twice fires twice and
    // splits its own times_applied/times_helped ratio.
    const { rowCount } = await pool.query(
      'SELECT 1 FROM lessons WHERE app_id = $1 AND title = $2',
      [appId, l.title],
    );
    if (rowCount) {
      result.lessons.alreadyPresent++;
      continue;
    }
    await pool.query(
      `INSERT INTO lessons (app_id, kind, title, body, trigger, fix_snippet, source, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,'user_said',$7)`,
      [appId, l.kind, l.title, l.body, JSON.stringify(l.trigger), l.fixSnippet ?? null, l.confidence ?? 0.9],
    );
    result.lessons.written++;
  }

  for (const f of findings) {
    // RETURNING occurrences, not the PostgreSQL `xmax = 0` trick — `xmax` does
    // not exist in CockroachDB and throws UndefinedColumn.
    const { rows } = await pool.query<{ occurrences: string }>(
      `INSERT INTO findings (app_id, kind, severity, statement, evidence, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (app_id, fingerprint)
       DO UPDATE SET occurrences = findings.occurrences + 1, last_seen_at = now()
       RETURNING occurrences`,
      [appId, f.kind, f.severity, f.statement, JSON.stringify(f.evidence ?? {}), f.fingerprint],
    );
    if (Number(rows[0]!.occurrences) > 1) result.findings.reoccurred++;
    else result.findings.written++;
  }

  return result;
}
