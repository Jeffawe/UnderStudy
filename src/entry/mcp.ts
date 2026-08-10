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
import { recall, isGap, GAP_DISTANCE } from '../core/recall.js';
import { startRun, resumeRun, type RunStep } from '../core/session.js';

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
    return json(await fetchVocabulary(appId));
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
    },
  },
  async ({ appSlug, goal, values, dryRun, allowPurchases }) => {
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
