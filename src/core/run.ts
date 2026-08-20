/**
 * Recording a run — and turning what replay already saw into memory.
 *
 * Replay collects console errors, non-2xx responses with bodies, failed
 * requests and round-trip mismatches on every single execution, with no model
 * involved. Until now it threw all of that away, which made "detection is free,
 * judgment is the reasoner" untrue: detection was free and then discarded.
 *
 * Three things get written here, all deterministic:
 *
 *   runs / run_events   what happened, step by step, with the signals attached
 *                       to the step they fired during. `sig_sequence` is the
 *                       flow-drift baseline — you cannot diff against last week
 *                       unless last week was recorded.
 *
 *   findings            "X is wrong". Deduped by fingerprint ACROSS runs, so
 *                       occurrences accumulate whether or not anyone was
 *                       watching. Severity and triage are left alone — deciding
 *                       whether something is a lesson (we adapt) or an issue
 *                       (the app gets fixed) is a human call.
 *
 *   page_edges          the sig sequence IS a set of observed page transitions.
 *                       Writing them back as `inferred_from_run` grows the
 *                       route map every time anything runs, which is what makes
 *                       rung 3 of seam resolution pay off later.
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { tx, getPool } from './db.js';
import type { CapturedSignal, ReplayResult } from './replay.js';
import { detectDrift, recordDrift, type Drift } from './drift.js';
import { rollUpSelectorHealth, type HealthRollup } from './health.js';

export interface RecordRunOptions {
  appId: string;
  goal: string;
  mode?: 'execute' | 'emit-only' | 'dry-run';
  reasoner?: string;
  /** Step rows in ordinal order, when they exist. Null-safe: a bare replay has none. */
  stepIds?: string[];
  /** Selector per step, parallel to stepIds. */
  selectorIds?: Array<string | null>;
}

export interface RecordRunResult {
  runId: string;
  events: number;
  findingsNew: number;
  findingsSeenAgain: number;
  edges: number;
  /** Path comparison against previous runs of the same goal. */
  drift?: Drift;
  /** Selector health after this run's outcomes were folded in. */
  health?: HealthRollup;
}

/** A finding before it meets the database. */
interface FindingDraft {
  kind: 'console_error' | 'network_error' | 'data_mismatch' | 'persistence' | 'nondeterminism' | 'flow_drift' | 'perf' | 'other';
  severity: 'high' | 'medium' | 'low' | 'unknown';
  statement: string;
  evidence: Record<string, unknown>;
  fingerprint: string;
}

/**
 * Strip the parts of a message that differ run to run, so the SAME defect
 * fingerprints identically every time. Without this, occurrences never
 * accumulate and every run looks like a fresh problem.
 */
function stable(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
    .replace(/\b\d{3,}\b/g, ':n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Route shape only — query strings and ids would fragment the fingerprint. */
function routeOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/\d+(?=\/|$)/g, '/:id');
  } catch {
    return stable(url);
  }
}

const fingerprint = (parts: unknown[]) =>
  createHash('sha1').update(parts.map(String).join('|')).digest('hex').slice(0, 20);

/**
 * Turn captured signals into findings. Pure, so it can be tested without a
 * browser or a database.
 *
 * Correlation with intent is the value-add: a 500 is noise, a 500 DURING a
 * particular step is evidence. `duringStep` is carried into the evidence for
 * exactly that reason.
 */
