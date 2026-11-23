import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stable, extractFindings } from '../src/flows/findings.js';
import { excerpt } from '../src/core/replay.js';

test('normalising keeps addresses, versions and ports; ids still collapse', () => {
  assert.equal(stable('Failed to fetch (127.0.0.1:8080) for order 48213'), 'Failed to fetch (127.0.0.1:8080) for order :n');
  assert.equal(stable('v1.2.300 on 10.0.0.255'), 'v1.2.300 on 10.0.0.255');
  assert.equal(stable('http://localhost:3000/orders'), 'http://localhost:3000/orders');
});

test('a finding shows the message as it was; console warnings are not findings', () => {
  const drafts = extractFindings({
    steps: [],
    signals: [
      { kind: 'console', level: 'error', duringStep: 1, text: 'Error fetching notifications: TypeError: Failed to fetch (127.0.0.1:8080) id 48213' },
      { kind: 'console', level: 'warning', duringStep: 1, text: 'Image with src "/a.png" has either width or height modified, but not the other.' },
    ],
  }, 'g');
  assert.equal(drafts.length, 1, 'the warning is not a finding');
  assert.equal(drafts[0]!.statement, 'Error fetching notifications: TypeError: Failed to fetch (127.0.0.1:8080) id 48213');
});

test('excerpt: a window around the expected words, not the start of the page', () => {
  const page = `${'{"@context":"https://schema.org","@type":"Organization"} '.repeat(5)} Dashboard Total Transactions 9 This month $1,200 Footer`;
  const shown = excerpt(page, 'Total Transactions 10', 60);
  assert.match(shown, /Total Transactions 9/);
  assert.ok(shown.startsWith('…'));
  assert.equal(excerpt('short text', 'x'), 'short text');
});
