/**
 * Where raw recordings live on disk.
 *
 * Recordings are keyed by their content hash, which makes this the
 * distillation cache BUILDING.md asks for on day one: distilling is the expensive
 * step, and re-recording the same flow produces the same hash, so the model is
 * paid for once. Two captures of genuinely different flows differ in hash and
 * are stored side by side.
 *
 * Mode A eventually mirrors these to S3; Mode B keeps them local. Nothing here
 * knows which — it is just a directory.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RawRecording } from './recording.js';
import { HOME } from '../store/settings.js';

/**
 * Under ~/.understudy (or UNDERSTUDY_HOME), NOT the current folder. It used to
 * be `./.understudy/recordings`, so the MCP server — started by an agent from
 * inside some repo — wrote recordings there, and the CLI run from anywhere
 * else said "no recordings yet" about a flow saved a minute earlier.
 */
export const RECORDINGS_DIR = process.env.UNDERSTUDY_RECORDINGS_DIR ?? join(HOME, 'recordings');

/** Where recordings went before, read (never written) so old hashes still load. */
const LEGACY_DIR = resolve('.understudy/recordings');
const legacyDirs = () => (process.env.UNDERSTUDY_RECORDINGS_DIR || LEGACY_DIR === RECORDINGS_DIR ? [] : [LEGACY_DIR]);

export function recordingPath(hash: string): string {
  const path = join(RECORDINGS_DIR, `${hash}.json`);
  if (existsSync(path)) return path;
  const old = legacyDirs().map((d) => join(d, `${hash}.json`)).find(existsSync);
  return old ?? path;
}

/**
 * Write a recording, keyed by hash.
 *
 * Returns `existed: true` when this exact recording is already on disk — the
 * caller can then skip distillation entirely rather than paying for it again.
 */
export async function saveRecording(
  rec: RawRecording,
): Promise<{ path: string; existed: boolean }> {
  await mkdir(RECORDINGS_DIR, { recursive: true });
  const path = join(RECORDINGS_DIR, `${rec.hash}.json`);
  const existed = existsSync(path);
  await writeFile(path, JSON.stringify(rec, null, 2), 'utf8');
  return { path, existed };
}

export async function loadRecording(hashOrPath: string): Promise<RawRecording> {
  const path = hashOrPath.endsWith('.json') ? hashOrPath : recordingPath(hashOrPath);
  const parsed = JSON.parse(await readFile(path, 'utf8')) as RawRecording;

  if (parsed.version !== 1) {
    throw new Error(`recording ${path} is version ${parsed.version}, this build reads version 1`);
  }
  return parsed;
}

export interface RecordingSummary {
  hash: string;
  appSlug: string;
  source: RawRecording['source'];
  events: number;
  createdAt: string;
}

export async function listRecordings(appSlug?: string): Promise<RecordingSummary[]> {
  const files: string[] = [];
  for (const dir of [RECORDINGS_DIR, ...legacyDirs()]) {
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) if (f.endsWith('.json')) files.push(join(dir, f));
  }
  const out: RecordingSummary[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    try {
      const rec = await loadRecording(file);
      if (appSlug && rec.appSlug !== appSlug) continue;
      if (seen.has(rec.hash)) continue;
      seen.add(rec.hash);
      out.push({
        hash: rec.hash,
        appSlug: rec.appSlug,
        source: rec.source,
        events: rec.events.length,
        createdAt: rec.createdAt,
      });
    } catch {
      // A corrupt or half-written file shouldn't hide every other recording.
    }
  }

  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
