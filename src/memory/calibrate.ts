/**
 * calibrate: fit recall's known/unknown cutoffs to one app and one embedding
 * model, instead of trusting numbers set by hand for another model.
 *
 * recall says "known" when the top flow scores ≥ strong, or ≥ good and ≥
 * margin ahead of the next (isKnown in recall.ts). Each model scores on its
 * own scale, so those three numbers have to be learned from goals whose right
 * answer is known:
 *
 *   known goals    "log into my account" → sign-in. Reworded, never a flow's
 *                  own name (that matches exactly and proves nothing). From a
 *                  goals file, and from runs that bound a flow and passed.
 *   unknown goals  ones the app doesn't have, from a goals file. Short of
 *                  MIN_GOALS of those, made up: leave each flow out and search
 *                  for its own title among the rest (skipping the recording it
 *                  was cut from and segments cut from it — those really do it).
 *                  Only a fallback: a title is in the app's own words, so its
 *                  sibling scores far higher than a goal a person would ask.
 *                  On the 28-flow providernow corpus these drove voyage-4-lite's
 *                  fitted strong cutoff to 0.96, missing 20 of 34 real goals.
 *
 * Every goal is embedded once and scored against the stored flow vectors here,
 * with the score vector search gives cosine — (1 + cos) / 2 — so leaving a
 * flow out costs nothing. Then a grid search picks the cutoffs that put the
 * most goals on the right side, counting a wrong "known" (a flow runs that
 * shouldn't) twice as bad as a missed one (it's shown, not run).
 *
 * The goals are kept on the app, so `reembed` re-fits every app for a new
 * model without asking for them again.
 */

import type { CalibrationGoals, Cutoffs, FittedCutoffs } from '../store/types.js';
import { collections } from '../store/db.js';
import { embed, embedderConfig } from '../store/embed.js';
import { cutoffsFor, isKnown, type CutoffSource } from './recall.js';

/** Fewer than this many of either kind, and the fit isn't saved: too easy to fit by luck. */
export const MIN_GOALS = 5;
/** Below this many flows the scores bunch up; the fit is saved but flagged. */
export const FEW_FLOWS = 8;

export interface Sample {
  goal: string;
  /** The flow that does it, or null for a goal the app doesn't have. */
  expect: string | null;
  from: 'goals file' | 'run' | 'left out';
  /** For 'left out': the flow removed before searching. */
  without?: string;
  topFlow?: string;
  top: number;
  second?: number;
}

/** Should recall call this one known? Only when the embedder ranked the right flow first. */
const shouldBeKnown = (s: Sample) => s.expect !== null && s.topFlow === s.expect;

/** A wrong "known" runs the wrong flow; a missed one is only shown. */
const COST_WRONG_KNOWN = 2;
const COST_MISSED = 1;

const STEP = 0.005;
const grid = (from: number, to: number) => {
  const out: number[] = [];
  for (let i = Math.round(from / STEP); i <= Math.round(to / STEP); i++) out.push(Number((i * STEP).toFixed(3)));
  return out;
};

export interface Fit extends Cutoffs {
  cost: number;
  correct: number;
}

/** How many samples a rule puts on the right side, and what its mistakes cost. */
export function score(samples: Sample[], rule: Cutoffs): { cost: number; correct: number; wrong: Sample[] } {
  let cost = 0;
  const wrong: Sample[] = [];
  for (const s of samples) {
    const want = shouldBeKnown(s);
    if (isKnown(s.top, s.second, rule) === want) continue;
    cost += want ? COST_MISSED : COST_WRONG_KNOWN;
    wrong.push(s);
  }
  return { cost, correct: samples.length - wrong.length, wrong };
}

/**
 * Pure: the cutoffs that cost least on these samples. Among equally good ones,
 * the one whose decisions sit furthest from any cutoff — so a goal worded a
 * little differently next time lands on the same side.
 */
