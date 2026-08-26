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
import { recordRun, openRun, markRunStatus } from './run.js';
import { RunBudget, withBudget } from './budget.js';
import { loadRecording } from './recording-store.js';
import { saveHandoffSession, forgetHandoffSession } from './auth-cache.js';
import type { HandoffOutcome, HandoffRequest } from './replay.js';
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
  budget: RunBudget;
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
    // The row said 'pending' from the moment it was written; it is only truly
    // DELIVERED once we are about to hand it back to the agent.
    void session.reasoner.markDelivered(next.suspended.requestId);
    if (next.suspended.kind === 'record_flow') void markRunStatus(session.runId, 'needs_context');
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
  budget: RunBudget = new RunBudget(),
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
    budget: { stepAttempts: budget.limits.stepAttempts, exceeded: () => budget.exceeded() },
    // THE HANDOFF. Distinct from onDecision because the request carries live
    // storageState, which must never reach a PendingDecision payload — that
    // goes verbatim into a JSONB column.
    onHandoff: (request) => handoffToHuman(reasoner, appId, appSlug, runId, request),
    // THE MID-RUN ESCALATION. The executor drives; when it cannot decide —
    // an unexpected page, a step that failed — it escalates here. In Mode B
    // that suspends and the agent answers; in Mode A it is another API call.
    // Same mechanism, different question, either reasoner.
    onDecision: (decision) => reasoner.resolve(decision),
  });
  await recordRun(exec.result, { appId, goal, mode: 'execute', reasoner: reasoner.id, runId });
  await forgetHandoffSession(runId);

  return { plan, executed: true, result: exec.result, flowsRun: exec.flowsRun };
}


/**
 * Ask a human to record the piece the executor cannot do, and adopt what they
 * reached.
 *
 * OUT OF PROCESS, DELIBERATELY. Opening a headed window from inside the MCP
 * server would mean either a tool call that blocks for ten minutes — breaking
 * "a tool call never waits on a human", the rule this whole file is built on —
 * or a second suspension whose deferred two parties race to resolve. It also
 * assumes the stdio server has a display. Instead the run parks its state on
 * disk, hands the agent a command to paste, and waits for an ordinary
 * `resume_run` carrying the hash the CLI printed.
 *
 * THE PAYLOAD CARRIES A PATH, NEVER THE STATE. `storageState` holds live
 * session tokens and every PendingDecision payload is written verbatim into
 * `context_requests.payload`, a JSONB column in a cluster that may be hosted.
 */
export async function handoffToHuman(
  reasoner: Reasoner,
  appId: string,
  appSlug: string,
  runId: string,
  request: HandoffRequest,
): Promise<HandoffOutcome> {
  const sessionFile = await saveHandoffSession(request.storageState, runId, {
    url: request.url,
    sig: request.sig,
  });

  const seed = `--seed-session ${sessionFile} --seed-url '${request.url}'`;
  const answer = await reasoner.resolve({
    kind: 'needs_capture',
    context: {
      runId,
      appSlug,
      trigger: request.trigger,
      why: request.reason,
      atStep: request.seq,
      ...(request.failed ? { failed: request.failed } : {}),
      from: {
        url: request.url,
        sig: request.sig,
        ...(request.expectedSig ? { expectedSig: request.expectedSig } : {}),
        sessionFile,
      },
      howTo: {
        run: `understudy record ${appSlug} ${seed}`,
        then: 'the command prints a hash — send it back as { recordingHash }',
      },
      expects: {
        recordingHash: 'the hash `understudy record` printed',
        orInstead: "{ action: 'skip' } to let the run fail here, or { action: 'abort', reason }",
      },
    },
  });

  if (answer.action === 'abort') {
    return { action: 'abort', ...(answer.reason ? { reason: String(answer.reason) } : {}) };
  }
  const hash = typeof answer.recordingHash === 'string' ? answer.recordingHash : undefined;
  if (!hash) return { action: 'skip' };

  const captured = await loadRecording(hash).catch(() => undefined);
  if (!captured) return { action: 'skip' };

  if (reasoner instanceof HostAgentReasoner) {
    await reasoner.markIngested({
      recordingHash: hash,
      steps: captured.events.length,
      trigger: request.trigger,
    });
  }

  // Where the human ACTUALLY ended up, which is the state being adopted — not
  // where they were asked to start.
  const last = captured.events[captured.events.length - 1];
  const landedUrl = last?.url || request.url;

  await markRunStatus(runId, 'running');

  // NO EXPECTED SIG IS CLAIMED, on purpose. The recording's `startState` is
  // where the human ARMED — the seed page — not where they finished, so
  // asserting it would compare against the wrong end of their work. There is no
  // second oracle for where they ended up, and inventing one that could
  // disagree with the real check is the mistake `auth-cache.ts` documents: the
  // NEXT step's own `expectedSig` already answers "am I somewhere sensible?",
  // and it answers it against the flow we are actually trying to run.
  return {
    action: 'adopt',
    steps: captured.events,
    url: landedUrl,
    recordingHash: hash,
  };
}

