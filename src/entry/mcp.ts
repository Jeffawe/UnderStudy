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
 *   understudy_save            prove a recording by replaying it, then keep it as a flow (or prove a saved one)
 *   understudy_app             an app's settings — e.g. keep email fields as placeholders
 *   understudy_calibrate       fit when recall calls a goal known, for one app and embedding model
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
import { triage, listFindings } from '../flows/findings.js';
import { acceptPaths } from '../flows/runs.js';
import { collections } from '../store/db.js';
import { startExtensionRecorder, extensionDir, type ExtensionRecorder } from '../adapters/recorder/extension.js';
import { saveRecording, loadRecording, recordingPath } from '../core/recording-store.js';
import { editFlow, proveAndSave, proveFlow } from '../flows/save.js';
import type { Flow } from '../store/types.js';
import type { EndCheck } from '../core/replay.js';
import { MissingValuesError } from '../flows/execute.js';
import { parseScript } from '../adapters/recorder/script.js';
import { setPlaceholders, appPlaceholders } from '../memory/placeholders.js';
import { calibrate } from '../memory/calibrate.js';
import { VERSION } from './version.js';

/**
 * Sent to the agent when it connects. EVERY session pays for this, used or not,
 * so it says only what Understudy is and where to start. Everything else lives
 * on the tool it is about: a client that loads tools on demand pays for those
 * words only when the tool is used.
 */
const INSTRUCTIONS = `Understudy runs end-to-end tests of the user's web apps from flows it remembers; it calls no model. Start with understudy_recall.`;

const server = new McpServer({ name: 'understudy', version: VERSION }, { instructions: INSTRUCTIONS });

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

/**
 * A run that may stop mid-way to ask a person something, browser left open.
 *
 * Planning questions are asked before any browser opens and live on the run
 * document. These can't: the browser is the state. So the run keeps going in
 * this (long-lived) process, and `understudy_answer` reaches it here. If the
 * server restarts, the run is lost — the agent starts it again.
 */
type LiveEvent =
  | { kind: 'question'; seq: number; question: Record<string, unknown> }
  | { kind: 'done'; result: unknown }
  | { kind: 'error'; error: unknown };

class LiveRun {
  private queue: LiveEvent[] = [];
  private waiter: ((e: LiveEvent) => void) | undefined;
  /** The question waiting for an answer, if any. */
  pending: { seq: number; resolve: (a: PersonSaid) => void } | undefined;
  push(e: LiveEvent) {
    const w = this.waiter;
    if (w) { this.waiter = undefined; w(e); } else this.queue.push(e);
  }
  /** The page showed the step done: nobody needs to answer that question now. */
  withdraw(seq: number) {
    this.queue = this.queue.filter((e) => !(e.kind === 'question' && e.seq === seq));
    if (this.pending?.seq === seq) this.pending = undefined;
  }
  next(): Promise<LiveEvent> {
    const e = this.queue.shift();
    return e ? Promise.resolve(e) : new Promise((r) => { this.waiter = r; });
  }
}
type PersonSaid = { done: true } | { abort: string };
const liveRuns = new Map<string, LiveRun>();

const HUMAN_HOW = 'A step only a person can do. Tell the user exactly what to do, then answer {"done": true} when they say it is done, or {"abort": "why"}.';
const STUCK_HOW = 'This step failed, and the run\'s browser is open on screen. Ask the user to do just this step by hand in that window, then answer {"done": true} — or {"abort": "why"}. Then suggest re-recording, so it works next time.';

function personSaid(reply: unknown): PersonSaid {
  const r = reply as { done?: unknown; abort?: unknown };
  if (r?.done === true) return { done: true };
  if (typeof r?.abort === 'string' && r.abort.trim()) return { abort: r.abort.trim() };
  throw new Error('answer {"done": true} once they have done it, or {"abort": "why"}');
}

