/** The MCP server, spoken to over stdio by a real MCP client — the way Claude Code or Codex would. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DB = 'understudy_test_mcp';
let client: Client;

before(async () => {
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/entry/mcp.ts'],
    env: { ...process.env, MONGODB_DB: DB, EMBED_URL: '', EMBED_MODEL: '' } as Record<string, string>,
  }));
});
after(async () => {
  process.env.MONGODB_DB = DB;
  const { connect, close } = await import('../src/store/db.js');
  const d = await connect();
  for (const c of await d.listCollections({}, { nameOnly: true }).toArray()) await d.collection(c.name).drop();
  await close();
  await client.close();
});

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

test('seven tools, each with a short description', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'understudy_answer', 'understudy_distill', 'understudy_findings', 'understudy_recall',
    'understudy_remember', 'understudy_run', 'understudy_save_distilled',
  ]);
  // Every session pays for these, whether or not it uses them.
  const total = tools.reduce((n, t) => n + (t.description?.length ?? 0) + JSON.stringify(t.inputSchema).length, 0);
  assert.ok(total < 9000, `tool definitions are ${total} chars — keep them lean`);
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
