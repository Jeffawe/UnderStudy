#!/usr/bin/env node
/**
 * understudy MCP server — memory and execution for any agent that speaks MCP
 * (Claude Code, Codex, Cursor…). The agent is the model: Understudy never
 * calls one. REASONER.md is the contract for using these tools.
 *
 *   understudy_recall          what memory knows about a goal (free, nothing runs)
 *   understudy_run             plan a goal; returns a question, or runs it
 *   understudy_answer          answer a run's question; returns the next one, or runs it
 *   understudy_distill         a saved flow's numbered steps, to name and split
 *   understudy_save_distilled  store that answer (validated; every problem at once)
 *   understudy_remember        store facts, lessons, findings, goals reached by other means
 *   understudy_findings        list open findings; triage them
 *   understudy_record          wait for the user to record a flow in their Chrome
 *   understudy_save            prove a recording by replaying it, then keep it as a flow
 *
 * Long-lived: reconnect (/mcp) after changing the source.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { recall } from '../memory/recall.js';
import { remember } from '../memory/notes.js';
import { start, answer, runPlan, type PlanState } from '../plan/planner.js';
import { distillRequest, saveDistilled } from '../flows/distill.js';
import { triage } from '../flows/findings.js';
import { collections } from '../store/db.js';
import { startExtensionRecorder, extensionDir, type ExtensionRecorder } from '../adapters/recorder/extension.js';
import { saveRecording, loadRecording } from '../core/recording-store.js';
import { proveAndSave } from '../flows/save.js';

/**
 * Sent to the agent when it connects — its copy of the contract, since an
 * agent that installed Understudy from npm never sees REASONER.md. Kept short:
 * every session pays for it.
 */
const INSTRUCTIONS = `Understudy runs end-to-end tests against the user's web apps from flows it remembers. You supply judgement; it never calls a model.

Rules:
- Memory first: understudy_recall is free (nothing runs). Then reach the goal however works — understudy_run, or your own browser/Playwright. Say which you used; never imply Understudy ran something you drove.
- Runs plan before any browser opens and may ask two questions:
  · decompose → {"subGoals": [...]}: the things that must happen, IN THE ORDER the app does them, phrased in the words of the app's flows (listed with the question). Include implicit prerequisites (log in first). One sub-goal naming a whole recorded flow beats several naming its parts. Tell the user the sub-goals too.
  · seam → {"steps": [one click or goto]}, or {"steps": []} unless you actually KNOW — an answer is saved and reused forever.
- Start with dryRun: true. Destructive flows (purchases, deletions) are refused unless allowPurchases.
- Login values: recordings store references like SECRET.password, read from settings as UNDERSTUDY_SECRET_PASSWORD. Never ask the user to paste a password into chat; ask them to add it to their Understudy env file.
- Memory doesn't have a flow? Ask the user to record it: understudy_record, then understudy_save when they've stopped. Save replays it first and keeps it only if every step passes.
- Learned something (a fact that changes plans, a lesson that changes one step, a finding that the app is broken)? Gather them, put the list to the user at a natural pause, and write the approved ones in one understudy_remember. Reached a goal without understudy_run? Record it there too, as "reached".
- understudy_findings lists what looked broken; triage each as issue, lesson or noise.`;

const server = new McpServer({ name: 'understudy', version: '0.2.0' }, { instructions: INSTRUCTIONS });

/** Credentials passed to `run`, kept in memory (never stored) until the run executes. */
const valuesByRun = new Map<string, Record<string, string>>();

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] });
const err = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });
/** Run a handler, returning its result as JSON or its error as a readable message. */
const wrap = async (fn: () => Promise<unknown>) => {
  try { return ok(await fn()); } catch (e) { return err(e); }
};
/** Drop undefined fields: the zod types allow them, the functions here don't. */
const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };

/** After planning: run it now, unless it was a dry run or is waiting/blocked. */
async function continueRun(state: PlanState, opts: { headed?: boolean }) {
  if (state.status !== 'planned' || state.dryRun) return state;
  const values = valuesByRun.get(state.runId) ?? {};
  valuesByRun.delete(state.runId);
  const { executed, recorded, plan } = await runPlan(state.runId, { values, ...opts });
  const r = executed.result;
  return {
    status: r.ok ? 'passed' : 'failed',
    runId: state.runId,
    plan,
    seams: state.seams,
    failedSteps: r.steps.filter((s) => !s.ok).map((s) => ({ seq: s.seq, action: s.action, error: s.error })),
    unexpectedPages: r.steps.filter((s) => s.unexpectedPage).map((s) => ({ seq: s.seq, ...s.unexpectedPage })),
    path: r.sigSequence,
    drift: recorded.drift.firstRun ? 'first run' : recorded.drift.changed
      ? { added: recorded.drift.added, removed: recorded.drift.removed, stateChanged: recorded.drift.stateChanged }
      : 'same path',
    findings: recorded.findings.map((f) => ({ kind: f.kind, severity: f.severity, statement: f.statement })),
    ...(executed.lessons?.fired ? { lessons: executed.lessons } : {}),
    ...(executed.missingValues.length ? { missingValues: executed.missingValues } : {}),
    ...(executed.staleSession ? { staleSession: executed.staleSession } : {}),
  };
}

