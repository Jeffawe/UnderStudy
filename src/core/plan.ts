/**
 * Planning — goal in, an ordered set of bound flows out.
 *
 * Everything here is DETERMINISTIC. The reasoner is consulted at exactly one
 * point (decompose, to split a goal into sub-goals in the app's vocabulary) and
 * everything after that is arithmetic and SQL: recall, bind, seam, safety.
 * That is what makes a plan reproducible and auditable — you can see why a
 * sub-goal bound to what it bound to.
 *
 * BINDING IS NOT JUST RETRIEVAL.
 *
 * `recall()` proposes candidates by meaning; binding decides which are LEGAL
 * from where execution currently is. That split is deliberate and it is the
 * cheap answer to the polarity problem documented in STATUS.md: "sign in to the
 * app" retrieves "Log out" at 0.9077, just ahead of "Log in" at 0.9201, because
 * a single-vector embedding cannot represent polarity. But "Log out" requires
 * being authenticated, and from the login page that precondition is unmet — so
 * it is unbindable on STATE grounds regardless of what the vector says.
 *
 * Embedding picks candidates. Structure decides which can actually run.
 */

import { getPool } from './db.js';
import { recall, isGap, GAP_DISTANCE, type RecalledChunk } from './recall.js';
import { resolveSeam, persistProbedBridge, type Seam } from './seams.js';
import type { Embedder } from './types.js';

export interface BoundStep {
  flowId: string;
  slug: string;
  title: string;
  /** What this flow is for, as the corpus phrases it. */
  intent: string;
  distance: number;
  startState: string | null;
  endState: string | null;
  preconditions: string[];
  destructive: boolean;
  steps: number;
  outcome: string | null;
}

export interface SubGoalPlan {
  subGoal: string;
  bound?: BoundStep;
  /** Candidates rejected by the state filter, with the reason. */
  rejected: Array<{ slug: string; distance: number; why: string }>;
  gap: boolean;
  topDistance: number | null;
  /** Facts and lessons retrieved alongside — context, never executed. */
  context: RecalledChunk[];
}

export interface Plan {
  goal: string;
  appId: string;
  subGoals: SubGoalPlan[];
  seams: Seam[];
  /** True when any bound flow is destructive. */
  destructive: boolean;
  /** Set when the safety gate refuses to execute. */
  blocked?: string;
  /** Sub-goals that bound to nothing. Execution cannot proceed past one. */
  unbound: string[];
}

export interface PlanOptions {
  /** Sub-goals, when a reasoner has already decomposed the goal. */
  subGoals?: string[];
  /** Environment flags. Absent means the safest reading — see below. */
  env?: { allowsPurchases: boolean; allowsIrreversible: boolean; name?: string };
  limit?: number;
  /** Needed to build an absolute URL for a rung-4 navigation seam. */
  baseUrl?: string;
  /**
   * Rung 5. Called only when rungs 1–4 all fail, so probing stays the last
   * resort it is meant to be. The reasoner drives a real browser and returns
   * the steps it found; we persist them and re-resolve, which then lands on
   * rung 2 — so the same gap is never probed twice.
   *
   * Omitted means an unresolved seam stays unresolved and blocks execution,
   * rather than being guessed at.
   */
  onSeamProbe?: (context: {
    fromSlug: string;
    toSlug: string;
    fromState: string;
    toState: string;
  }) => Promise<{ steps?: Array<{ action: string; role?: string; name?: string; testId?: string; css?: string; value?: string }> }>;
  /**
   * What is already true when the plan starts.
   *
   * Defaults to `['not authenticated']` because a fresh browser context has no
   * cookies — that is a FACT about how execution begins, not an assumption.
   * Without it the first sub-goal is judged against "we know nothing", so a
   * segment requiring authentication binds happily as step one and then fails
   * on a locator that was never going to be there.
   *
   * Override when starting from seeded storage state.
   */
  initialState?: string[];
}

/**
 * State predicates worth tracking across a plan.
 *
 * Deliberately tiny and keyword-based, in the same spirit as destructive
 * inference: preconditions and outcomes are prose, and a small audited list
 * beats pretending to parse English. `authenticated` is the one that decides
 * real bindings today.
 */
const STATE_PREDICATES = ['authenticated'];

/**
 * How much worse than the best candidate a fallback may be.
 *
 * When the closest match is refused on SAFETY grounds, the next legal candidate
 * is only a real alternative if it means roughly the same thing. Observed: with
 * the cart step marked destructive, "put an item into the cart" fell through
 * from a 0.4124 match to a 0.8936 mined macro that does not touch the cart —
 * a plan that silently did not do what was asked. Anything beyond this margin
 * is a different intent, and the honest answer there is "blocked".
 */
const FALLBACK_MARGIN = 0.12;

