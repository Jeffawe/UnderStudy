/**
 * Flows in the database → IR events `replay()` can walk.
 *
 * The inverse of ingest. This lived inside `execute.ts` when the executor was
 * the only thing that needed it; the recorder now needs it too, to replay a
 * PRELUDE — a list of already-known flows walked in the context a capture is
 * about to arm in. Importing `executePlan` to reach it would have dragged the
 * planner and the safety gate into the recorder for one query.
 */

import { getPool } from './db.js';
import type { RawEvent } from './recording.js';

interface StepRow {
  action: string;
  role: string | null;
  name: string | null;
  test_id: string | null;
  css: string | null;
  frame_hint: string | null;
  value_ref: string | null;
  args: Record<string, unknown>;
  semantic: string;
  state_after: string | null;
}

/**
 * Reconstruct the IR for a flow, in order.
 *
 * `args.value` holds the literal that was typed, `value_ref` holds the
 * reference to something we deliberately never stored.
 */
export async function eventsForFlow(flowId: string, startingSeq: number): Promise<RawEvent[]> {
  const { rows } = await getPool().query<StepRow>(
    `SELECT s.action, sel.role, sel.name, sel.test_id, sel.css, sel.frame_hint,
            s.value_ref, s.args, s.semantic, s.state_after
     FROM flow_steps fs
     JOIN steps s ON s.step_id = fs.step_id
     LEFT JOIN selectors sel ON sel.selector_id = s.selector_id
     WHERE fs.flow_id = $1
     ORDER BY fs.ordinal`,
    [flowId],
  );

  return rows.map((r, i) => {
    const args = (r.args ?? {}) as Record<string, unknown>;
    const literal = typeof args.value === 'string' ? args.value : undefined;

    return {
      seq: startingSeq + i,
      ts: startingSeq + i,
      action: r.action as RawEvent['action'],
      // '' is how the schema encodes "no role/name" — turn it back into absence
      // so the locator builder falls through to test id or css.
      ...(r.role ? { role: r.role } : {}),
      ...(r.name ? { name: r.name } : {}),
      ...(literal !== undefined ? { value: literal } : {}),
      ...(r.value_ref ? { valueRef: r.value_ref } : {}),
      ...(r.test_id ? { testId: r.test_id } : {}),
      ...(args.testIdAttr ? { testIdAttr: String(args.testIdAttr) } : {}),
      ...(r.css ? { css: r.css } : {}),
      ...(r.frame_hint ? { frameHint: r.frame_hint } : {}),
      ...(args.exact ? { exact: true } : {}),
      ...(typeof args.nth === 'number' ? { hints: { nth: args.nth } } : {}),
      // state_after is the fingerprint this step PRODUCED when recorded — an
      // expectation, not a URL. It was being loaded and then assigned to `url`,
      // which threw the expectation away and put a sig where a URL belongs.
      ...(r.state_after ? { expectedSig: r.state_after } : {}),
      url: '',
      resolution: 'accname' as const,
    };
  });
}

export interface ResolvedFlow {
  flowId: string;
  slug: string;
  destructive: boolean;
  /** Flow slugs this one declares as its own prelude. */
  prelude: string[];
}

async function lookupFlow(appId: string, slug: string): Promise<ResolvedFlow | undefined> {
  const { rows } = await getPool().query<{
    flow_id: string; slug: string; destructive: boolean; prelude: string[] | null;
  }>(
    `SELECT flow_id, slug, destructive, prelude FROM flows WHERE app_id = $1 AND slug = $2`,
    [appId, slug],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    flowId: row.flow_id,
    slug: row.slug,
    destructive: row.destructive,
    prelude: Array.isArray(row.prelude) ? row.prelude : [],
  };
}

/**
 * Expand flow slugs to the full ordered list, following each flow's own prelude.
 *
 * TRANSITIVITY IS THE WHOLE REASON THIS RECURSES. A recording captured with
 * `--after log-in` ingests as a flow that does NOT contain the login — it
 * declares it. Someone later building on that flow would otherwise get its
 * steps without the login they depend on, and the failure surfaces as a locator
 * that matched nothing, three steps in, with no hint of the real cause.
 *
 * The cycle guard is not defensive programming: A declaring B while B declares
 * A is one mistaken `--after` away, and without the guard it is a hang, not an
 * error.
 */
export async function resolveFlowChain(appId: string, slugs: string[]): Promise<ResolvedFlow[]> {
  const chain: ResolvedFlow[] = [];
  const seen = new Set<string>();
  const onStack = new Set<string>();

  const visit = async (slug: string, trail: string[]): Promise<void> => {
    if (onStack.has(slug)) {
      throw new Error(`prelude cycle: ${[...trail, slug].join(' -> ')}`);
    }
    if (seen.has(slug)) return;

    const flow = await lookupFlow(appId, slug);
    if (!flow) {
      throw new Error(
        `no flow '${slug}' in this app's corpus — ` +
          `check \`understudy flows\` for the slugs that exist`,
      );
    }

    onStack.add(slug);
    for (const parent of flow.prelude) await visit(parent, [...trail, slug]);
    onStack.delete(slug);

    seen.add(slug);
    chain.push(flow);
  };

  for (const slug of slugs) await visit(slug, []);
  return chain;
}

/**
 * The IR for several flows, concatenated into one runnable sequence.
 *
 * Non-first `goto`s are dropped for the same reason `executePlan` drops them:
 * a flow that begins by navigating is self-contained, and honouring that
 * mid-sequence would throw away the state the previous flow just established.
 */
export async function eventsForFlowSlugs(
  appId: string,
  slugs: string[],
  startingSeq = 0,
): Promise<{ events: RawEvent[]; chain: ResolvedFlow[] }> {
  const chain = await resolveFlowChain(appId, slugs);
  const events: RawEvent[] = [];

  for (const flow of chain) {
    for (const e of await eventsForFlow(flow.flowId, 0)) {
      if (events.length && e.action === 'goto') continue;
      const seq = startingSeq + events.length;
      events.push({ ...e, seq, ts: seq });
    }
  }

  return { events, chain };
}
