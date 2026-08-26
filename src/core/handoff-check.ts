/**
 * Gates for the mid-run handoff — the "ask a human to record this" rung.
 *
 * SAFE: no database, no corpus, no model. Everything runs against a local HTTP
 * server and in-memory objects, so this is the cheapest check in the repo.
 *
 * The properties under test are the ones that are expensive to get wrong:
 * a retry must never double-submit, a credential must never reach a payload,
 * and a run that a human rescued must never report as a clean pass.
 */

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { RunBudget, estimateTokens, limitsFromEnv } from './budget.js';
import { replay, type HandoffRequest } from './replay.js';
import { buildRecording, type RawEvent } from './recording.js';
import { saveHandoffSession, forgetHandoffSession, handoffPath } from './auth-cache.js';
import { HostAgentReasoner } from '../adapters/reasoner/host-agent.js';
import { openLease } from './browser.js';
import { handoffToHuman } from './session.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

/** Counts every mutating hit, so a double-submit is directly observable. */
let submits = 0;
let flaky = 0;
function makeServer(): Server {
  return createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/submit') { submits++; res.writeHead(302, { location: '/' }); return res.end(); }
    if (url === '/advance') { flaky = 1; res.writeHead(302, { location: '/' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<title>s${submits}f${flaky}</title><main>` +
        '<a href="/submit">Submit</a>' +
        (flaky === 1 ? '<a href="/advance">Appears</a>' : '') +
        '</main>',
    );
  });
}

async function main(): Promise<void> {
  const server = makeServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const HOME = `http://127.0.0.1:${port}/`;

  const ev = (seq: number, e: Partial<RawEvent>): RawEvent =>
    ({ seq, ts: seq, action: 'click', url: HOME, resolution: 'script-literal', ...e }) as RawEvent;
  const rec = (events: RawEvent[]) =>
    buildRecording({ source: 'import', origin: 'test', appSlug: '__handoffcheck', startUrl: HOME }, events);

  console.log('\n1. THE BUDGET IS READ FROM THE ENVIRONMENT');
  process.env.UNDERSTUDY_MAX_DECISIONS = '3';
  process.env.UNDERSTUDY_MAX_STEP_ATTEMPTS = '2';
  const limits = limitsFromEnv();
  check('decisions comes from the env', limits.decisions === 3, String(limits.decisions));
  check('step attempts comes from the env', limits.stepAttempts === 2, String(limits.stepAttempts));
  process.env.UNDERSTUDY_MAX_DECISIONS = 'not-a-number';
  check('a malformed value falls back rather than becoming zero',
    limitsFromEnv().decisions === 25, String(limitsFromEnv().decisions));
  delete process.env.UNDERSTUDY_MAX_DECISIONS;
  delete process.env.UNDERSTUDY_MAX_STEP_ATTEMPTS;

  console.log('\n2. THE TOKEN PROXY MEASURES WHAT UNDERSTUDY ACTUALLY CAUSES');
  const b = new RunBudget({ decisions: 100, minutes: 100, tokens: 100_000, stepAttempts: 1 });
  b.note({ ask: 'x'.repeat(400), payload: { a: 'y'.repeat(400) }, answer: {} });
  check('characters are metered at roughly 4 per token', b.tokens >= 200 && b.tokens < 400, String(b.tokens));

  const imaged = new RunBudget({ decisions: 100, minutes: 100, tokens: 100_000, stepAttempts: 1 });
  imaged.note({
    ask: 'judge these',
    payload: { checks: [{ shot: '/tmp/a.png' }, { baseline: '/tmp/b.png' }, { diff: '/tmp/c.png' }] },
    answer: {},
  });
  // The correction that matters: a visual_diff payload is a few hundred chars
  // of PATHS and then tells the agent to open three images.
  check('image paths carry a surcharge the character count misses',
    imaged.tokens > 4000, `${imaged.tokens} tokens for 3 image paths`);

  console.log('\n3. A SELF-REPORT CAN ONLY TRIP THE BUDGET SOONER');
  const sr = new RunBudget({ decisions: 100, minutes: 100, tokens: 1000, stepAttempts: 1 });
  sr.note({ ask: 'x'.repeat(2000), payload: {}, answer: {} });
  const proxy = sr.tokens;
  sr.selfReport(1);
  check('a smaller self-report is ignored', sr.tokens === proxy, `${sr.tokens} vs proxy ${proxy}`);
  sr.selfReport(50_000);
  check('a larger self-report is adopted', sr.tokens === 50_000, String(sr.tokens));
  check('and it trips the budget', Boolean(sr.exceeded()), sr.exceeded() ?? '');
  check('the reason says it was reported, not estimated',
    sr.exceeded()!.includes('reported'), sr.exceeded()!);

  console.log('\n4. A RETRY NEVER DOUBLE-SUBMITS');
  // The element appears only after /advance, so attempt 1 cannot address it.
  flaky = 0; submits = 0;
  const lease = await openLease({ headless: true });
  await lease.page.goto(HOME);
  flaky = 1; // it exists now, but the FIRST attempt already failed to find it
  const addressing = await replay(
    rec([ev(0, { action: 'goto', value: HOME }), ev(1, { role: 'link', name: 'Appears' })]),
    { lease, budget: { stepAttempts: 2 } },
  );
  check('an addressing failure is retried and recovers', addressing.ok,
    addressing.steps.find((s) => !s.ok)?.error ?? '');
  await lease.close();

  submits = 0;
  const dispatched = await replay(
    rec([
      ev(0, { action: 'goto', value: HOME }),
      // Succeeds, then fails its fingerprint check — a retry here would submit twice.
      ev(1, { role: 'link', name: 'Submit', expectedSig: '/never#matches' }),
    ]),
    { budget: { stepAttempts: 3 } },
  );
  check('a DISPATCHED action is never retried — exactly one submit', submits === 1,
    `${submits} submit(s), ${dispatched.steps.length} steps`);

  console.log('\n5. A STUCK RUN HANDS OFF, AND ADOPTS WHAT THE HUMAN REACHED');
  flaky = 0; submits = 0;
  let seenRequest: HandoffRequest | undefined;
  const handed = await replay(
    rec([
      ev(0, { action: 'goto', value: HOME }),
      ev(1, { role: 'link', name: 'Nonexistent' }),
      ev(2, { role: 'link', name: 'Submit' }),
    ]),
    {
      onHandoff: async (request) => {
        seenRequest = request;
        // Stand in for the human: do the thing, out of band.
        await fetch(`${HOME}advance`).catch(() => {});
        return { action: 'adopt', steps: [ev(0, { role: 'link', name: 'Appears' })], url: HOME };
      },
    },
  );
  check('the run continued past the step it could not do', handed.ok,
    handed.steps.map((s) => `${s.seq}:${s.ok ? 'ok' : 'x'}`).join(' '));
  check('the handoff is recorded', handed.handoffs.length === 1, JSON.stringify(handed.handoffs));
  check('the adopted step is marked as NOT executor-run',
    handed.steps.find((s) => s.seq === 1)?.viaHandoff === true);
  check('the following step still ran for real', submits === 1, `${submits} submit(s)`);
  check('the trigger is reported', seenRequest?.trigger === 'step_attempts', seenRequest?.trigger ?? '');

  console.log('\n6. AN UNIMPLEMENTED ACTION ESCALATES, IT DOES NOT JUST DIE');
  let unimplemented: HandoffRequest | undefined;
  await replay(
    rec([ev(0, { action: 'goto', value: HOME }), ev(1, { action: 'dispatch_click', role: 'link', name: 'Submit' })]),
    {
      onHandoff: async (request) => { unimplemented = request; return { action: 'skip' }; },
    },
  );
  check('the trigger names the cause', unimplemented?.trigger === 'unimplemented_action',
    unimplemented?.trigger ?? 'none');

  console.log('\n7. A PURE WAIT IS IMPLEMENTED, NOT DELEGATED');
  flaky = 1;
  let askedToWait = false;
  const waited = await replay(
    rec([
      ev(0, { action: 'goto', value: HOME }),
      ev(1, { action: 'wait_text', value: 'Appears' }),
      ev(2, { action: 'wait_url', value: '127.0.0.1' }),
    ]),
    { onHandoff: async () => { askedToWait = true; return { action: 'skip' }; } },
  );
  check('wait_text and wait_url both run', waited.ok,
    waited.steps.find((s) => !s.ok)?.error ?? '');
  check('nobody was asked to record a wait', !askedToWait);

  console.log('\n8. AN UNRESOLVED SEAM REFUSES, THEN RE-RUNS THE DESTINATION STEP');
  flaky = 0; submits = 0;
  let seamReq: HandoffRequest | undefined;
  const seamed = await replay(
    rec([
      ev(0, { action: 'goto', value: HOME }),
      ev(1, { role: 'link', name: 'Submit', hints: { seamGapBefore: { from: 'a', to: 'b', detail: 'no path' } } }),
    ]),
    {
      onHandoff: async (request) => {
        seamReq = request;
        return { action: 'adopt', steps: [], url: HOME };
      },
    },
  );
  check('the seam is what triggered it', seamReq?.trigger === 'unresolved_seam', seamReq?.trigger ?? '');
  check('the reason names the seam', Boolean(seamReq?.reason.includes('unresolved seam')), seamReq?.reason ?? '');
  check('the destination step then ACTUALLY RAN — the bridge was the gap, not the step',
    submits === 1, `${submits} submit(s)`);
  check('and the run passed', seamed.ok, seamed.steps.find((s) => !s.ok)?.error ?? '');

  console.log('\n9. A CREDENTIAL NEVER REACHES A DECISION PAYLOAD');
  const state = { cookies: [{ name: 'sid', value: 'SUPERSECRET', domain: 'x.test', path: '/' }], origins: [] };
  const file = await saveHandoffSession(state as never, 'run_gate', { url: HOME, sig: '/x#1' });
  check('handoff state is written to its own file', file === handoffPath('run_gate'), file);
  const raw = await readFile(file, 'utf8');
  check('the file does hold the token', raw.includes('SUPERSECRET'));
  const { mode } = await import('node:fs').then((fs) => fs.promises.stat(file));
  check('written 0600 — it is a credential', (mode & 0o777) === 0o600, (mode & 0o777).toString(8));
  await forgetHandoffSession('run_gate');
  check('and it is deleted when the run ends',
    !(await readFile(file, 'utf8').then(() => true).catch(() => false)));

  // THE ACTUAL CLAIM, on the real code path: what reaches a PendingDecision is
  // a PATH, never the state. That payload is written verbatim into
  // context_requests.payload — a JSONB column in a possibly-hosted cluster.
  let seenDecision: Record<string, unknown> | undefined;
  const spy = {
    id: 'spy',
    decompose: async () => [],
    resolve: async (d: { kind: string; context: Record<string, unknown> }) => {
      seenDecision = d.context;
      return { action: 'skip' };
    },
  };
  await handoffToHuman(spy as never, 'app', '__handoffcheck', 'run_gate2', {
    trigger: 'step_attempts',
    seq: 4,
    reason: 'stuck',
    url: HOME,
    sig: '/x#1',
    storageState: state as never,
  });
  const payloadJson = JSON.stringify(seenDecision ?? {});
  check('the decision payload does NOT carry the session token',
    !payloadJson.includes('SUPERSECRET'), payloadJson.slice(0, 90));
  check('it carries the file PATH instead',
    payloadJson.includes('sessionFile'));
  check('and a ready-to-run command for the human',
    payloadJson.includes('--seed-session') && payloadJson.includes('--seed-url'));
  await forgetHandoffSession('run_gate2');

  console.log('\n10. AN ANSWER OF THE WRONG SHAPE IS RE-ASKED, NOT FATAL');
  check('a decompose answer must carry subGoals',
    Boolean(HostAgentReasoner.misfit('gap', { verdicts: [] })));
  check('a good decompose answer passes',
    HostAgentReasoner.misfit('gap', { subGoals: ['a'] }) === undefined);
  check('a needs_capture answer takes a hash',
    HostAgentReasoner.misfit('needs_capture', { recordingHash: 'abc' }) === undefined);
  check("...or an explicit skip",
    HostAgentReasoner.misfit('needs_capture', { action: 'skip' }) === undefined);
  check('but not something unrelated',
    Boolean(HostAgentReasoner.misfit('needs_capture', { subGoals: ['x'] })));

  server.close();
  console.log(failures ? `\n${failures} FAILED\n` : '\nall gates passed\n');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
