/**
 * Running a recording for real: replay, plus everything around it.
 *
 *   - restore the saved session a late-armed recording needs
 *   - consult lessons before every step, and count them afterwards
 *   - throw away a saved session that turned out to be stale
 *
 * Used by every command that runs something (`replay`, `save`, `run`) and by
 * the MCP server. Throws with a readable message instead of printing, so each
 * caller decides how to show it.
 */

import { loadSession, forgetSession, loadSessionById, forgetSessionById } from '../core/auth-cache.js';
import type { RawRecording } from '../core/recording.js';
import { replay, type ReplayResult } from '../core/replay.js';
import { foldLessons, lessonsFor } from '../memory/notes.js';
import { valuesFromEnv, valueEnvNames } from '../store/settings.js';

export interface ExecuteOptions {
  /** Values for steps that deliberately don't store theirs, e.g. { 'SECRET.password': '…' }. */
  values?: Record<string, string>;
  headed?: boolean;
  /**
   * Consult this app's lessons. Off when proving a brand-new recording, so
   * what gets saved is what the recording does on its own.
   */
  useLessons?: boolean;
}

export interface Executed {
  result: ReplayResult;
  /** Value references the recording needs that weren't supplied. */
  missingValues: string[];
  lessons?: { fired: number; helped: number };
  /** Set when a restored session didn't land where it was saved, and was discarded. */
  staleSession?: { expected: string; observed: string };
  sessionRestoredFrom?: string;
}

export async function execute(recording: RawRecording, opts: ExecuteOptions = {}): Promise<Executed> {
  if (recording.entry?.prelude?.length) {
    throw new Error(
      `this starts after other flows (${recording.entry.prelude.join(' -> ')}), and preludes are parked in the rewrite — ` +
        're-record it with --arm-manually',
    );
  }
  // Login values: given explicitly, else from UNDERSTUDY_<REF> in the environment.
  const refs = new Set(recording.events.map((e) => e.valueRef).filter((r): r is string => Boolean(r)));
  const values = { ...valuesFromEnv(refs, recording.appSlug), ...(opts.values ?? {}) };
  const missingValues = [...refs].filter((r) => !(r in values));
  // Checked BEFORE a browser opens: a run that reached the password step
  // without a password would spend a real login attempt — and some apps lock
  // the account after a few.
  if (missingValues.length) {
    throw new Error(
      `missing login value(s) — nothing was run:\n` +
        missingValues.map((r) => `- ${r}: set ${valueEnvNames(r, recording.appSlug).join(' or ')}, or pass it for this run`).join('\n'),
    );
  }

  // A late-armed recording starts signed in; a cold browser would land on a
  // login page and fail somewhere confusing.
  let storageState;
  let sessionRestoredFrom: string | undefined;
  const sessionId = recording.entry?.session;
  if (recording.entry?.requiresSession) {
    const cached = sessionId ? await loadSessionById(recording.appSlug, sessionId) : await loadSession(recording.appSlug, values);
    if (!cached) {
      throw new Error(
        sessionId
          ? `this starts from the signed-in tab it was recorded in, and that saved session (${sessionId}) is gone or older ` +
              'than 12 hours — record it again from the extension, or start the plan with a flow that logs in'
          : 'this starts from a signed-in browser, and no saved session matches these credentials — pass the same ' +
              '--value credentials it was recorded with, re-record with --arm-manually, or start the plan with a flow that logs in',
      );
    }
    storageState = cached.storageState;
    sessionRestoredFrom = cached.savedAt;
  }

  const app = recording.appSlug;
  const result = await replay(recording, {
    values,
    ...(storageState ? { storageState } : {}),
    ...(opts.headed ? { headless: false } : {}),
    ...(opts.useLessons ? { lessonsFor: (ctx) => lessonsFor(app, ctx) } : {}),
  });

  const out: Executed = { result, missingValues, ...(sessionRestoredFrom ? { sessionRestoredFrom } : {}) };

  // Step 0 of a late-armed recording carries the fingerprint of where it was
  // armed; landing elsewhere means the session expired.
  const entry = result.steps.find((s) => s.seq === 0);
  if (recording.entry?.requiresSession && entry?.unexpectedPage) {
    if (sessionId) await forgetSessionById(app, sessionId);
    else await forgetSession(app, values);
    out.staleSession = entry.unexpectedPage;
  }
  if (opts.useLessons) out.lessons = await foldLessons(app, result.steps, recording.events);
  return out;
}

export interface Proven extends Executed {
  /** The recording as it should be saved: with `requiresSession` set, or its unneeded session dropped. */
  recording: RawRecording;
  /** What proving found out about signing in. */
  signIn: 'not needed' | 'needed' | 'no session to try';
}

/**
 * Prove a recording before saving it, and work out whether it needs to start
 * signed in — so nobody has to be asked.
 *
 * A recording from the Chrome extension carries the tab's session as
 * AVAILABLE (`entry.session`) but not required. Replay it in an empty browser
 * first: if that passes, the flow doesn't need anyone signed in, and the
 * session file is deleted. If it fails, try again with the session; if that
 * passes, the flow starts signed in and keeps it. A session is kept on disk
 * only when a flow actually needs one.
 */
export async function prove(recording: RawRecording, opts: ExecuteOptions = {}): Promise<Proven> {
  const id = recording.entry?.session;
  // Already known to need it (--arm-manually), or nothing to try: one replay.
  if (!id || recording.entry?.requiresSession) {
    return { ...(await execute(recording, opts)), recording, signIn: id || recording.entry?.requiresSession ? 'needed' : 'no session to try' };
  }

  // The same recording without the session: what an empty browser would do.
  const { session: _dropped, ...rest } = recording.entry!;
  const cold: RawRecording = { ...recording };
  if (Object.keys(rest).length) cold.entry = rest;
  else delete cold.entry;
  const first = await execute(cold, opts);
  if (first.result.ok) {
    await forgetSessionById(recording.appSlug, id);
    return { ...first, recording: cold, signIn: 'not needed' };
  }

  const warm = { ...recording, entry: { ...recording.entry, requiresSession: true } };
  const second = await execute(warm, opts);
  if (second.result.ok) return { ...second, recording: warm, signIn: 'needed' };
  // Broken either way: report the cold attempt, and don't keep a session for a broken flow.
  await forgetSessionById(recording.appSlug, id);
  return { ...first, recording: cold, signIn: 'not needed' };
}
