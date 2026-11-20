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
 *   understudy_app             an app's settings — e.g. keep email fields as placeholders
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
import { MissingValuesError } from '../flows/execute.js';
import { parseScript } from '../adapters/recorder/script.js';
import { setPlaceholders, appPlaceholders } from '../memory/placeholders.js';

/**
 * Sent to the agent when it connects — its copy of the contract, since an
 * agent that installed Understudy from npm never sees REASONER.md. Kept short:
 * every session pays for it.
 */
const INSTRUCTIONS = `Understudy remembers the user's web-app flows and runs them as end-to-end tests. You supply judgement; it calls no model.
- Recall first: free, runs nothing. A known flow comes with its steps and the login values it needs. Run it with understudy_run, or drive it yourself — say which.
- Runs ask before a browser opens. decompose: subGoals in the order the app does them, in the words of its flows. seam: one click or goto, or [] unless you know — answers are reused forever. Start with dryRun.
- Never ask for a password in chat. Values come from the user's settings (UNDERSTUDY_<NAME>), or pass ones you fetched yourself.
- No flow for it? understudy_record (the user records) then understudy_save — or save a Playwright script of what you drove (understudy_save with script). Save what's worth testing again.
- Ask the user before each distill. Gather facts, lessons and findings, get approval, then one understudy_remember.
Full guide: REASONER.md in the package.`;

const server = new McpServer({ name: 'understudy', version: '0.2.0' }, { instructions: INSTRUCTIONS });

/** Credentials passed to `run`, kept in memory (never stored) until the run executes. */
const valuesByRun = new Map<string, Record<string, string>>();

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] });
const err = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });
/** Run a handler, returning its result as JSON or its error as a readable message. */
const wrap = async (fn: () => Promise<unknown>) => {
  try { return ok(await fn()); } catch (e) {
    return e instanceof MissingValuesError ? ok(missingValues(e)) : err(e);
  }
};

/**
 * Login values are missing, and nothing ran. Never ask for the value in chat:
 * say which line goes in which file, and that a retry re-reads the file.
 */
const missingValues = (e: MissingValuesError, retry?: Record<string, unknown>) => ({
  ran: false,
  missingLoginValues: e.missing,
  envFile: e.envFile,
  next:
    `Ask the user to add ${e.missing.map((m) => `${m.setOneOf[0]}=<value>`).join(', ')} to ${e.envFile} ` +
    '(or run `understudy config set …`) — never to paste it into chat — then call this again; the file is re-read. ' +
    'Or pass a value you fetched yourself in values.',
  ...(retry ? { retry } : {}),
});
/** Drop undefined fields: the zod types allow them, the functions here don't. */
const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };

/** After planning: run it now, unless it was a dry run or is waiting/blocked. */
async function continueRun(state: PlanState, opts: { headed?: boolean }) {
  if (state.status !== 'planned' || state.dryRun) return state;
  const values = valuesByRun.get(state.runId) ?? {};
  const { executed, recorded, plan, nowProven } = await runPlan(state.runId, { values, ...opts });
  valuesByRun.delete(state.runId);
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
    ...(nowProven.length ? { nowProven } : {}),
    ...(executed.missingValues.length ? { missingValues: executed.missingValues } : {}),
    ...(executed.staleSession ? { staleSession: executed.staleSession } : {}),
  };
}

const values = z.record(z.string(), z.string()).optional()
  .describe('Login values you fetched yourself, e.g. {"SECRET.password":"…"}; otherwise read from settings. Never stored.');

server.registerTool('understudy_recall', {
  description: 'What memory knows about a goal: closest flows and notes, and a verdict. A known flow comes with its steps and needed login values. Free; nothing runs.',
  inputSchema: { app: z.string(), goal: z.string(), limit: z.number().int().positive().optional() },
}, ({ app, goal, limit }) => wrap(() => recall(app, goal, { withSteps: true, ...(limit ? { limit } : {}) })));

server.registerTool('understudy_run', {
  description: 'Plan a goal and run it headless. Returns a question to answer with understudy_answer, "blocked" with why, or the result.',
  inputSchema: {
    app: z.string(), goal: z.string(),
    subGoals: z.array(z.string()).optional().describe('Skip the decompose question.'),
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
  description: 'Answer a waiting run\'s question; returns the next one, or the result. decompose: {"subGoals":[…]}. seam: {"steps":[…]}, or {"steps":[]} unless you know.',
  inputSchema: { runId: z.string(), answer: z.record(z.string(), z.unknown()), values, headed: z.boolean().optional() },
}, (a) => wrap(async () => {
  if (a.values) valuesByRun.set(a.runId, a.values);
  return continueRun(await answer(a.runId, a.answer), a.headed ? { headed: true } : {});
}));

server.registerTool('understudy_distill', {
  description: 'A saved flow\'s numbered steps and the app\'s vocabulary, to name it and split it into segments. Ask the user first.',
  inputSchema: { app: z.string(), flow: z.string() },
}, ({ app, flow }) => wrap(() => distillRequest(app, flow)));

server.registerTool('understudy_save_distilled', {
  description: 'Store a distillation. Validated; every problem returned at once; nothing written unless all is valid.',
  inputSchema: { app: z.string(), flow: z.string(), distilled: z.record(z.string(), z.unknown()) },
}, ({ app, flow, distilled }) => wrap(() => saveDistilled(app, flow, distilled)));

server.registerTool('understudy_remember', {
  description: 'Store what you learned, as one approved batch: facts, lessons (trigger never empty), findings, and goals you reached without understudy_run.',
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
  description: 'Open findings for an app, most frequent first. Pass triage to route them: issue, lesson or noise.',
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
  description: 'Wait for the user to record a flow in their Chrome. Returns at once with what to tell them; then call understudy_save.',
  inputSchema: { app: z.string(), port: z.number().int().min(0).max(65535).optional().describe('Default 7397.') },
}, ({ app, port }) => wrap(async () => {
  if (recording) throw new Error(`already waiting for a recording of "${recording.app}" — the user needs to stop it first`);
  const rec = await startExtensionRecorder({ appSlug: app, savedBy: 'agent', ...(port ? { port } : {}) });
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
      'Do the flow as normal, then click the icon → "Stop".',
      `Extension not loaded yet? chrome://extensions → Developer mode → Load unpacked → ${extensionDir()}`,
    ],
    then: 'When they say they\'ve stopped, call understudy_save with a name for the flow.',
  };
}));