export function fit(samples: Sample[]): Fit {
  const tops = samples.map((s) => s.top);
  const gaps = samples.map((s) => (s.second === undefined ? -1 : s.top - s.second));
  const want = samples.map(shouldBeKnown);
  const n = samples.length;

  const strongs = [...grid(0.5, 1), 1 + STEP]; // the last: never known on score alone
  const margins = grid(0, 0.5);
  let best: (Fit & { clearance: number; spread: number }) | undefined;

  for (const strong of strongs) {
    for (const good of grid(0.5, Math.min(strong, 1))) {
      for (const margin of margins) {
        let cost = 0;
        let wrong = 0;
        for (let i = 0; i < n; i++) {
          const t = tops[i]!;
          const k = t >= strong || (t >= good && gaps[i]! >= 0 && gaps[i]! >= margin);
          if (k !== want[i]) { wrong++; cost += want[i] ? COST_MISSED : COST_WRONG_KNOWN; }
        }
        if (best && cost > best.cost) continue;

        // How close the nearest decision is to flipping: smallest distance to a cutoff it was tested against.
        let clearance = Infinity;
        let spread = 0;
        for (let i = 0; i < n; i++) {
          const t = tops[i]!;
          let d = Math.abs(t - strong);
          if (t < strong) d = Math.min(d, Math.abs(t - good));
          if (t < strong && t >= good && gaps[i]! >= 0) d = Math.min(d, Math.abs(gaps[i]! - margin));
          clearance = Math.min(clearance, d);
          spread += d;
        }
        if (!best || cost < best.cost || clearance > best.clearance + 1e-9 || (Math.abs(clearance - best.clearance) <= 1e-9 && spread > best.spread)) {
          best = { strong, good, margin, cost, correct: n - wrong, clearance, spread };
        }
      }
    }
  }
  const { clearance: _c, spread: _s, ...out } = best!;
  return out;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na * nb) || 1);
};
/** What $vectorSearch reports for cosine similarity. */
const searchScore = (a: number[], b: number[]) => (1 + cosine(a, b)) / 2;

export interface CalibrateInput {
  /** More goals to fit on, added to the ones already kept for the app. */
  goals?: Partial<CalibrationGoals>;
  /** Fit and report, but keep nothing. */
  dryRun?: boolean;
}

