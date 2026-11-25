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
let home: string;

before(async () => {
  shop = await startFixtureApp();
  recordings = await mkdtemp(join(tmpdir(), 'understudy-recordings-'));
  home = await mkdtemp(join(tmpdir(), 'understudy-home-'));
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/entry/mcp.ts'],
    env: {
      ...process.env, MONGODB_DB: DB, EMBED_URL: '', EMBED_MODEL: '', EMBED_KEY: '',
      UNDERSTUDY_RECORDINGS_DIR: recordings,
      UNDERSTUDY_HOME: home, // anything it writes to an env file goes here, not your real one
      // A login value from settings, the way a user would set it — never through the chat.
      UNDERSTUDY_SECRET_PASSWORD: 'not-a-real-password',
      // An agent's own script reads its own variable; that works too.
      AGENT_SHOP_PASSWORD: 'also-not-real',
      // A run with a step for a person opens a visible browser; not in a test.
      UNDERSTUDY_HEADLESS: '1',
    } as Record<string, string>,
  }));
});
after(async () => {
  await shop.close();
  await rm(recordings, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  process.env.MONGODB_DB = DB;
  const { connect, close } = await import('../src/store/db.js');
  const d = await connect();
  for (const c of await d.listCollections({}, { nameOnly: true }).toArray()) await d.collection(c.name).drop();
  await close();
  await client.close();
});

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

test('eleven tools and short instructions — every session pays for them', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'understudy_answer', 'understudy_app', 'understudy_calibrate', 'understudy_distill', 'understudy_findings', 'understudy_recall', 'understudy_record',
    'understudy_remember', 'understudy_run', 'understudy_save', 'understudy_save_distilled',
  ]);
  const total = tools.reduce((n, t) => n + (t.description?.length ?? 0) + JSON.stringify(t.inputSchema).length, 0);
  assert.ok(total < 11000, `tool definitions are ${total} chars — keep them lean`);
  const instructions = client.getInstructions() ?? '';
  assert.match(instructions, /Start with understudy_recall/, 'an agent is told where to start');
  assert.ok(instructions.length < 300, `instructions are ${instructions.length} chars — every session pays for them; put the rest on a tool`);
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