server.registerTool('understudy_save', {
  description: 'Prove a flow by replaying it, and keep it only if every step passes: the user\'s latest recording, a recording hash, or a script of a flow you drove.',
  inputSchema: {
    app: z.string(), name: z.string().describe('What the flow does, as someone would ask for it.'),
    hash: z.string().optional(),
    script: z.string().optional().describe('Path to a Playwright script of a flow you drove; read passwords from process.env.'),
    intent: z.string().optional(), slug: z.string().optional(), values,
    verify: z.boolean().optional().describe('false: keep it without replaying (e.g. it ends in a real purchase). Saved as unproven until a run passes.'),
    note: z.string().optional().describe('With verify false: why, e.g. what you checked yourself.'),
  },
}, (a) => wrap(async () => {
  let rec;
  let madeBy: 'user' | 'agent' = 'user';
  if (a.script) {
    // A flow the agent drove: read its script into steps, exactly like `understudy import`.
    const { apps } = await collections();
    const base = (await apps.findOne({ slug: a.app }))?.urls.default;
    const parsed = await parseScript(a.script, a.app, base);
    if (!parsed.recording.events.length) throw new Error(`no Playwright actions found in ${a.script} — expected calls like page.getByRole(...).click()`);
    if (parsed.warnings.length) throw new Error(`these calls in the script can't be replayed, so it wasn't kept — rewrite them as plain Playwright actions:\n- ${parsed.warnings.slice(0, 10).join('\n- ')}`);
    rec = parsed.recording;
    await saveRecording(rec);
    madeBy = 'agent';
  } else {
    if (!a.hash && recording?.app === a.app) throw new Error('the user is still recording — ask them to click "Stop" in the extension first');
    const hash = a.hash ?? finished.get(a.app)?.hash;
    if (!hash) throw new Error(`no finished recording for "${a.app}" — start one with understudy_record, pass a hash, or pass a script`);
    rec = await loadRecording(hash);
  }
  const hash = rec.hash;
  let out;
  try {
    out = await proveAndSave(rec, {
      title: a.name, madeBy,
      ...(a.verify === false ? { verify: false, unproven: a.note ? `saved by an agent without a replay: ${a.note}` : 'saved by an agent without a replay' } : {}),
      ...(a.values ? { values: a.values } : {}), ...(a.intent ? { intent: a.intent } : {}), ...(a.slug ? { slug: a.slug } : {}),
    });
  } catch (e) {
    // The recording is kept; saving it again by hash needs nothing re-recorded.
    if (e instanceof MissingValuesError) return { saved: false, ...missingValues(e, { tool: 'understudy_save', hash, name: a.name }) };
    throw e;
  }
  const r = out.proven?.result;
  const base = {
    recording: hash,
    ...(r ? {
      passed: r.ok,
      failedSteps: r.steps.filter((s) => !s.ok).map((s) => ({ seq: s.seq, action: s.action, error: s.error })),
      signIn: out.proven!.signIn,
    } : { replayed: false }),
    ...(finished.get(a.app)?.droppedUploads ? { droppedUploads: finished.get(a.app)!.droppedUploads } : {}),
  };
  if (!out.saved) return { saved: false, ...base, why: 'it did not replay cleanly, so it was not kept. Fix the step, or pass verify: false to keep it unproven.' };
  return {
    saved: true, flow: out.flow.slug, steps: out.flow.steps.length, madeBy, ...base,
    ...(out.flow.proven === false ? { unproven: out.flow.unprovenBecause } : {}),
    ...(out.flow.destructive ? { destructive: out.flow.destructiveBecause } : {}),
    ...(out.run ? { findings: out.run.findings.map((f) => f.statement) } : {}),
    ...(out.placeholders.converted.length ? { placeholders: out.placeholders.converted } : {}),
  };
}));

server.registerTool('understudy_app', {
  description: 'An app\'s settings. placeholders ["email"] keeps email addresses out of memory: they become placeholders, and the values move to the user\'s env file.',
  inputSchema: {
    app: z.string(),
    placeholders: z.array(z.enum(['email'])).optional().describe('[] turns it off for new flows.'),
  },
}, ({ app, placeholders }) => wrap(async () => {
  if (placeholders) return setPlaceholders(app, placeholders);
  return { app, placeholders: await appPlaceholders(app) };
}));

await server.connect(new StdioServerTransport());
