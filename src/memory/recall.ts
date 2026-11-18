/**
 * recall: what does memory know about a goal?
 *
 * A database query — no browser, no model call beyond embedding the goal — so
 * it is cheap enough to run before every action. It returns the closest flows
 * and notes, and a verdict:
 *
 *   known    one flow clearly does this — safe to run it
 *   unsure   something is close, but not clearly the answer — show, don't run
 *   unknown  nothing does this — record it rather than guess
 *
 * Two ways to match, depending on whether an embedding model is configured:
 *   meaning  embed the goal and search by vector (any wording works)
 *   words    no model: match the goal's words against flow names
 * Either way, a goal that IS a flow's name or slug matches exactly.
 */

import type { Flow, Note } from '../store/types.js';
import { collections, vectorSearch } from '../store/db.js';
import { embed, embedderConfig } from '../store/embed.js';
import { valuesFromEnv, valueEnvNames } from '../store/settings.js';

export interface FlowMatch {
  slug: string;
  title: string;
  kind: Flow['kind'];
  madeBy: 'user' | 'agent';
  score: number;
  destructive: boolean;
  requiresSession: boolean;
}

/** One step of the flow to run, in a form an agent can drive from directly. */
export interface BriefStep {
  n: number;
  action: string;
  role?: string;
  name?: string;
  /** How to find it when there's no role + name. */
  testId?: string;
  css?: string;
  /** Which of several matching elements (0-based). */
  nth?: number;
  /** A literal value to type or select, or the address for a goto. */
  value?: string;
  /** A login value that was never stored — see `needs` for where it is. */
  placeholder?: string;
}

/** A login value the flow needs: where it's set, and whether it is — never the value. */
export interface Need {
  placeholder: string;
  /** Environment variables Understudy reads it from, in order. */
  readFrom: string[];
  set: boolean;
}

export interface NoteMatch {
  kind: Note['kind'];
  text: string;
  score: number;
}

export type Verdict = 'known' | 'unsure' | 'unknown';

export interface Recall {
  goal: string;
  method: 'exact' | 'meaning' | 'words';
  verdict: Verdict;
  /** The flow to run, when the verdict is 'known'. */
  best?: FlowMatch;
  /** When known: the best flow's steps, so an agent can drive it itself. */
  steps?: BriefStep[];
  /** When known: the login values those steps need. */
  needs?: Need[];
  /** Why the verdict, in one line a person can read. */
  why: string;
  flows: FlowMatch[];
  notes: NoteMatch[];
}

/**
 * When a match by MEANING is good enough to act on. Calibrated 2026-11-18 on
 * the providernow corpus with voyage-4-lite (15 known goals, 14 plausible
 * unknown ones — see ROADMAP.md): no single score separates them, because a
 * goal the app doesn't have still lands near something. What does separate
 * them is how far the top match is ahead of the runner-up. A different
 * embedding model needs recalibrating.
 */
export const MEANING = {
  /** At or above this, the top flow is the answer. */
  strong: 0.78,
  /** At or above this, the top flow is the answer IF it clearly beats the runner-up… */
  good: 0.7,
  /** …by at least this much. */
  margin: 0.08,
};

/** The same rule for word matching, where a score is the share of the goal's words a flow contains. */
export const WORDS = { strong: 1, good: 0.6, margin: 0.2 };

/** Pure: the verdict for a ranked list of scores. Exported for tests. */
export function judge(scores: number[], rule: { strong: number; good: number; margin: number }): { verdict: Verdict; why: string } {
  const [top, second] = scores;
  if (top === undefined) return { verdict: 'unknown', why: 'this app has no flows yet' };
  const f = (n: number) => n.toFixed(2);

  if (top >= rule.strong) return { verdict: 'known', why: `strong match (${f(top)})` };
  if (top >= rule.good) {
    // With only one flow there's no runner-up to beat, so only a strong match counts.
    if (second === undefined) return { verdict: 'unsure', why: `good match (${f(top)}), but only one flow to compare with` };
    if (top - second >= rule.margin) return { verdict: 'known', why: `good match (${f(top)}), clearly ahead of the next (${f(second)})` };
    return { verdict: 'unsure', why: `good match (${f(top)}), but the next is close (${f(second)})` };
  }
  return { verdict: 'unknown', why: `nothing matches well (best ${f(top)})` };
}

const STOP = new Set(['a', 'an', 'the', 'to', 'my', 'of', 'for', 'and', 'in', 'on', 'as', 'i', 'me', 'it', 'is', 'with', 'at', 'up', 'out']);
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)));