/** Wait for the live run's next question, or its result. */
async function nextFrom(runId: string) {
  const run = liveRuns.get(runId)!;
  const e = await run.next();
  if (e.kind === 'question') return { status: 'waiting', runId, question: e.question };
  liveRuns.delete(runId);
  valuesByRun.delete(runId);
  if (e.kind === 'error') throw e.error;
  return e.result;
}

/** After planning: run it now, unless it was a dry run or is waiting/blocked. */
async function continueRun(state: PlanState, opts: { headed?: boolean }) {
  if (state.status !== 'planned' || state.dryRun) return state;
  const runId = state.runId;
  const live = new LiveRun();
  liveRuns.set(runId, live);
  const ask = (seq: number, question: Record<string, unknown>) =>
    new Promise<PersonSaid>((resolve) => {
      live.pending = { seq, resolve };
      live.push({ kind: 'question', seq, question });
    });

  runPlan(runId, {
    values: valuesByRun.get(runId) ?? {}, ...opts,
    onHuman: async (req, signal) => {
      signal.addEventListener('abort', () => live.withdraw(req.seq));
      const said = await ask(req.seq, {
        kind: 'human', step: req.seq, ask: req.instruction, page: req.url,
        ...(req.until ? { doneWhen: req.until, carriesOnWhen: 'the page shows doneWhen — it checks that after your answer too' } : {}),
        how: HUMAN_HOW,
      });
      return 'done' in said ? { action: 'done' } : { action: 'abort', reason: said.abort };
    },
    onStuck: async (stuck) => {
      const said = await ask(stuck.seq, { kind: 'handoff', step: stuck.seq, failed: { action: stuck.action, target: stuck.target, error: stuck.error }, page: stuck.url, how: STUCK_HOW });
      return 'done' in said ? 'done' : 'abort';
    },
  }).then(
    (out) => live.push({ kind: 'done', result: report(state, out) }),
    (error) => live.push({ kind: 'error', error }),
  );
  return nextFrom(runId);
}

/** What a finished run tells the agent. */
function report(state: Extract<PlanState, { status: 'planned' }>, out: Awaited<ReturnType<typeof runPlan>>) {
  const { executed, recorded, plan, nowProven } = out;
  const r = executed.result;
  const byPerson = r.steps.filter((s) => s.viaHuman || s.viaHandoff);
  return {
    status: r.ok ? 'passed' : 'failed',
    runId: state.runId,
    plan,
    seams: state.seams,
    failedSteps: r.steps.filter((s) => !s.ok).map((s) => ({ seq: s.seq, action: s.action, error: s.error, ...(s.saw ? { saw: s.saw } : {}) })),
    ...(byPerson.length ? { doneByAPerson: byPerson.map((s) => ({ seq: s.seq, how: s.viaHuman ? `human step, ${s.viaHuman === 'page' ? 'the page showed it done' : 'they said it was done'}` : 'a failed step they did by hand' })) } : {}),
    unexpectedPages: r.steps.filter((s) => s.unexpectedPage).map((s) => ({ seq: s.seq, ...s.unexpectedPage })),
    path: r.sigSequence,
    drift: recorded.drift.notCompared ? `not compared: ${recorded.drift.notCompared}`
      : recorded.drift.firstRun ? 'first passed run of this plan — now the baseline' : recorded.drift.changed
      ? { added: recorded.drift.added, removed: recorded.drift.removed, stateChanged: recorded.drift.stateChanged }
      : 'same path',
    findings: recorded.findings.map((f) => ({ kind: f.kind, severity: f.severity, statement: f.statement, fingerprint: f.fingerprint })),
    ...(recorded.pending ? { pathNotAccepted: 'it passed on a changed path, so it isn\'t history yet: ask the user if the change is right, then understudy_findings triage its flow_drift finding as expected (or issue)' } : {}),
    ...(executed.lessons?.fired ? { lessons: executed.lessons } : {}),
    ...(nowProven.length ? { nowProven } : {}),
    ...(executed.missingValues.length ? { missingValues: executed.missingValues } : {}),
    ...(executed.staleSession ? { staleSession: executed.staleSession } : {}),
  };
}

