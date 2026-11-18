/** Where settings come from, and in what order — each case in a fresh process, as an installed Understudy would start. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { valueEnvName } from '../src/store/settings.js';

const SETTINGS = resolve('src/store/settings.ts');
/** The tsx loader, by absolute URL — the child processes run from temp folders where `tsx` can't be found by name. */
const TSX = import.meta.resolve('tsx');

/** Load settings in a clean process (no MONGODB_URI inherited), from `cwd`, and report what it saw. */
function settingsIn(cwd: string, home: string, args: string[] = [], env: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MONGODB_|EMBED_|UNDERSTUDY_)/.test(k)));
  const out = execFileSync(process.execPath, [
    '--import', TSX, '--input-type=module', '-e',
    `const s = await import(${JSON.stringify(SETTINGS)}); console.log(JSON.stringify({ uri: process.env.MONGODB_URI ?? null, pw: process.env.UNDERSTUDY_SECRET_PASSWORD ?? null, from: s.loadedFrom }));`,
    '--', ...args,
  ], { cwd, env: { ...clean, UNDERSTUDY_HOME: home, ...env } }).toString();
  return JSON.parse(out) as { uri: string | null; pw: string | null; from: string[] };
}

test('environment > --env-file > saved env file > ./.env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'understudy-settings-'));
  try {
    const home = join(dir, 'home');
    const cwd = join(dir, 'project');
    await (await import('node:fs/promises')).mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, '.env'), 'MONGODB_URI=from-dot-env\n');
    assert.equal(settingsIn(cwd, home).uri, 'from-dot-env', 'with nothing else, ./.env');

    await (await import('node:fs/promises')).mkdir(home, { recursive: true });
    await writeFile(join(home, 'saved.env'), 'MONGODB_URI=from-saved\n');
    await writeFile(join(home, 'config.json'), JSON.stringify({ envFile: join(home, 'saved.env') }));
    assert.equal(settingsIn(cwd, home).uri, 'from-saved', 'the saved env file beats ./.env');

    await writeFile(join(dir, 'flag.env'), 'MONGODB_URI=from-flag\n');
    assert.equal(settingsIn(cwd, home, ['--env-file', join(dir, 'flag.env')]).uri, 'from-flag', '--env-file beats the saved file');
    assert.equal(settingsIn(cwd, home, [`--env-file=${join(dir, 'flag.env')}`]).uri, 'from-flag');

    assert.equal(settingsIn(cwd, home, ['--env-file', join(dir, 'flag.env')], { MONGODB_URI: 'from-env' }).uri, 'from-env', 'the real environment beats every file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a password with quotes survives `config set` and comes back intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'understudy-settings-'));
  try {
    const home = join(dir, 'home');
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MONGODB_|EMBED_|UNDERSTUDY_)/.test(k)));
    const tricky = 'p@ss "w$rd" \\ end';
    execFileSync(process.execPath, ['--import', TSX, resolve('src/entry/cli.ts'), 'config', 'set', `UNDERSTUDY_SECRET_PASSWORD=${tricky}`],
      { cwd: dir, env: { ...clean, UNDERSTUDY_HOME: home } });
    assert.equal(settingsIn(dir, home).pw, tricky);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a leading ~ means the home folder, even from a JSON config', async () => {
  const { expandHome } = await import('../src/store/settings.js');
  const { homedir } = await import('node:os');
  assert.equal(expandHome('~/x/understudy.env'), join(homedir(), 'x/understudy.env'));
  assert.equal(expandHome('/abs/path.env'), '/abs/path.env');
});

test('login values are read from UNDERSTUDY_<REF>', () => {
  assert.equal(valueEnvName('SECRET.password'), 'UNDERSTUDY_SECRET_PASSWORD');
  assert.equal(valueEnvName('MEMBER.email'), 'UNDERSTUDY_MEMBER_EMAIL');
});
