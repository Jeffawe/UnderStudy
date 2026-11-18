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
  const values = opts.values ?? {};
  const missingValues = [...new Set(recording.events.filter((e) => e.valueRef && !(e.valueRef in values)).map((e) => e.valueRef!))];

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
