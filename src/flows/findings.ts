/**
 * Findings: "the app looks broken here". Detection is free — it reads what
 * replay already captured — and runs on every replay, no model involved.
 *
 * Each finding has a fingerprint built from what is wrong, not from when it
 * happened, so the same 500 on the same route across ten runs is ONE finding
 * with ten occurrences, not ten findings. Ported from the old run.ts.
 */

import { createHash } from 'node:crypto';
import type { Collection } from 'mongodb';
import type { ReplayResult } from '../core/replay.js';
import type { Finding } from '../store/types.js';

export type FindingDraft = Pick<Finding, 'kind' | 'severity' | 'statement' | 'evidence' | 'fingerprint'>;

/** Strip what differs run to run (ids, numbers, signed query strings), so one defect fingerprints the same every time. */
export function stable(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s'"?#]+)\?[^\s'"]*/g, '$1')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
    // Not a port: `localhost:3000` is where the app is, not a varying id, and
    // replacing it produced `localhost::n`. Not part of a dotted address or
    // version either (127.0.0.1, 1.2.300): replacing those produced `:n.0.0.1`.
    .replace(/(?<![\w\]]:)(?<![\d.])\d{3,}(?!\d|\.\d)/g, ':n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** For showing: whitespace squashed and cut, nothing rewritten. */
const readable = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 300);

/** Route shape only: `https://x.com/orders/123?a=b` → `https://x.com/orders/:id`. */
export function routeOf(url: string | undefined): string {
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

/** Turn one replay's captured signals into findings. Pure: no browser, no database. */
export function extractFindings(result: Pick<ReplayResult, 'signals' | 'steps'>, goal: string): FindingDraft[] {
  const drafts = new Map<string, FindingDraft>();
  const add = (d: FindingDraft) => {
    if (!drafts.has(d.fingerprint)) drafts.set(d.fingerprint, d);
  };

  for (const s of result.signals) {
    if (s.kind === 'http' && (s.status ?? 0) >= 400) {
      const route = routeOf(s.url);
      add({
        kind: 'network_error',
        // 5xx is the app breaking; 4xx may be the app correctly refusing.
        severity: (s.status ?? 0) >= 500 ? 'high' : 'medium',
        statement: `${s.text} on ${route}`,
        evidence: { url: s.url, status: s.status, body: s.body, duringStep: s.duringStep, goal },
        fingerprint: fingerprint(['network_error', s.status, route]),
      });
    } else if ((s.kind === 'console' && s.level !== 'warning') || s.kind === 'pageerror') {
      // console.warn is framework chatter far more often than a defect (Next.js
      // image-size hints, React dev warnings): kept in the run, not a finding.
      add({
        kind: 'console_error',
        severity: s.kind === 'pageerror' ? 'high' : 'low',
        // Shown as it was; only the fingerprint is normalised.
        statement: readable(s.text),
        evidence: { text: s.text, duringStep: s.duringStep, goal },
        fingerprint: fingerprint(['console_error', stable(s.text)]),
      });
    } else if (s.kind === 'requestfailed') {
      add({
        kind: 'network_error',
        severity: 'medium',
        statement: `request failed: ${s.text} on ${routeOf(s.url)}`,
        evidence: { url: s.url, text: s.text, duringStep: s.duringStep, goal },
        fingerprint: fingerprint(['requestfailed', routeOf(s.url), stable(s.text)]),
      });
    }
  }

  for (const step of result.steps) {
    // Landed on a different page than when the flow was proven.
    if (step.unexpectedPage) {
      add({
        kind: 'flow_drift',
        severity: 'medium',
        statement: `step ${step.seq} (${step.action}) landed on ${step.unexpectedPage.observed}, expected ${step.unexpectedPage.expected}`,
        evidence: { step: step.seq, ...step.unexpectedPage, goal },
        fingerprint: fingerprint(['unexpected_page', step.unexpectedPage.expected, step.unexpectedPage.observed]),
      });
    }
    // A value typed into a field that didn't stay there.
    if (step.roundTripMismatch) {
      add({
        kind: 'persistence',
        severity: 'medium',
        statement: `a value written at step ${step.seq} did not survive: wrote "${step.roundTripMismatch.expected}", read back "${step.roundTripMismatch.actual}"`,
        evidence: { step: step.seq, ...step.roundTripMismatch, goal },
        fingerprint: fingerprint(['persistence', step.action, step.roundTripMismatch.expected.length]),
      });
    }
  }

  return [...drafts.values()];
}

/**
 * Store findings: new ones are inserted as open, known ones get another
 * occurrence. A finding someone already triaged keeps its status.
 */
export async function saveFindings(coll: Collection<Finding>, app: string, drafts: FindingDraft[], at = new Date()) {
  if (!drafts.length) return;
  await coll.bulkWrite(
    drafts.map((d) => ({
      updateOne: {
        filter: { app, fingerprint: d.fingerprint },
        update: {
          $set: { kind: d.kind, severity: d.severity, statement: d.statement, evidence: d.evidence, lastSeen: at },
          $inc: { occurrences: 1 },
          $setOnInsert: { app, fingerprint: d.fingerprint, firstSeen: at, status: 'open' as const },
        },
        upsert: true,
      },
    })),
  );
}

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/**
 * Findings for an app, MOST SEVERE FIRST, then most frequent, then newest.
 *
 * Frequency alone put eight framework image warnings above the one real
 * regression: a noisy console fires on every page, a broken route once.
 * Sorted here rather than in the query because severity is a word, not a rank.
 */
export async function listFindings(coll: Collection<Finding>, app: string, opts: { all?: boolean; limit?: number } = {}): Promise<Finding[]> {
  const rows = await coll.find(opts.all ? { app } : { app, status: 'open' }).toArray();
  rows.sort((a, b) =>
    (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
    || (b.occurrences ?? 0) - (a.occurrences ?? 0)
    || +new Date(b.lastSeen) - +new Date(a.lastSeen));
  return rows.slice(0, opts.limit ?? 40);
}

export type Verdict = 'issue' | 'lesson' | 'noise';

/**
 * Route open findings. issue: the app is wrong and someone should fix it.
 * lesson: accepted — the agent works around it (pass the lesson to store).
 * noise: not a problem (third-party telemetry, framework warnings).
 * Returns what couldn't be routed instead of throwing, so one bad item
 * doesn't lose the rest.
 */
export async function triage(
  coll: Collection<Finding>,
  app: string,
  items: { fingerprint: string; verdict: Verdict }[],
): Promise<{ routed: number; problems: string[] }> {
  const problems: string[] = [];
  let routed = 0;
  for (const [i, item] of items.entries()) {
    if (!['issue', 'lesson', 'noise'].includes(item?.verdict)) {
      problems.push(`triage[${i}].verdict must be issue, lesson or noise`);
      continue;
    }
    const { matchedCount } = await coll.updateOne({ app, fingerprint: item.fingerprint }, { $set: { status: item.verdict } });
    if (matchedCount) routed++;
    else problems.push(`triage[${i}]: no finding with fingerprint ${item.fingerprint}`);
  }
  return { routed, problems };
}