/** Fold a flow's outcome into what is now true. */
function applyOutcome(satisfied: Set<string>, outcome: string | null | undefined): void {
  if (!outcome) return;
  const text = outcome.toLowerCase();
  for (const p of STATE_PREDICATES) {
    if (!text.includes(p)) continue;
    if (new RegExp(`\\b(not|no longer)\\s+${p}`).test(text)) {
      satisfied.delete(p);
      satisfied.add(`not ${p}`);
    } else {
      satisfied.delete(`not ${p}`);
      satisfied.add(p);
    }
  }
}

interface FlowMeta {
  outcome: string | null;
  start_state: string | null;
  end_state: string | null;
  preconditions: string[];
  destructive: boolean;
  slug: string;
  title: string;
  steps: number;
}

/**
 * Does this flow's start state match where we currently are?
 *
 * `null` current state means "we haven't started yet", so anything is legal.
 * A flow with no recorded start_state is also permitted — absence of knowledge
 * is not evidence of conflict, and refusing would make every pre-replay flow
 * unbindable.
 */
function stateAllows(current: string | null, flow: FlowMeta): boolean {
  if (current === null) return true;
  if (!flow.start_state) return true;
  return flow.start_state === current;
}

/**
 * Preconditions are prose, so this is a deliberately shallow check: it looks
 * for a direct contradiction, not for entailment.
 *
 * "authenticated" vs "not authenticated" is the case that matters and the one
 * that actually fires — it is what stops "Log out" binding to "sign in". Real
 * precondition reasoning is the reasoner's job at seam time; this is the free
 * filter that catches the common, dangerous case.
 */
function contradicts(satisfied: Set<string>, preconditions: string[]): string | undefined {
  for (const raw of preconditions) {
    const p = raw.toLowerCase().trim();
    const negated = /^(not|no longer|un)\b/.test(p);
    const bare = p.replace(/^(not|no longer|un)\s+/, '');

    const haveBare = satisfied.has(bare);
    const haveNegated = satisfied.has(`not ${bare}`);

    if (negated && haveBare) return `requires "${raw}" but state is "${bare}"`;
    if (!negated && haveNegated) return `requires "${raw}" but state is "not ${bare}"`;
  }
  return undefined;
}

