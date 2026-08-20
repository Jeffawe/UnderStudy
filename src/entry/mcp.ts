#!/usr/bin/env node
/**
 * understudy mcp — Mode B entry point.
 *
 * The host agent (Claude Code, Codex, …) is the reasoner and the distiller.
 * This exposes the pause-and-ask handshake as tool calls.
 *
 * THE AGENT DOES NOT DRIVE. It is CONSULTED.
 *
 * Deterministic code owns the pipeline: replay, recall, binding, execution.
 * The agent is called at judgement points only — distilling a recording,
 * decomposing a goal, resolving a stuck step. PLAN.md is explicit about why:
 * eighty MCP round-trips would be slow and would consume the very context
 * window the user is working in.
 *
 * So every tool here is one half of a handshake, never a step in a loop:
 *
 *     understudy_distill(hash)          → needs_distillation + payload
 *     understudy_save_distilled(...)    → validate → ingest → done
 *
 * The server validates. A malformed distillation writes NOTHING and returns
 * every problem at once, so the agent can fix and retry — that check is the
 * only thing standing between a hallucinated segment and the corpus.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createEmbedder } from '../adapters/embedder/index.js';
import { closePool, describeTarget, getPool } from '../core/db.js';
import { listRecordings, loadRecording } from '../core/recording-store.js';
import { replay } from '../core/replay.js';
import { ingestRecording } from '../core/ingest.js';
import { buildDistillRequest, validateDistilled, saveDistilled, loadDistilled } from '../core/distill.js';
import { fetchVocabulary } from '../core/vocabulary.js';
import { remember, validateRemember } from '../core/remember.js';
import { recordAttributedRun } from '../core/run.js';
import type { RememberFact, RememberLesson, RememberFinding } from '../core/remember.js';
import { recall, isGap, GAP_DISTANCE } from '../core/recall.js';
import { startRun, resumeRun, type RunStep } from '../core/session.js';
import { listOpenFindings, suppressThirdParty, applyTriage, triageSummary } from '../core/triage.js';

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

const fail = (message: string, extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  isError: true,
});

const appIdFor = async (slug: string): Promise<string | undefined> => {
  const { rows } = await getPool().query<{ app_id: string }>(
    'SELECT app_id FROM apps WHERE slug = $1',
    [slug],
  );
  return rows[0]?.app_id;
};

const server = new McpServer({ name: 'understudy', version: '0.1.0' });

// ---------------------------------------------------------------------------

server.registerTool(
  'understudy_recordings',
  {
    title: 'List recordings',
    description:
      'List captured recordings awaiting distillation or already ingested. Start here to find a hash.',
    inputSchema: { appSlug: z.string().optional().describe('filter to one app') },
  },
  async ({ appSlug }) => json({ target: describeTarget(), recordings: await listRecordings(appSlug) }),
);

server.registerTool(
  'understudy_distill',
  {
    title: 'Distill a recording (first half of the handshake)',
    description:
      'Replays a recording to verify it, then returns the steps to distill plus the app\'s existing ' +
      'vocabulary. YOU annotate and partition — you may reference steps only BY INDEX, never restate ' +
      'or invent them. Answer with understudy_save_distilled. If a cached distillation exists it is ' +
      'ingested immediately and nothing is asked.',
    inputSchema: {
      hash: z.string().describe('recording hash from understudy_recordings'),
      values: z
        .record(z.string(), z.string())
        .optional()
        .describe('values for redacted refs, e.g. {"SECRET.password": "hunter2"}'),
      again: z.boolean().optional().describe('re-distill even if a cached answer exists'),
    },
  },
  async ({ hash, values, again }) => {
    const recording = await loadRecording(hash).catch(() => undefined);
    if (!recording) return fail(`no recording '${hash}'`, { hint: 'call understudy_recordings' });

    // Replay first, always: the distiller must only ever see VERIFIED steps.
    const result = await replay(recording, { values: values ?? {} });
    if (result.needsReview) {
      const bad = result.steps.find((s) => !s.ok);
      return fail('recording did not replay cleanly, so it cannot be distilled', {
        failedStep: bad?.seq,
        action: bad?.action,
        reason: bad?.error,
        needsValues: recording.events
          .filter((e) => e.valueRef && !(values ?? {})[e.valueRef])
          .map((e) => e.valueRef),
      });
    }

    const cached = await loadDistilled(hash);
    if (cached && !again) {
      const ing = await ingestRecording(createEmbedder(), recording, result, { distilled: cached });
      return json({
        status: 'already_distilled',
        note: 'cached answer reused; pass again:true to re-distill',
        intent: cached.intent,
        segments: ing.segments,
      });
    }

    const appId = await appIdFor(recording.appSlug);
    const vocabulary = appId
      ? await fetchVocabulary(appId)
      : { segments: [], flows: [], facts: [] };

    return json({
      status: 'needs_distillation',
      ...buildDistillRequest(recording, result, vocabulary),
      answerWith: 'understudy_save_distilled',
    });
  },
);

server.registerTool(
  'understudy_save_distilled',
  {
    title: 'Save a distillation (second half of the handshake)',
    description:
      'Validates your distillation and, if it is well formed, writes the flow, its segments and their ' +
      'embeddings in one transaction. Invalid input writes NOTHING and returns every problem at once.',
    inputSchema: {
      hash: z.string(),
      distilled: z
        .record(z.string(), z.unknown())
        .describe('the object matching the schema returned by understudy_distill'),
      values: z.record(z.string(), z.string()).optional(),
    },
  },
  async ({ hash, distilled, values }) => {
    const recording = await loadRecording(hash).catch(() => undefined);
    if (!recording) return fail(`no recording '${hash}'`);

    const result = await replay(recording, { values: values ?? {} });
    if (result.needsReview) return fail('recording no longer replays cleanly; not ingested');

    const request = buildDistillRequest(recording, result);
    const check = validateDistilled(distilled, request.steps.length);
    if (!check.ok) {
      return fail('distillation is invalid — nothing was written', {
        problems: check.errors,
        stepCount: request.steps.length,
      });
    }

    await saveDistilled(hash, check.value!);
    const ing = await ingestRecording(createEmbedder(), recording, result, { distilled: check.value! });

    return json({
      status: 'ingested',
      flow: ing.slug,
      intent: check.value!.intent,
      steps: ing.steps,
      segments: ing.segments,
      bindable: ing.chunkWritten,
    });
  },
);

server.registerTool(
  'understudy_recall',
  {
    title: 'Query the memory',
    description:
      'What the planner would see for a goal. `bindable` is what can actually be executed; `context` ' +
      'informs execution but is not executable. A gap means ask rather than guess.',
    inputSchema: {
      appSlug: z.string(),
      goal: z.string(),
      limit: z.number().int().positive().max(20).optional(),
    },
  },
  async ({ appSlug, goal, limit }) => {
    const appId = await appIdFor(appSlug);
    if (!appId) return fail(`unknown app '${appSlug}'`);

    const result = await recall(createEmbedder(), appId, goal, { limit: limit ?? 5 });
    return json({
      goal,
      threshold: GAP_DISTANCE,
      topDistance: result.topDistance,
      margin: result.margin,
      gap: isGap(result),
      bindable: result.bindable.map((c) => ({ distance: c.distance, kind: c.kind, text: c.text })),
      context: result.context.map((c) => ({ distance: c.distance, kind: c.kind, text: c.text })),
    });
  },
);

server.registerTool(
  'understudy_record_run',
  {
    title: 'Attribute a run Understudy did not drive',
    description:
      'Record that a goal really was run and how it turned out, when something OTHER than the ' +
      'Understudy executor drove it — a Playwright script, the browser directly, an API call. ' +
      'Reaching a goal that way is explicitly allowed, but it used to leave NO trace: no run row, ' +
      'no drift baseline, nothing showing the goal had ever succeeded.\n\n' +
      'Call this whenever you achieve a goal by hand. It is the difference between a corpus that ' +
      'accumulates evidence and one that only grows when someone remembers to write a fact.\n\n' +
      'Recorded as mode=attributed, never mode=execute — "the goal works" and "the executor can do ' +
      'it" are different claims and only one of them is self-verifying. Supply sigSequence only if ' +
      'you actually captured page fingerprints; a path you did not observe is not a baseline.',
    inputSchema: {
      appSlug: z.string(),
      goal: z.string().describe('what was attempted, in the words you would use to ask for it again'),
      passed: z.boolean(),
      sigSequence: z.array(z.string()).optional().describe('page fingerprints in order, if observed'),
      drivenBy: z.string().optional().describe('e.g. "playwright script: hair-loss-full-checkout.ts"'),
      note: z.string().optional().describe('why the executor was not used, or what the outcome proved'),
    },
  },
  async ({ appSlug, goal, passed, sigSequence, drivenBy, note }) => {
    const appId = await appIdFor(appSlug);
    if (!appId) return fail(`unknown app '${appSlug}'`);
    const out = await recordAttributedRun({
      appId, goal, passed,
      ...(sigSequence ? { sigSequence } : {}),
      ...(drivenBy ? { drivenBy } : {}),
      ...(note ? { note } : {}),
    });
    return json({
      result: 'recorded',
      runId: out.runId,
      mode: 'attributed',
      ...(out.drift ? { drift: out.drift } : { drift: 'not measured — no sigSequence supplied' }),
    });
  },
);

server.registerTool(
  'understudy_remember',
  {
    title: 'Write what you learned to memory',
    description:
      'Record facts, lessons and findings you learned while working — the counterpart to every other ' +
      'tool here, which only READ. Batched on purpose: gather what you learned, confirm the whole list ' +
      'with the user at a natural pause, then write it in one call.\n\n' +
      'A FACT is declarative and retrieved BY MEANING at planning time ("reaching checkout texts a real ' +
      'phone") — it changes what you plan. A LESSON is a conditional fix matched by EXACT TRIGGER during ' +
      'execution ("when filling Card number, dismiss Stripe Link first") — it changes one step. A FINDING ' +
      'is "the app is broken" and someone fixes the app.\n\n' +
      'Prefer facts about CONSEQUENCES over facts about structure: "on page X you can click Y" is visible ' +
      'by loading the page and is the least useful kind to retrieve.\n\n' +
      'Nothing is written unless the whole batch validates, and every problem comes back at once.',
    inputSchema: {
      appSlug: z.string(),
      facts: z
        .array(z.object({
          kind: z.enum(['structure', 'capability', 'entity', 'auth', 'environment', 'boundary', 'constraint']),
          statement: z.string(),
          scope: z.record(z.string(), z.unknown()).optional().describe('e.g. {url_pattern: "/overview"}'),
          confidence: z.number().optional(),
        }))
        .optional(),
      lessons: z
        .array(z.object({
          kind: z.string().describe('e.g. timing, gate, addressing, workaround, state'),
          title: z.string(),
          body: z.string(),
          trigger: z.record(z.string(), z.unknown())
            .describe('matched by EXACT containment at execution: url_pattern, action, role, name. An absent key is a wildcard, so keep it as narrow as the lesson really is.'),
          fixSnippet: z.string().optional(),
          confidence: z.number().optional(),
        }))
        .optional(),
      findings: z
        .array(z.object({
          kind: z.enum(['console_error', 'network_error', 'data_mismatch', 'persistence',
            'nondeterminism', 'flow_drift', 'perf', 'addressability', 'other']),
          severity: z.enum(['high', 'medium', 'low', 'unknown']),
          statement: z.string(),
          fingerprint: z.string().describe('stable dedupe key across runs — the same defect must produce the same string'),
          evidence: z.record(z.string(), z.unknown()).optional(),
        }))
        .optional(),
    },
  },
  async ({ appSlug, facts, lessons, findings }) => {
    const appId = await appIdFor(appSlug);
    if (!appId) return fail(`unknown app '${appSlug}'`);

    const input = {
      ...(facts ? { facts: facts as RememberFact[] } : {}),
      ...(lessons ? { lessons: lessons as RememberLesson[] } : {}),
      ...(findings ? { findings: findings as RememberFinding[] } : {}),
    };

    // Validate before touching the embedder: a bad batch should cost nothing.
    const problems = validateRemember(input);
    if (problems.length) return fail(`nothing was written. Problems:\n- ${problems.join('\n- ')}`);

    const out = await remember(createEmbedder(), appId, input);
    return json({
      result: 'remembered',
      ...out,
      note:
        'Facts are retrievable immediately via understudy_recall. A lesson only ever fires if its trigger ' +
        'is CONTAINED by a real step context — times_applied = 0 means it has never matched anything, which ' +
        'looks identical to a trigger that was never right.',
    });
  },
);

server.registerTool(
  'understudy_vocabulary',
  {
    title: "The app's own vocabulary",
    description:
      'Segment titles, flow titles and facts, in the words the corpus uses. Phrase goals in THIS ' +
      'vocabulary before recalling — a query that speaks the corpus\'s language retrieves far better.',
    inputSchema: { appSlug: z.string() },
  },
  async ({ appSlug }) => {
    const appId = await appIdFor(appSlug);
    if (!appId) return fail(`unknown app '${appSlug}'`);
    return json(await fetchVocabulary(appId, { purpose: 'plan' }));
  },
);

server.registerTool(
  'understudy_findings',
  {
    title: 'What looks wrong',
    description:
      'Open findings, ranked. Detection already happened mechanically on every run — console errors, ' +
      'non-2xx bodies, failed requests, values that did not survive, flow drift. What is missing is ' +
      'JUDGEMENT: whether each one matters. `goal` tells you which intent was executing when it fired, ' +
      'which is the difference between a 500 and a 500 during checkout.',
    inputSchema: {
      appSlug: z.string(),
      filterThirdParty: z.boolean().optional().describe('suppress other origins first (default true)'),
      includeTriaged: z.boolean().optional(),
    },
  },
  async ({ appSlug, filterThirdParty, includeTriaged }) => {
    const appId = await appIdFor(appSlug);
    if (!appId) return fail(`unknown app '${appSlug}'`);

    const filtered = filterThirdParty === false ? { suppressed: 0, hosts: [] } : await suppressThirdParty(appId);
    const findings = await listOpenFindings(appId, {
      ...(includeTriaged ? { includeSuppressed: true } : {}),
    });

    return json({
      autoSuppressed: filtered,
      summary: await triageSummary(appId),
      findings,
      triageWith: 'understudy_triage_finding',
      note:
        'A finding is "X is wrong" and the APP gets fixed. A lesson is "when X, do Y first" and the ' +
        'AGENT adapts. The same observation is one or the other depending on whether you accept it.',
    });
  },
);

server.registerTool(
  'understudy_triage_finding',
  {
    title: 'Decide what a finding means',
    description:
      'Route a finding. `triaged_lesson` is the one that changes future behaviour: it writes a real ' +
      'lesson, linked back through promoted_to, so the agent routes AROUND the problem next time ' +
      'instead of rediscovering it. `triaged_issue` means the app should be fixed. `wontfix` means it ' +
      'is noise.',
    inputSchema: {
      appSlug: z.string(),
      findingId: z.string(),
      disposition: z.enum(['triaged_lesson', 'triaged_issue', 'wontfix', 'fixed']),
      reason: z.string().describe('why — recorded on the finding'),
      lesson: z
        .object({
          kind: z.string(),
          title: z.string(),
          body: z.string(),
          trigger: z.record(z.string(), z.unknown()).describe('matched EXACTLY at execution: url_pattern, action, role, name'),
        })
        .optional()
        .describe('required for triaged_lesson — what should the agent do instead?'),
      externalRef: z.string().optional().describe('issue URL, once filed'),
    },
  },
  async ({ appSlug, findingId, disposition, reason, lesson, externalRef }) => {
    const appId = await appIdFor(appSlug);
    if (!appId) return fail(`unknown app '${appSlug}'`);
    try {
      const out = await applyTriage(appId, findingId, {
        disposition,
        reason,
        ...(lesson ? { lesson: lesson as NonNullable<Parameters<typeof applyTriage>[2]['lesson']> } : {}),
        ...(externalRef ? { externalRef } : {}),
      });
      // `out.status` is the disposition, not a tool status — name them apart
      // rather than letting one silently overwrite the other.
      return json({
        result: 'triaged',
        disposition: out.status,
        ...(out.lessonId ? { lessonId: out.lessonId } : {}),
        summary: await triageSummary(appId),
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

/** Render a step of the run loop for the agent. */
const renderStep = (step: RunStep) => {
  if (step.status === 'needs_decision') {
    return json({
      status: 'needs_decision',
      runId: step.runId,
      requestId: step.requestId,
      ask: step.ask,
      why: step.reason,
      ...step.payload,
      answerWith: 'understudy_resume_run',
    });
  }
  if (step.status === 'failed') return fail(step.error, { runId: step.runId });

  const o = step.outcome;
  return json({
    status: o.blocked ? 'blocked' : o.executed ? 'executed' : 'planned',
    runId: step.runId,
    ...(o.blocked ? { blocked: o.blocked } : {}),
    subGoals: o.plan.subGoals.map((s) => ({
      subGoal: s.subGoal,
      bound: s.bound ? { slug: s.bound.slug, distance: s.bound.distance, steps: s.bound.steps } : null,
      rejected: s.rejected,
      gap: s.gap,
    })),
    seams: o.plan.seams,
    unbound: o.plan.unbound,
    ...(o.result
      ? {
          passed: o.result.ok,
          flowsRun: o.flowsRun,
          path: o.result.sigSequence,
          failures: o.result.steps.filter((st) => !st.ok).map((st) => ({ seq: st.seq, action: st.action, error: st.error })),
        }
      : {}),
  });
};

