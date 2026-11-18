/** The pure parts of flows: destructive check, drift diff, findings, flow ↔ recording. No browser, no database. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destructiveReason, flowDestructiveReason } from '../src/flows/destructive.js';
import { compareToHistory, driftFinding } from '../src/flows/drift.js';
import { extractFindings, stable, routeOf } from '../src/flows/findings.js';
import { slugify, stepsFrom, recordingFrom } from '../src/flows/save.js';
import { buildRecording } from '../src/core/recording.js';
import type { ReplayResult } from '../src/core/replay.js';
import type { Flow } from '../src/store/types.js';

const url = 'https://shop.test/';

test('destructive: only a committing action on a committing control', () => {
  assert.match(destructiveReason({ action: 'click', name: 'Place order', url })!, /commit-shaped/);
  assert.equal(destructiveReason({ action: 'fill', name: 'Confirm password', url }), null, 'typing is not committing');
  assert.equal(destructiveReason({ action: 'click', name: 'Add to cart', url }), null);
  assert.match(destructiveReason({ action: 'click', name: 'Next', url: 'https://checkout.stripe.com/pay' })!, /payment site/);
  assert.match(flowDestructiveReason([{ action: 'click', name: 'Log in', url }, { action: 'click', name: 'Buy now', url }])!, /^step 1:/);
});

test('drift: first run, same path, a new page, and alternating paths', () => {
  const base = ['/login#a', '/shop#b', '/cart#c'];
  assert.equal(compareToHistory(base, []).firstRun, true);
  assert.equal(compareToHistory(base, [base]).changed, false);

  const withPromo = compareToHistory(['/login#a', '/shop#b', '/promo#d', '/cart#c'], [base]);
  assert.deepEqual(withPromo.added, ['/promo#d']);
  assert.deepEqual(withPromo.removed, []);

  // Same page in another state is a state change, not "gone + new".
  const state = compareToHistory(['/login#a', '/shop#b', '/cart#X'], [base]);
  assert.deepEqual(state.stateChanged, ['/cart#X']);
  assert.deepEqual(state.added, []);

  // A path seen recently isn't new just because the very last run differed.
  const alt = ['/login#a', '/shop#b', '/promo#d', '/cart#c'];
  assert.equal(compareToHistory(alt, [base, alt]).changed, false);

  const f = driftFinding('buy-a-thing', withPromo)!;
  assert.equal(f.kind, 'flow_drift');
  assert.equal(driftFinding('buy-a-thing', withPromo)!.fingerprint, f.fingerprint, 'same drift → same fingerprint');
});

test('findings: same defect fingerprints the same across runs', () => {
  assert.equal(stable('order 12345 failed for 9f1c2d3e-1111-2222-3333-444455556666'), 'order :n failed for :uuid');
  assert.equal(routeOf('https://shop.test/orders/123?x=1'), 'https://shop.test/orders/:id');

  const run = (orderId: number): Pick<ReplayResult, 'signals' | 'steps'> => ({
    signals: [
      { kind: 'http', duringStep: 2, text: 'GET 500', status: 500, url: `https://shop.test/orders/${orderId}` },
      { kind: 'http', duringStep: 2, text: 'GET 500', status: 500, url: `https://shop.test/orders/${orderId}` },
      { kind: 'console', duringStep: 3, text: `widget ${orderId}000 crashed` },
    ],
    steps: [{ seq: 4, action: 'click', ok: true, durationMs: 1, unexpectedPage: { expected: '/cart#c', observed: '/promo#d' } }],
  });
  const a = extractFindings(run(1), 'g');
  const b = extractFindings(run(2), 'g');
  assert.deepEqual(a.map((f) => f.kind), ['network_error', 'console_error', 'flow_drift'], 'duplicate 500 counted once');
  assert.equal(a[0]!.severity, 'high');
  assert.deepEqual(a.map((f) => f.fingerprint), b.map((f) => f.fingerprint));
});

test('flow ↔ recording round trip keeps the steps and records what each step saw', () => {
  const recording = buildRecording({ source: 'live', origin: 'test', appSlug: 'shop', startUrl: url }, [
    { seq: 0, ts: 0, action: 'goto', url, resolution: 'synthesized' },
    { seq: 1, ts: 5, action: 'fill', role: 'textbox', name: 'Password', valueRef: 'SECRET.password', url, resolution: 'accname' },
    { seq: 2, ts: 9, action: 'click', role: 'button', name: 'Log in', url, resolution: 'accname' },
  ]);
  const steps = stepsFrom(recording, { steps: [{ seq: 2, action: 'click', ok: true, durationMs: 1, sig: '/shop#b' }] } as ReplayResult);
  assert.equal(steps.length, 3);
  assert.equal('seq' in steps[0]!, false, 'recorder bookkeeping is dropped');
  assert.equal(steps[1]!.valueRef, 'SECRET.password');
  assert.equal('value' in steps[1]!, false, 'no credential appears');
  assert.equal(steps[2]!.expectedSig, '/shop#b');

  const now = new Date();
  const flow = { app: 'shop', slug: 'log-in', startUrl: url, recording: recording.hash, requiresSession: false, steps, updatedAt: now } as Flow;
  const back = recordingFrom(flow);
  assert.deepEqual(back.events.map((e) => [e.seq, e.action, e.name]), recording.events.map((e) => [e.seq, e.action, e.name]));

  assert.equal(slugify('Log in as a Member!'), 'log-in-as-a-member');
});

test('emit: Playwright and Cypress, credentials from the environment, positions kept', async () => {
  const { emitFlow } = await import('../src/flows/emit.js');
  const now = new Date();
  const flow = {
    app: 'shop', slug: 'log-in', title: 'Log in', intent: 'sign in', kind: 'recording', preconditions: [], outcome: '',
    destructive: false, corrections: [], recording: 'x', startUrl: url, requiresSession: false, searchText: '', createdAt: now, updatedAt: now,
    steps: [
      { action: 'goto', value: url, url, resolution: 'synthesized' },
      { action: 'fill', role: 'textbox', name: 'Password', valueRef: 'SECRET.password', url, resolution: 'accname' },
      { action: 'fill', css: 'div.code input', value: '5', hints: { nth: 1 }, url, resolution: 'accname' },
      { action: 'click', testId: 'go', testIdAttr: 'data-test', url, resolution: 'accname' },
    ],
  } as unknown as Flow;

  const pw = emitFlow(flow);
  assert.match(pw.code, /await page\.goto\('https:\/\/shop\.test\/'\);/);
  assert.match(pw.code, /getByRole\('textbox', \{ name: 'Password' \}\)\.fill\(SECRET_PASSWORD\)/);
  assert.match(pw.code, /const SECRET_PASSWORD = process\.env\.SECRET_PASSWORD/);
  assert.match(pw.code, /locator\('div\.code input'\)\.nth\(1\)\.fill\('5'\)/, 'which of several matching boxes is kept');
  assert.match(pw.code, /locator\('\[data-test="go"\]'\)\.click\(\)/);
  assert.deepEqual(pw.requiredValues, ['SECRET.password']);

  const cy = emitFlow(flow, 'cypress-js');
  assert.match(cy.code, /cy\.visit\('https:\/\/shop\.test\/'\);/);
  assert.match(cy.code, /cy\.get\('div\.code input'\)\.eq\(1\)\.type\('5'\)/);
  assert.ok(cy.warnings.some((w) => /Cypress can't express/.test(w)), 'role + name loss is said out loud');
});
