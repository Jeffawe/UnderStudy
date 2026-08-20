/**
 * lessons_for — what have we learned about THIS step?
 *
 * A lesson is a conditional fix: "when X, do Y first". It is matched by EXACT
 * TRIGGER PREDICATE at every step during execution, never by similarity —
 * which is why the trigger is structured JSON and not prose. A lesson that
 * fired approximately would be worse than no lesson: it would change behaviour
 * on steps it was never about.
 *
 * This is the read path for everything the system learns. Lessons were being
 * written by the distiller and promoted from findings, and then never once
 * consulted — the difference between recording that you learned something and
 * actually acting on it.
 *
 * MATCHING IS CONTAINMENT. The trigger is a subset of the step's context:
 * `{action: 'click'}` fires on every click, `{action: 'click', name: 'Login'}`
 * only on that one. An absent key is a wildcard, so a lesson is as broad or as
 * narrow as whoever wrote it made it.
 */

import { getPool } from './db.js';
import { stepFingerprint } from './fingerprint.js';
import type { RawEvent } from './recording.js';

export interface StepContext {
  url_pattern?: string;
  action?: string;
  role?: string;
  name?: string;
}

export interface Lesson {
  lessonId: string;
  kind: string;
  title: string;
  body: string;
  fixSnippet: string | null;
  trigger: Record<string, unknown>;
  confidence: number;
}

/**
 * Every lesson whose trigger is satisfied by this step.
 *
 * `$2 @> trigger` is JSONB containment: the context contains every key/value
 * the trigger demands. Done in SQL rather than in JS so a large lesson set stays
 * one indexed query rather than a fetch-and-filter.
 */
export async function lessonsFor(appId: string, context: StepContext): Promise<Lesson[]> {
  const { rows } = await getPool().query<{
    lesson_id: string; kind: string; title: string; body: string;
    fix_snippet: string | null; trigger: Record<string, unknown>; confidence: number;
  }>(
    `SELECT lesson_id, kind, title, body, fix_snippet, trigger, confidence
     FROM lessons
     WHERE app_id = $1 AND $2::JSONB @> trigger
     ORDER BY confidence DESC`,
    [appId, JSON.stringify(context)],
  );

  return rows.map((r) => ({
    lessonId: r.lesson_id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    fixSnippet: r.fix_snippet,
    trigger: r.trigger ?? {},
    confidence: Number(r.confidence),
  }));
}

/**
 * Has a step of this KIND ever actually failed on this app?
 *
 * This is the counterfactual `times_helped` needs. We cannot re-run the step
 * without its lesson to see what would have happened, but we can ask whether
 * this fingerprint — same action, role, name and route — has a recorded
 * history of going wrong. If it never has, a lesson firing on it has no
 * demonstrated problem to solve.
 *
 * `run_events.step_id` is ON DELETE SET NULL (db/03), so the join silently
 * drops events whose step rows were replaced by a re-ingest. That is the right
 * behaviour here: it makes the check conservative, and a lesson is better
 * under-credited than falsely credited.
 */
async function fingerprintHasFailed(appId: string, fingerprint: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM run_events re
     JOIN steps s ON s.step_id = re.step_id
     WHERE s.app_id = $1 AND s.fingerprint = $2
       AND re.outcome IN ('not_found','assert_fail','timeout','error')
     LIMIT 1`,
    [appId, fingerprint],
  );
  return rows.length > 0;
}

/**
 * Fold one replay's lesson firings into the counters.
 *
 * Lives here, not in `execute.ts`, because it was ONLY in execute.ts — so
 * lessons fired during a verification replay were never counted, and every
 * lesson on a corpus that had never had a real executor run sat at
 * `times_applied = 0`. That is indistinguishable from a trigger that was never
 * right, which is the exact failure the operating contract warns about.
 *
 * Needs the events as well as the outcomes because the fingerprint is computed
 * from the event (action/role/name/route); `StepOutcome` does not carry it.
 */
export async function foldLessonOutcomes(
  appId: string,
  steps: Array<{ seq: number; ok: boolean; lessonsApplied?: Array<{ lessonId: string }> }>,
  events: RawEvent[],
): Promise<{ fired: number; helped: number }> {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  // One run can fire the same lesson on many steps; cache so a long flow does
  // not re-ask the same question per step.
  const failedBefore = new Map<string, boolean>();
  let fired = 0;
  let helped = 0;

  for (const step of steps) {
    if (!step.lessonsApplied?.length) continue;
    fired += step.lessonsApplied.length;

    let didHelp = false;
    if (step.ok) {
      const event = bySeq.get(step.seq);
      if (event) {
        const fp = stepFingerprint(event);
        let known = failedBefore.get(fp);
        if (known === undefined) {
          known = await fingerprintHasFailed(appId, fp);
          failedBefore.set(fp, known);
        }
        didHelp = known;
      }
    }
    if (didHelp) helped += step.lessonsApplied.length;
    await markApplied(step.lessonsApplied.map((l) => l.lessonId), didHelp);
  }

  return { fired, helped };
}

/**
 * Record that a lesson fired.
 *
 * `times_applied` counts every firing. `times_helped` counts only firings where
 * the guarded step PASSED **and** a step of that same fingerprint has failed
 * before — see `fingerprintHasFailed`.
 *
 * The older definition was simply "the step passed", which sounds right and is
 * nearly useless: on a healthy flow every step passes, so `times_helped`
 * tracked `times_applied` almost exactly and the ratio could not distinguish a
 * lesson that is load-bearing from one that fires harmlessly on steps that were
 * never going to fail. Requiring evidence of prior trouble makes the number
 * falsifiable: applied high with helped at zero now means "this lesson has
 * never once fired on a step with a history of going wrong", which is
 * actionable — it is probably scoped too broadly, or no longer needed.
 */
export async function markApplied(lessonIds: string[], helped: boolean): Promise<void> {
  if (!lessonIds.length) return;
  await getPool()
    .query(
      `UPDATE lessons
         SET times_applied = times_applied + 1,
             times_helped = times_helped + $2
       WHERE lesson_id = ANY($1::UUID[])`,
      [lessonIds, helped ? 1 : 0],
    )
    .catch(() => {
      // Bookkeeping must never sink a run.
    });
}

/** `/inventory.html#bf3dd322` -> `/inventory.html`. */
export const patternOf = (sig: string): string =>
  sig.includes('#') ? sig.slice(0, sig.lastIndexOf('#')) : sig;
