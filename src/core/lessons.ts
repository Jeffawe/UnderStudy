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
 * Record that a lesson fired.
 *
 * `times_applied` counts every firing; `times_helped` is only incremented when
 * the step it guarded actually succeeded. The ratio is what eventually says
 * whether a lesson earns its keep — a lesson that fires constantly and never
 * helps is noise with a trigger attached.
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
