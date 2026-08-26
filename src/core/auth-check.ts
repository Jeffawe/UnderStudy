/**
 * Gates for the session cache and late-armed capture.
 *
 * SAFE TO RUN — unlike `explore:check`, this deletes nothing. It writes one
 * session under the reserved slug `__authcheck` and removes it again.
 *
 * Gate 1 is the one that matters. Recordings already exist on disk, and their
 * hash is the distillation cache key — a change to `recordingHash` orphans
 * every one of them from work that was paid for, silently, with nothing
 * reporting it. It is checked against the real corpus rather than a fixture
 * precisely because a fixture would have been written after the change.
 */

import { readdir, readFile, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { chromium } from 'playwright';
import { recordingHash, type RawRecording } from './recording.js';
import { RECORDINGS_DIR } from './recording-store.js';
import { authKey, loadSession, saveSession, sessionPath } from './auth-cache.js';
import { recordLive } from '../adapters/recorder/live.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  console.log('\n1. EXISTING RECORDINGS KEEP THEIR HASH');
  const files = (await readdir(RECORDINGS_DIR).catch(() => [])).filter((f) => f.endsWith('.json'));
  const drifted: string[] = [];
  for (const f of files) {
    const rec = JSON.parse(await readFile(`${RECORDINGS_DIR}/${f}`, 'utf8')) as RawRecording;
    if (recordingHash(rec.events, rec.entry) !== rec.hash) drifted.push(f);
  }
  check(`${files.length} on-disk recordings rehash to their stored hash`, !drifted.length, drifted.join(', '));

  console.log('\n2. THE ENTRY CONDITION IS PART OF THE KEY');
  const events: RawEventList = [
    { seq: 0, ts: 0, action: 'goto', value: 'https://x.test/inbox', url: 'https://x.test/inbox', resolution: 'script-literal' },
    { seq: 1, ts: 5, action: 'click', role: 'button', name: 'Send', url: 'https://x.test/inbox', resolution: 'accname' },
  ];
  const cold = recordingHash(events);
  const warm = recordingHash(events, { requiresSession: true });
  check('same steps, different entry condition -> different hash', cold !== warm, `${cold.slice(0, 12)} vs ${warm.slice(0, 12)}`);
  check('no entry condition hashes exactly as it always did', recordingHash(events, {}) === cold);
  check(
    'startState does NOT move the hash — cosmetic drift must not orphan a cache entry',
    recordingHash(events, { requiresSession: true, startState: '/inbox#aaaa1111' }) === warm,
  );

  // A prelude is a DECLARATION about how to reach step 0, so it keys like
  // requiresSession and unlike startState. Without this, the same tail captured
  // after a login and after a login-plus-intake collide, and saveRecording
  // silently keeps whichever landed first.
  const afterLogin = recordingHash(events, { prelude: ['log-in'] });
  const afterIntake = recordingHash(events, { prelude: ['log-in', 'complete-intake'] });
  check('a prelude moves the hash', afterLogin !== cold, `${afterLogin.slice(0, 12)} vs ${cold.slice(0, 12)}`);
  check('a longer prelude is a different recording', afterLogin !== afterIntake);
  check(
    'prelude ORDER matters — a different order is a different journey',
    recordingHash(events, { prelude: ['complete-intake', 'log-in'] }) !== afterIntake,
  );
  check('an empty prelude hashes as no prelude at all', recordingHash(events, { prelude: [] }) === cold);
  check(
    'prelude and requiresSession compose without colliding',
    recordingHash(events, { requiresSession: true, prelude: ['log-in'] }) !== afterLogin,
  );

  console.log('\n3. THE SESSION KEY');
  const jo = { 'MEMBER.email': 'jo@x.test', 'SECRET.password': 'hunter2' };
  const joReordered = { 'SECRET.password': 'hunter2', 'MEMBER.email': 'jo@x.test' };
  const sam = { 'MEMBER.email': 'sam@x.test', 'SECRET.password': 'hunter2' };
  check('stable regardless of key order', authKey('app', jo) === authKey('app', joReordered));
  check('a different user is a different session', authKey('app', jo) !== authKey('app', sam));
  check('a different app is a different session', authKey('app', jo) !== authKey('other', jo));
  check('no credentials -> no key, so nothing is cached', authKey('app', {}) === undefined);
  check('the raw credential never appears in the key', !authKey('app', jo)!.includes('hunter2'));

  console.log('\n4. SAVE / LOAD ROUND TRIP');
  const browser = await chromium.launch();
  const context = await browser.newContext();
  // A cookie, not localStorage: `data:` and `about:blank` have no storage
  // origin, and a session cookie is the thing that actually carries a login
  // anyway.
  await context.addCookies([
    { name: 'sid', value: 'abc123', domain: 'x.test', path: '/', httpOnly: true },
  ]);

  const saved = await saveSession(context, '__authcheck', jo, '/inbox#deadbeef');
  check('saveSession wrote a file', Boolean(saved));

  const back = await loadSession('__authcheck', jo);
  check('loads for the same credentials', Boolean(back));
  check('carries the staleness baseline', back?.expectedSig === '/inbox#deadbeef');
  check('misses for different credentials', (await loadSession('__authcheck', sam)) === undefined);
  check(
    'the session payload actually round trips',
    back?.storageState.cookies?.some((c) => c.name === 'sid' && c.value === 'abc123') === true,
  );

  // The restored session must survive into a NEW context, which is the only
  // thing replay and the recorder ever do with it.
  const restored = await browser.newContext({ storageState: back!.storageState });
  const cookies = await restored.cookies('https://x.test/');
  check('restores into a fresh context', cookies.some((c) => c.name === 'sid'));
  await restored.close();

  const mode = saved ? (statSync(saved).mode & 0o777).toString(8) : '';
  check('stored 0600 — it holds live session tokens', mode === '600', `mode ${mode}`);

  await browser.close();
  await rm(sessionPath('__authcheck', authKey('__authcheck', jo)!), { force: true });

  console.log('\n5. LATE ARMING DROPS THE JOURNEY, KEEPS THE TAIL');
  // The whole point of the change: clicking "Before" is how you get to the
  // starting point, and it must not end up in the recording.
  const page1 = 'data:text/html,<title>P</title><main><button>Before</button><button>After</button></main>';
  const rec = await recordLive({
    appSlug: '__authcheck',
    startUrl: page1,
    armWhen: async (p) => {
      await p.getByRole('button', { name: 'Before' }).click();
      await p.waitForTimeout(150);
    },
    drive: async (p) => {
      await p.getByRole('button', { name: 'After' }).click();
    },
  });

  const names = rec.events.map((e) => `${e.action}:${e.name ?? ''}`);
  check('the pre-arm click is not in the recording', !names.some((n) => n.includes('Before')), names.join(' '));
  check('the post-arm click is', names.some((n) => n.includes('After')), names.join(' '));
  check('step 0 is a goto to where capture armed', rec.events[0]?.action === 'goto');
  check('the entry condition records where it armed', Boolean(rec.entry?.startState), rec.entry?.startState ?? '');
  check(
    'no session involved -> requiresSession is not claimed',
    rec.entry?.requiresSession === undefined,
  );

  console.log('\n6. A PRELUDE IS WALKED, NOT RECORDED');
  // The prelude case, without a database: `beforeArm` drives the journey and
  // capture must arm only afterwards. This is the mechanism `record --after`
  // rides on — a prelude is a journey driven programmatically instead of by a
  // human, and the SAME gate has to drop it.
  const preludePage =
    'data:text/html,<title>Q</title><main><button>Prelude</button><button>Tail</button></main>';
  const withPrelude = await recordLive({
    appSlug: '__authcheck',
    startUrl: preludePage,
    beforeArm: async (lease) => {
      await lease.page.goto(preludePage, { waitUntil: 'domcontentloaded' });
      await lease.page.getByRole('button', { name: 'Prelude' }).click();
      await lease.page.waitForTimeout(150);
    },
    preludeSlugs: ['walk-the-prelude'],
    drive: async (p) => {
      await p.getByRole('button', { name: 'Tail' }).click();
    },
  });

  const pnames = withPrelude.events.map((e) => `${e.action}:${e.name ?? ''}`);
  check('the prelude click is not in the recording', !pnames.some((n) => n.includes('Prelude')), pnames.join(' '));
  check('the tail click is', pnames.some((n) => n.includes('Tail')), pnames.join(' '));
  check('step 0 is a goto to where the prelude finished', withPrelude.events[0]?.action === 'goto');
  check(
    'the prelude is declared BY REFERENCE on the entry condition',
    JSON.stringify(withPrelude.entry?.prelude) === JSON.stringify(['walk-the-prelude']),
    JSON.stringify(withPrelude.entry?.prelude),
  );
  check(
    'the referenced slugs are NOT inlined as steps',
    !withPrelude.events.some((e) => e.name === 'Prelude'),
  );

  console.log(failures ? `\n${failures} FAILED\n` : '\nall gates passed\n');
  process.exit(failures ? 1 : 0);
}

type RawEventList = RawRecording['events'];

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