/** Share of the goal's words that appear in the flow's name, slug or intent. */
export function wordScore(goal: string, flow: Pick<Flow, 'slug' | 'title' | 'intent'>): number {
  const g = words(goal);
  if (!g.size) return 0;
  const f = words(`${flow.title} ${flow.slug} ${flow.intent}`);
  let hit = 0;
  for (const w of g) if (f.has(w)) hit++;
  return hit / g.size;
}

const toMatch = (f: Flow & { score?: number }, score: number): FlowMatch => ({
  slug: f.slug, title: f.title, kind: f.kind, madeBy: f.madeBy ?? 'user', score,
  destructive: f.destructive, requiresSession: f.requiresSession,
});

/** The best flow's steps and the login values they need, for an agent driving it itself. */
async function plan(app: string, slug: string): Promise<Pick<Recall, 'steps' | 'needs'>> {
  const { flows } = await collections();
  const flow = await flows.findOne({ app, slug }, { projection: { steps: 1 } });
  if (!flow) return {};
  const steps: BriefStep[] = flow.steps.map((s, n) => {
    const nth = typeof s.hints?.nth === 'number' ? (s.hints.nth as number) : undefined;
    const addressed = Boolean(s.role && s.name);
    return {
      n, action: s.action,
      ...(s.role ? { role: s.role } : {}), ...(s.name ? { name: s.name } : {}),
      ...(!addressed && s.testId ? { testId: s.testId } : {}),
      ...(!addressed && !s.testId && s.css ? { css: s.css } : {}),
      ...(nth !== undefined ? { nth } : {}),
      ...(s.valueRef ? { placeholder: s.valueRef } : s.value !== undefined ? { value: s.value } : s.action === 'goto' ? { value: s.url } : {}),
    };
  });
  const refs = [...new Set(flow.steps.map((s) => s.valueRef).filter((r): r is string => Boolean(r)))];
  const found = valuesFromEnv(refs);
  const needs = refs.map((placeholder) => ({ placeholder, readFrom: valueEnvNames(placeholder), set: placeholder in found }));
  return { steps, ...(needs.length ? { needs } : {}) };
}

/**
 * `withSteps`: when the verdict is known, also return the best flow's steps and
 * the login values it needs — what an agent driving the flow itself wants. Off
 * for the planner, which only needs to know which flow.
 */
export async function recall(app: string, goal: string, opts: { limit?: number; withSteps?: boolean } = {}): Promise<Recall> {
  const limit = opts.limit ?? 5;
  const c = await collections();
  const needle = goal.trim().toLowerCase();

  // 1. The goal names a flow exactly: no search needed, and no doubt.
  const exact = await c.flows.findOne(
    { app, $or: [{ slug: needle }, { title: { $regex: `^${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }] },
    { projection: { embedding: 0, steps: 0 } },
  );
  if (exact) {
    const best = toMatch(exact, 1);
    return { goal, method: 'exact', verdict: 'known', best, why: `named exactly`, flows: [best], notes: [], ...(opts.withSteps ? await plan(app, best.slug) : {}) };
  }

  // 2. By meaning, if there's a model.
  if (embedderConfig()) {
    const [vector] = await embed([goal], 'query');
    const [flows, notes] = await Promise.all([
      vectorSearch(c.flows, app, vector!, { limit }),
      vectorSearch(c.notes, app, vector!, { limit }),
    ]);
    const matches = flows.map((f) => toMatch(f, f.score));
    const { verdict, why } = judge(matches.map((m) => m.score), MEANING);
    return {
      goal, method: 'meaning', verdict, why, flows: matches,
      ...(verdict === 'known' ? { best: matches[0]!, ...(opts.withSteps ? await plan(app, matches[0]!.slug) : {}) } : {}),
      notes: notes.map((n) => ({ kind: n.kind, text: n.text, score: n.score })),
    };
  }

  // 3. By words, with no model. Corpora are small, so scoring every flow is fine.
  const all = await c.flows.find({ app }, { projection: { slug: 1, title: 1, intent: 1, kind: 1, madeBy: 1, destructive: 1, requiresSession: 1 } }).toArray();
  const matches = all
    .map((f) => toMatch(f as Flow, wordScore(goal, f as Flow)))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const { verdict, why } = judge(matches.map((m) => m.score), WORDS);
  return {
    goal, method: 'words', verdict, why, flows: matches, notes: [],
    ...(verdict === 'known' ? { best: matches[0]!, ...(opts.withSteps ? await plan(app, matches[0]!.slug) : {}) } : {}),
  };
}