export async function startRun(
  embedder: Embedder,
  appId: string,
  appSlug: string,
  goal: string,
  opts: StartRunOptions = {},
): Promise<RunStep> {
  const baseUrl = await resolveBaseUrl(appId, appSlug);

  // OPENED UP FRONT, and it is a real UUID. The row used to be written only at
  // the END, which left `context_requests.run_id` unconditionally NULL — so
  // "what is this run waiting on?" was unanswerable in SQL, and a run that died
  // mid-flight left no trace at all.
  const runId = await openRun({ appId, goal, mode: opts.dryRun ? 'dry-run' : 'execute', reasoner: 'host-agent' });

  const budget = new RunBudget();
  const reasoner = new HostAgentReasoner(appId, runId);
  const metered = withBudget(reasoner, budget);

  // Detached: the tool call must return at the first suspension, not sit here.
  const settled = runPipeline(embedder, metered, appId, appSlug, goal, baseUrl, runId, opts, budget);

  // Swallow here so an unhandled rejection cannot take the process down; the
  // error is surfaced through advance() instead.
  settled.catch(() => {});

  const session: Session = { runId, appId, appSlug, goal, reasoner, budget, settled };
  sessions.set(runId, session);
  return advance(session);
}

export async function resumeRun(
  requestId: string,
  answer: unknown,
  usage?: { totalTokens?: number | undefined },
): Promise<RunStep> {
  const runId = byRequest.get(requestId);
  const session = runId ? sessions.get(runId) : undefined;
  if (!session) throw new Error(`no run is waiting on request ${requestId}`);

  // A SELF-REPORT CAN ONLY EVER TRIP THE BUDGET SOONER — see budget.ts. It
  // rides beside `answer` rather than inside it, because `answer` is the
  // reasoner's response to the question that was asked, and burying a meta
  // field in it would oblige every reader of an answer to know to ignore it.
  if (typeof usage?.totalTokens === 'number') session.budget.selfReport(usage.totalTokens);

  // VALIDATE BEFORE DELIVERING. An answer of the wrong shape used to be
  // accepted silently and then explode somewhere unhelpful — or, for decompose,
  // kill the run outright. Re-asking costs one question.
  const misfit = HostAgentReasoner.misfit(session.reasoner.pendingKind, answer);
  if (misfit) {
    return {
      status: 'needs_decision',
      runId: session.runId,
      requestId,
      ask: `That answer does not fit the question — ${misfit}`,
      reason: session.reasoner.pending?.reason ?? 'the run is still waiting on this',
      payload: session.reasoner.pending?.payload ?? {},
    };
  }

  byRequest.delete(requestId);
  if (!session.reasoner.answer(requestId, answer)) {
    // NOT AN ERROR ANY MORE. With handoffs a late or duplicated resume is
    // ordinary — a human retries, or two windows answer the same prompt.
    // Throwing lost the run for a caller who had done nothing wrong; returning
    // where the run actually IS lets them carry on.
    return advance(session);
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
