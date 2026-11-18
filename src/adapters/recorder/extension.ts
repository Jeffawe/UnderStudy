/**
 * Recording from the Chrome extension: record in the browser you already have
 * open, on the tab you're already on.
 *
 * `understudy record <app> --extension` starts this tiny local server; the
 * extension (extension/ in the repo) finds it, and while you record, sends
 * each action here. Nothing about the page is stored by the extension itself.
 *
 *   GET  /hello   → { app, token }   which recording is waiting, and its token
 *   POST /start   { token, url, storageState? }
 *   POST /event   { token, event }   one action, as the in-page recorder saw it
 *   POST /stop    { token }
 *
 * SAFETY. It listens on 127.0.0.1 only. The token is random per recording and
 * only handed to Chrome extensions: a web page can send requests to localhost,
 * but the browser won't let it READ /hello's answer (no CORS header for web
 * origins), so it can never learn the token, so it can't inject steps.
 *
 * If you start recording on a signed-in tab, the extension sends that site's
 * cookies and local storage, saved here as a session file (0600, gitignored,
 * same as --arm-manually sessions) so replay can start signed in too.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { saveSessionById, type StorageState } from '../../core/auth-cache.js';
import { buildRecording, type RawEvent, type RawRecording, type RecordingEntry } from '../../core/recording.js';
import { toRawEvent, type WireEvent } from './wire.js';

export const DEFAULT_PORT = 7397;

export interface ExtensionRecorder {
  /** Where it's listening. */
  url: string;
  /** Resolves when the extension says stop (or `stop()` is called). */
  done: Promise<ExtensionRecording>;
  /** Stop from this side, keeping whatever was recorded (e.g. on Ctrl+C). */
  stop(): void;
}

export interface ExtensionRecording {
  recording: RawRecording;
  /** False if the extension never started recording. */
  started: boolean;
  /** File uploads seen but not recordable — the page can't say which file. */
  droppedUploads: number;
  /** Where the signed-in session was saved, if one was. */
  sessionPath?: string;
}

const isExtensionOrigin = (origin: string | undefined) => !!origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 5_000_000) throw new Error('request too large');
  }
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
}

export async function startExtensionRecorder(opts: { appSlug: string; port?: number; startUrl?: string }): Promise<ExtensionRecorder> {
  const token = randomBytes(18).toString('base64url');
  const events: RawEvent[] = [];
  let startedAt = 0;
  let started = false;
  let startUrl = opts.startUrl ?? '';
  let entry: RecordingEntry | undefined;
  let sessionPath: string | undefined;
  let droppedUploads = 0;
  let finish!: () => void;
  const stopped = new Promise<void>((r) => (finish = r));

  const reply = (res: ServerResponse, origin: string | undefined, status: number, data: unknown) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      // Only an extension may read the answer — this is what keeps the token secret.
      ...(isExtensionOrigin(origin) ? { 'access-control-allow-origin': origin!, 'access-control-allow-headers': 'content-type' } : {}),
    });
    res.end(JSON.stringify(data));
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    try {
      if (req.method === 'OPTIONS') return reply(res, origin, 204, {});
      // A web page has its own origin; refuse anything that isn't an extension.
      if (origin && !isExtensionOrigin(origin)) return reply(res, origin, 403, { error: 'only the Understudy extension may talk to this' });
      const path = new URL(req.url ?? '/', 'http://x').pathname;

      if (req.method === 'GET' && path === '/hello') return reply(res, origin, 200, { app: opts.appSlug, token, started });

      if (req.method !== 'POST') return reply(res, origin, 404, { error: 'not found' });
      const b = await body(req);
      if (b.token !== token) return reply(res, origin, 401, { error: 'wrong token — start a new recording from the extension' });

      if (path === '/start') {
        if (started) return reply(res, origin, 409, { error: 'already recording' });
        startUrl = String(b.url);
        startedAt = Date.now();
        started = true;
        if (b.storageState) {
          const id = `ext-${randomBytes(6).toString('hex')}`;
          sessionPath = await saveSessionById(opts.appSlug, id, b.storageState as StorageState);
          entry = { requiresSession: true, session: id };
        }
        // Step 0: replay opens the page recording started on.
        events.push({ seq: 0, ts: 0, action: 'goto', value: startUrl, url: startUrl, resolution: 'script-literal' });
        return reply(res, origin, 200, { ok: true });
      }

      if (path === '/event') {
        if (!started) return reply(res, origin, 409, { error: 'not recording' });
        const wire = b.event as WireEvent;
        // The page can count the files on an upload but never say which ones,
        // so an upload can't be replayed. Dropped and reported, never faked.
        if (wire.action === 'upload') {
          droppedUploads++;
          return reply(res, origin, 200, { ok: true, dropped: 'upload' });
        }
        events.push(toRawEvent(wire, Date.now() - startedAt));
        return reply(res, origin, 200, { ok: true });
      }

      if (path === '/stop') {
        reply(res, origin, 200, { ok: true, events: events.length });
        finish();
        return;
      }
      return reply(res, origin, 404, { error: 'not found' });
    } catch (e) {
      return reply(res, origin, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_PORT, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  const done = stopped.then(async (): Promise<ExtensionRecording> => {
    await new Promise<void>((r) => server.close(() => r()));
    const ordered = events.slice().sort((a, b) => a.ts - b.ts).map((e, i) => ({ ...e, seq: i }));
    const recording = buildRecording(
      { source: 'live', origin: 'chrome-extension', appSlug: opts.appSlug, startUrl, ...(entry ? { entry } : {}) },
      ordered,
    );
    return { recording, started, droppedUploads, ...(sessionPath ? { sessionPath } : {}) };
  });

  return { url: `http://127.0.0.1:${port}`, done, stop: finish };
}
