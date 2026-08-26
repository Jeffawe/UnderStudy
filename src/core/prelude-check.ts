/**
 * Gates for `record --after` — the prelude rung.
 *
 * SAFE, like `auth:check` and unlike `explore:check`: everything is scoped to a
 * reserved `__preludecheck` slug that is deleted on the way in and the way out.
 * It never touches a real corpus.
 *
 * The thing under test is not "does a callback fire". It is the property that
 * makes the feature worth having: server-side progress that a saved session
 * CANNOT carry is reached by walking a known flow, and the recording that
 * results holds only the tail while still replaying end to end.
 */

import { createServer, type Server } from 'node:http';
import { createEmbedder } from '../adapters/embedder/index.js';
import { recordLive } from '../adapters/recorder/live.js';
import { eventsForFlowSlugs } from './flow-ir.js';
import { buildRecording, recordingHash } from './recording.js';
import { closePool, getPool } from './db.js';
import { ingestRecording } from './ingest.js';
import { buildPlan } from './plan.js';
import { replay } from './replay.js';

const SLUG = '__preludecheck';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

/**
 * An app whose progress lives ON THE SERVER, not in cookies.
 *
 * That is the whole point: `storageState` cannot carry `stage`, so a recording
 * of the tail is only replayable if the prelude is actually walked. A cookie
 * would have made this test pass for the wrong reason.
 */
let stage = 0;
function makeServer(): Server {
  return createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/advance') { stage = 1; res.writeHead(302, { location: '/' }); return res.end(); }
    if (url === '/finish') { stage = stage === 1 ? 2 : stage; res.writeHead(302, { location: '/' }); return res.end(); }
    if (url === '/reset') { stage = 0; res.writeHead(302, { location: '/' }); return res.end(); }

    res.writeHead(200, { 'content-type': 'text/html' });
    // The tail control EXISTS ONLY at stage 1 — so a cold replay of the tail
    // cannot pass by luck, it can only pass if the prelude ran.
    // IDS MATTER HERE, and their absence made an earlier version of this check
    // pass for the wrong reason. The live recorder captures a css fallback
    // alongside role+name; with one anonymous <a> per stage that fallback was
    // `html > body > main > a`, which matches whichever link happens to be
    // rendered — so a cold replay of the tail clicked *Begin* and "succeeded".
    // Distinct ids make the fixture test what it claims: that the tail control
    // genuinely is not reachable without the prelude.
    res.end(
      `<title>stage ${stage}</title><main>` +
        (stage === 0 ? '<a id="begin" href="/advance">Begin</a>' : '') +
        (stage === 1 ? '<a id="finish" href="/finish">Finish</a>' : '') +
        (stage === 2 ? '<p id="done">Done</p>' : '') +
        '</main>',
    );
  });
}

async function wipe(): Promise<void> {
  await getPool().query('DELETE FROM apps WHERE slug = $1', [SLUG]);
}

