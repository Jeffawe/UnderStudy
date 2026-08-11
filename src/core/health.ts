/**
 * Selector health — one score per element, and quarantine when it stops working.
 *
 * Selectors are per-APP, not per flow: the same "Add to cart" button is ONE row
 * however many flows use it. That is what makes this meaningful — a rename
 * degrades every flow at once and you see ONE cause rather than twelve, and
 * healing it once fixes all of them.
 *
 * `success_count` was already being incremented at ingest, but failures were
 * never recorded anywhere and nothing ever computed `health` or set
 * `quarantined`. So the column existed, the rule was documented, and no element
 * could ever actually be quarantined.
 *
 * QUARANTINE DROPS THE CHUNK FROM recall(). `recall()`'s ANN query already
 * excludes quarantined selectors — that was built long before anything could
 * set the flag. This closes the other half.
 */

import { getPool } from './db.js';

export interface HealthRollup {
  updated: number;
  quarantined: string[];
  released: string[];
}

/** Outcomes that count as the selector having failed, not the app. */
const FAILURE_OUTCOMES = ['not_found', 'timeout', 'error', 'assert_fail'];

/**
 * Fold one run's outcomes into selector health.
 *
 * Health is a smoothed success rate rather than raw `s / (s + f)`: with one
 * observation the raw ratio is 0 or 1, which would make a single flake look
 * exactly like a permanently broken element. The +1/+2 prior keeps a new
 * selector near 0.5 until there is evidence either way.
 */
export async function rollUpSelectorHealth(appId: string, runId: string): Promise<HealthRollup> {
  const pool = getPool();

  await pool.query(
    `UPDATE selectors s SET
       success_count = s.success_count + counts.ok,
       failure_count = s.failure_count + counts.bad,
       last_seen_at = now()
     FROM (
       SELECT selector_id,
              count(*) FILTER (WHERE outcome = 'ok')::INT AS ok,
              count(*) FILTER (WHERE outcome = ANY($2::STRING[]))::INT AS bad
       FROM run_events
       WHERE run_id = $1 AND selector_id IS NOT NULL
       GROUP BY selector_id
     ) AS counts
     WHERE s.selector_id = counts.selector_id AND s.app_id = $3`,
    [runId, FAILURE_OUTCOMES, appId],
  );

  const { rows: updated } = await pool.query<{ n: number }>(
    `UPDATE selectors
        SET health = (success_count + 1.0) / (success_count + failure_count + 2.0)
      WHERE app_id = $1 AND (success_count > 0 OR failure_count > 0)
      RETURNING 1 AS n`,
    [appId],
  );

  // THE RULE: >=3 failures and no successes. Deliberately strict — quarantining
  // an element removes it from retrieval entirely, so a flaky-but-working
  // selector must not qualify. One success is enough to prove it can work.
  const { rows: quarantined } = await pool.query<{ name: string }>(
    `UPDATE selectors
        SET quarantined = true
      WHERE app_id = $1 AND NOT quarantined
        AND failure_count >= 3 AND success_count = 0
      RETURNING coalesce(nullif(name, ''), coalesce(test_id, css, 'unnamed')) AS name`,
    [appId],
  );

  // And release: an element that starts working again should come back rather
  // than staying dead because of history.
  const { rows: released } = await pool.query<{ name: string }>(
    `UPDATE selectors
        SET quarantined = false
      WHERE app_id = $1 AND quarantined AND success_count > 0
      RETURNING coalesce(nullif(name, ''), coalesce(test_id, css, 'unnamed')) AS name`,
    [appId],
  );

  return {
    updated: updated.length,
    quarantined: quarantined.map((r) => r.name),
    released: released.map((r) => r.name),
  };
}
