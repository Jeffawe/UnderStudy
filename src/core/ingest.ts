/**
 * Mechanical ingest — a verified recording becomes memory, with no model.
 *
 * This is the half of distillation that needs no judgement. It produces ONE
 * flow per recording (`source='recorded'`), its steps, its selectors, and one
 * embedded chunk — enough for `recall()` to return something BINDABLE, which
 * until now it never could.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — it all needs judgement, and that is the
 * distiller's job:
 *   · slicing into reusable segments
 *   · naming intent ("log in as a member") rather than enumerating steps
 *   · correction rules
 *   · candidate lessons
 *
 * Segments arrive later WITHOUT rework, because a segment is not a different
 * kind of thing: it is a `flows` row with `source='sliced'` and a
 * `parent_flow_id`. Nothing here has to be undone.
 *
 * THE GATE: a recording that did not replay cleanly is written with
 * `needs_review = true` and NO memory chunk, so `recall()` can never return it.
 * Bad memory is worse than no memory — the agent acts on it confidently.
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { getPool, tx } from './db.js';
import { urlPattern } from './sig.js';
import { toVector } from './recall.js';
import type { Embedder } from './types.js';
import type { RawEvent, RawRecording } from './recording.js';
import type { ReplayResult, StepOutcome } from './replay.js';

/**
 * Commit-shaped words, shared in spirit with exploration's refusal list.
 *
 * Destructive marking is INFERENCE-ONLY and FAILS OPEN: no signal means not
 * destructive, and no question is ever asked. This covers the first of the
 * plan's five signals — "a commit-shaped control was clicked".
 */
const COMMIT_WORDS =
  /\b(pay|purchase|buy|order|checkout|confirm|delete|remove account|reset|deactivate|destroy|publish|subscribe|charge)\b/i;

export interface IngestResult {
  flowId: string;
  slug: string;
  created: boolean;
  steps: number;
  selectorsCreated: number;
  selectorsReused: number;
  needsReview: boolean;
  destructive: boolean;
  chunkWritten: boolean;
}

/**
 * A step's fingerprint: `sha1(action|role|name|url_pattern)`.
 * Used by macro mining to spot the same step recurring across flows, and by
 * destructive inference to match a step against an already-destructive flow.
 */
