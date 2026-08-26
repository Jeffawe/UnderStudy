/**
 * Saved browser sessions, keyed by the credentials that produced them.
 *
 * THE PROBLEM THIS SOLVES IS MEASURED, NOT THEORETICAL. Every replay does a
 * cold login and `distill` replays again, so verify-then-ingest costs 2–3
 * logins per recording — against an app that locks the account for 15 minutes
 * after a handful of attempts (REASONER.md, "Logins are often rate limited").
 * A restored session skips the login entirely.
 *
 * IT IS A CACHE, NEVER A SUBSTITUTE FOR PROOF. A saved session may satisfy a
 * PRELUDE — the part we deliberately did not record — and must never satisfy
 * the steps under verification. If a recording's own steps are the login, they
 * have to run, or ingest "proves" a flow it never executed. Callers enforce
 * that by choosing what to pass `storageState` to; nothing here can.
 *
 * ON DISK, NOT IN THE DATABASE. `storageState` holds live session cookies and
 * tokens — a credential in every meaningful sense. A gitignored local file at
 * 0600 is a materially smaller blast radius than a row in a cloud cluster, and
 * follows the same reasoning that already keeps `.understudy/recordings/` out
 * of git.
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrowserContext } from 'playwright';

export const SESSIONS_DIR =
  process.env.UNDERSTUDY_SESSIONS_DIR ?? resolve('.understudy/sessions');

/**
 * How long a saved session is worth trying at all.
 *
 * A cheap pre-filter, not the real check — `sessionIsLive` is what actually
 * decides. This only avoids launching a browser around state that is certainly
 * dead. Deliberately shorter than a typical "remember me" cookie: the cost of
 * being wrong is one extra login, and the cost of being right is nothing.
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Playwright's storageState payload. Opaque to us — we store and replay it. */
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export interface CachedSession {
  version: 1;
  appSlug: string;
  /** The credential fingerprint this session belongs to. */
  key: string;
  savedAt: string;
  /**
   * The page fingerprint observed when this session was saved.
   *
   * This is the staleness oracle. An expired session does not announce itself —
   * the app simply serves the login page at a URL that used to be the account
   * page, which is exactly the case `sig()` exists to distinguish and a URL
   * check cannot (REASONER: `/inventory.html` served the login page when
   * unauthenticated).
   */
  expectedSig?: string;
  storageState: StorageState;
}

/**
 * Fingerprint the credentials a session was established with.
 *
 * KEYED ON ALL SUPPLIED VALUES, deliberately. Narrowing this to the refs that
 * "look like" credentials would be a heuristic, and the two failure directions
 * are wildly asymmetric: an over-broad key costs one unnecessary login, while a
 * key missing a component that actually distinguishes two users hands you
 * SOMEONE ELSE'S SESSION. So it fails toward fragmentation.
 *
 * Only the hash is ever written down — the values themselves are customer data
 * on a real app, and the point of `valueRef` is that they never reach disk.
 */
export function authKey(
  appSlug: string,
  values: Record<string, string>,
  prelude: string[] = [],
): string | undefined {
  const refs = Object.keys(values).sort();
  // Nothing to key on. A session shared by every credential-free run would be
  // indistinguishable from "whoever logged in last", which is not a cache.
  if (!refs.length) return undefined;

  const material = refs.map((ref) => `${ref}=${values[ref]}`).join('\n');

  // THE PRELUDE IS PART OF THE KEY, for the same fail-toward-fragmentation
  // reason the credentials are. A session banked after `--after complete-intake`
  // holds a browser that is mid-wizard; a plain `--arm-manually` run for the
  // same credentials would restore it and land somewhere the operator never
  // asked to be. Keyed separately, that is a cache miss and one honest login.
  // Empty prelude appends nothing, so every key written before this existed is
  // unchanged.
  const salt = prelude.length ? `\nprelude=${prelude.join('>')}` : '';
  return createHash('sha256').update(`${appSlug}\n${material}${salt}`).digest('hex').slice(0, 16);
}

export function sessionPath(appSlug: string, key: string): string {
  return join(SESSIONS_DIR, `${appSlug}-${key}.json`);
}

