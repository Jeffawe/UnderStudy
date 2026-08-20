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
import { selectorIdentity } from './selector-identity.js';
import { stepFingerprint } from './fingerprint.js';
import { urlPattern } from './sig.js';
import { toVector } from './recall.js';
import type { Embedder } from './types.js';
import type { RawEvent, RawRecording } from './recording.js';
import type { ReplayResult, StepOutcome } from './replay.js';
import { loadDistilled, type Distilled } from './distill.js';
import { judgeStep, loadDestructiveContext, propagateDestructive } from './destructive.js';

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
  /** Segments written, when a distillation was supplied. */
  segments: number;
  /** Candidate lessons persisted. */
  lessons: number;
  /** Distillation corrections recorded against the flow. */
  corrections: number;
  /**
   * Controls captured with no accessible name, each filed as an
   * `addressability` finding. Non-zero means this recording contains steps that
   * cannot be addressed as {role, name} — which is what makes a seam
   * unresolvable later, so it is worth seeing at ingest time.
   */
  unnamedControls: number;
  /** Step ids in ordinal order — lets the caller record a run against them. */
  stepIds: string[];
  /** Selector per step, parallel to stepIds. */
  selectorIds: Array<string | null>;
  appId: string;
  /** True when intent came from a distiller rather than being enumerated. */
  distilled: boolean;
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
    case 'scroll_container':
      // Says WHY, not just what: this text is what gets embedded, and "scroll
      // the pane" retrieves nothing useful for a goal about submitting a form.
      return event.value === 'bottom' || event.value === 'top'
        ? `Scroll the ${target} panel to the ${event.value} to satisfy a scroll gate`
        : `Scroll the${role} ${target} into view to satisfy a scroll gate`;
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
  opts: { force?: boolean; distilled?: Distilled } = {},
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

  const slug = slugFor(recording);
  const semantics = events.map(semanticFor);

  // A distilled flow is searched by its INTENT — what it is for, phrased the
  // way someone would ask for it. Mechanical ingest can only enumerate what the
  // flow does, which retrieves far worse. This is the text swap the distiller
  // exists to make.
  // A recording that has been distilled STAYS distilled. Re-ingesting without
  // passing one used to tear the segments down and leave the flow with only its
  // enumerated text — silently discarding the distillation, and then macro
  // mining would "discover" the login block it had just deleted the name for.
  const distilled = opts.distilled ?? (await loadDistilled(recording.hash));
  const chunkText = distilled
    ? `${distilled.intent}. Outcome: ${distilled.outcome}`
    : chunkTextFor(recording, semantics);

  // Embed OUTSIDE the transaction — it is the slow part, and holding a
  // CockroachDB transaction open across it invites the 40001 retries tx()
  // exists to absorb.
  const vector = needsReview ? null : await embedder.embedDocument(chunkText);

  // Segment chunks are embedded up front for the same reason — outside the
  // transaction, because embedding is the slow part.
  const segmentVectors: number[][] = [];
  if (distilled && !needsReview) {
    for (const seg of distilled.segments) {
      segmentVectors.push(await embedder.embedDocument(`${seg.intent}. Outcome: ${seg.outcome ?? distilled.outcome}`));
    }
  }

  let selectorsCreated = 0;
  let selectorsReused = 0;

  const result = await tx(async (client: pg.PoolClient) => {
    // Re-ingesting the same recording UPDATES rather than duplicating. The
    // recording hash is the identity — that is the same key the distillation
    // cache uses.
    // source='recorded' is NOT optional here. Segments carry the SAME
    // recording_hash as their parent (they came from that recording), so
    // without it this lookup returns the parent AND its segments — and
    // whichever row came back first was treated as "the flow". A segment then
    // received the parent's steps, its own children were torn down instead of
    // the parent's, and the next run died on a foreign key.
    const { rows: existing } = await client.query<{ flow_id: string }>(
      `SELECT flow_id FROM flows
       WHERE app_id = $1 AND recording_hash = $2 AND source = 'recorded'`,
      [appId, recording.hash],
    );

    const destructiveContext = await loadDestructiveContext(client, appId);

    let flowId: string;
    const created = existing.length === 0;

    if (created) {
      const { rows } = await client.query<{ flow_id: string }>(
        `INSERT INTO flows (app_id, slug, title, intent, outcome, start_state, end_state,
                            source, destructive, needs_review, recording_hash, corrections)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'recorded',$8,$9,$10,$11)
         RETURNING flow_id`,
        [
          appId,
          slug,
          distilled?.intent ?? slug,
          chunkText,
          replayResult.sigSequence[replayResult.sigSequence.length - 1] ?? null,
          replayResult.sigSequence[0] ?? null,
          replayResult.sigSequence[replayResult.sigSequence.length - 1] ?? null,
          false, // set by propagateDestructive once the steps exist
          needsReview,
          recording.hash,
          JSON.stringify(distilled?.corrections ?? []),
        ],
      );
      flowId = rows[0]!.flow_id;
    } else {
      flowId = existing[0]!.flow_id;
      await client.query(
        `UPDATE flows SET intent = $2, start_state = $3, end_state = $4,
                          destructive = $5, needs_review = $6, updated_at = now(),
                          title = coalesce($7, title), preconditions = $8,
                          corrections = $9
         WHERE flow_id = $1`,
        [
          flowId,
          chunkText,
          replayResult.sigSequence[0] ?? null,
          replayResult.sigSequence[replayResult.sigSequence.length - 1] ?? null,
          false, // set by propagateDestructive once the steps exist
          needsReview,
          distilled?.intent ?? null,
          JSON.stringify(distilled?.preconditions ?? []),
          JSON.stringify(distilled?.corrections ?? []),
        ],
      );
      // Membership is rebuilt from scratch. The step ROWS are then garbage
      // collected below: re-ingesting inserts fresh steps, so the previous
      // generation would otherwise linger forever, unreferenced and invisible
      // (10 step rows for a 5-step flow after one re-ingest).
      // FULL TEARDOWN BEFORE ANY WRITE.
      //
      // Interleaving teardown with inserts was too subtle to get right: the
      // old step rows were still referenced by the old SEGMENT memberships
      // when the collector ran, so they survived, and the rebuilt segments
      // then pointed at a different generation than the parent — silently
      // un-sharing them (steps=10 for a 5-step flow, 0 shared). Tear the whole
      // previous generation down first, collect its garbage, THEN build.
      const { rows: oldSegs } = await client.query<{ flow_id: string }>(
        'SELECT flow_id FROM flows WHERE parent_flow_id = $1',
        [flowId],
      );
      const oldSegIds = oldSegs.map((r) => r.flow_id);

      if (oldSegIds.length) {
        await client.query(
          `DELETE FROM memory_chunks WHERE app_id = $1 AND kind = 'segment' AND ref_id = ANY($2::UUID[])`,
          [appId, oldSegIds],
        );
        await client.query('DELETE FROM flow_steps WHERE flow_id = ANY($1::UUID[])', [oldSegIds]);
        await client.query('DELETE FROM flows WHERE flow_id = ANY($1::UUID[])', [oldSegIds]);
      }
      await client.query('DELETE FROM flow_steps WHERE flow_id = $1', [flowId]);

      // Now nothing references the previous generation, so this is unambiguous.
      await client.query(
        `DELETE FROM steps WHERE app_id = $1
           AND NOT EXISTS (SELECT 1 FROM flow_steps fs WHERE fs.step_id = steps.step_id)`,
        [appId],
      );
    }

    // Segments reference these EXACT step rows at their own ordinals — the
    // schema's whole reason for flow_steps being a join table. A step is never
    // duplicated just because two flows contain it.
    const stepIds: string[] = [];
    const stepSelectorIds: Array<string | null> = [];
    /** Controls captured with no accessible name — see the flag below. */
    const unnamed: Array<{ action: string; css: string | null; testId: string | null; semantic: string }> = [];

    for (const [ordinal, event] of events.entries()) {
      const outcome = outcomeBySeq.get(event.seq);
      let selectorId: string | null = null;

      // goto addresses no element.
      if (event.action !== 'goto') {
        // AN ELEMENT WITH NO ACCESSIBLE NAME IS NOT IDENTIFIED.
        //
        // `explore` already refuses to click one and records a boundary fact
        // about it, but a RECORDING captures them silently — `codegen` happily
        // emits `locator('div').filter({hasText:/^Services$/}).nth(1)`, which
        // imports as a step with role='' and name=''. Nothing complained, and
        // the cost surfaced much later and somewhere else: such a step cannot
        // be expressed as {role, name}, so any seam that needs it is
        // unresolvable and the flow can only ever bind as one whole recording.
        //
        // Flag it HERE, where it is cheap to fix, instead of at bind time.
        if (!event.name) {
          unnamed.push({
            action: event.action,
            css: event.css ?? null,
            testId: event.testId ?? null,
            semantic: semanticFor(event),
          });
        }
        // Selectors are per-APP and deduped on `identity` — one row per
        // element, so a rename degrades every flow at once and you see ONE
        // cause rather than twelve.
        //
        // identity is the accessible name when there is one (byte-identical to
        // the old role|name|frame key), else the test id, else the css. `null`
        // means the element cannot be identified AT ALL — and then it gets no
        // row, rather than sharing one with every other unnamed element on the
        // app. See src/core/selector-identity.ts for what that was costing.
        const identity = selectorIdentity({
          role: event.role ?? '',
          name: event.name ?? '',
          frameHint: event.frameHint ?? '',
          testId: event.testId ?? null,
          css: event.css ?? null,
        });

        if (identity) {
          // Ask BEFORE upserting whether this element is already known.
          // RETURNING cannot answer it: the ON CONFLICT branch sets
          // observed_only = false, so the returned row looks identical either
          // way and every selector would report as "reused".
          const { rows: prior } = await client.query<{ selector_id: string }>(
            'SELECT selector_id FROM selectors WHERE app_id = $1 AND identity = $2',
            [appId, identity],
          );
          if (prior.length) selectorsReused++;
          else selectorsCreated++;

          const { rows: sel } = await client.query<{ selector_id: string; observed_only: boolean }>(
            `INSERT INTO selectors (app_id, identity, role, name, frame_hint, test_id, css, fragility,
                                    observed_only, success_count, health)
             VALUES ($1,$8,$2,$3,$7,$4,$5,$6,false,1,0.6)
             ON CONFLICT (app_id, identity) DO UPDATE
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
              // '' not NULL: a NULL component makes the unique key inert.
              event.role ?? '',
              event.name ?? '',
              event.testId ?? null,
              event.css ?? null,
              fragilityFor(event, outcome),
              // '' is the main frame. Writing NULL here would put the row back
              // outside the unique index and re-introduce the duplicate bug.
              event.frameHint ?? '',
              identity,
            ],
          );
          selectorId = sel[0]!.selector_id;
        }
        // else: selectorId stays null. The step still runs — its addressing is
        // in `steps.args` (nth, hasText) — it just does not claim to be a
        // health-tracked element, because it is not one.
      }

      const fp = stepFingerprint(event);
      // All five signals, evaluated per STEP. Marking the step rather than the
      // flow is what propagates to every segment and macro sharing this row.
      const verdict = judgeStep(
        { action: event.action, name: event.name, url: event.url, fingerprint: fp },
        destructiveContext,
      );

      const { rows: stepRows } = await client.query<{ step_id: string }>(
        `INSERT INTO steps (app_id, action, selector_id, value_ref, args, semantic,
                            state_after, fingerprint, destructive, destructive_signal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
            // Which attribute the test id came from. Dropped here originally,
            // so anything reading it back defaulted to `data-testid` — and
            // saucedemo uses `data-test`. Same bug the executor hit once
            // already; losing it at ingest just moved it downstream.
            ...(event.testIdAttr ? { testIdAttr: event.testIdAttr } : {}),
            ...(event.hints ?? {}),
          }),
          semantics[ordinal]!,
          outcome?.sig ?? null,
          fp,
          verdict.destructive,
          verdict.signal,
        ],
      );

      stepIds.push(stepRows[0]!.step_id);
      stepSelectorIds.push(selectorId);
      await client.query(
        `INSERT INTO flow_steps (flow_id, step_id, ordinal) VALUES ($1,$2,$3)`,
        [flowId, stepRows[0]!.step_id, ordinal],
      );
    }

    // ---- segments -------------------------------------------------------
    //
    // A segment is NOT a different kind of thing: it is a flows row with
    // source='sliced' and a parent_flow_id, sharing the parent's step rows via
    // flow_steps. That is what makes "a login block captured while recording
    // checkout is reusable by every future flow" literally true rather than
    // aspirational.
    let segmentCount = 0;
    if (distilled) {
      // Segments were already torn down with the parent's membership above, so
      // a re-cut set of boundaries cannot leave stale bindable memory behind.
      for (const [i, seg] of distilled.segments.entries()) {
        const [start, end] = seg.stepRange;
        const slice = stepIds.slice(start, end);
        if (!slice.length) continue;


        const { rows: segRows } = await client.query<{ flow_id: string }>(
          `INSERT INTO flows (app_id, slug, title, intent, preconditions, outcome,
                              start_state, end_state, source, parent_flow_id,
                              destructive, recording_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sliced',$9,$10,$11)
           ON CONFLICT (app_id, slug) DO UPDATE
             SET title = excluded.title, intent = excluded.intent,
                 preconditions = excluded.preconditions, outcome = excluded.outcome,
                 start_state = excluded.start_state, end_state = excluded.end_state,
                 parent_flow_id = excluded.parent_flow_id,
                 destructive = excluded.destructive, updated_at = now()
           RETURNING flow_id`,
          [
            appId,
            seg.slug,
            seg.title,
            seg.intent,
            JSON.stringify(seg.preconditions ?? []),
            seg.outcome ?? null,
            // start_state is the state the segment begins FROM — the sig after
            // the PRECEDING step, not after its own first one. Seam resolution
            // matches A.end_state against B.start_state, so an off-by-one here
            // makes every segment uncomposable.
            start === 0
              ? (replayResult.sigSequence[0] ?? null)
              : (outcomeBySeq.get(events[start - 1]!.seq)?.sig ?? null),
            outcomeBySeq.get(events[end - 1]!.seq)?.sig ?? null,
            flowId,
            false, // derived from its steps, like every other flow
            recording.hash,
          ],
        );
        const segId = segRows[0]!.flow_id;

        await client.query('DELETE FROM flow_steps WHERE flow_id = $1', [segId]);
        for (const [ordinal, stepId] of slice.entries()) {
          await client.query(
            `INSERT INTO flow_steps (flow_id, step_id, ordinal) VALUES ($1,$2,$3)`,
            [segId, stepId, ordinal],
          );
        }

        const segVector = segmentVectors[i];
        if (segVector) {
          const segText = `${seg.intent}. Outcome: ${seg.outcome ?? distilled.outcome}`;
          await client.query(
            `DELETE FROM memory_chunks WHERE app_id = $1 AND kind = 'segment' AND ref_id = $2`,
            [appId, segId],
          );
          await client.query(
            `INSERT INTO memory_chunks (app_id, kind, ref_id, flow_id, text, meta, destructive, health, embedding)
             VALUES ($1,'segment',$2,$2,$3,$4,$5,0.6,$6::VECTOR(1024))`,
            [
              appId,
              segId,
              segText,
              JSON.stringify({ source: 'sliced', parent: flowId, steps: slice.length }),
              false,
              toVector(segVector),
            ],
          );
        }
        segmentCount++;
      }
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
          false, // propagateDestructive syncs this from the flow afterwards
          toVector(vector),
        ],
      );
      chunkWritten = true;
    }

    // ---- lessons ---------------------------------------------------------
    //
    // A lesson says "when X, do Y first" — the agent adapts. It is matched by
    // EXACT trigger predicate at every step during execution, not retrieved by
    // similarity, which is why the trigger is stored as structured JSON rather
    // than prose. Until now the distiller could return these and they were
    // validated and then silently dropped.
    let lessonCount = 0;
    if (distilled?.candidateLessons?.length) {
      // Rebuilt per distillation: a re-cut distillation may drop a lesson, and
      // a lesson nobody stands behind should not linger.
      await client.query(
        `DELETE FROM lessons WHERE lesson_id IN (
           SELECT lesson_id FROM lesson_links
           WHERE target_kind = 'flow' AND target_id = $1)`,
        [flowId],
      );

      for (const lesson of distilled.candidateLessons) {
        const { rows: lr } = await client.query<{ lesson_id: string }>(
          `INSERT INTO lessons (app_id, kind, title, body, trigger, source)
           VALUES ($1,$2,$3,$4,$5,'distilled')
           RETURNING lesson_id`,
          [appId, lesson.kind, lesson.title, lesson.body, JSON.stringify(lesson.trigger ?? {})],
        );
        await client.query(
          `INSERT INTO lesson_links (lesson_id, target_kind, target_id)
           VALUES ($1,'flow',$2) ON CONFLICT DO NOTHING`,
          [lr[0]!.lesson_id, flowId],
        );
        lessonCount++;
      }
    }

    // Derive destructive for every flow from the steps it now contains. This is
    // the propagation: parent, segments and macros all reference the same rows,
    // so none of them can be labelled differently from the others.
    await propagateDestructive(client, appId);

    const { rows: destRows } = await client.query<{ destructive: boolean }>(
      'SELECT destructive FROM flows WHERE flow_id = $1',
      [flowId],
    );

    return {
      flowId, created, chunkWritten, segmentCount, lessonCount, stepIds, stepSelectorIds,
      unnamed,
      destructive: destRows[0]?.destructive ?? false,
    };
  });

  // ---- flag controls that cannot be addressed -----------------------------
  //
  // Deliberately AFTER the transaction: a finding is a report about the
  // ingest, not part of it, and failing to file one must never roll back a
  // recording that otherwise ingested cleanly.
  //
  // Deduped per element by fingerprint, so re-ingesting the same recording
  // increments occurrences instead of filing a new finding every time.
  const unnamedFindings = new Map<string, { semantic: string; action: string; css: string | null; testId: string | null }>();
  for (const u of result.unnamed) {
    // css/testId, when present, is what actually distinguishes one unnamed
    // element from another — without either there is nothing to key on but the
    // step's own description.
    unnamedFindings.set(`unnamed:${slug}:${u.css ?? u.testId ?? u.semantic}`, u);
  }
  let unnamedFiled = 0;
  for (const [fingerprint, u] of unnamedFindings) {
    await getPool().query(
      `INSERT INTO findings (app_id, kind, severity, statement, evidence, fingerprint)
       VALUES ($1,'addressability','medium',$2,$3,$4)
       ON CONFLICT (app_id, fingerprint)
       DO UPDATE SET occurrences = findings.occurrences + 1, last_seen_at = now()`,
      [
        appId,
        `A control used by "${slug}" has no accessible name (${u.semantic}), so it cannot be addressed as {role, name}. ` +
          `Steps that reach it are unreplayable outside this recording, and any seam that needs it cannot be resolved.`,
        JSON.stringify({ flow: slug, action: u.action, css: u.css, testId: u.testId, semantic: u.semantic }),
        fingerprint,
      ],
    );
    unnamedFiled++;
  }

  return {
    flowId: result.flowId,
    slug,
    created: result.created,
    unnamedControls: unnamedFiled,
    steps: events.length,
    selectorsCreated,
    selectorsReused,
    needsReview,
    destructive: result.destructive,
    chunkWritten: result.chunkWritten,
    segments: result.segmentCount,
    distilled: Boolean(distilled),
    lessons: result.lessonCount,
    corrections: distilled?.corrections?.length ?? 0,
    stepIds: result.stepIds,
    selectorIds: result.stepSelectorIds,
    appId,
  };
}