function stepFingerprint(event: RawEvent): string {
  return createHash('sha1')
    .update([event.action, event.role ?? '', event.name ?? '', urlPattern(event.url)].join('|'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Human-readable description of one step. This is what `steps.semantic` holds,
 * and the schema is explicit that it is the text which gets embedded.
 */
function semanticFor(event: RawEvent): string {
  const target = event.name ? `"${event.name}"` : event.testId ? `[${event.testId}]` : event.css ?? 'element';
  const role = event.role ? ` ${event.role}` : '';
  switch (event.action) {
    case 'goto':
      return `Go to ${event.value ?? event.url}`;
    case 'fill':
      return `Fill the${role} ${target}`;
    case 'select':
      return `Select ${event.value ?? ''} in the${role} ${target}`.replace(/\s+/g, ' ');
    case 'check':
      return `Check the${role} ${target}`;
    case 'uncheck':
      return `Uncheck the${role} ${target}`;
    case 'press':
      return `Press ${event.value ?? 'Enter'} on the${role} ${target}`;
    case 'upload':
      return `Upload a file to the${role} ${target}`;
    default:
      return `Click the${role} ${target}`;
  }
}

/**
 * Fragility, computed from the SHAPE of the addressing — this is what decides
 * whether a future failure is rot to heal silently or a genuine gap to ask
 * about.
 */
function fragilityFor(event: RawEvent, outcome: StepOutcome | undefined): string {
  if (event.hints?.nth !== undefined) return 'positional';
  // A name that matched several elements is not a stable address, even though
  // the step passed — it will pick a different element as soon as the list
  // reorders. Replay is what notices this.
  if (outcome?.ambiguousByName) return event.testId ? 'stable' : 'positional';
  if (event.role && event.name) return 'stable';
  if (event.testId) return 'stable';
  if (event.css && /[#.][a-z0-9]*[0-9a-f]{6,}/i.test(event.css)) return 'hashed';
  return 'unknown';
}

/** A readable, stable slug for the flow. */
function slugFor(recording: RawRecording): string {
  const meaningful = recording.events.filter((e) => e.action !== 'goto' && e.name).slice(0, 3);
  const words = meaningful
    .map((e) => `${e.action}-${e.name}`)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  // Hash suffix keeps (app_id, slug) unique when two recordings start alike.
  return `${words || 'recorded'}-${recording.hash.slice(0, 6)}`;
}

/**
 * The text that gets embedded and searched.
 *
 * Deliberately ENUMERATIVE, not intentional: mechanical ingest knows what the
 * flow *does*, not what it is *for*. Claiming "log in as a member" would be
 * inventing intent we have not earned. The distiller replaces this text with a
 * real intent later, and re-embeds — which is why the chunk is keyed by
 * ref_id and updated in place rather than appended to.
 */
function chunkTextFor(recording: RawRecording, steps: string[]): string {
  return `Recorded flow on ${recording.appSlug}: ${steps.join('; ')}`;
}

export async function ingestRecording(
  embedder: Embedder,
  recording: RawRecording,
  replayResult: ReplayResult,
  opts: { force?: boolean } = {},
): Promise<IngestResult> {
  const pool = getPool();

  const { rows: appRows } = await pool.query<{ app_id: string }>(
    `INSERT INTO apps (slug, name, base_url) VALUES ($1, $1, $2)
     ON CONFLICT (slug) DO UPDATE SET base_url = excluded.base_url
     RETURNING app_id`,
    [recording.appSlug, recording.startUrl],
  );
  const appId = appRows[0]!.app_id;

  const needsReview = replayResult.needsReview && !opts.force;
  const outcomeBySeq = new Map(replayResult.steps.map((s) => [s.seq, s]));

  // Only steps that actually replayed become memory. A half-executed recording
  // would otherwise contribute steps that were never proven to work.
  const events = recording.events.filter((e) => outcomeBySeq.get(e.seq)?.ok);

  const destructive = events.some((e) => COMMIT_WORDS.test(e.name ?? ''));
  const slug = slugFor(recording);
  const semantics = events.map(semanticFor);
  const chunkText = chunkTextFor(recording, semantics);

  // Embed OUTSIDE the transaction — it is the slow part, and holding a
  // CockroachDB transaction open across it invites the 40001 retries tx()
  // exists to absorb.
  const vector = needsReview ? null : await embedder.embedDocument(chunkText);

  let selectorsCreated = 0;
  let selectorsReused = 0;

  const result = await tx(async (client: pg.PoolClient) => {
    // Re-ingesting the same recording UPDATES rather than duplicating. The
    // recording hash is the identity — that is the same key the distillation
    // cache uses.
    const { rows: existing } = await client.query<{ flow_id: string }>(
      `SELECT flow_id FROM flows WHERE app_id = $1 AND recording_hash = $2`,
      [appId, recording.hash],
    );

    let flowId: string;
    const created = existing.length === 0;

    if (created) {
      const { rows } = await client.query<{ flow_id: string }>(
        `INSERT INTO flows (app_id, slug, title, intent, outcome, start_state, end_state,
                            source, destructive, needs_review, recording_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'recorded',$8,$9,$10)
         RETURNING flow_id`,
        [
          appId,
          slug,
          slug,
          chunkText,
          replayResult.sigSequence[replayResult.sigSequence.length - 1] ?? null,
          replayResult.sigSequence[0] ?? null,
          replayResult.sigSequence[replayResult.sigSequence.length - 1] ?? null,
          destructive,
          needsReview,
          recording.hash,
        ],
      );
      flowId = rows[0]!.flow_id;
    } else {
      flowId = existing[0]!.flow_id;
      await client.query(
        `UPDATE flows SET intent = $2, start_state = $3, end_state = $4,
                          destructive = $5, needs_review = $6, updated_at = now()
         WHERE flow_id = $1`,
        [
          flowId,
          chunkText,
          replayResult.sigSequence[0] ?? null,
          replayResult.sigSequence[replayResult.sigSequence.length - 1] ?? null,
          destructive,
          needsReview,
        ],
      );
      // Membership is rebuilt from scratch; the steps themselves are shared and
      // may belong to other flows, so they are never deleted here.
      await client.query('DELETE FROM flow_steps WHERE flow_id = $1', [flowId]);
    }

    for (const [ordinal, event] of events.entries()) {
      const outcome = outcomeBySeq.get(event.seq);
      let selectorId: string | null = null;

      // goto addresses no element.
      if (event.action !== 'goto') {
        // Selectors are per-APP and deduped on (role, name, frame_hint) — one
        // row per element, so a rename degrades every flow at once and you see
        // ONE cause rather than twelve.
        // Ask BEFORE upserting whether this element is already known.
        // RETURNING cannot answer it: the ON CONFLICT branch sets
        // observed_only = false, so the returned row looks identical either
        // way and every selector would report as "reused".
        const { rows: prior } = await client.query<{ selector_id: string }>(
          `SELECT selector_id FROM selectors
           WHERE app_id = $1 AND role IS NOT DISTINCT FROM $2
             AND name IS NOT DISTINCT FROM $3 AND frame_hint = $4`,
          [appId, event.role ?? null, event.name ?? null, event.frameHint ?? ''],
        );
        if (prior.length) selectorsReused++;
        else selectorsCreated++;

        const { rows: sel } = await client.query<{ selector_id: string; observed_only: boolean }>(
          `INSERT INTO selectors (app_id, role, name, frame_hint, test_id, css, fragility,
                                  observed_only, success_count, health)
           VALUES ($1,$2,$3,$7,$4,$5,$6,false,1,0.6)
           ON CONFLICT (app_id, role, name, frame_hint) DO UPDATE
             SET last_seen_at = now(),
                 -- a replayed step PROVES the element: it is no longer merely observed
                 observed_only = false,
                 success_count = selectors.success_count + 1,
                 test_id = coalesce(selectors.test_id, excluded.test_id),
                 css = coalesce(selectors.css, excluded.css),
                 fragility = excluded.fragility
           RETURNING selector_id, observed_only`,
          [
            appId,
            event.role ?? null,
            event.name ?? null,
            event.testId ?? null,
            event.css ?? null,
            fragilityFor(event, outcome),
            // '' is the main frame. Writing NULL here would put the row back
            // outside the unique index and re-introduce the duplicate bug.
            event.frameHint ?? '',
          ],
        );
        selectorId = sel[0]!.selector_id;
      }

      const { rows: stepRows } = await client.query<{ step_id: string }>(
        `INSERT INTO steps (app_id, action, selector_id, value_ref, args, semantic,
                            state_after, fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING step_id`,
        [
          appId,
          event.action,
          selectorId,
          // value_ref is a REFERENCE. A literal value is data and lives in args,
          // so nothing can mistake a typed string for a named parameter.
          event.valueRef ?? null,
          JSON.stringify({
            ...(event.value !== undefined ? { value: event.value } : {}),
            ...(event.exact ? { exact: true } : {}),
            ...(event.hints ?? {}),
          }),
          semantics[ordinal]!,
          outcome?.sig ?? null,
          stepFingerprint(event),
        ],
      );

      await client.query(
        `INSERT INTO flow_steps (flow_id, step_id, ordinal) VALUES ($1,$2,$3)`,
        [flowId, stepRows[0]!.step_id, ordinal],
      );
    }

    // THE GATE. A recording that did not replay gets a flow row for the record,
    // but NO chunk — so recall() can never surface it and nothing can bind to it.
    let chunkWritten = false;
    if (vector) {
      await client.query(
        `DELETE FROM memory_chunks WHERE app_id = $1 AND kind = 'flow' AND ref_id = $2`,
        [appId, flowId],
      );
      await client.query(
        `INSERT INTO memory_chunks (app_id, kind, ref_id, flow_id, text, meta, destructive, health, embedding)
         VALUES ($1,'flow',$2,$2,$3,$4,$5,0.6,$6::VECTOR(1024))`,
        [
          appId,
          flowId,
          chunkText,
          JSON.stringify({ source: 'recorded', recording_hash: recording.hash, steps: events.length }),
          destructive,
          toVector(vector),
        ],
      );
      chunkWritten = true;
    }

    return { flowId, created, chunkWritten };
  });

  return {
    flowId: result.flowId,
    slug,
    created: result.created,
    steps: events.length,
    selectorsCreated,
    selectorsReused,
    needsReview,
    destructive,
    chunkWritten: result.chunkWritten,
  };
}