/**
 * Load the session saved for these exact credentials, if one is still worth
 * trying. Age is the only thing checked here; liveness needs a browser.
 */
export async function loadSession(
  appSlug: string,
  values: Record<string, string>,
  prelude?: string[],
): Promise<CachedSession | undefined> {
  const key = authKey(appSlug, values, prelude);
  if (!key) return undefined;

  const path = sessionPath(appSlug, key);
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CachedSession;
    if (parsed.version !== 1) return undefined;
    if (Date.now() - Date.parse(parsed.savedAt) > MAX_AGE_MS) return undefined;
    return parsed;
  } catch {
    // A corrupt cache entry is not an error worth stopping for — the fallback
    // is logging in, which is what would have happened anyway.
    return undefined;
  }
}

/**
 * Save the context's current session under these credentials.
 *
 * Returns the path so the caller can SAY where it went. Writing live tokens to
 * disk silently would be the wrong kind of convenience.
 */
export async function saveSession(
  context: BrowserContext,
  appSlug: string,
  values: Record<string, string>,
  expectedSig?: string,
  prelude?: string[],
): Promise<string | undefined> {
  const key = authKey(appSlug, values, prelude);
  if (!key) return undefined;

  const state = await context.storageState();

  await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  const path = sessionPath(appSlug, key);
  const entry: CachedSession = {
    version: 1,
    appSlug,
    key,
    savedAt: new Date().toISOString(),
    ...(expectedSig ? { expectedSig } : {}),
    storageState: state,
  };

  await writeFile(path, JSON.stringify(entry, null, 2), { encoding: 'utf8', mode: 0o600 });
  // `writeFile`'s mode applies only when it CREATES the file, so an entry
  // written before this line existed would keep its old permissions forever.
  // Setting them explicitly makes the guarantee hold on every save.
  await chmod(path, 0o600).catch(() => {});
  return path;
}

/**
 * Drop a saved session once it proves stale.
 *
 * There is no `isSessionLive` here on purpose. Liveness is already answered by
 * machinery that exists: a late-armed recording carries the arming fingerprint
 * as step 0's `expectedSig`, so replay's ordinary "am I where I expected to
 * be?" check reports a dead session as an unexpected page. A second, private
 * probe would be a duplicate oracle that could disagree with the first.
 */
export async function forgetSession(
  appSlug: string,
  values: Record<string, string>,
  prelude?: string[],
): Promise<void> {
  const key = authKey(appSlug, values, prelude);
  if (!key) return;
  await unlink(sessionPath(appSlug, key)).catch(() => {});
}

/**
 * Park a paused run's browser state so a human can pick it up in another window.
 *
 * SEPARATE FROM THE CREDENTIAL CACHE, and keyed by RUN rather than by
 * credentials, because it is not a cache: it is a one-shot handover of a
 * specific paused browser, valid only until that run finishes. Reusing the
 * credential key would let a handoff overwrite the session cache with a
 * mid-flow state, which is the cross-contamination the prelude salt exists to
 * prevent.
 *
 * The PATH is what gets handed to the reasoner, never the state. `storageState`
 * holds live tokens, and `context_requests.payload` is a JSONB column in a
 * cluster that may be hosted — a credential must not make that trip.
 */
export async function saveHandoffSession(
  storageState: StorageState,
  runId: string,
  meta: { url: string; sig?: string },
): Promise<string> {
  await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  const path = handoffPath(runId);
  const payload = {
    version: 1 as const,
    runId,
    savedAt: new Date().toISOString(),
    url: meta.url,
    ...(meta.sig ? { sig: meta.sig } : {}),
    storageState,
  };
  await writeFile(path, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return path;
}

export interface HandoffSession {
  version: 1;
  runId: string;
  savedAt: string;
  url: string;
  sig?: string;
  storageState: StorageState;
}

export function handoffPath(runId: string): string {
  return join(SESSIONS_DIR, `handoff-${runId}.json`);
}

export async function loadHandoffSession(path: string): Promise<HandoffSession | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as HandoffSession;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Handoff state is one-shot; leaving live tokens on disk after the run is not. */
export async function forgetHandoffSession(runId: string): Promise<void> {
  await unlink(handoffPath(runId)).catch(() => {});
}
