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
    .replace(/\b\d{3,}\b/g, ':n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

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
    } else if (s.kind === 'console' || s.kind === 'pageerror') {
      add({
        kind: 'console_error',
        severity: s.kind === 'pageerror' ? 'high' : 'low',
        statement: stable(s.text),
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
