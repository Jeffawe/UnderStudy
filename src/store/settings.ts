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

/** The per-app variable: `UNDERSTUDY_SHOP_USER_EMAIL` for app `shop`, ref `USER.email`. */
export function appValueEnvName(app: string, ref: string): string {
  return valueEnvName(`${app}.${ref}`);
}

/**
 * Where a reference's value may be set, in the order they're tried: the
 * per-app variable first (so two apps can use different test accounts), then
 * the shared one. `ENV.X` came from a script that read `process.env.X`, so `X`
 * itself works too.
 */
export function valueEnvNames(ref: string, app?: string): string[] {
  const names = [...(app ? [appValueEnvName(app, ref)] : []), valueEnvName(ref)];
  if (ref.startsWith('ENV.')) names.push(ref.slice(4));
  return names;
}

/** Values for these references found in the environment. */
export function valuesFromEnv(refs: Iterable<string>, app?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ref of refs) {
    const name = valueEnvNames(ref, app).find((n) => process.env[n] !== undefined);
    if (name) out[ref] = process.env[name]!;
  }
  return out;
}

/** The env file Understudy writes to: the one given with --env-file, else the saved one, else ~/.understudy/understudy.env. */
export function writableEnvFile(): string {
  return envFileFlag() ?? (readConfig().envFile && expandHome(readConfig().envFile!)) ?? join(HOME, 'understudy.env');
}

/**
 * Quote a value so dotenv reads it back EXACTLY. dotenv doesn't undo escapes
 * like \" — a password with quotes in it would come back mangled — so pick a
 * quote character the value doesn't contain: single quotes are fully literal.
 */
export function envFileQuote(key: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${key}: values can't contain line breaks`);
  for (const q of ["'", '"', '`']) {
    if (!value.includes(q)) return q + value + q;
  }
  throw new Error(`${key}: the value contains ', " and \` — put it in the env file by hand, or set it in the environment`);
}

/**
 * Write KEY=value lines into the env file (replacing a key already there),
 * readable only by you, and apply them to this process too. If no env file was
 * chosen yet, ~/.understudy/understudy.env becomes the saved one.
 */
export async function writeEnvValues(pairs: Record<string, string>): Promise<string> {
  const file = writableEnvFile();
  const cfg = readConfig();
  if (!envFileFlag() && !cfg.envFile) await writeConfig({ ...cfg, envFile: file });
  await mkdir(HOME, { recursive: true, mode: 0o700 }).catch(() => {});
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  for (const [key, value] of Object.entries(pairs)) {
    const line = `${key}=${envFileQuote(key, value)}`;
    const at = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (at >= 0) lines[at] = line;
    else lines.push(line);
    process.env[key] = value;
  }
  await writeFile(file, lines.filter((l, i) => l || i < lines.length - 1).join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return file;
}
