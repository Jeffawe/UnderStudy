/**
 * The run registry — the stateful half of the pause-and-ask handshake.
 *
 *     run_plan(goal)              → pipeline starts, hits decompose, SUSPENDS
 *                                 → returns needs_decision (does NOT block)
 *     resume_run(requestId, ans)  → deferred resolves, pipeline continues
 *                                 → returns at the NEXT suspension, or the end
 *
 * Each call returns at the next suspension point or at completion — the
 * coroutine-over-RPC shape. The pipeline itself runs as a detached task, so a
 * tool call never waits on a human.
 *
 * Runs live in memory because they hold an open browser. That is the difference
 * from distillation, which is stateless and survives a restart. If this process
 * dies, its runs are abandoned; the `runs` row records that.
 */

import { HostAgentReasoner, vocabularyLines } from '../adapters/reasoner/host-agent.js';
import { buildPlan, type Plan } from './plan.js';
import { executePlan } from './execute.js';
import { fetchVocabulary } from './vocabulary.js';
import { recordRun } from './run.js';
import { getPool } from './db.js';
import type { Embedder, Reasoner } from './types.js';
import type { ReplayResult } from './replay.js';

export interface RunOutcome {
  plan: Plan;
  executed: boolean;
  result?: ReplayResult;
  flowsRun?: string[];
  blocked?: string;
}

interface Session {
  runId: string;
  appId: string;
  appSlug: string;
  goal: string;
  reasoner: HostAgentReasoner;
  settled: Promise<RunOutcome>;
  finished?: RunOutcome;
  error?: string;
}

const sessions = new Map<string, Session>();
/** requestId -> runId, so resume only needs the request it was handed. */
const byRequest = new Map<string, string>();

export type RunStep =
  | { status: 'needs_decision'; runId: string; requestId: string; ask: string; reason: string; payload: Record<string, unknown> }
  | { status: 'finished'; runId: string; outcome: RunOutcome }
  | { status: 'failed'; runId: string; error: string };

