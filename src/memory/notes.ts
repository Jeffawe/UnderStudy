/**
 * Writing down what was learned, and using it.
 *
 *   remember()     one validated batch of facts, lessons, findings, and goals
 *                  reached by other means. Every problem is reported at once,
 *                  and nothing is written unless the whole batch is clean.
 *   lessonsFor()   the lessons whose trigger matches a step — replay asks
 *                  before every step.
 *   foldLessons()  after a run, count which lessons fired and whether they
 *                  helped.
 *
 * A FACT changes what you plan ("order history is at /past-invoices").
 * A LESSON changes one step ("when filling Card number, dismiss Stripe Link first").
 * A FINDING says the app is broken and someone should fix it.
 * Ported from the old remember.ts and lessons.ts.
 */

import { ObjectId } from 'mongodb';
import { collections, ensureSchema } from '../store/db.js';
import { embed, embedderConfig } from '../store/embed.js';
import { triggerProblems } from '../core/trigger.js';
import { stepFingerprint } from '../core/fingerprint.js';
import type { RawEvent } from '../core/recording.js';
import type { Note, Trigger } from '../store/types.js';
import { saveFindings } from '../flows/findings.js';

export interface RememberInput {
  facts?: { text: string; marksDestructive?: string }[];
  lessons?: { title: string; text: string; kind: string; trigger: Trigger }[];
  findings?: { kind: string; severity: 'low' | 'medium' | 'high'; statement: string; fingerprint: string; evidence?: Record<string, unknown> }[];
  /** A goal an agent reached WITHOUT Understudy driving (its own Playwright, by hand…). */
  reached?: { goal: string; passed: boolean; drivenBy?: string; note?: string; sigSequence?: string[] }[];
}

const SEVERITIES = ['low', 'medium', 'high'];
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Every problem in the batch, so one round trip is enough to fix them all. */
export function validateRemember(input: RememberInput): string[] {
  const p: string[] = [];
  const { facts = [], lessons = [], findings = [], reached = [] } = input ?? {};
  if (!facts.length && !lessons.length && !findings.length && !reached.length) {
    p.push('nothing to write: facts, lessons, findings and reached are all empty');
  }
  facts.forEach((f, i) => {
    if (!filled(f?.text)) p.push(`facts[${i}].text is required`);
    if (f?.marksDestructive !== undefined && !filled(f.marksDestructive)) p.push(`facts[${i}].marksDestructive must be a control's name`);
  });
  lessons.forEach((l, i) => {
    for (const k of ['title', 'text', 'kind'] as const) if (!filled(l?.[k])) p.push(`lessons[${i}].${k} is required`);
    for (const e of triggerProblems(l?.trigger)) p.push(`lessons[${i}].${e}`);
  });
  findings.forEach((f, i) => {
    for (const k of ['kind', 'statement', 'fingerprint'] as const) if (!filled(f?.[k])) p.push(`findings[${i}].${k} is required`);
    if (!SEVERITIES.includes(f?.severity)) p.push(`findings[${i}].severity must be one of ${SEVERITIES.join(', ')}`);
  });
  reached.forEach((r, i) => {
    if (!filled(r?.goal)) p.push(`reached[${i}].goal is required`);
    if (typeof r?.passed !== 'boolean') p.push(`reached[${i}].passed must be true or false`);
  });
  return p;
}

export interface RememberResult {
  facts: { written: number; alreadyKnown: number };
  lessons: { written: number; alreadyKnown: number };
  findings: number;
  reached: number;
}

