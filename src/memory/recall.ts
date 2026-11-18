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

export interface FlowMatch {
  slug: string;
  title: string;
  kind: Flow['kind'];
  score: number;
  destructive: boolean;
  requiresSession: boolean;
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
  slug: f.slug, title: f.title, kind: f.kind, score,
  destructive: f.destructive, requiresSession: f.requiresSession,
});

export async function recall(app: string, goal: string, opts: { limit?: number } = {}): Promise<Recall> {
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
    return { goal, method: 'exact', verdict: 'known', best, why: `named exactly`, flows: [best], notes: [] };
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
      ...(verdict === 'known' ? { best: matches[0]! } : {}),
      notes: notes.map((n) => ({ kind: n.kind, text: n.text, score: n.score })),
    };
  }

  // 3. By words, with no model. Corpora are small, so scoring every flow is fine.
  const all = await c.flows.find({ app }, { projection: { slug: 1, title: 1, intent: 1, kind: 1, destructive: 1, requiresSession: 1 } }).toArray();
  const matches = all
    .map((f) => toMatch(f as Flow, wordScore(goal, f as Flow)))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const { verdict, why } = judge(matches.map((m) => m.score), WORDS);
  return { goal, method: 'words', verdict, why, flows: matches, notes: [], ...(verdict === 'known' ? { best: matches[0]! } : {}) };
}