export function extractFindings(result: ReplayResult, goal: string): FindingDraft[] {
  const drafts = new Map<string, FindingDraft>();

  // A lesson of kind `ignore` says: signals during this step are known, expected
  // and not defects. This is the payoff of promoting a finding to a lesson — the
  // observation stops being re-reported as a problem on every single run, which
  // is what "the same observation is a lesson if you accept it" actually buys.
  const ignoredSteps = new Set(
    result.steps
      .filter((s) => s.lessonsApplied?.some((l) => l.kind === 'ignore'))
      .map((s) => s.seq),
  );

  const add = (d: FindingDraft) => {
    // Within one run the same defect can fire repeatedly; it is still one
    // finding. Cross-run accumulation happens in the database.
    if (!drafts.has(d.fingerprint)) drafts.set(d.fingerprint, d);
  };

  for (const s of result.signals as CapturedSignal[]) {
    if (ignoredSteps.has(s.duringStep)) continue;
    if (s.kind === 'http' && (s.status ?? 0) >= 400) {
      const route = routeOf(s.url);
      add({
        kind: 'network_error',
        // A 5xx is the app breaking; a 4xx may well be the app correctly
        // refusing. Guessing beyond that is the reasoner's job, not ours.
        severity: (s.status ?? 0) >= 500 ? 'high' : 'medium',
        statement: `${s.text} on ${route}`,
        evidence: { url: s.url, status: s.status, body: s.body, duringStep: s.duringStep, goal },
        fingerprint: fingerprint(['network_error', s.status, route]),
      });
      continue;
    }

    if (s.kind === 'console' || s.kind === 'pageerror') {
      add({
        kind: 'console_error',
        severity: s.kind === 'pageerror' ? 'high' : 'low',
        statement: stable(s.text),
        evidence: { text: s.text, duringStep: s.duringStep, goal },
        fingerprint: fingerprint(['console_error', stable(s.text)]),
      });
      continue;
    }

    if (s.kind === 'requestfailed') {
      add({
        kind: 'network_error',
        severity: 'medium',
        statement: `request failed: ${s.text} on ${routeOf(s.url)}`,
        evidence: { url: s.url, text: s.text, duringStep: s.duringStep, goal },
        fingerprint: fingerprint(['requestfailed', routeOf(s.url), stable(s.text)]),
      });
    }
  }

  // The page after a step is not the page that step recorded. Not automatically
  // a failure — an app may legitimately gain a banner — but it is precisely the
  // signal PLAN.md escalates to the reasoner, so it must be recorded rather
  // than shrugged off.
  for (const step of result.steps) {
    if (!step.unexpectedPage) continue;
    add({
      kind: 'flow_drift',
      severity: 'medium',
      statement: `step ${step.seq} (${step.action}) landed on ${step.unexpectedPage.observed}, expected ${step.unexpectedPage.expected}`,
      evidence: { step: step.seq, ...step.unexpectedPage, goal },
      fingerprint: fingerprint(['unexpected_page', step.unexpectedPage.expected, step.unexpectedPage.observed]),
    });
  }

  // A value that does not survive being written is a real defect class, and the
  // IR makes it free to detect: we know what went into which field.
  for (const step of result.steps) {
    if (!step.roundTripMismatch) continue;
    add({
      kind: 'persistence',
      severity: 'medium',
      statement: `a value written at step ${step.seq} did not survive: wrote "${step.roundTripMismatch.expected}", read back "${step.roundTripMismatch.actual}"`,
      evidence: { step: step.seq, ...step.roundTripMismatch, goal },
      fingerprint: fingerprint(['persistence', step.action, step.roundTripMismatch.expected.length]),
    });
  }

  return [...drafts.values()];
}

/** `/inventory.html#bf3dd322` → `/inventory.html`. */
const patternOf = (sig: string) => sig.slice(0, sig.lastIndexOf('#')) || sig;

export interface AttributedRunOptions {
  appId: string;
  goal: string;
  passed: boolean;
  /**
   * Page fingerprints observed, in order, if the driver captured any.
   *
   * Optional because a hand-written script usually has URLs, not sigs. An
   * empty sequence still records that the goal ran and what the outcome was;
   * it simply cannot serve as a drift baseline, and `detectDrift` already
   * skips zero-length histories rather than reporting a phantom diff.
   */
  sigSequence?: string[];
  /** How it was actually driven — recorded so the claim stays honest. */
  drivenBy?: string;
  note?: string;
}

