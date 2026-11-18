/**
 * Keeping more typed values out of memory, per app.
 *
 * Passwords are always placeholders. An app can also choose `email`: every
 * email field in its flows stops storing the address it was recorded with and
 * uses a placeholder instead — `USER.email`, read from the user's env file —
 * so a test account can be swapped per run and personal data doesn't sit in a
 * (possibly shared) database.
 *
 * Turning it on converts the app's existing flows and MOVES each address into
 * the env file, so nothing breaks and nothing needs setting up. New flows are
 * converted when they're saved, after they've been proven with the real value.
 *
 * Several different addresses in one app (several test accounts) each get
 * their own placeholder — the most used is USER.email, then USER.email_2 … —
 * because merging them would quietly log some flows in as the wrong account.
 */

import { collections } from '../store/db.js';
import { appValueEnvName, valueEnvName, writeEnvValues } from '../store/settings.js';
import { PLACEHOLDER_KINDS, type PlaceholderKind, type Step } from '../store/types.js';

const EMAIL_IN_NAME = /e-?mail/i;
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Is this a step that types an email address the recording stored as-is? */
export function isEmailStep(s: Step): boolean {
  if (s.action !== 'fill' || s.valueRef || !s.value) return false;
  const named = [s.name, s.testId, s.css].some((x) => x && EMAIL_IN_NAME.test(x));
  return named || s.hints?.inputType === 'email' || LOOKS_LIKE_EMAIL.test(s.value);
}

export interface Applied {
  app: string;
  placeholders: PlaceholderKind[];
  /** Each placeholder, the flows now using it, and where its value lives. */
  converted: { placeholder: string; flows: string[]; valueIn: string }[];
  /** The env file values were written to, if any were. */
  envFile?: string;
}

/** The app's chosen kinds (validated). */
export async function appPlaceholders(app: string): Promise<PlaceholderKind[]> {
  const { apps } = await collections();
  return (await apps.findOne({ slug: app }))?.placeholders ?? [];
}

/** Choose which kinds of value an app keeps as placeholders, and apply it to its flows now. */
export async function setPlaceholders(app: string, kinds: string[]): Promise<Applied> {
  const bad = kinds.filter((k) => !(PLACEHOLDER_KINDS as readonly string[]).includes(k));
  if (bad.length) throw new Error(`unknown placeholder kind(s): ${bad.join(', ')} — available: ${PLACEHOLDER_KINDS.join(', ')}`);
  const { apps, flows } = await collections();
  if (!(await flows.findOne({ app })) && !(await apps.findOne({ slug: app }))) throw new Error(`no app '${app}' — save a flow for it first`);
  const chosen = [...new Set(kinds)] as PlaceholderKind[];
  await apps.updateOne(
    { slug: app },
    { $set: { placeholders: chosen }, $setOnInsert: { slug: app, name: app, urls: {}, createdAt: new Date() } },
    { upsert: true },
  );
  return applyPlaceholders(app, chosen);
}

/**
 * Convert the app's flows (or just `onlyFlow`) to placeholders for the chosen
 * kinds, moving each value into the env file unless the environment already has it.
 */
export async function applyPlaceholders(app: string, kinds?: PlaceholderKind[], onlyFlow?: string): Promise<Applied> {
  const chosen = kinds ?? (await appPlaceholders(app));
  const out: Applied = { app, placeholders: chosen, converted: [] };
  if (!chosen.includes('email')) return out;

  const { flows } = await collections();
  const all = await flows.find({ app }).toArray();
  const targets = onlyFlow ? all.filter((f) => f.slug === onlyFlow) : all;

  // Which addresses these flows type, most-used first. (An address that was
  // moved before keeps its placeholder: found below by its value.)
  const uses = new Map<string, number>();
  for (const f of targets) for (const s of f.steps) if (isEmailStep(s)) uses.set(s.value!, (uses.get(s.value!) ?? 0) + 1);
  if (!uses.size) return out;

  const env = process.env;
  const refFor = new Map<string, string>();
  const write: Record<string, string> = {};
  const where = new Map<string, string>();

  // An address already moved earlier keeps its placeholder: find it by value.
  const takenRefs = new Set<string>();
  for (const f of all) for (const s of f.steps) if (s.valueRef?.startsWith('USER.email')) takenRefs.add(s.valueRef);
  for (const ref of takenRefs) {
    for (const name of [appValueEnvName(app, ref), valueEnvName(ref)]) {
      const v = env[name];
      if (v !== undefined && uses.has(v) && !refFor.has(v)) {
        refFor.set(v, ref);
        where.set(ref, name);
      }
    }
  }

  let n = 1;
  const nextRef = () => {
    for (;;) {
      const ref = n === 1 ? 'USER.email' : `USER.email_${n}`;
      n++;
      if (!takenRefs.has(ref)) return ref;
    }
  };
  for (const value of [...uses.keys()].sort((a, b) => uses.get(b)! - uses.get(a)!)) {
    if (refFor.has(value)) continue;
    const ref = nextRef();
    refFor.set(value, ref);
    takenRefs.add(ref);
    // The shared variable if it's free (or already this address); otherwise this
    // app's own, so two apps can use different accounts.
    const shared = valueEnvName(ref);
    const own = appValueEnvName(app, ref);
    if (env[own] === value) where.set(ref, own);
    else if (env[shared] === value || (env[shared] === undefined && write[shared] === undefined)) {
      where.set(ref, shared);
      if (env[shared] === undefined) write[shared] = value;
    } else {
      where.set(ref, own);
      write[own] = value;
    }
  }

  if (Object.keys(write).length) out.envFile = await writeEnvValues(write);

  const flowsUsing = new Map<string, Set<string>>();
  for (const f of targets) {
    let changed = false;
    const steps: Step[] = f.steps.map((s) => {
      if (!isEmailStep(s)) return s;
      const ref = refFor.get(s.value!)!;
      const { value: _gone, ...rest } = s;
      changed = true;
      (flowsUsing.get(ref) ?? flowsUsing.set(ref, new Set()).get(ref)!).add(f.slug);
      return { ...rest, valueRef: ref };
    });
    if (changed) await flows.updateOne({ _id: f._id! }, { $set: { steps, updatedAt: new Date() } });
  }

  out.converted = [...flowsUsing.entries()].map(([placeholder, slugs]) => ({
    placeholder, flows: [...slugs].sort(), valueIn: where.get(placeholder)!,
  }));
  return out;
}

