/** The MCP server, spoken to over stdio by a real MCP client — the way Claude Code or Codex would. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureApp, type FixtureApp } from './fixture-app.js';

const DB = 'understudy_test_mcp';
let client: Client;
let shop: FixtureApp;
let recordings: string;

before(async () => {
  shop = await startFixtureApp();
  recordings = await mkdtemp(join(tmpdir(), 'understudy-recordings-'));
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/entry/mcp.ts'],
    env: {
      ...process.env, MONGODB_DB: DB, EMBED_URL: '', EMBED_MODEL: '', EMBED_KEY: '',
      UNDERSTUDY_RECORDINGS_DIR: recordings,
      // A login value from settings, the way a user would set it — never through the chat.
      UNDERSTUDY_SECRET_PASSWORD: 'not-a-real-password',
    } as Record<string, string>,
  }));
});
after(async () => {
  await shop.close();
  await rm(recordings, { recursive: true, force: true });
  process.env.MONGODB_DB = DB;
  const { connect, close } = await import('../src/store/db.js');
  const d = await connect();
  for (const c of await d.listCollections({}, { nameOnly: true }).toArray()) await d.collection(c.name).drop();
  await close();
  await client.close();
});

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

test('nine tools and short instructions — every session pays for them', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'understudy_answer', 'understudy_distill', 'understudy_findings', 'understudy_recall', 'understudy_record',
    'understudy_remember', 'understudy_run', 'understudy_save', 'understudy_save_distilled',
  ]);
  const total = tools.reduce((n, t) => n + (t.description?.length ?? 0) + JSON.stringify(t.inputSchema).length, 0);
  assert.ok(total < 11000, `tool definitions are ${total} chars — keep them lean`);
  const instructions = client.getInstructions() ?? '';
  assert.match(instructions, /Memory first/, 'an npm-installed agent gets the contract on connect');
  assert.ok(instructions.length < 2500, `instructions are ${instructions.length} chars — keep them short`);
});

test('recall on an empty app says it does not know', async () => {
  const r = JSON.parse(text(await client.callTool({ name: 'understudy_recall', arguments: { app: 'nothing', goal: 'log in' } })));
  assert.equal(r.verdict, 'unknown');
});

test('a bad remember batch comes back as a readable error, not a crash', async () => {
  const r = await client.callTool({ name: 'understudy_remember', arguments: { app: 'x', lessons: [{ title: 't', text: 'b', kind: 'wait', trigger: {} }] } });
  assert.equal(r.isError, true);
  assert.match(text(r), /trigger is empty/);
});

test('run without sub-goals asks the decompose question', async () => {
  const r = JSON.parse(text(await client.callTool({ name: 'understudy_run', arguments: { app: 'x', goal: 'buy a thing' } })));
  assert.equal(r.status, 'waiting');
  assert.equal(r.question.kind, 'decompose');
  const next = JSON.parse(text(await client.callTool({ name: 'understudy_answer', arguments: { runId: r.runId, answer: { subGoals: ['buy a thing'] } } })));
  assert.equal(next.status, 'blocked', 'nothing in memory does it — blocked, not guessed');
});

test('ask the user to record, then save it — the whole path over MCP', { timeout: 120_000 }, async () => {
  const started = JSON.parse(text(await client.callTool({ name: 'understudy_record', arguments: { app: 'shop', port: 0 } })));
  assert.equal(started.status, 'waiting for the user');
  assert.ok(started.tellTheUser.some((l: string) => /Record from this page/.test(l)));

  const early = await client.callTool({ name: 'understudy_save', arguments: { app: 'shop', name: 'Open the cart' } });
  assert.equal(early.isError, true);
  assert.match(text(early), /still recording/);

  // Play the extension's side: what it sends while the user clicks through the shop.
  const url = started.listening as string;
  const { token } = await (await fetch(`${url}/hello`)).json();
  const post = (path: string, body: object) => fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify({ token, ...body }) });
  const wire = (action: string, role: string, name: string, extra: object = {}) =>
    ({ seq: 0, stamp: 0, action, url: shop.url, hintRole: role, hintName: name, resolvedBy: 'accname', ...extra });
  await post('/start', { url: shop.url });
  await post('/event', { event: wire('fill', 'textbox', 'Username', { value: 'demo' }) });
  await post('/event', { event: wire('fill', 'textbox', 'Password', { value: 'typed-by-user', inputType: 'password' }) });
  await post('/event', { event: wire('click', 'button', 'Log in') });
  await post('/event', { event: { ...wire('click', 'link', 'Cart'), url: `${shop.url}shop` } });
  await post('/stop', {});
  await new Promise((r) => setTimeout(r, 300));

  const saved = JSON.parse(text(await client.callTool({ name: 'understudy_save', arguments: { app: 'shop', name: 'Open the cart' } })));
  assert.equal(saved.saved, true, JSON.stringify(saved));
  assert.equal(saved.flow, 'open-the-cart');
  assert.equal(saved.steps, 5);
  assert.equal(saved.missingValues, undefined, 'the password came from UNDERSTUDY_SECRET_PASSWORD');

  const recall = JSON.parse(text(await client.callTool({ name: 'understudy_recall', arguments: { app: 'shop', goal: 'open-the-cart' } })));
  assert.equal(recall.verdict, 'known');
});