async function main(): Promise<void> {
  const server = makeServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const HOME = `http://127.0.0.1:${port}/`;
  const embedder = createEmbedder();

  await wipe();

  console.log('\n1. A PRELUDE FLOW EXISTS TO BUILD ON');
  stage = 0;
  const preludeRec = await recordLive({
    appSlug: SLUG,
    startUrl: HOME,
    drive: async (p) => { await p.getByRole('link', { name: 'Begin' }).click(); },
  });
  stage = 0;
  const preludeReplay = await replay(preludeRec, {});
  check('the prelude recording replays', preludeReplay.ok, preludeReplay.steps.map((s) => s.action).join(','));

  const ingested = await ingestRecording(embedder, preludeRec, preludeReplay, {
    distilled: {
      intent: 'begin the wizard', preconditions: [], outcome: 'at stage 1',
      segments: [], candidateLessons: [], corrections: [],
    } as never,
  });
  check('the prelude flow is in the corpus', Boolean(ingested.flowId), ingested.slug);
  const preludeSlug = ingested.slug;

  console.log('\n2. THE TAIL IS CAPTURED WITHOUT RE-RECORDING THE PRELUDE');
  const { rows } = await getPool().query<{ app_id: string }>(
    'SELECT app_id FROM apps WHERE slug = $1', [SLUG],
  );
  const appId = rows[0]!.app_id;
  const { events: preludeEvents } = await eventsForFlowSlugs(appId, [preludeSlug]);
  check('the prelude resolves to steps by slug', preludeEvents.length > 0, `${preludeEvents.length} steps`);

  stage = 0;
  const tail = await recordLive({
    appSlug: SLUG,
    startUrl: HOME,
    preludeSlugs: [preludeSlug],
    beforeArm: async (lease) => {
      const pre = await replay(
        buildRecording({ source: 'import', origin: 'prelude', appSlug: SLUG, startUrl: HOME }, preludeEvents),
        { lease },
      );
      if (!pre.ok) throw new Error('prelude failed inside beforeArm');
    },
    drive: async (p) => { await p.getByRole('link', { name: 'Finish' }).click(); },
  });

  const tailNames = tail.events.map((e) => `${e.action}:${e.name ?? ''}`);
  check('the prelude click is NOT in the tail recording', !tailNames.some((n) => n.includes('Begin')), tailNames.join(' '));
  check('the tail click IS', tailNames.some((n) => n.includes('Finish')), tailNames.join(' '));
  check('the tail declares its prelude by reference',
    JSON.stringify(tail.entry?.prelude) === JSON.stringify([preludeSlug]), JSON.stringify(tail.entry?.prelude));
  const { prelude: _dropped, ...entryWithoutPrelude } = tail.entry ?? {};
  check('the declared prelude is part of the recording hash',
    recordingHash(tail.events, tail.entry) !== recordingHash(tail.events, entryWithoutPrelude));

  console.log('\n3. THE TAIL DOES NOT REPLAY WITHOUT ITS PRELUDE');
  stage = 0;
  const cold = await replay(tail, {});
  const coldFailure = cold.steps.find((s) => !s.ok);
  check('a cold replay of the tail FAILS — the state was never reached', !cold.ok,
    coldFailure?.error?.slice(0, 60) ?? 'no failure');
  // Failing for the RIGHT reason. A generic css fallback silently clicking some
  // other control would also produce a red gate, and would mean the opposite.
  check('...because the control is absent, not because something else broke',
    Boolean(coldFailure?.error?.includes('matched no elements')), coldFailure?.error ?? '');

  console.log('\n4. THE TAIL REPLAYS WHEN THE PRELUDE IS SUPPLIED');
  stage = 0;
  const warm = await replay(tail, { prelude: preludeEvents });
  check('replay with the prelude PASSES', warm.ok,
    warm.steps.find((s) => !s.ok)?.error?.slice(0, 80) ?? '');
  check('the prelude is accounted for separately', (warm.preludeSteps?.length ?? 0) > 0, `${warm.preludeSteps?.length} prelude steps`);
  check('prelude steps are NOT counted as the recording\'s own', warm.steps.length === tail.events.length,
    `${warm.steps.length} vs ${tail.events.length}`);
  check('prelude sigs stay out of the flow path — start_state is the TAIL\'s',
    warm.sigSequence.length === new Set(warm.sigSequence).size && !warm.sigSequence.includes(preludeReplay.sigSequence[0] ?? '#none'),
    warm.sigSequence.join(' -> '));

  console.log('\n5. A BROKEN PRELUDE IS AN ENVIRONMENT FAILURE, NOT A BAD RECORDING');
  stage = 0;
  const bogus = await replay(tail, {
    prelude: [{ seq: 0, ts: 0, action: 'click', role: 'link', name: 'NoSuchControl', url: HOME, resolution: 'accname' }] as never,
  });
  check('a failing prelude reports preludeOk=false', bogus.preludeOk === false);
  check('and does NOT quarantine the recording as needsReview', bogus.needsReview === false);
  check('and the recording\'s own steps never ran', bogus.steps.length === 0, `${bogus.steps.length} steps`);

  console.log('\n6. TRANSITIVITY — BUILDING ON A FLOW THAT ITSELF DECLARES ONE');
  stage = 0;
  const tailReplayForIngest = await replay(tail, { prelude: preludeEvents });
  const tailIngest = await ingestRecording(embedder, tail, tailReplayForIngest, {
    distilled: {
      intent: 'finish the wizard', preconditions: [], outcome: 'at stage 2',
      segments: [], candidateLessons: [], corrections: [],
    } as never,
  });
  const { rows: pr } = await getPool().query<{ prelude: string[] }>(
    'SELECT prelude FROM flows WHERE flow_id = $1', [tailIngest.flowId],
  );
  check('the flow row records the declared prelude',
    JSON.stringify(pr[0]?.prelude) === JSON.stringify([preludeSlug]), JSON.stringify(pr[0]?.prelude));

  const { events: chained, chain } = await eventsForFlowSlugs(appId, [tailIngest.slug]);
  check('resolving the tail flow pulls its prelude in FIRST',
    chain.map((f) => f.slug).join(' -> ') === `${preludeSlug} -> ${tailIngest.slug}`,
    chain.map((f) => f.slug).join(' -> '));
  check('so the expanded chain is longer than the flow alone', chained.length > preludeEvents.length,
    `${chained.length} steps`);

  console.log('\n7. THE PLANNER REFUSES TO START A FLOW FROM NOWHERE');
  // Binding the tail without its prelude would put the executor on a page the
  // first step never expected. Blocking is the same call the unresolved-seam
  // rule makes, and for the same reason.
  const alone = await buildPlan(embedder, appId, 'finish the wizard', {
    subGoals: ['finish the wizard'],
    baseUrl: HOME,
  });
  const boundTail = alone.subGoals.some((g) => g.bound?.slug === tailIngest.slug);
  check('the tail flow still binds on its own merits', boundTail,
    alone.subGoals.map((g) => g.bound?.slug ?? 'unbound').join(','));
  check('but the plan is BLOCKED, naming the missing prelude',
    Boolean(alone.blocked?.includes(preludeSlug)), alone.blocked ?? '(not blocked)');

  const together = await buildPlan(embedder, appId, 'begin then finish the wizard', {
    subGoals: ['begin the wizard', 'finish the wizard'],
    baseUrl: HOME,
  });
  check('a plan that runs the prelude first is NOT blocked',
    !together.blocked?.includes('prelude'), together.blocked ?? '(not blocked)');

  console.log('\n8. A PRELUDE CYCLE IS AN ERROR, NOT A HANG');
  await getPool().query(
    `UPDATE flows SET prelude = $2 WHERE app_id = $1 AND slug = $3`,
    [appId, JSON.stringify([tailIngest.slug]), preludeSlug],
  );
  let cycled = '';
  await eventsForFlowSlugs(appId, [tailIngest.slug]).catch((e: Error) => { cycled = e.message; return null as never; });
  check('a cycle is reported', cycled.includes('cycle'), cycled);

  await wipe();
  server.close();
  console.log(failures ? `\n${failures} FAILED\n` : '\nall gates passed\n');
  await closePool();
  // exitCode, never process.exit(): the ONNX embedder holds native resources
  // and tearing the process down mid-flight aborts with SIGABRT *after* the
  // gates have already printed "all gates passed" — a green run reporting 134.
  process.exitCode = failures ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err);
  await wipe().catch(() => {});
  await closePool().catch(() => {});
  process.exitCode = 1;
});
