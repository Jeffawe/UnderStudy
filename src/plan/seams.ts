/**
 * Seams: how to get from where one flow ends to where the next begins.
 *
 * Two flows bound for one goal often came from different recordings, so no
 * recording ever went from one to the other. Three ways to bridge them, tried
 * in order, cheapest first — and if none works, ASK (never guess):
 *
 *   1. no bridge needed   the next flow opens its own page, or the first
 *                         already ends exactly where the next starts
 *   2. the page map       a run once clicked something on this page that led
 *                         to that one — click it again
 *   3. navigate           same site, plain address (no ids in it) — go there
 *
 * An agent's answer to a seam question is saved to the page map, so the same
 * seam is bridged at step 2 next time without asking.
 */

import { collections } from '../store/db.js';
import type { Flow, Step } from '../store/types.js';

/** `/inventory.html#bf3dd322` → `/inventory.html` */
const pageOf = (sig: string) => sig.slice(0, sig.lastIndexOf('#')) || sig;

export type Seam =
  | { resolved: true; steps: Step[]; how: string }
  | { resolved: false; evidence: SeamEvidence };

/** What the agent is shown, so it doesn't have to go digging to answer. */
export interface SeamEvidence {
  from: { slug: string; endsOn?: string; lastSteps: Pick<Step, 'action' | 'role' | 'name'>[] };
  to: { slug: string; startsOn?: string; firstSteps: Pick<Step, 'action' | 'role' | 'name'>[]; firstUrl?: string };
  /** Every known way out of the page `from` ends on. Empty = the page map has never left it. */
  knownLinksFromHere: { to: string; via: { role: string; name: string } }[];
}

const brief = (s: Step) => ({ action: s.action, ...(s.role ? { role: s.role } : {}), ...(s.name ? { name: s.name } : {}) });

export async function resolveSeam(app: string, from: Flow, to: Flow): Promise<Seam> {
  const first = to.steps[0];

  // 1. No bridge needed.
  if (first?.action === 'goto') return { resolved: true, steps: [], how: `${to.slug} opens its own page` };
  const end = from.endState;
  const start = to.startState;
  if (end && start && end === start) return { resolved: true, steps: [], how: `${from.slug} ends where ${to.slug} starts` };

  // 2. The page map knows a control on this page that leads there.
  const { pages } = await collections();
  const here = end ? await pages.findOne({ app, sig: end }) : null;
  const link = start ? here?.links.find((l) => l.to === start) : undefined;
  const lastUrl = from.steps.at(-1)?.url ?? from.startUrl;
  if (link) {
    return {
      resolved: true,
      steps: [{ action: 'click', role: link.via.role, name: link.via.name, url: lastUrl, resolution: 'synthesized' }],
      how: `the page map: "${link.via.name}" leads from ${pageOf(end!)} to ${pageOf(start!)}`,
    };
  }

  // 3. Same site, and the start page has a plain address: go straight there.
  const target = start ? pageOf(start) : undefined;
  if (target && !target.includes(':') && first?.url) {
    const origin = new URL(lastUrl).origin;
    if (new URL(first.url).origin === origin) {
      const url = origin + target;
      return {
        resolved: true,
        steps: [{ action: 'goto', value: url, url, resolution: 'synthesized' }],
        how: `navigate to ${target}`,
      };
    }
  }

  return {
    resolved: false,
    evidence: {
      from: { slug: from.slug, ...(end ? { endsOn: end } : {}), lastSteps: from.steps.slice(-3).map(brief) },
      to: { slug: to.slug, ...(start ? { startsOn: start } : {}), firstSteps: to.steps.slice(0, 3).map(brief), ...(first?.url ? { firstUrl: first.url } : {}) },
      knownLinksFromHere: here?.links ?? [],
    },
  };
}

/**
 * Turn an agent's seam answer into steps, and remember a one-click answer in
 * the page map so the next plan doesn't need to ask. Returns the problems
 * instead if the answer isn't usable.
 */
export async function acceptSeamAnswer(
  app: string, from: Flow, to: Flow, answer: unknown,
): Promise<{ steps: Step[] } | { problems: string[] }> {
  const raw = (answer as { steps?: unknown })?.steps;
  if (!Array.isArray(raw)) return { problems: ['answer must be { "steps": [...] } — [] if you do not know'] };

  const lastUrl = from.steps.at(-1)?.url ?? from.startUrl;
  const steps: Step[] = [];
  const problems: string[] = [];
  raw.forEach((s: Record<string, unknown>, i) => {
    if (s?.action === 'click' && typeof s.role === 'string' && typeof s.name === 'string' && s.role && s.name) {
      steps.push({ action: 'click', role: s.role, name: s.name, url: lastUrl, resolution: 'synthesized' });
    } else if (s?.action === 'goto' && typeof s.url === 'string' && /^https?:\/\//.test(s.url)) {
      steps.push({ action: 'goto', value: s.url, url: s.url, resolution: 'synthesized' });
    } else {
      problems.push(`steps[${i}] must be {"action":"click","role":"…","name":"…"} or {"action":"goto","url":"https://…"}`);
    }
  });
  if (problems.length) return { problems };

  const only = steps[0];
  if (steps.length === 1 && only?.action === 'click' && from.endState && to.startState) {
    const { pages } = await collections();
    const now = new Date();
    await pages.updateOne(
      { app, sig: from.endState },
      {
        $addToSet: { links: { to: to.startState, via: { role: only.role!, name: only.name! } } },
        $setOnInsert: { app, sig: from.endState, urlPattern: pageOf(from.endState), firstSeen: now, lastSeen: now },
      },
      { upsert: true },
    );
  }
  return { steps };
}