/**
 * Record a run that Understudy did NOT drive.
 *
 * The operating contract permits reaching a goal by any means — a script, the
 * browser directly, an API call — and for a third-party checkout or an
 * unimplemented IR action that is the only option. What nobody noticed is that
 * taking the escape hatch opted out of the whole feedback loop: no run row, no
 * drift baseline, no trace that the goal had ever succeeded. On providernow a
 * paid intake completed on 2026-08-20 while the newest run row still read
 * 2026-08-13.
 *
 * This is deliberately NOT `recordRun`. There is no ReplayResult here, so there
 * are no step outcomes, no signals, and no selector health to fold — claiming
 * otherwise would put unearned confidence into the health model. What it does
 * record is exactly what an outside driver can honestly attest: this goal ran,
 * this was the outcome, this is the path if I saw one, and Understudy was not
 * the one driving.
 */
export async function recordAttributedRun(opts: AttributedRunOptions): Promise<{ runId: string; drift?: Drift }> {
  const { appId, goal, passed, sigSequence = [], drivenBy, note } = opts;

  // Measured BEFORE the row is written, so the baseline excludes this run.
  const drift = sigSequence.length ? await detectDrift(appId, goal, sigSequence) : undefined;

  const { rows } = await getPool().query<{ run_id: string }>(
    `INSERT INTO runs (app_id, goal, mode, status, sig_sequence, plan, finished_at)
     VALUES ($1,$2,'attributed',$3,$4,$5, now())
     RETURNING run_id`,
    [
      appId,
      goal,
      passed ? 'passed' : 'failed',
      JSON.stringify(sigSequence),
      JSON.stringify({ drivenBy: drivenBy ?? 'external', ...(note ? { note } : {}) }),
    ],
  );

  return { runId: rows[0]!.run_id, ...(drift ? { drift } : {}) };
}