const values = z.record(z.string(), z.string()).optional()
  .describe('Login values you fetched yourself, e.g. {"SECRET.password":"…"}; otherwise read from the user\'s settings. Never stored. Never ask the user to paste one into chat.');

server.registerTool('understudy_recall', {
  description: 'Call first: what memory knows about a goal — closest flows, notes, a verdict. Free; nothing runs. A known flow comes with its steps and needed login values: run it with understudy_run or drive it yourself, and tell the user which. Unknown: the user records it (understudy_record), or you drive it and save the script (understudy_save).',
  inputSchema: { app: z.string(), goal: z.string(), limit: z.number().int().positive().optional() },
}, ({ app, goal, limit }) => wrap(() => recall(app, goal, { withSteps: true, ...(limit ? { limit } : {}) })));

server.registerTool('understudy_run', {
  description: 'Plan a goal and run it headless (visible when a step needs a person). Start with dryRun. Returns a question for understudy_answer, "blocked" with why, or the result.',
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
  description: 'Answer a waiting run\'s question, as its "how" says. Returns the next question, or the result.',
  inputSchema: { runId: z.string(), answer: z.record(z.string(), z.unknown()), values, headed: z.boolean().optional() },
}, (a) => wrap(async () => {
  // A run waiting on a person, browser open: answer it where it is.
  const live = liveRuns.get(a.runId);
  if (live) {
    const said = personSaid(a.answer);
    const waiting = live.pending;
    live.pending = undefined;
    waiting?.resolve(said); // none: the page showed it done, and it carried on
    return nextFrom(a.runId);
  }
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
  description: 'Store what you learned, as one batch the user has approved: facts (change plans), lessons (change one step; trigger never empty), findings (the app is broken), and goals you reached without understudy_run.',
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
  description: 'Open findings for an app, most severe first, then most frequent. Pass triage to route them: issue, lesson, noise — or, for a changed path (flow_drift), expected: the app changed on purpose and the new path becomes the normal one. Ask the user before expected.',
  inputSchema: {
    app: z.string(),
    triage: z.array(z.object({ fingerprint: z.string(), verdict: z.enum(['issue', 'lesson', 'noise', 'expected']) })).optional(),
    all: z.boolean().optional().describe('Include already-triaged findings.'),
  },
}, ({ app, triage: items, all }) => wrap(async () => {
  const { findings } = await collections();
  const routed = items?.length ? await triage(findings, app, items) : undefined;
  const accepted = routed?.expected.length ? await acceptPaths(app, routed.expected) : undefined;
  const rows = await listFindings(findings, app, { ...(all ? { all } : {}), limit: 40 });
  return {
    ...(routed ? { triaged: { routed: routed.routed, problems: routed.problems } } : {}),
    ...(accepted ? { acceptedPath: accepted } : {}),
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
  description: [
    'Keep a flow, proven by replaying it: the user\'s latest recording, a recording hash, or a Playwright script of a flow you drove.',
    'A script is read, not run — literal page calls only: no loops, no values computed at runtime (a code from an email is a human step).',
    'Understood: goto, click, dblclick, fill, type, press, check, uncheck, selectOption, setInputFiles, scrollIntoViewIfNeeded; getBy* locators, locator(css), frameLocator, filter({hasText}), first/last/nth;',
    'inline expect(page | locator) checks of URL, title, visible, hidden, text, value, checked; page.waitForURL, waitForSelector, waitForResponse.',
    'Other checks come back in droppedAssertions; calls that change the steps (evaluate, hover, route…) refuse the save.',
    'Where only a person can act: human(\'what they do\', { untilText | untilUrl | untilResponse }).',
  ].join(' '),
  inputSchema: {
    app: z.string(), name: z.string().optional().describe('What the flow does, as someone would ask for it. Needed unless flow is given.'),
    flow: z.string().optional().describe('A saved flow to prove where it stands (e.g. one kept with verify false), instead of saving a new one.'),
    add: z.array(z.object({ before: z.number().int(), step: z.record(z.string(), z.unknown()) })).optional()
      .describe('With flow: steps to add first, each before step n. {"action":"human","value":"what they do","hints":{"untilText":"…"}}, {"action":"wait_response","value":"/api/visits","hints":{"method":"POST","status":201,"field":"commission.amount","above":0}}, {"action":"assert","role":"checkbox","name":"…","hints":{"assert":"checked"}}; also wait_url, wait_text.'),
    hash: z.string().optional(),
    script: z.string().optional().describe('Path to a Playwright script of a flow you drove; read passwords from process.env.'),
    intent: z.string().optional(), slug: z.string().optional(), values,
    verify: z.boolean().optional().describe('A flow that commits something real (a purchase, a submission) is replayed only up to that step, which is checked and never pressed. false: keep it without replaying at all; saved as unproven until a run passes.'),
    note: z.string().optional().describe('With verify false: why, e.g. what you checked yourself.'),
  },
}, (a) => wrap(async () => {
  if (a.flow) {
    const edited = a.add?.length ? await editFlow(a.app, a.flow, a.add) : undefined;
    if (edited && a.verify === false) return { flow: edited.slug, steps: edited.steps.length, unproven: edited.unprovenBecause };
    return { ...(edited ? { added: a.add!.length } : {}), ...(await proveSaved(a.app, a.flow, a)) };
  }
  if (!a.name) throw new Error('name is required — what the flow does, as someone would ask for it (or pass flow to prove a saved one)');
  const name = a.name;
  let rec;
  let madeBy: 'user' | 'agent' = 'user';
  let dropped: string[] = [];
  if (a.script) {
    // A flow the agent drove: read its script into steps, exactly like `understudy import`.
    const { apps } = await collections();
    const base = (await apps.findOne({ slug: a.app }))?.urls.default;
    const parsed = await parseScript(a.script, a.app, base);
    if (!parsed.recording.events.length) throw new Error(`no Playwright actions found in ${a.script} — expected calls like page.getByRole(...).click()`);
    if (parsed.warnings.length) throw new Error(`these calls in the script can't be replayed, so it wasn't kept — rewrite them as plain Playwright actions:\n- ${parsed.warnings.slice(0, 10).join('\n- ')}`);
    rec = parsed.recording;
    dropped = parsed.dropped;
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
      title: name, madeBy,
      ...(a.verify === false ? { verify: false, unproven: a.note ? `saved by an agent without a replay: ${a.note}` : 'saved by an agent without a replay' } : {}),
      ...(a.values ? { values: a.values } : {}), ...(a.intent ? { intent: a.intent } : {}), ...(a.slug ? { slug: a.slug } : {}),
    });
  } catch (e) {
    // The recording is kept; saving it again by hash needs nothing re-recorded.
    if (e instanceof MissingValuesError) return { saved: false, ...missingValues(e, { tool: 'understudy_save', hash, name }) };
    throw e;
  }
  const r = out.proven?.result;
  const base = {
    recording: hash,
    // Where the steps it read are, so a failure can be checked against them.
    recordingFile: recordingPath(hash),
    ...(dropped.length ? { droppedAssertions: dropped, droppedWhy: 'these checks in the script were not kept, so the flow checks less than the script did' } : {}),
    ...(r ? {
      passed: r.ok,
      failedSteps: r.steps.filter((s) => !s.ok).map((s) => ({ seq: s.seq, action: s.action, error: s.error, ...(s.saw ? { saw: s.saw } : {}) })),
      signIn: out.proven!.signIn,
    } : { replayed: false }),
    ...(finished.get(a.app)?.droppedUploads ? { droppedUploads: finished.get(a.app)!.droppedUploads } : {}),
  };
  if (!out.saved) return { saved: false, ...base, why: 'it did not replay cleanly, so it was not kept. Fix the step, or pass verify: false to keep it unproven.' };
  return {
    saved: true, flow: out.flow.slug, steps: out.flow.steps.length, madeBy, ...base,
    ...(out.flow.proven === false ? {
      unproven: out.flow.unprovenBecause,
      proveIt: `when it should pass: understudy_run with subGoals ["${out.flow.slug}"] — a passing run proves it`,
    } : {}),
    ...(out.flow.destructive ? { destructive: out.flow.destructiveBecause } : {}),
    ...provenUpTo(out.flow),
    ...endChecks(out.flow, r?.endChecks),
    ...(out.run ? { findings: out.run.findings.map((f) => f.statement) } : {}),
    ...(out.placeholders.converted.length ? { placeholders: out.placeholders.converted } : {}),
  };
}));

/** understudy_save with `flow`: prove a saved flow — up to its commit, if it has one. Records the run. */
async function proveSaved(app: string, slug: string, a: { values?: Record<string, string> | undefined }) {
  const out = await proveFlow(app, slug, a.values ? { values: a.values } : {});
  const r = out.result;
  return {
    flow: out.flow.slug, passed: r.ok, newlyProven: out.newlyProven,
    proven: out.flow.proven !== false,
    ...(out.flow.proven === false ? { unproven: out.flow.unprovenBecause } : {}),
    ...provenUpTo(out.flow),
    ...(out.commit && !r.ok ? { wouldStopBefore: `step ${out.commit.index}: ${out.commit.reason}` } : {}),
    failedSteps: r.steps.filter((s) => !s.ok).map((s) => ({ seq: s.seq, action: s.action, error: s.error, ...(s.saw ? { saw: s.saw } : {}) })),
    findings: out.run.findings.map((f) => f.statement),
  };
}

/**
 * How the flow ended, offered as checks to add — never added unasked. A
 * person's own recording is the best word on how it should end; an agent's
 * may have taken a path the user wouldn't, so the user says either way.
 */
function endChecks(flow: Flow, checks: EndCheck[] | undefined) {
  if (!checks?.length) return {};
  return {
    endChecks: {
      suggest: checks.map((step) => ({ before: flow.steps.length, step })),
      how: (flow.madeBy === 'agent'
        ? 'You drove this, so ask the user how it should end: '
        : 'From the user\'s own recording — ask them: ')
        + 'which of these say it ended right? Add those with understudy_save { flow, add }. Without them the flow only checks that each step could be done.',
    },
  };
}

/** What "proven up to its commit" means, for a flow that is. */
function provenUpTo(flow: Flow) {
  if (flow.provenUpTo === undefined) return {};
  const s = flow.steps[flow.provenUpTo];
  return {
    provenUpTo: flow.provenUpTo,
    stoppedBefore: `step ${flow.provenUpTo}${s?.name ? ` ("${s.name}")` : ''}, its commit: the control was there and ready, and was not pressed — nothing after it has run`,
  };
}

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

server.registerTool('understudy_calibrate', {
  description: 'Fit when recall calls a goal "known", for this app and embedding model — needed after switching models, or when recall calls the wrong things known (its `cutoffs.source` says "uncalibrated"). Give 2–3 rewordings per flow (not its own title) and 5+ goals that sound like the app but that it has no flow for; they are kept, so later calls and `understudy reembed` re-fit from them. Tell the user the before/after and any mistakes.',
  inputSchema: {
    app: z.string(),
    known: z.array(z.object({ flow: z.string().describe('the flow\'s slug'), goals: z.array(z.string()) })).optional(),
    unknown: z.array(z.string()).optional(),
    dryRun: z.boolean().optional().describe('fit and report, keep nothing'),
  },
}, ({ app, known, unknown, dryRun }) => wrap(() => calibrate(app, {
  goals: { known: (known ?? []).flatMap((k) => k.goals.map((goal) => ({ flow: k.flow, goal }))), unknown: unknown ?? [] },
  ...(dryRun ? { dryRun } : {}),
})));

await server.connect(new StdioServerTransport());