server.registerTool(
  'understudy_run_plan',
  {
    title: 'Run a goal (first half of the run handshake)',
    description:
      'Plans and executes a goal. Returns at the first point it needs YOU: decomposing the goal ' +
      'into sub-goals phrased in the app\'s own vocabulary. It does NOT drive the browser through ' +
      'you — deterministic code binds, splices and executes; you are consulted at judgement points ' +
      'only. Answer with understudy_resume_run.',
    inputSchema: {
      appSlug: z.string(),
      goal: z.string(),
      values: z.record(z.string(), z.string()).optional().describe('e.g. {"SECRET.password": "hunter2"}'),
      dryRun: z.boolean().optional().describe('plan only, never open a browser'),
      allowPurchases: z.boolean().optional().describe('permit a destructive plan (default: refuse)'),
      visualCheck: z
        .boolean()
        .optional()
        .describe(
          'capture visual checkpoints and ask you to judge any that changed (default: on). ' +
            'You will be given image PATHS — open them before answering.',
        ),
    },
  },
  async ({ appSlug, goal, values, dryRun, allowPurchases, visualCheck }) => {
    const appId = await appIdFor(appSlug);
    if (!appId) return fail(`unknown app '${appSlug}'`);
    try {
      return renderStep(
        await startRun(createEmbedder(), appId, appSlug, goal, {
          ...(values ? { values } : {}),
          ...(dryRun ? { dryRun } : {}),
          ...(allowPurchases
            ? { env: { allowsPurchases: true, allowsIrreversible: true, name: 'tool --allowPurchases' } }
            : {}),
          // Default ON here and nowhere else: reaching this tool means the
          // reasoner is an agent that can open a PNG. The Bedrock path cannot,
          // and leaves it off.
          visualCheck: visualCheck ?? true,
        }),
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  'understudy_resume_run',
  {
    title: 'Answer a run\'s question (second half of the run handshake)',
    description:
      'Supply the decision a suspended run is waiting on, and it continues. Returns at the NEXT ' +
      'point it needs you, or when the run finishes. For a decompose request answer ' +
      '{ subGoals: ["...", "..."] } using the vocabulary you were given.',
    inputSchema: {
      requestId: z.string(),
      answer: z.record(z.string(), z.unknown()).describe('e.g. { "subGoals": ["log in", "add to cart"] }'),
    },
  },
  async ({ requestId, answer }) => {
    try {
      return renderStep(await resumeRun(requestId, answer));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel — anything written there corrupts it.
  console.error(`understudy mcp ready (${describeTarget()})`);
}

main().catch(async (err) => {
  console.error(`understudy mcp failed: ${err instanceof Error ? err.message : String(err)}`);
  await closePool().catch(() => {});
  process.exitCode = 1;
});