export interface Calibration {
  app: string;
  model: string;
  flows: number;
  goals: { known: number; unknown: number; fromRuns: number; leftOut: number };
  /** What recall uses now, and how it does on these goals. */
  before: Cutoffs & { source: CutoffSource; correct: number };
  after: Cutoffs & { correct: number };
  total: number;
  /** Goals the fitted cutoffs still get wrong. */
  mistakes: { goal: string; expected: string | null; top?: string; score: number; next?: number; verdict: 'known' | 'not known' }[];
  /** Known goals where the embedder ranked another flow first — no cutoff can fix those. */
  misranked: { goal: string; expected: string; top?: string }[];
  saved: boolean;
  /** Why not saved, or what to be wary of. */
  notes: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

/** Fit, report, and (unless dryRun, or there's too little to go on) keep the cutoffs. */
export async function calibrate(app: string, input: CalibrateInput = {}): Promise<Calibration> {
  const cfg = embedderConfig();
  if (!cfg) throw new Error('calibrate fits the cutoffs for matching by meaning, and no embedding model is configured — set EMBED_KEY, or EMBED_URL and EMBED_MODEL');

  const c = await collections();
  const flows = await c.flows.find({ app }, { projection: { slug: 1, title: 1, from: 1, embedding: 1 } }).toArray();
  if (!flows.length) throw new Error(`no flows for '${app}' — save some first`);
  const unembedded = flows.filter((f) => f.embedding?.length !== cfg.dims);
  if (unembedded.length) {
    throw new Error(`${unembedded.length} of ${app}'s flows have no ${cfg.dims}-number vector from ${cfg.model} (e.g. ${unembedded[0]!.slug}) — run: understudy reembed`);
  }
  const slugs = new Set(flows.map((f) => f.slug));
  const names = new Set(flows.flatMap((f) => [norm(f.slug), norm(f.title)]));

  // Goals: the ones kept, plus the ones given now. A flow that no longer exists drops out.
  const appDoc = await c.apps.findOne({ slug: app }, { projection: { calibrationGoals: 1 } });
  const kept = appDoc?.calibrationGoals ?? { known: [], unknown: [] };
  const badSlugs = [...new Set((input.goals?.known ?? []).map((k) => k.flow).filter((f) => !slugs.has(f)))];
  if (badSlugs.length) throw new Error(`no flow ${badSlugs.map((s) => `'${s}'`).join(', ')} in ${app} — known goals name a flow by its slug (understudy flows ${app})`);

  const known = new Map<string, { flow: string; goal: string }>();
  for (const k of [...kept.known, ...(input.goals?.known ?? [])]) if (slugs.has(k.flow) && k.goal.trim()) known.set(norm(k.goal), { flow: k.flow, goal: k.goal.trim() });
  const unknown = new Map<string, string>();
  for (const u of [...kept.unknown, ...(input.goals?.unknown ?? [])]) if (u.trim()) unknown.set(norm(u), u.trim());
  const skippedExact = [...known.keys(), ...unknown.keys()].filter((g) => names.has(g)).length;
  for (const g of names) { known.delete(g); unknown.delete(g); }
  const clash = [...known.keys()].filter((g) => unknown.has(g));
  if (clash.length) throw new Error(`listed as both known and unknown: ${clash.map((g) => `"${g}"`).join(', ')}`);
  const goals: CalibrationGoals = { known: [...known.values()], unknown: [...unknown.values()] };

  // Free known goals: what runs were asked for, bound to a flow, and passed.
  const fromRuns = new Map<string, string>();
  const runs = await c.runs.find({ app, mode: 'run', status: 'passed' }, { projection: { goal: 1, plan: 1, planning: 1 } }).toArray();
  for (const r of runs) {
    const pairs: [string, string | undefined][] = r.planning?.subGoals && r.planning.bound?.length === r.planning.subGoals.length
      ? r.planning.subGoals.map((g, i) => [g, r.planning!.bound![i]])
      : r.plan.length === 1 ? [[r.goal, r.plan[0]]] : [];
    for (const [g, flow] of pairs) {
      if (flow && slugs.has(flow) && !names.has(norm(g)) && !known.has(norm(g)) && !unknown.has(norm(g))) fromRuns.set(norm(g), JSON.stringify([g, flow]));
    }
  }

  // Embed every goal once, in as few requests as possible.
  const titleTaken = (title: string, slug: string) => flows.some((f) => f.slug !== slug && norm(f.title) === norm(title));
  const leftOut = flows.length > 1 && goals.unknown.length < MIN_GOALS ? flows.filter((f) => !titleTaken(f.title, f.slug)) : [];
  /** With `slug` left out: it, the recording it was cut from, and segments cut from it. */
  const related = (slug: string) => {
    const left = flows.find((f) => f.slug === slug);
    return new Set([slug, ...(left?.from ? [left.from.flow] : []), ...flows.filter((f) => f.from?.flow === slug).map((f) => f.slug)]);
  };
  const runPairs = [...fromRuns.values()].map((p) => JSON.parse(p) as [string, string]);
  const texts = [...new Set([...goals.known.map((k) => k.goal), ...goals.unknown, ...runPairs.map(([g]) => g), ...leftOut.map((f) => f.title)])];
  const vectors = new Map<string, number[]>();
  const embedded = texts.length ? await embed(texts, 'query', cfg) : [];
  texts.forEach((t, i) => vectors.set(t, embedded[i]!));

  const sample = (goal: string, expect: string | null, from: Sample['from'], without?: string): Sample => {
    const q = vectors.get(goal)!;
    const skip = without ? related(without) : undefined;
    const ranked = flows
      .filter((f) => !skip?.has(f.slug))
      .map((f) => ({ slug: f.slug, score: searchScore(q, f.embedding!) }))
      .sort((a, b) => b.score - a.score);
    return {
      goal, expect, from, ...(without ? { without } : {}),
      ...(ranked[0] ? { topFlow: ranked[0].slug, top: ranked[0].score } : { top: 0 }),
      ...(ranked[1] ? { second: ranked[1].score } : {}),
    };
  };
  const samples: Sample[] = [
    ...goals.known.map((k) => sample(k.goal, k.flow, 'goals file')),
    ...runPairs.map(([g, flow]) => sample(g, flow, 'run')),
    ...goals.unknown.map((g) => sample(g, null, 'goals file')),
    ...leftOut.map((f) => sample(f.title, null, 'left out', f.slug)),
  ];

  const nKnown = samples.filter((s) => s.expect !== null).length;
  const nUnknown = samples.length - nKnown;
  const current = await cutoffsFor(app, cfg);
  const fitted = fit(samples);
  const after: Cutoffs = { strong: fitted.strong, good: fitted.good, margin: fitted.margin };
  const { wrong } = score(samples, after);

  const notes: string[] = [];
  if (skippedExact) notes.push(`${skippedExact} goal(s) skipped: they are a flow's exact name, which recall matches without scores`);
  if (nKnown < MIN_GOALS) notes.push(`only ${nKnown} known goal(s) — need ${MIN_GOALS}+: add rewordings of the app's flows (e.g. 2–3 ways someone would ask for each)`);
  if (nUnknown < MIN_GOALS) notes.push(`only ${nUnknown} unknown goal(s) — need ${MIN_GOALS}+: add goals that sound like the app but that it has no flow for`);
  if (leftOut.length) notes.push(`${leftOut.length} unknown goal(s) made by leaving a flow out and searching its title — harder than real goals, so the fit leans strict; add ${MIN_GOALS}+ real unknown goals instead`);
  if (flows.length < FEW_FLOWS) notes.push(`only ${flows.length} flows: scores bunch up on a small app, so treat these cutoffs as rough and calibrate again as it grows`);
  const enough = nKnown >= MIN_GOALS && nUnknown >= MIN_GOALS;
  const saved = enough && !input.dryRun;

  // The goals are worth keeping even when they're too few to fit on yet.
  if (!input.dryRun) {
    const cutoffs: FittedCutoffs = { ...after, model: cfg.model, dims: cfg.dims, fittedAt: new Date(), goals: { known: nKnown, unknown: nUnknown }, correct: samples.length - wrong.length };
    await c.apps.updateOne(
      { slug: app },
      { $set: { calibrationGoals: goals, ...(saved ? { cutoffs } : {}) }, $setOnInsert: { slug: app, name: app, urls: {}, createdAt: new Date() } },
      { upsert: true },
    );
  }

  const r3 = (x: number) => Number(x.toFixed(3));
  return {
    app, model: cfg.model, flows: flows.length,
    goals: { known: goals.known.length, unknown: goals.unknown.length, fromRuns: runPairs.length, leftOut: leftOut.length },
    before: { strong: current.strong, good: current.good, margin: current.margin, source: current.source, correct: score(samples, current).correct },
    after: { ...after, correct: samples.length - wrong.length },
    total: samples.length,
    mistakes: wrong.map((s) => ({
      goal: s.from === 'left out' ? `${s.goal} (with ${s.without} left out)` : s.goal,
      expected: s.expect, ...(s.topFlow ? { top: s.topFlow } : {}), score: r3(s.top), ...(s.second !== undefined ? { next: r3(s.second) } : {}),
      verdict: isKnown(s.top, s.second, after) ? 'known' : 'not known',
    })),
    misranked: samples.filter((s) => s.expect !== null && s.topFlow !== s.expect).map((s) => ({ goal: s.goal, expected: s.expect!, ...(s.topFlow ? { top: s.topFlow } : {}) })),
    saved, notes,
  };
}

/** After `reembed`: re-fit every app that has goals kept, for the model now configured. */
export async function recalibrateAll(): Promise<{ refitted: Calibration[]; withoutGoals: string[] }> {
  const { apps, flows } = await collections();
  const withGoals = (await apps.find({ calibrationGoals: { $exists: true } }, { projection: { slug: 1 } }).toArray()).map((a) => a.slug);
  const refitted: Calibration[] = [];
  for (const app of withGoals) {
    if (await flows.findOne({ app })) refitted.push(await calibrate(app));
  }
  const all = await flows.distinct('app');
  return { refitted, withoutGoals: all.filter((a) => !withGoals.includes(a)) };
}