export async function recordRun(
  result: ReplayResult,
  opts: RecordRunOptions,
): Promise<RecordRunResult> {
  // Drift compares against PREVIOUS runs, so it is measured before this run is
  // written — otherwise the baseline would include the run being judged.
  const drift = await detectDrift(opts.appId, opts.goal, result.sigSequence);

  const { appId, goal, mode = 'execute', reasoner, stepIds = [], selectorIds = [] } = opts;

  const findings = extractFindings(result, goal);
  const signalsByStep = new Map<number, CapturedSignal[]>();
  for (const s of result.signals) {
    const list = signalsByStep.get(s.duringStep) ?? [];
    list.push(s);
    signalsByStep.set(s.duringStep, list);
  }

  const outcome = await tx(async (client: pg.PoolClient) => {
    const { rows: runRows } = await client.query<{ run_id: string }>(
      `INSERT INTO runs (app_id, goal, mode, status, sig_sequence, reasoner, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       RETURNING run_id`,
      [
        appId,
        goal,
        mode,
        result.ok ? 'passed' : 'failed',
        JSON.stringify(result.sigSequence),
        reasoner ?? null,
      ],
    );
    const runId = runRows[0]!.run_id;

    for (const [ordinal, step] of result.steps.entries()) {
      const signals = signalsByStep.get(step.seq) ?? [];
      await client.query(
        `INSERT INTO run_events (run_id, ordinal, step_id, selector_id, outcome, error,
                                 sig_observed, duration_ms, console, network)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          runId,
          ordinal,
          stepIds[ordinal] ?? null,
          selectorIds[ordinal] ?? null,
          // Distinguish "the element is gone" from "it broke": not_found is rot
          // to heal silently, everything else is a genuine gap worth asking about.
          step.ok
            ? 'ok'
            : /matched no elements|no usable locator/i.test(step.error ?? '')
              ? 'not_found'
              : /timeout/i.test(step.error ?? '')
                ? 'timeout'
                : 'error',
          step.error ?? null,
          step.sig ?? null,
          step.durationMs,
          JSON.stringify(signals.filter((s) => s.kind === 'console' || s.kind === 'pageerror')),
          JSON.stringify(signals.filter((s) => s.kind === 'http' || s.kind === 'requestfailed')),
        ],
      );
    }

    // ---- findings, deduped ACROSS runs -----------------------------------
    let findingsNew = 0;
    let findingsSeenAgain = 0;
    for (const f of findings) {
      // NOT `RETURNING (xmax = 0)`. xmax is a PostgreSQL MVCC system column and
      // CockroachDB does not have it — that threw UndefinedColumn, and only
      // stayed hidden because a run with zero captured signals never reaches
      // this loop. `occurrences` is portable: it defaults to 1 on insert and is
      // incremented on conflict, so 1 means new.
      const { rows } = await client.query<{ occurrences: number }>(
        `INSERT INTO findings (app_id, kind, severity, statement, evidence, fingerprint,
                               first_run_id, last_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT (app_id, fingerprint) DO UPDATE
           SET occurrences = findings.occurrences + 1,
               last_run_id = excluded.last_run_id,
               last_seen_at = now(),
               evidence = excluded.evidence
         RETURNING occurrences`,
        [appId, f.kind, f.severity, f.statement, JSON.stringify(f.evidence), f.fingerprint, runId],
      );
      if (rows[0]?.occurrences === 1) findingsNew++;
      else findingsSeenAgain++;
    }

    // ---- page graph, grown from what was actually walked ------------------
    //
    // The sig sequence is a list of observed transitions. Writing them back
    // means every run enriches the route map, which is what lets seam
    // resolution answer "how do I get from A to B" as a graph query later.
    let edges = 0;
    const pageIdFor = async (sig: string): Promise<string> => {
      const { rows } = await client.query<{ page_id: string }>(
        `INSERT INTO pages (app_id, sig, url_pattern, title)
         VALUES ($1,$2,$3,'')
         ON CONFLICT (app_id, sig) DO UPDATE SET last_seen_at = now()
         RETURNING page_id`,
        [appId, sig, patternOf(sig)],
      );
      return rows[0]!.page_id;
    };

    for (let i = 1; i < result.sigSequence.length; i++) {
      const from = await pageIdFor(result.sigSequence[i - 1]!);
      const to = await pageIdFor(result.sigSequence[i]!);
      if (from === to) continue;

      // Attribute the edge to the selector of the step that caused it — the
      // step whose sig first equals the destination.
      const causingIndex = result.steps.findIndex((s) => s.sig === result.sigSequence[i]);
      const via = causingIndex >= 0 ? (selectorIds[causingIndex] ?? null) : null;

      // via_selector is part of the PRIMARY KEY, so it is implicitly NOT NULL:
      // the schema's model of an edge is "A -> B VIA THIS CONTROL", not merely
      // "A -> B". An observed transition whose cause we cannot name is not
      // representable, so skip it rather than inventing a sentinel. This is why
      // a bare replay contributes no edges while an ingest (which knows each
      // step's selector) does.
      if (!via) continue;

      const { rowCount } = await client.query(
        `INSERT INTO page_edges (app_id, from_page, to_page, via_selector, kind)
         VALUES ($1,$2,$3,$4,'inferred_from_run')
         ON CONFLICT DO NOTHING`,
        [appId, from, to, via],
      );
      edges += rowCount ?? 0;
    }

    return { runId, events: result.steps.length, findingsNew, findingsSeenAgain, edges };
  });

  if (drift.changed) await recordDrift(opts.appId, drift, outcome.runId);

  // Fold this run's per-step outcomes into each selector's health, and
  // quarantine anything that has only ever failed.
  const health = await rollUpSelectorHealth(opts.appId, outcome.runId);

  return { ...outcome, drift, health };
}