/** Wait for whichever comes first: the next suspension, or the run finishing. */
async function advance(session: Session): Promise<RunStep> {
  const next = await session.reasoner.nextSuspensionOr(
    session.settled.then(
      (outcome) => ({ ok: true as const, outcome }),
      (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
    ),
  );

  if ('suspended' in next) {
    byRequest.set(next.suspended.requestId, session.runId);
    return {
      status: 'needs_decision',
      runId: session.runId,
      requestId: next.suspended.requestId,
      ask: next.suspended.ask,
      reason: next.suspended.reason,
      payload: next.suspended.payload,
    };
  }

  if (!next.done.ok) {
    session.error = next.done.error;
    return { status: 'failed', runId: session.runId, error: next.done.error };
  }
  session.finished = next.done.outcome;
  return { status: 'finished', runId: session.runId, outcome: next.done.outcome };
}

export interface StartRunOptions {
  values?: Record<string, string>;
  env?: { allowsPurchases: boolean; allowsIrreversible: boolean; name?: string };
  dryRun?: boolean;
  headless?: boolean;
  /**
   * Capture visual checkpoints and have the reasoner judge them.
   *
   * Gated on the reasoner rather than always-on: judging a diff means looking
   * at an image, which the host agent can do and the Bedrock adapter cannot.
   * Capturing for a reasoner that can't look just fills a directory.
   */
  visualCheck?: boolean;
}

export async function resolveBaseUrl(appId: string, appSlug: string): Promise<string> {
  const { rows } = await getPool().query<{ base_url: string }>(
    'SELECT base_url FROM apps WHERE app_id = $1',
    [appId],
  );
  const baseUrl = rows[0]?.base_url;
  if (!baseUrl) throw new Error(`app ${appSlug} has no base URL`);
  return baseUrl;
}

/**
 * The pipeline itself — decompose, plan, execute — for ANY reasoner.
 *
 * This used to live inside `startRun`'s detached task, which quietly made it
 * Mode B-only: the suspension machinery around it is what MCP needs, and a
 * Bedrock reasoner needs none of it. Pulled out here, the two modes differ
 * only in how the pipeline is CALLED — awaited directly for Mode A, raced
 * against its own next suspension for Mode B — and not at all in what it does.
 *
 * Nothing in this function knows which reasoner it has. `decompose` resolves
 * from an API call in ~2s or from a human in ten minutes; the await is
 * identical either way.
 */
export async function runPipeline(
  embedder: Embedder,
  reasoner: Reasoner,
  appId: string,
  appSlug: string,
  goal: string,
  baseUrl: string,
  runId: string,
  opts: StartRunOptions = {},
): Promise<RunOutcome> {
  const vocabulary = await fetchVocabulary(appId, { purpose: 'plan' });

  // THE ONE MODEL CALL IN PLANNING. Everything after it is arithmetic.
  const subGoals = await reasoner.decompose(goal, vocabularyLines(vocabulary));

  const plan = await buildPlan(embedder, appId, goal, {
    subGoals,
    baseUrl,
    // Rung 5 uses the same reasoner as everything else — it just asks a
    // different question, and the answer is written back as memory.
    onSeamProbe: async (context) => {
      const answer = await reasoner.resolve({ kind: 'seam', context });
      return answer as { steps?: Array<{ action: string; role?: string; name?: string; testId?: string; css?: string; value?: string }> };
    },
    ...(opts.env ? { env: opts.env } : {}),
  });

  if (plan.blocked) return { plan, executed: false, blocked: plan.blocked };
  if (plan.unbound.length) return { plan, executed: false };
  if (opts.dryRun) return { plan, executed: false };

  const exec = await executePlan(plan, baseUrl, appSlug, {
    values: opts.values ?? {},
    ...(opts.headless === false ? { headless: false } : {}),
    ...(opts.visualCheck ? { visualCheck: { appSlug, runId } } : {}),
    // THE MID-RUN ESCALATION. The executor drives; when it cannot decide —
    // an unexpected page, a step that failed — it escalates here. In Mode B
    // that suspends and the agent answers; in Mode A it is another API call.
    // Same mechanism, different question, either reasoner.
    onDecision: (decision) => reasoner.resolve(decision),
  });
  await recordRun(exec.result, { appId, goal, mode: 'execute', reasoner: reasoner.id });

  return { plan, executed: true, result: exec.result, flowsRun: exec.flowsRun };
}

export async function startRun(
  embedder: Embedder,
  appId: string,
  appSlug: string,
  goal: string,
  opts: StartRunOptions = {},
): Promise<RunStep> {
  const baseUrl = await resolveBaseUrl(appId, appSlug);

  const reasoner = new HostAgentReasoner(appId);
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // Detached: the tool call must return at the first suspension, not sit here.
  const settled = runPipeline(embedder, reasoner, appId, appSlug, goal, baseUrl, runId, opts);

  // Swallow here so an unhandled rejection cannot take the process down; the
  // error is surfaced through advance() instead.
  settled.catch(() => {});

  const session: Session = { runId, appId, appSlug, goal, reasoner, settled };
  sessions.set(runId, session);
  return advance(session);
}

export async function resumeRun(requestId: string, answer: unknown): Promise<RunStep> {
  const runId = byRequest.get(requestId);
  const session = runId ? sessions.get(runId) : undefined;
  if (!session) throw new Error(`no run is waiting on request ${requestId}`);

  byRequest.delete(requestId);
  if (!session.reasoner.answer(requestId, answer)) {
    throw new Error(`request ${requestId} has already been answered`);
  }
  return advance(session);
}

export function abandonRun(runId: string, reason = 'abandoned'): boolean {
  const session = sessions.get(runId);
  if (!session) return false;
  session.reasoner.abandon(reason);
  sessions.delete(runId);
  return true;
}