export async function buildPlan(
  embedder: Embedder,
  appId: string,
  goal: string,
  opts: PlanOptions = {},
): Promise<Plan> {
  const pool = getPool();
  const subGoals = opts.subGoals?.length ? opts.subGoals : [goal];
  const limit = opts.limit ?? 8;

  // FAIL CLOSED. No environment configured means we do not know whether spend
  // is allowed, and "unknown" must not read as "permitted" for something that
  // can place an order.
  const env = opts.env ?? { allowsPurchases: false, allowsIrreversible: false, name: '(none configured)' };

  const plans: SubGoalPlan[] = [];
  const seams: Seam[] = [];

  // Where execution will be when this sub-goal starts. Threaded through so each
  // binding is judged from the state its predecessor leaves behind.
  let currentState: string | null = null;
  const satisfied = new Set<string>(
    (opts.initialState ?? ['not authenticated']).map((s) => s.toLowerCase().trim()),
  );
  let previous: BoundStep | undefined;

  for (const subGoal of subGoals) {
    // NO destructive penalty here, deliberately. recall() can add +0.50 to
    // destructive chunks when spend is disallowed, but that RE-ORDERS rather
    // than forbids — and it fought the hard filter below: the correct segment
    // (0.4124) sorted behind an unrelated macro (0.8936) once penalised, so
    // binding took the macro before ever reaching the candidate it was meant to
    // refuse.
    //
    // Retrieval ranks by MEANING; binding applies POLICY. Keeping them separate
    // is what lets a refusal be a refusal instead of a nudge.
    const result = await recall(embedder, appId, subGoal, { limit });

    const rejected: SubGoalPlan['rejected'] = [];
    let bound: BoundStep | undefined;
    /** Distance of the closest candidate refused for being destructive. */
    let refusedBest: number | undefined;

    for (const candidate of result.bindable) {
      const { rows } = await pool.query<FlowMeta>(
        `SELECT slug, title, outcome, start_state, end_state, preconditions, destructive,
                (SELECT count(*) FROM flow_steps fs WHERE fs.flow_id = f.flow_id) AS steps
         FROM flows f WHERE f.flow_id = $1`,
        [candidate.flowId ?? candidate.refId],
      );
      const meta = rows[0];
      if (!meta) continue;

      const preconditions = Array.isArray(meta.preconditions) ? meta.preconditions : [];

      // DESTRUCTIVE IS A HARD FILTER, NOT A PENALTY.
      //
      // recall() adds +0.50 to destructive chunks when spend is disallowed,
      // which sorts them down — but sorting down is not forbidding. Observed:
      // asked to add an item to the cart with the cart step marked destructive,
      // the planner bound a mined macro that does not touch the cart at all,
      // because it merely scored better. A soft signal produced a plan that
      // silently did not do what was asked.
      //
      // If the only way to achieve a sub-goal is destructive and the
      // environment forbids it, the honest answer is "blocked", never
      // "here is something else".
      if (meta.destructive && !env.allowsPurchases) {
        rejected.push({
          slug: meta.slug,
          distance: candidate.distance,
          why: `destructive, and ${env.name ?? 'this environment'} does not allow purchases`,
        });
        refusedBest ??= candidate.distance;
        continue;
      }

      // A fallback far worse than the refused candidate is not an alternative
      // way to do the same thing; it is a different thing that happens to be
      // allowed. Substituting it would produce a plan that runs cleanly and
      // does not achieve the goal — the worst possible outcome.
      if (refusedBest !== undefined && candidate.distance - refusedBest > FALLBACK_MARGIN) {
        rejected.push({
          slug: meta.slug,
          distance: candidate.distance,
          why: `too far from the refused candidate (${refusedBest.toFixed(4)}) to be the same intent`,
        });
        continue;
      }

      const clash = contradicts(satisfied, preconditions);
      if (clash) {
        rejected.push({ slug: meta.slug, distance: candidate.distance, why: clash });
        continue;
      }
      if (!stateAllows(currentState, meta)) {
        rejected.push({
          slug: meta.slug,
          distance: candidate.distance,
          why: `starts at ${meta.start_state}, execution is at ${currentState}`,
        });
        continue;
      }

      bound = {
        flowId: candidate.flowId ?? candidate.refId,
        slug: meta.slug,
        title: meta.title,
        intent: candidate.text,
        distance: candidate.distance,
        startState: meta.start_state,
        endState: meta.end_state,
        preconditions,
        destructive: meta.destructive,
        steps: Number(meta.steps),
        outcome: meta.outcome,
      };
      break;
    }

    plans.push({
      subGoal,
      ...(bound ? { bound } : {}),
      rejected,
      // A sub-goal is a gap if nothing LEGAL bound, even when something was
      // retrieved — retrieving a flow you cannot run is not knowing how.
      gap: !bound || isGap(result),
      topDistance: result.topDistance,
      context: result.context,
    });

    if (bound) {
      if (previous) {
        const fromEp = { slug: previous.slug, endState: previous.endState, startState: previous.startState };
        const toEp = { slug: bound.slug, endState: bound.endState, startState: bound.startState };
        let seam = await resolveSeam(appId, fromEp, toEp, opts.baseUrl ?? 'http://localhost');

        // RUNG 5 — everything cheaper has failed, so ask someone who can look.
        if (seam.kind === 'unresolved' && opts.onSeamProbe && previous.endState && bound.startState) {
          const probed = await opts.onSeamProbe({
            fromSlug: previous.slug,
            toSlug: bound.slug,
            fromState: previous.endState,
            toState: bound.startState,
          });

          if (probed.steps?.length) {
            await persistProbedBridge(
              embedder,
              appId,
              previous.endState,
              bound.startState,
              probed.steps,
            );
            // Re-resolve rather than using the returned steps directly: if the
            // write-back worked, this now answers at rung 2 from the database,
            // which proves the gap will never be probed again.
            seam = await resolveSeam(appId, fromEp, toEp, opts.baseUrl ?? 'http://localhost');
            if (seam.kind === 'bridge-segment') {
              seam = { ...seam, kind: 'probed', rung: 5, detail: `probed and persisted; ${seam.detail}` };
            }
          }
        }
        seams.push(seam);
      }
      currentState = bound.endState ?? currentState;
      // A flow's outcome becomes the state its successor is judged against.
      applyOutcome(satisfied, bound.outcome);
      if (bound.endState) satisfied.add(`at ${bound.endState}`);
      previous = bound;
    }
  }

  const destructive = plans.some((p) => p.bound?.destructive);
  const unbound = plans.filter((p) => !p.bound).map((p) => p.subGoal);

  // THE SAFETY GATE. Before any browser action, and it fails closed.
  let blocked: string | undefined;
  if (destructive && !env.allowsPurchases) {
    const which = plans.filter((p) => p.bound?.destructive).map((p) => p.bound!.slug);
    blocked = `plan is destructive (${which.join(', ')}) and environment ${env.name ?? ''} does not allow purchases`;
  } else {
    // A sub-goal whose only candidates were refused for being destructive is
    // BLOCKED, not merely unbound — the difference between "I don't know how"
    // and "I know how and I am not allowed to" matters to whoever reads it.
    const forbidden = plans.filter(
      (p) => !p.bound && p.rejected.some((r) => r.why.includes('does not allow purchases')),
    );
    if (forbidden.length) {
      blocked =
        `${forbidden.length} sub-goal(s) can only be achieved destructively, and ` +
        `${env.name ?? 'this environment'} does not allow purchases: ` +
        forbidden.map((p) => `"${p.subGoal}"`).join(', ');
    }
  }

  return {
    goal,
    appId,
    subGoals: plans,
    seams,
    destructive,
    ...(blocked ? { blocked } : {}),
    unbound,
  };
}

export { GAP_DISTANCE };
export type { Seam } from './seams.js';
