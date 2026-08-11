/**
 * Destructive inference — five signals, and it FAILS OPEN.
 *
 * CLAUDE.md: "commit-shaped control clicked, payment origin crossed, clicked
 * through a `boundary` fact, step fingerprint matches an already-destructive
 * flow, or a fact says so. No signal → not destructive. No question is ever
 * asked."
 *
 * Failing open is deliberate and worth stating plainly: a false positive blocks
 * a harmless test until someone passes `--allow-purchases`, while a false
 * negative places a real order. But asking would make the system interrogate the
 * user about every flow, which is the behaviour that gets a tool switched off.
 * So: infer from evidence, mark loudly, never ask.
 *
 * MARKED ON THE STEP, NOT THE FLOW. Segments share their parent's step rows, so
 * putting the mark on the step propagates in every direction for free — parent,
 * segment, and any mined macro containing it. That is what closes the routing
 * hole where the planner bound a differently-labelled flow doing the same thing.
 */

import type pg from 'pg';

/** Signal 1 — the control itself commits something. */
const COMMIT_WORDS =
  /\b(pay|purchase|buy|place order|order now|checkout|check out|confirm|delete|remove account|reset|deactivate|destroy|publish|subscribe|charge|submit order)\b/i;

/**
 * Signal 2 — the flow crosses into a payment provider.
 *
 * Reaching one of these origins means money is in play even if the control was
 * called something innocuous.
 */
const PAYMENT_HOSTS =
  /(^|\.)(stripe|paypal|braintree|adyen|checkout|squareup|klarna|worldpay|authorize)\.(com|net|io)$/i;

export interface StepLike {
  action: string;
  name?: string | undefined;
  url?: string | undefined;
  fingerprint: string;
}

export interface DestructiveVerdict {
  destructive: boolean;
  /** Which signal fired, for audit. Null when nothing did. */
  signal: string | null;
}

/**
 * Judge one step against all five signals.
 *
 * `boundaryControls` and `destructiveFingerprints` are passed in rather than
 * queried per step: they are per-app sets fetched once, and a per-step query
 * would turn ingest into N round trips.
 */
export function judgeStep(
  step: StepLike,
  context: {
    boundaryControls: Set<string>;
    destructiveFingerprints: Set<string>;
    factSaysDestructive: Set<string>;
  },
): DestructiveVerdict {
  const name = (step.name ?? '').trim();

  // 1 — commit-shaped control
  if (name && COMMIT_WORDS.test(name)) {
    return { destructive: true, signal: `commit-shaped control "${name}"` };
  }

  // 2 — payment origin crossed
  if (step.url) {
    try {
      const host = new URL(step.url).hostname;
      if (PAYMENT_HOSTS.test(host)) {
        return { destructive: true, signal: `payment origin ${host}` };
      }
    } catch {
      /* not a URL we can judge */
    }
  }

  // 3 — clicked through a control exploration REFUSED. Exploration already
  // decided this was too dangerous to touch; a recording that clicked it anyway
  // is by definition doing the thing exploration would not.
  if (name && context.boundaryControls.has(name.toLowerCase())) {
    return { destructive: true, signal: `clicked through a boundary fact ("${name}")` };
  }

  // 4 — the same step, by fingerprint, already appears in a destructive flow
  if (context.destructiveFingerprints.has(step.fingerprint)) {
    return { destructive: true, signal: 'fingerprint matches an already-destructive step' };
  }

  // 5 — a fact says so
  if (name && context.factSaysDestructive.has(name.toLowerCase())) {
    return { destructive: true, signal: `a fact names "${name}" as destructive` };
  }

  return { destructive: false, signal: null };
}

/**
 * Fetch the per-app evidence the signals need.
 *
 * Boundary facts are the interesting source: exploration's refusals become the
 * list of controls nobody should be clicking, so the boundary of exploration
 * turns into a safety input rather than only a note.
 */
export async function loadDestructiveContext(
  client: pg.PoolClient,
  appId: string,
): Promise<{
  boundaryControls: Set<string>;
  destructiveFingerprints: Set<string>;
  factSaysDestructive: Set<string>;
}> {
  const { rows: boundary } = await client.query<{ control: string }>(
    `SELECT scope->>'control' AS control FROM facts
     WHERE app_id = $1 AND kind = 'boundary' AND scope->>'refusal' = 'commit'
       AND scope->>'control' IS NOT NULL`,
    [appId],
  );

  const { rows: fingerprints } = await client.query<{ fingerprint: string }>(
    `SELECT DISTINCT s.fingerprint FROM steps s WHERE s.app_id = $1 AND s.destructive`,
    [appId],
  );

  const { rows: factRows } = await client.query<{ statement: string; scope: Record<string, unknown> }>(
    `SELECT statement, scope FROM facts
     WHERE app_id = $1 AND superseded_by IS NULL
       AND (statement ILIKE '%destructive%' OR statement ILIKE '%irreversible%'
            OR statement ILIKE '%places an order%' OR statement ILIKE '%charges%')`,
    [appId],
  );

  return {
    boundaryControls: new Set(boundary.map((r) => r.control.toLowerCase())),
    destructiveFingerprints: new Set(fingerprints.map((r) => r.fingerprint)),
    factSaysDestructive: new Set(
      factRows
        .map((r) => (typeof r.scope?.control === 'string' ? r.scope.control.toLowerCase() : ''))
        .filter(Boolean),
    ),
  };
}

/**
 * Recompute `flows.destructive` from the steps each flow contains.
 *
 * This is the propagation. A flow is destructive if ANY step in it is — which
 * covers the parent, every segment cut from it, and any mined macro that
 * happens to include that step, because they all reference the same rows.
 */
export async function propagateDestructive(client: pg.PoolClient, appId: string): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE flows f
        SET destructive = EXISTS (
              SELECT 1 FROM flow_steps fs
              JOIN steps s ON s.step_id = fs.step_id
              WHERE fs.flow_id = f.flow_id AND s.destructive),
            updated_at = now()
      WHERE f.app_id = $1`,
    [appId],
  );

  // memory_chunks denormalizes it so the re-rank can penalise without a join.
  // Left stale, recall() would keep offering a flow the gate then refuses.
  await client.query(
    `UPDATE memory_chunks mc
        SET destructive = f.destructive
       FROM flows f
      WHERE mc.app_id = $1 AND mc.ref_id = f.flow_id AND mc.kind IN ('flow','segment')`,
    [appId],
  );

  return rowCount ?? 0;
}
