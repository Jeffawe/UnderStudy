/**
 * Is this lesson trigger one that can fire as written?
 *
 * Lessons match by JSONB containment against a `StepContext` (lessons.ts), and
 * containment makes two mistakes silent. An empty trigger is contained by
 * EVERY context, so it fires on every step. A key the context never carries
 * (`urlPattern` for `url_pattern`) is contained by NO context, so the lesson
 * never fires and still looks exactly like one whose step simply has not come
 * up yet — observed on a real corpus, on the one lesson that explained why a
 * page rendered empty.
 *
 * Every writer of `lessons` runs this: remember, distill, triage. Lives in its
 * own module so `distill.ts` can validate without importing the database.
 */

/** The only keys a step context ever carries — see `StepContext` in lessons.ts. */
export const TRIGGER_KEYS = ['url_pattern', 'action', 'role', 'name'] as const;

/** Everything wrong with a trigger, or [] when it is usable. */
export function triggerProblems(trigger: unknown): string[] {
  if (typeof trigger !== 'object' || trigger === null || Array.isArray(trigger)) {
    return ['trigger must be an object'];
  }
  const keys = Object.keys(trigger);
  if (!keys.length) return ['trigger is empty — it would match every step'];
  const problems: string[] = [];
  for (const k of keys) {
    if (!(TRIGGER_KEYS as readonly string[]).includes(k)) {
      problems.push(
        `trigger key "${k}" is never in a step context, so the lesson could never fire — use ${TRIGGER_KEYS.join(', ')}`,
      );
    } else if (typeof (trigger as Record<string, unknown>)[k] !== 'string') {
      problems.push(`trigger.${k} must be a string`);
    }
  }
  return problems;
}
