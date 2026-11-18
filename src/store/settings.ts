/**
 * Where settings come from — MONGODB_URI, EMBED_*, and login values.
 *
 * Understudy is installed, not cloned, so it can't rely on a .env beside its
 * code. Highest wins:
 *
 *   1. real environment variables       (e.g. the `env` block of an MCP config)
 *   2. --env-file <path>                 on the command line, CLI or MCP server
 *   3. the env file saved with           `understudy config --env-file <path>`
 *   4. .env in the current folder        (handy when developing in the repo)
 *
 * Files never override what's already set, so (1) always wins. Loaded once, on
 * first import, before anything reads process.env.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { config as loadEnvFile } from 'dotenv';

/** ~/.understudy, or UNDERSTUDY_HOME. */
export const HOME = process.env.UNDERSTUDY_HOME ?? join(homedir(), '.understudy');
const CONFIG = join(HOME, 'config.json');

export interface SavedConfig {
  /** An env file to read settings from. */
  envFile?: string;
}

export function readConfig(): SavedConfig {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8')) as SavedConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(cfg: SavedConfig): Promise<string> {
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  await chmod(CONFIG, 0o600).catch(() => {});
  return CONFIG;
}

/** `~/x` → the home folder. Shells expand `~`, but a path in an MCP JSON config arrives as-is. */
export const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

/** `--env-file <path>` or `--env-file=<path>` from argv, if given. */
export function envFileFlag(argv = process.argv): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--env-file') return argv[i + 1] && expandHome(argv[i + 1]!);
    if (a.startsWith('--env-file=')) return expandHome(a.slice('--env-file='.length));
  }
  return undefined;
}

/** Which files were read, in order, so `understudy config` can say. */
export const loadedFrom: string[] = [];

function load() {
  const saved = readConfig().envFile;
  const candidates = [envFileFlag(), saved && expandHome(saved), resolve('.env')].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    loadEnvFile({ path, override: false, quiet: true });
    loadedFrom.push(path);
  }
}

load();

/**
 * The environment variable that holds a login value. A recording never stores
 * passwords; it stores a reference like `SECRET.password`, and the value comes
 * from `UNDERSTUDY_SECRET_PASSWORD` — so nobody has to type it into a command,
 * and an agent never has to see it.
 */
export function valueEnvName(ref: string): string {
  return `UNDERSTUDY_${ref.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase()}`;
}

/**
 * Where a reference's value may be set, in the order they're tried.
 * `ENV.X` came from a script that read `process.env.X`, so `X` itself works too.
 */
export function valueEnvNames(ref: string): string[] {
  const names = [valueEnvName(ref)];
  if (ref.startsWith('ENV.')) names.push(ref.slice(4));
  return names;
}

/** Values for these references found in the environment. */
export function valuesFromEnv(refs: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ref of refs) {
    const name = valueEnvNames(ref).find((n) => process.env[n] !== undefined);
    if (name) out[ref] = process.env[name]!;
  }
  return out;
}
