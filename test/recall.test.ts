/** recall's verdict rule and word matching. The meaning cases are real scores from the 2026-11-18 calibration. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, wordScore, MEANING, WORDS } from '../src/memory/recall.js';

// Scores are from a real calibration; the goals are reworded generically.
test('meaning: real goals from the calibration land on the right side', () => {
  // [top score, runner-up] for goals the corpus DOES know — all must run.
  const known: [string, number, number][] = [
    ['sign in', 0.73, 0.633],
    ['log into my account', 0.756, 0.619],
    ['where should we deliver', 0.755, 0.61],
    ['calculate my order total', 0.776, 0.686],
    ['choose a subscription plan', 0.884, 0.862], // strong, even though the next is close
  ];
  for (const [goal, a, b] of known) assert.equal(judge([a, b], MEANING).verdict, 'known', goal);

  // Goals the corpus does NOT know, that still land near something. None may run.
  const unknown: [string, number, number][] = [
    ['download my invoices', 0.735, 0.709], // scores higher than "sign in" — the margin catches it
    ['message support', 0.72, 0.696],
    ['reorder my last purchase', 0.684, 0.683],
    ['change my password', 0.668, 0.636],
  ];
  for (const [goal, a, b] of unknown) assert.notEqual(judge([a, b], MEANING).verdict, 'known', goal);
});

test('meaning: edge cases', () => {
  assert.equal(judge([], MEANING).verdict, 'unknown');
  assert.equal(judge([0.75], MEANING).verdict, 'unsure', 'one flow and no runner-up: only a strong match counts');
  assert.equal(judge([0.8], MEANING).verdict, 'known');
  assert.equal(judge([0.6, 0.3], MEANING).verdict, 'unknown');
});

test('words: share of the goal found in the flow', () => {
  const cart = { slug: 'open-the-cart', title: 'Open the cart', intent: 'Open the cart' };
  assert.equal(wordScore('open the cart', cart), 1);
  assert.equal(wordScore('open cart', cart), 1, 'little words ignored');
  assert.equal(wordScore('open the basket', cart), 0.5);
  assert.equal(wordScore('change password', cart), 0);
  assert.equal(judge([1, 0.5], WORDS).verdict, 'known');
  assert.equal(judge([0.5], WORDS).verdict, 'unknown');
});