export async function remember(app: string, input: RememberInput): Promise<RememberResult> {
  const problems = validateRemember(input);
  if (problems.length) throw new Error(`nothing written — fix these and send the batch again:\n- ${problems.join('\n- ')}`);
  await ensureSchema();
  const c = await collections();
  const { facts = [], lessons = [], findings = [], reached = [] } = input;
  const out: RememberResult = { facts: { written: 0, alreadyKnown: 0 }, lessons: { written: 0, alreadyKnown: 0 }, findings: 0, reached: 0 };
  const now = new Date();

  // Only new notes are embedded, all in one request.
  const newFacts = [];
  for (const f of facts) {
    if (await c.notes.findOne({ app, kind: 'fact', text: f.text })) out.facts.alreadyKnown++;
    else newFacts.push(f);
  }
  const newLessons = [];
  for (const l of lessons) {
    // Deduped by title: a lesson stored twice fires twice and splits its counts.
    if (await c.notes.findOne({ app, kind: 'lesson', title: l.title })) out.lessons.alreadyKnown++;
    else newLessons.push(l);
  }
  const texts = [...newFacts.map((f) => f.text), ...newLessons.map((l) => `${l.title}. ${l.text}`)];
  const vectors = embedderConfig() && texts.length ? await embed(texts, 'document') : [];

  const docs: Note[] = [
    ...newFacts.map((f, i): Note => ({
      app, kind: 'fact', text: f.text, searchText: f.text,
      ...(f.marksDestructive ? { marksDestructive: f.marksDestructive } : {}),
      ...(vectors[i] ? { embedding: vectors[i] } : {}),
      timesApplied: 0, timesHelped: 0, createdAt: now,
    })),
    ...newLessons.map((l, i): Note => ({
      app, kind: 'lesson', title: l.title, text: l.text, lessonKind: l.kind, trigger: l.trigger,
      searchText: `${l.title}. ${l.text}`,
      ...(vectors[newFacts.length + i] ? { embedding: vectors[newFacts.length + i]! } : {}),
      timesApplied: 0, timesHelped: 0, createdAt: now,
    })),
  ];
  if (docs.length) await c.notes.insertMany(docs);
  out.facts.written = newFacts.length;
  out.lessons.written = newLessons.length;

  await saveFindings(c.findings, app, findings.map((f) => ({ ...f, evidence: f.evidence ?? {} })), now);
  out.findings = findings.length;

  // "This goal works" from something other than Understudy's executor. Stored
  // as 'attributed', never as a replay: only a replay proves the executor can do it.
  for (const r of reached) {
    await c.runs.insertOne({
      app, goal: r.goal, mode: 'attributed', status: r.passed ? 'passed' : 'failed',
      plan: [], steps: [], sigSequence: r.sigSequence ?? [],
      events: [{ drivenBy: r.drivenBy ?? 'unspecified', ...(r.note ? { note: r.note } : {}) }],
      findings: [], durationMs: 0, startedAt: now, endedAt: now,
    });
    out.reached++;
  }
  return out;
}

/** What replay hands over before each step. */
export type StepContext = Trigger;

/**
 * Lessons whose trigger matches this step: every field the trigger names must
 * equal the step's; fields it leaves out match anything.
 */
export async function lessonsFor(app: string, ctx: StepContext) {
  const { notes } = await collections();
  // Each trigger field must either be absent or equal the step's value.
  const match = (k: keyof Trigger) => ({ $or: [{ [`trigger.${k}`]: { $exists: false } }, { [`trigger.${k}`]: ctx[k] ?? null }] });
  const rows = await notes
    .find({ app, kind: 'lesson', $and: [match('url_pattern'), match('action'), match('role'), match('name')] })
    .toArray();
  return rows.map((n) => ({ lessonId: String(n._id), kind: n.lessonKind ?? 'other', title: n.title ?? '', body: n.text }));
}

/**
 * Count lesson firings after a run. `timesHelped` only counts when the step
 * passed AND a step like it has failed before — otherwise there was nothing
 * for the lesson to fix, and "it fired, the step passed" proves nothing.
 */
export async function foldLessons(
  app: string,
  steps: { seq: number; ok: boolean; lessonsApplied?: { lessonId: string }[] }[],
  events: RawEvent[],
): Promise<{ fired: number; helped: number }> {
  const c = await collections();
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  let fired = 0;
  let helped = 0;
  for (const s of steps) {
    if (!s.lessonsApplied?.length) continue;
    fired += s.lessonsApplied.length;
    const event = bySeq.get(s.seq);
    const failedBefore = s.ok && event
      ? Boolean(await c.runs.findOne({ app, steps: { $elemMatch: { fingerprint: stepFingerprint(event), ok: false } } }))
      : false;
    if (failedBefore) helped += s.lessonsApplied.length;
    const ids = s.lessonsApplied.map((l) => l.lessonId);
    await c.notes.updateMany(
      { _id: { $in: ids.map((id) => new ObjectId(id)) } },
      { $inc: { timesApplied: 1, ...(failedBefore ? { timesHelped: 1 } : {}) } },
    );
  }
  return { fired, helped };
}

/** Controls that facts say commit something real: clicking one makes a flow destructive. */
export async function destructiveControls(app: string): Promise<Map<string, string>> {
  const { notes } = await collections();
  const rows = await notes.find({ app, kind: 'fact', marksDestructive: { $exists: true } }).toArray();
  return new Map(rows.map((n) => [n.marksDestructive!.toLowerCase(), n.text]));
}