const values = z.record(z.string(), z.string()).optional()
  .describe('Values for steps that deliberately store none, e.g. {"SECRET.password":"…"}. Never stored.');

server.registerTool('understudy_recall', {
  description: 'What memory knows about a goal: closest flows and notes, and a verdict (known / unsure / unknown). A database query — free, no browser. Call it before acting.',
  inputSchema: { app: z.string(), goal: z.string(), limit: z.number().int().positive().optional() },
}, ({ app, goal, limit }) => wrap(() => recall(app, goal, limit ? { limit } : {})));

server.registerTool('understudy_run', {
  description: 'Plan a goal and run it headless. Returns a question (status "waiting": answer with understudy_answer), "blocked" with why, or the result. Pass subGoals to skip the decompose question. Destructive flows are refused unless allowPurchases.',
  inputSchema: {
    app: z.string(), goal: z.string(),
    subGoals: z.array(z.string()).optional().describe('The goal split into sub-goals, in order, phrased in the app\'s words.'),
    dryRun: z.boolean().optional().describe('Plan only; open no browser.'),
    allowPurchases: z.boolean().optional(),
    values, headed: z.boolean().optional(),
  },
}, (a) => wrap(async () => {
  const state = await start({
    app: a.app, goal: a.goal,
    ...(a.subGoals ? { subGoals: a.subGoals } : {}),
    ...(a.dryRun ? { dryRun: true } : {}),
    ...(a.allowPurchases ? { allowPurchases: true } : {}),
  });
  if (a.values) valuesByRun.set(state.runId, a.values);
  return continueRun(state, a.headed ? { headed: true } : {});
}));

server.registerTool('understudy_answer', {
  description: 'Answer a waiting run\'s question. decompose → {"subGoals":[…]}. seam → {"steps":[{"action":"click","role":"…","name":"…"}]}, or {"steps":[]} unless you actually know (an answer is reused forever). Returns the next question, or the result.',
  inputSchema: { runId: z.string(), answer: z.record(z.string(), z.unknown()), values, headed: z.boolean().optional() },
}, (a) => wrap(async () => {
  if (a.values) valuesByRun.set(a.runId, a.values);
  return continueRun(await answer(a.runId, a.answer), a.headed ? { headed: true } : {});
}));

server.registerTool('understudy_distill', {
  description: 'A saved flow\'s numbered, proven steps plus the app\'s vocabulary and instructions. Name it and split it into reusable segments by step index — never invent steps — then call understudy_save_distilled.',
  inputSchema: { app: z.string(), flow: z.string() },
}, ({ app, flow }) => wrap(() => distillRequest(app, flow)));

server.registerTool('understudy_save_distilled', {
  description: 'Validate and store a distillation of a saved flow. Every problem is returned at once; nothing is written unless all is valid. Reusing an existing segment slug replaces that segment.',
  inputSchema: { app: z.string(), flow: z.string(), distilled: z.record(z.string(), z.unknown()) },
}, ({ app, flow, distilled }) => wrap(() => saveDistilled(app, flow, distilled)));

server.registerTool('understudy_remember', {
  description: 'Store what you learned, in one batch: facts (change the plan), lessons (change one step; trigger keys url_pattern/action/role/name, never empty), findings (the app is broken), reached (a goal you reached WITHOUT understudy_run). Validated; every problem at once. Confirm the list with the user first.',
  inputSchema: {
    app: z.string(),
    facts: z.array(z.object({ text: z.string(), marksDestructive: z.string().optional() })).optional(),
    lessons: z.array(z.object({ title: z.string(), text: z.string(), kind: z.string(), trigger: z.record(z.string(), z.string()) })).optional(),
    findings: z.array(z.object({ kind: z.string(), severity: z.enum(['low', 'medium', 'high']), statement: z.string(), fingerprint: z.string(), evidence: z.record(z.string(), z.unknown()).optional() })).optional(),
    reached: z.array(z.object({ goal: z.string(), passed: z.boolean(), drivenBy: z.string().optional(), note: z.string().optional(), sigSequence: z.array(z.string()).optional() })).optional(),
  },
}, ({ app, facts, lessons, findings, reached }) => wrap(() => remember(app, defined({
  facts: facts?.map((f) => defined(f)),
  lessons,
  findings: findings?.map((f) => defined(f)),
  reached: reached?.map((r) => defined(r)),
}))));