test('a goal on an app with no flows says so, instead of asking how to plan it', async () => {
  const r = JSON.parse(text(await client.callTool({ name: 'understudy_run', arguments: { app: 'x', goal: 'buy a thing' } })));
  assert.equal(r.status, 'blocked');
  assert.match(r.why, /no saved flows yet/);
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

test('an agent saves a flow it drove itself, as a script — proven, and marked as made by an agent', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'understudy-agent-script-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const good = join(dir, 'profile.spec.ts');
    await writeFile(good, `import { test } from '@playwright/test';
test('view the profile', async ({ page }) => {
  await page.goto('${shop.url}');
  await page.getByRole('textbox', { name: 'Username' }).fill('demo');
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.AGENT_SHOP_PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('link', { name: 'Profile' }).click();
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
  await expect(page.getByRole('list')).toHaveCount(2);
});`);
    const saved = JSON.parse(text(await client.callTool({ name: 'understudy_save', arguments: { app: 'shop', name: 'View the profile', script: good } })));
    assert.equal(saved.saved, true, JSON.stringify(saved));
    assert.equal(saved.madeBy, 'agent');
    assert.equal(saved.steps, 6, 'the visibility check is a step');
    assert.ok((await import('node:fs')).existsSync(saved.recordingFile), 'says where the recording is');
    assert.equal(saved.droppedAssertions.length, 1, 'the check it could not keep is reported');
    assert.match(saved.droppedAssertions[0], /toHaveCount/);

    const recall = JSON.parse(text(await client.callTool({ name: 'understudy_recall', arguments: { app: 'shop', goal: 'view-the-profile' } })));
    assert.equal(recall.best.madeBy, 'agent');
    assert.deepEqual(recall.needs, [{ placeholder: 'ENV.AGENT_SHOP_PASSWORD', readFrom: ['UNDERSTUDY_SHOP_ENV_AGENT_SHOP_PASSWORD', 'UNDERSTUDY_ENV_AGENT_SHOP_PASSWORD', 'AGENT_SHOP_PASSWORD'], set: true }]);

    // A step that can't be replayed is refused outright, not saved with a hole in it.
    const bad = join(dir, 'bad.spec.ts');
    await writeFile(bad, `import { test } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('${shop.url}');
  await page.evaluate(() => localStorage.clear());
  await page.getByRole('button', { name: 'Log in' }).click();
});`);
    const refused = await client.callTool({ name: 'understudy_save', arguments: { app: 'shop', name: 'Bad', script: bad } });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /can't be replayed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an agent turns on email placeholders; a flow saved afterwards keeps its address out of memory', { timeout: 120_000 }, async () => {
  const set = JSON.parse(text(await client.callTool({ name: 'understudy_app', arguments: { app: 'shop', placeholders: ['email'] } })));
  assert.deepEqual(set.placeholders, ['email']);
  const shown = JSON.parse(text(await client.callTool({ name: 'understudy_app', arguments: { app: 'shop' } })));
  assert.deepEqual(shown.placeholders, ['email']);

  const dir = await mkdtemp(join(tmpdir(), 'understudy-agent-script-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const script = join(dir, 'with-email.spec.ts');
    // The shop ignores what's typed as the username — an email works as well as 'demo'.
    await writeFile(script, `import { test } from '@playwright/test';
test('log in by email', async ({ page }) => {
  await page.goto('${shop.url}');
  await page.getByRole('textbox', { name: 'Username' }).fill('tester@shop.test');
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.AGENT_SHOP_PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
});`);
    const saved = JSON.parse(text(await client.callTool({ name: 'understudy_save', arguments: { app: 'shop', name: 'Log in by email', script } })));
    assert.equal(saved.saved, true, JSON.stringify(saved));
    assert.equal(saved.placeholders?.[0]?.placeholder, 'USER.email', 'converted after it was proven');

    const recall = JSON.parse(text(await client.callTool({ name: 'understudy_recall', arguments: { app: 'shop', goal: 'log-in-by-email' } })));
    assert.equal(JSON.stringify(recall).includes('tester@shop.test'), false, 'the address is no longer in memory');
    assert.ok(recall.needs.some((n: { placeholder: string; set: boolean }) => n.placeholder === 'USER.email' && n.set), 'and replay can find it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an agent can skip the replay with verify: false — saved, but recall says it is unproven', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'understudy-agent-noverify-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const script = join(dir, 'missing.spec.ts');
    // Would fail a replay: the shop has no such link. Skipping the replay keeps it anyway.
    await writeFile(script, `import { test } from '@playwright/test';
test('open help', async ({ page }) => {
  await page.goto('${shop.url}');
  await page.getByRole('link', { name: 'Help' }).click();
});`);
    const saved = JSON.parse(text(await client.callTool({
      name: 'understudy_save',
      arguments: { app: 'shop', name: 'Open help', script, verify: false, note: 'help link is behind a feature flag' },
    })));
    assert.equal(saved.saved, true, JSON.stringify(saved));
    assert.equal(saved.replayed, false);
    assert.ok(saved.unproven, 'the answer says so');
    const recall = JSON.parse(text(await client.callTool({ name: 'understudy_recall', arguments: { app: 'shop', goal: 'open-help' } })));
    assert.equal(recall.best.proven, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing login value: nothing runs, the agent is told which line goes in which file, and a retry after the user adds it works', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'understudy-agent-missing-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const script = join(dir, 'late.spec.ts');
    await writeFile(script, `import { test } from '@playwright/test';
test('log in late', async ({ page }) => {
  await page.goto('${shop.url}');
  await page.getByRole('textbox', { name: 'Username' }).fill('demo');
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.MCP_LATE_PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
});`);
    const first = await client.callTool({ name: 'understudy_save', arguments: { app: 'shop', name: 'Log in late', script } });
    assert.notEqual(first.isError, true, 'an answer to act on, not an error');
    const r = JSON.parse(text(first));
    assert.equal(r.saved, false);
    assert.equal(r.ran, false);
    assert.deepEqual(r.missingLoginValues, [{ placeholder: 'ENV.MCP_LATE_PASSWORD', setOneOf: ['UNDERSTUDY_SHOP_ENV_MCP_LATE_PASSWORD', 'UNDERSTUDY_ENV_MCP_LATE_PASSWORD', 'MCP_LATE_PASSWORD'] }]);
    assert.equal(r.envFile, join(home, 'understudy.env'));
    assert.match(r.next, /never to paste it into chat/);
    assert.ok(r.retry.hash);

    // The user adds the line to the file; the running server picks it up.
    await writeFile(r.envFile, "UNDERSTUDY_SHOP_ENV_MCP_LATE_PASSWORD='not-a-real-password'\n");
    const again = JSON.parse(text(await client.callTool({ name: 'understudy_save', arguments: { app: 'shop', name: 'Log in late', hash: r.retry.hash } })));
    assert.equal(again.saved, true, JSON.stringify(again));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an agent proves an unproven flow by running it: understudy_run with the flow as the one sub-goal', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'understudy-agent-prove-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const script = join(dir, 'cart.spec.ts');
    await writeFile(script, `import { test } from '@playwright/test';
test('see the cart', async ({ page }) => {
  await page.goto('${shop.url}');
  await page.getByRole('textbox', { name: 'Username' }).fill('demo');
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.AGENT_SHOP_PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('link', { name: 'Cart' }).click();
});`);
    const saved = JSON.parse(text(await client.callTool({ name: 'understudy_save', arguments: { app: 'shop', name: 'See the cart', script, verify: false } })));
    assert.ok(saved.unproven);
    assert.match(saved.proveIt, /subGoals \["see-the-cart"\]/, 'the answer says how to prove it');
    const ran = JSON.parse(text(await client.callTool({ name: 'understudy_run', arguments: { app: 'shop', goal: 'see the cart', subGoals: ['see-the-cart'] } })));
    assert.equal(ran.status, 'passed', JSON.stringify(ran));
    assert.deepEqual(ran.nowProven, ['see-the-cart']);
    const recall = JSON.parse(text(await client.callTool({ name: 'understudy_recall', arguments: { app: 'shop', goal: 'see-the-cart' } })));
    assert.equal(recall.best.proven, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a step only a person can do: saved from human(), the run asks mid-way, and finishes once they say it is done', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'understudy-agent-human-'));
  shop.set({ approved: false });
  try {
    const { writeFile } = await import('node:fs/promises');
    const script = join(dir, 'visit.spec.ts');
    await writeFile(script, `import { test, expect } from '@playwright/test';
test('wait for the visit', async ({ page }) => {
  await page.goto('${shop.url}approval');
  human('Accept the visit in the provider portal', { untilText: 'Visit accepted' });
  await expect(page.getByRole('heading', { name: 'Visit accepted' })).toBeVisible();
});`);
    const saved = JSON.parse(text(await client.callTool({ name: 'understudy_save', arguments: { app: 'shop', name: 'Have the provider accept the visit', script } })));
    assert.equal(saved.saved, true, JSON.stringify(saved));
    assert.equal(saved.provenUpTo, 1, 'proven up to the person\'s step; nobody was asked while saving');

    const ran = JSON.parse(text(await client.callTool({ name: 'understudy_run', arguments: { app: 'shop', goal: 'visit accepted', subGoals: ['have-the-provider-accept-the-visit'] } })));
    assert.equal(ran.status, 'waiting', JSON.stringify(ran));
    assert.equal(ran.question.kind, 'human');
    assert.equal(ran.question.ask, 'Accept the visit in the provider portal');

    const bad = await client.callTool({ name: 'understudy_answer', arguments: { runId: ran.runId, answer: { ok: 'sure' } } });
    assert.equal(bad.isError, true, 'a non-answer is refused, and the run keeps waiting');

    shop.set({ approved: true }); // the person does it
    const done = JSON.parse(text(await client.callTool({ name: 'understudy_answer', arguments: { runId: ran.runId, answer: { done: true } } })));
    assert.equal(done.status, 'passed', JSON.stringify(done));
    assert.equal(done.doneByAPerson.length, 1);
    assert.deepEqual(done.nowProven, ['have-the-provider-accept-the-visit'], 'a full pass proves the rest');
  } finally {
    shop.set({ approved: false });
    await rm(dir, { recursive: true, force: true });
  }
});
