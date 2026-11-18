/**
 * The app's vocabulary: every flow and fact, in the words the app's memory
 * already uses. Handed to an agent when it splits a goal into sub-goals or
 * splits a recording into segments, so it reuses those words instead of
 * inventing synonyms — a sub-goal is a search, and it only finds what is
 * phrased like something stored.
 */

import { collections } from '../store/db.js';
import type { Vocabulary } from '../core/distill.js';

export async function vocabulary(app: string): Promise<Vocabulary> {
  const { flows, notes } = await collections();
  const rows = await flows
    .find({ app }, { projection: { slug: 1, title: 1, intent: 1, kind: 1, preconditions: 1, outcome: 1, steps: 1 } })
    .sort({ kind: -1, slug: 1 })
    .toArray();
  const facts = await notes.find({ app, kind: 'fact' }, { projection: { text: 1 } }).toArray();
  return {
    segments: rows.filter((f) => f.kind === 'segment').map((f) => ({
      slug: f.slug, title: f.title, intent: f.intent, steps: f.steps.length,
      preconditions: f.preconditions, outcome: f.outcome || null,
    })),
    flows: rows.filter((f) => f.kind === 'recording').map((f) => ({ slug: f.slug, title: f.title, intent: f.intent })),
    facts: facts.map((n) => n.text),
  };
}