server.registerTool('understudy_findings', {
  description: 'Open findings for an app, most frequent first. Pass triage to route them: issue (the app should be fixed), lesson (accepted; store the workaround with understudy_remember), noise.',
  inputSchema: {
    app: z.string(),
    triage: z.array(z.object({ fingerprint: z.string(), verdict: z.enum(['issue', 'lesson', 'noise']) })).optional(),
    all: z.boolean().optional().describe('Include already-triaged findings.'),
  },
}, ({ app, triage: items, all }) => wrap(async () => {
  const { findings } = await collections();
  const routed = items?.length ? await triage(findings, app, items) : undefined;
  const rows = await findings.find(all ? { app } : { app, status: 'open' }).sort({ occurrences: -1, lastSeen: -1 }).limit(40).toArray();
  return {
    ...(routed ? { triaged: routed } : {}),
    findings: rows.map((f) => ({ fingerprint: f.fingerprint, kind: f.kind, severity: f.severity, occurrences: f.occurrences, status: f.status, statement: f.statement })),
  };
}));

/** The recording in progress (one at a time), and the last finished one per app. */
let recording: { app: string; rec: ExtensionRecorder } | null = null;
const finished = new Map<string, { hash: string; steps: number; droppedUploads: number; at: Date }>();

server.registerTool('understudy_record', {
  description: 'Wait for the USER to record a flow in their own Chrome with the Understudy extension. Returns at once with what to tell them; when they stop, the recording is kept, then call understudy_save. Use when memory doesn\'t know a flow.',
  inputSchema: { app: z.string(), port: z.number().int().min(0).max(65535).optional().describe('Default 7397; 0 = any free port.') },
}, ({ app, port }) => wrap(async () => {
  if (recording) throw new Error(`already waiting for a recording of "${recording.app}" — the user needs to stop it first`);
  const rec = await startExtensionRecorder({ appSlug: app, ...(port ? { port } : {}) });
  recording = { app, rec };
  rec.done.then(async (out) => {
    recording = null;
    if (!out.started || !out.recording.events.some((e) => e.action !== 'goto')) return;
    await saveRecording(out.recording);
    finished.set(app, { hash: out.recording.hash, steps: out.recording.events.length, droppedUploads: out.droppedUploads, at: new Date() });
  }).catch(() => { recording = null; });
  return {
    status: 'waiting for the user',
    listening: rec.url,
    tellTheUser: [
      'In Chrome, go to the page where the flow starts.',
      'Click the Understudy icon → "Record from this page" (tick "I\'m signed in here" if the flow starts signed in).',
      'Do the flow as normal, then click the icon → "Stop and save".',
      `Extension not loaded yet? chrome://extensions → Developer mode → Load unpacked → ${extensionDir()}`,
    ],
    then: 'When they say they\'ve stopped, call understudy_save with a name for the flow.',
  };
}));

server.registerTool('understudy_save', {
  description: 'Prove a recording by replaying it headless, then keep it as a flow — only if every step passes. Without a hash, saves the recording the user just finished via understudy_record. Login values come from UNDERSTUDY_<REF> settings; don\'t ask the user to paste passwords into chat.',
  inputSchema: {
    app: z.string(), name: z.string().describe('What the flow does, as someone would ask for it.'),
    hash: z.string().optional(), intent: z.string().optional(), slug: z.string().optional(), values,
  },
}, (a) => wrap(async () => {
  if (!a.hash && recording?.app === a.app) throw new Error('the user is still recording — ask them to click "Stop and save" in the extension first');
  const hash = a.hash ?? finished.get(a.app)?.hash;
  if (!hash) throw new Error(`no finished recording for "${a.app}" — start one with understudy_record, or pass a hash`);
  const rec = await loadRecording(hash);
  const out = await proveAndSave(rec, { title: a.name, ...(a.values ? { values: a.values } : {}), ...(a.intent ? { intent: a.intent } : {}), ...(a.slug ? { slug: a.slug } : {}) });
  const r = out.proven.result;
  const base = {
    recording: hash,
    passed: r.ok,
    failedSteps: r.steps.filter((s) => !s.ok).map((s) => ({ seq: s.seq, action: s.action, error: s.error })),
    ...(out.proven.missingValues.length ? { missingValues: out.proven.missingValues } : {}),
    signIn: out.proven.signIn,
    ...(finished.get(a.app)?.droppedUploads ? { droppedUploads: finished.get(a.app)!.droppedUploads } : {}),
  };
  if (!out.saved) return { saved: false, ...base, why: 'it did not replay cleanly, so it was not kept' };
  return {
    saved: true, flow: out.flow.slug, steps: out.flow.steps.length, ...base,
    ...(out.flow.destructive ? { destructive: out.flow.destructiveBecause } : {}),
    findings: out.run.findings.map((f) => f.statement),
  };
}));

await server.connect(new StdioServerTransport());
