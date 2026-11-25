/**
 * Script source — turn an existing Playwright script into a RawRecording.
 *
 * Handles both `playwright codegen` output and hand-written `.spec.ts` suites,
 * because they are the same thing: codegen just produces an unusually regular
 * subset. This is what makes the input side open — a team with an existing
 * suite can import it without recording anything by hand.
 *
 * WHY A REAL AST, NOT REGEX:
 * codegen output is regular enough to regex, but hand-written tests are not —
 * chains split across lines, strings contain parentheses, comments contain
 * code-shaped text, and TypeScript syntax sits in the middle of it. The
 * TypeScript compiler is already a dependency and parses all of that correctly.
 *
 * WHY STATIC PARSING RATHER THAN EXECUTION:
 * running someone's suite needs their fixtures, auth, environment and a live
 * app. Reading it needs none of those. The tradeoff is that a static read
 * cannot know runtime values or which page it is on — see `url` below.
 *
 * A DELIBERATE WIN: a non-literal argument becomes a `valueRef` rather than a
 * value. `page.getByRole('textbox', {name: 'Email'}).fill(MEMBER.email)`
 * records `valueRef: 'MEMBER.email'` — which is exactly the parameterised shape
 * the IR wants, arrived at for free.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import ts from 'typescript';
import {
  buildRecording,
  redactValue,
  type RawEvent,
  type RawRecording,
  type RecordedAction,
} from '../../core/recording.js';

/** Playwright locator factories we understand, and what each contributes. */
type LocatorBit = {
  role?: string;
  name?: TextMatch;
  exact?: boolean;
  css?: string;
  testId?: string;
  frameHint?: string;
  nth?: number;
  /** `.filter({hasText})` — narrows the bit it follows. */
  hasText?: TextMatch;
  /** A filter form the IR can't express, reported rather than dropped. */
  unsupported?: string;
  /**
   * Which Playwright lookup found the name, when it wasn't plain text.
   * `getByPlaceholder('Email')` and `getByText('Email')` find different
   * elements — an input has no text — so replay must use the same lookup.
   */
  by?: NameLookup;
};

/** The name-based lookups other than text, as stored in `hints.by`. */
export type NameLookup = 'placeholder' | 'label' | 'title' | 'alt';

const NAME_LOOKUPS: Record<string, NameLookup | undefined> = {
  getByPlaceholder: 'placeholder',
  getByLabel: 'label',
  getByTitle: 'title',
  getByAltText: 'alt',
  getByText: undefined,
};

/**
 * Playwright's assertions and waits that a recording keeps, and what each
 * becomes. They are the point of an end-to-end test — without them a flow only
 * checks that what it clicks exists — so they used to be dropped in silence,
 * which was the worst outcome. One the IR can't express is now reported.
 *
 *   expect(page).toHaveURL(x) / page.waitForURL(x)   → wait_url
 *   expect(page).toHaveTitle(x)                       → assert title
 *   expect(locator).toBeVisible()                     → assert visible
 *   expect(locator).toBeHidden() / not.toBeVisible()  → assert hidden
 *   expect(locator).toHaveText(x)                     → assert text (whole text)
 *   expect(locator).toContainText(x)                  → assert contains
 *   expect(locator).toHaveValue(x)                    → assert value
 *   expect(locator).toBeChecked() / not.toBeChecked() → assert checked / unchecked
 *   page.waitForSelector(css)                         → assert visible
 */
export const KEPT_ASSERTIONS = [
  'toHaveURL', 'toHaveTitle', 'toBeVisible', 'toBeHidden', 'toHaveText',
  'toContainText', 'toHaveValue', 'toBeChecked', 'waitForURL', 'waitForSelector',
] as const;

/** What an `assert` step checks, in `hints.assert`. */
export type AssertKind = 'visible' | 'hidden' | 'text' | 'contains' | 'value' | 'checked' | 'unchecked' | 'title';

/** Waits that need nothing kept: replay already settles the page after every step. */
const SETTLING_WAITS = new Set(['waitForLoadState', 'waitForNavigation']);

/** Terminal calls that are actions rather than refinements. */
const ACTIONS: Record<string, RecordedAction> = {
  click: 'click',
  dblclick: 'click',
  fill: 'fill',
  type: 'fill',
  press: 'press',
  check: 'check',
  uncheck: 'uncheck',
  selectOption: 'select',
  setInputFiles: 'upload',
  goto: 'goto',
  // Playwright's own name for "scroll whatever container holds this until it
  // is visible". Chosen as the capture form over a raw
  // `evaluate(el => el.scrollTop = el.scrollHeight)` deliberately: it is
  // element-addressed, so it fits the role/name/css model the rest of the IR
  // uses, and importing it needs no evaluation of arbitrary page script.
  scrollIntoViewIfNeeded: 'scroll_container',
};

/**
 * Calls that mean "take a picture here".
 *
 * `toHaveScreenshot` is Playwright's own; the rest are the wrapper names teams
 * put around it — a suite almost always has one, because the raw assertion
 * needs the same masking and options at every call site. Add yours here.
 */
const SNAPSHOT_CALLS = new Set(['toHaveScreenshot', 'checkpoint', 'visualCheckpoint', 'snapshot']);

/**
 * Calls that DO something to the page but that the IR cannot express.
 *
 * These exist to be warned about, not to be mapped. An unmapped call used to
 * fall through the walk in silence, which is the worst possible outcome: the
 * import "succeeds", the step count looks plausible, and the recording is
 * quietly missing a step the flow depends on. That is exactly how one spec's
 * `page.evaluate` scroll — the thing that unlocked its submit button —
 * disappeared between a spec that passes and a recording that cannot.
 *
 * A missing step must cost a warning, every time.
 */
const UNEXPRESSIBLE = new Set([
  'evaluate', 'evaluateHandle', '$eval', '$$eval',
  'dispatchEvent', 'hover', 'dragTo', 'focus', 'blur', 'tap',
  'setChecked', 'clear', 'selectText', 'waitForTimeout', 'waitForFunction',
  'addStyleTag', 'addScriptTag', 'route', 'unroute',
]);

/**
 * Recognise the one `evaluate` shape worth reading rather than warning about:
 * scrolling a nested pane to an edge.
 *
 * Deliberately narrow. This matches on SOURCE TEXT, which is a heuristic and
 * not a parse, so it only claims a call when both halves are unambiguous — a
 * `querySelector` with a literal argument, and an assignment to `scrollTop`.
 * Anything else falls through to the warning, because guessing at arbitrary
 * page script is how you get a recording that lies.
 *
 * Worth special-casing because a scroll gate is not exotic: any "review your
 * answers before submitting" screen has one, and without this the whole tail of
 * such a flow is uncapturable.
 */
function scrollContainerFrom(node: ts.CallExpression): { css: string; edge: 'bottom' | 'top' } | undefined {
  const body = node.arguments.map((a) => a.getText()).join(' ');
  if (!/\.scrollTop\s*=/.test(body)) return undefined;

  const css = body.match(/querySelector(?:All)?\(\s*['"`]([^'"`]+)['"`]\s*\)/)?.[1];
  if (!css) return undefined;

  // `= el.scrollHeight` means bottom; `= 0` means top. Anything else is a
  // partial scroll the IR has no way to say, so leave it to the warning.
  if (/\.scrollTop\s*=\s*[^;]*scrollHeight/.test(body)) return { css, edge: 'bottom' };
  if (/\.scrollTop\s*=\s*0\b/.test(body)) return { css, edge: 'top' };
  return undefined;
}

export interface ParsedScript {
  recording: RawRecording;
  /** Calls that looked like Playwright actions but could not be mapped. */
  warnings: string[];
  /**
   * Assertions and waits that were NOT kept. Not fatal — the flow still
   * replays — but the flow checks less than the script did, and the caller
   * must be told so rather than find out by opening the recording.
   */
  dropped: string[];
}

const text = (node: ts.Node): string | undefined =>
  ts.isStringLiteralLike(node) ? node.text : undefined;

/** Join a possibly-relative spec URL onto the app's base URL. */
function absolute(url: string, base: string): string {
  try {
    return new URL(url, base).toString();
  } catch {
    // An unparseable base is not worth failing the whole import over; the
    // literal at least records what the spec said.
    return url;
  }
}

/**
 * Resolve a file path a spec passes to setInputFiles.
 *
 * Specs write these relative to the repo they run in ('tests/fixtures/x.png'),
 * because that is where Playwright's cwd is. Understudy replays from its own
 * directory, so storing the literal produced ENOENT on every upload step. Walk
 * up from the spec file until the path resolves — that finds the repo root
 * without needing to know how the other project is laid out.
 */
function resolveFixture(value: string, specPath: string): string {
  if (isAbsolute(value)) return value;
  let dir = dirname(specPath);
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, value);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Not found anywhere: keep the literal so the failure names what the spec
  // asked for rather than a path this function invented.
  return value;
}

/**
 * A text constraint, which Playwright lets you write either way.
 *
 * `{ name: 'Sign in' }` and `{ name: /^Sign in$/ }` mean different things — the
 * first is a substring match, the second is anchored — so the regex-ness has to
 * survive into the IR rather than being flattened to its source text.
 */
export interface TextMatch {
  source: string;
  regex: boolean;
  flags: string;
}

function textMatch(node: ts.Node | undefined): TextMatch | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return { source: node.text, regex: false, flags: '' };
  if (ts.isRegularExpressionLiteral(node)) {
    // getText() is the literal as written, e.g. `/^No$/i`.
    const raw = node.getText();
    const close = raw.lastIndexOf('/');
    return { source: raw.slice(1, close), regex: true, flags: raw.slice(close + 1) };
  }
  return undefined;
}

/**
 * Read `{ name: 'Login', exact: true }`.
 * Only literal properties are useful; a computed name can't be known statically.
 */
function readOptions(node: ts.Node | undefined): { name?: TextMatch; exact?: boolean } {
  if (!node || !ts.isObjectLiteralExpression(node)) return {};
  const out: { name?: TextMatch; exact?: boolean } = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    if (prop.name.text === 'name') {
      const match = textMatch(prop.initializer);
      if (match !== undefined) out.name = match;
    }
    if (prop.name.text === 'exact') {
      out.exact = prop.initializer.kind === ts.SyntaxKind.TrueKeyword;
    }
  }
  return out;
}

/**
 * Read `.filter({ hasText: ... })`.
 *
 * THIS IS ADDRESSING, NOT DECORATION. `filter` used to be treated as a
 * refinement "that doesn't change which element we're addressing", which is
 * exactly backwards: `page.locator('label').filter({hasText: 'I accept'})`
 * narrows every label on the page down to one. Dropping it turned a precise
 * locator into `css=label` — and silently, with no warning, so the recording
 * looked clean and would have clicked whatever label happened to be first.
 *
 * `has` / `hasNot` take a Locator rather than text and cannot be represented in
 * the IR, so they are reported instead of quietly ignored.
 */
function readFilter(node: ts.Node | undefined): { hasText?: TextMatch; unsupported?: string } {
  if (!node || !ts.isObjectLiteralExpression(node)) return {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const key = prop.name.text;
    if (key === 'hasText') {
      const match = textMatch(prop.initializer);
      if (match) return { hasText: match };
      return { unsupported: 'filter({hasText}) with a non-literal value' };
    }
    if (key === 'has' || key === 'hasNot' || key === 'hasNotText') {
      return { unsupported: `filter({${key}})` };
    }
  }
  return {};
}

/** What one link in a locator chain contributes to addressing the element. */
function locatorBit(method: string, args: readonly ts.Expression[]): LocatorBit | undefined {
  const first = args[0];
  switch (method) {
    case 'getByRole': {
      const role = first ? text(first) : undefined;
      const { name, exact } = readOptions(args[1]);
      return role ? { role, ...(name !== undefined ? { name } : {}), ...(exact ? { exact } : {}) } : undefined;
    }
    // The lookup is KEPT, not flattened to text: `getByPlaceholder('Email')`
    // replayed as `getByText('Email')` can never match an input, which has no
    // text. See LocatorBit.by.
    case 'getByPlaceholder':
    case 'getByLabel':
    case 'getByText':
    case 'getByTitle':
    case 'getByAltText': {
      const name = textMatch(first);
      const { exact } = readOptions(args[1]);
      const by = NAME_LOOKUPS[method];
      return name !== undefined ? { name, ...(exact ? { exact } : {}), ...(by ? { by } : {}) } : undefined;
    }
    case 'getByTestId': {
      const id = first ? text(first) : undefined;
      return id !== undefined ? { testId: id } : undefined;
    }
    case 'locator': {
      const css = first ? text(first) : undefined;
      return css !== undefined ? { css } : undefined;
    }
    case 'frameLocator': {
      const frame = first ? text(first) : undefined;
      // Suffix match, never exact — iframe ids are frequently generated.
      return frame !== undefined ? { frameHint: frame.replace(/^#/, '') } : undefined;
    }
    case 'first':
      return { nth: 0 };
    case 'last':
      return { nth: -1 };
    case 'nth': {
      const n = first && ts.isNumericLiteral(first) ? Number(first.text) : undefined;
      return n !== undefined ? { nth: n } : undefined;
    }
    // NOT a no-op — see readFilter. This is what narrows `locator('label')`
    // from every label on the page down to the one that says "I accept".
    case 'filter': {
      const { hasText, unsupported } = readFilter(first);
      return {
        ...(hasText ? { hasText } : {}),
        ...(unsupported ? { unsupported } : {}),
      };
    }
    // These genuinely don't narrow by anything the IR can express.
    case 'and':
    case 'or':
      return {};
    default:
      return undefined;
  }
}

/**
 * Read an action's argument as either a literal value or a reference.
 *
 * `fill('standard_user')`             → value
 * `fill(MEMBER.email)`                → valueRef 'MEMBER.email'  ← already the IR shape
 * `fill(process.env.SHOP_PASSWORD!)`  → valueRef 'ENV.SHOP_PASSWORD'
 */
function readArgument(arg: ts.Expression | undefined): { value?: string; valueRef?: string } {
  if (!arg) return {};
  const literal = text(arg);
  if (literal !== undefined) return { value: literal };

  // A script reading its own environment — what an agent's script usually
  // does for a password. Every spelling of it becomes ENV.<NAME>, whose value
  // is then found under that same variable at replay (store/settings.ts).
  const env = envVariable(arg);
  if (env) return { valueRef: `ENV.${env}` };

  if (ts.isPropertyAccessExpression(arg) || ts.isIdentifier(arg)) {
    return { valueRef: arg.getText() };
  }
  if (ts.isTemplateExpression(arg)) return { valueRef: arg.getText() };
  return { valueRef: arg.getText().slice(0, 80) };
}

/**
 * Actions whose FIRST argument is the value (`fill('x')`, `press('Enter')`).
 * Every other action's first argument is its options object.
 */
const VALUE_FIRST = new Set(['fill', 'type', 'press', 'selectOption', 'setInputFiles']);

/**
 * Options that change nothing replay needs to know: it has its own timeouts
 * and settles the page after every step.
 */
const IGNORABLE_OPTIONS = new Set(['timeout', 'noWaitAfter', 'delay', 'trial', 'strict']);

/**
 * Read an action's options — `click({ force: true })`, `fill(x, { force: true })`.
 *
 * THIS USED TO BE READ AS A VALUE. `check({ force: true })` became
 * `valueRef: '{ force: true }'`, so replay never forced the click (it can't
 * reach a checkbox hidden under its styled label without it) and every run
 * demanded a login value called "{ force: true }". `force` is kept; an option
 * the IR can't express (a right click, a modifier key) is reported.
 */
function readActionOptions(arg: ts.Expression | undefined, method: string): { force?: true; unsupported: string[] } {
  if (!arg) return { unsupported: [] };
  if (!ts.isObjectLiteralExpression(arg)) return { unsupported: [`${method}() options that aren't written inline`] };
  const out: { force?: true; unsupported: string[] } = { unsupported: [] };
  for (const prop of arg.properties) {
    const key = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : undefined;
    if (!key || !ts.isPropertyAssignment(prop)) {
      out.unsupported.push(`${method}() options that aren't plain properties`);
      continue;
    }
    if (key === 'force') {
      if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) out.force = true;
      else if (prop.initializer.kind !== ts.SyntaxKind.FalseKeyword) out.unsupported.push(`${method}({ force }) with a non-literal value`);
    } else if (!IGNORABLE_OPTIONS.has(key)) {
      out.unsupported.push(`${method}({ ${key} })`);
    }
  }
  return out;
}

/**
 * `selectOption({ label: 'Large' })` / `({ value: 'l' })` → 'Large' / 'l'.
 * Replay's selectOption(string) matches an option's value or its label.
 */
function selectedOption(arg: ts.Expression | undefined): string | undefined {
  if (!arg || !ts.isObjectLiteralExpression(arg) || arg.properties.length !== 1) return undefined;
  const prop = arg.properties[0]!;
  if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) return undefined;
  if (prop.name.text !== 'label' && prop.name.text !== 'value') return undefined;
  return text(prop.initializer);
}

/** `process.env.X`, `process.env.X!`, `process.env['X']`, `process.env.X ?? ''` → 'X'. */
function envVariable(arg: ts.Expression): string | undefined {
  let e: ts.Expression = arg;
  while (true) {
    if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
    else if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) e = e.left;
    else break;
  }
  const isProcessEnv = (x: ts.Expression) => ts.isPropertyAccessExpression(x) && x.name.text === 'env' && ts.isIdentifier(x.expression) && x.expression.text === 'process';
  if (ts.isPropertyAccessExpression(e) && isProcessEnv(e.expression)) return e.name.text;
  if (ts.isElementAccessExpression(e) && isProcessEnv(e.expression) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
  return undefined;
}

/** Does this bit say WHICH element, rather than only narrowing one? */
const addresses = (b: LocatorBit) =>
  b.role !== undefined || b.name !== undefined || b.css !== undefined || b.testId !== undefined;

/** A locator chain, read back to its root. */
interface Target {
  /** The chain starts at something page-like: `page`, `frame`, `this.page`. */
  rooted: boolean;
  /** The chain IS the page — `expect(page)`, not `expect(page.getByX())`. */
  bare: boolean;
  /** The element, with nth / frame / text filter applied. */
  merged: LocatorBit;
  scope?: string[];
  /** A chain step that wasn't understood, kept as a hint. */
  unknown?: string;
  unsupported?: string;
}

/**
 * Unwind `page.getByRole('navigation').getByText('Login').nth(1)` into one
 * element. Shared by actions and assertions, which address the same way.
 */
function readTarget(expr: ts.Expression): Target {
  const bits: LocatorBit[] = [];
  let cursor = expr;
  let unknown: string | undefined;
  while (ts.isCallExpression(cursor) && ts.isPropertyAccessExpression(cursor.expression)) {
    const bit = locatorBit(cursor.expression.name.text, cursor.arguments);
    if (!bit) unknown ??= cursor.expression.name.text;
    else bits.unshift(bit);
    cursor = cursor.expression.expression;
  }

  // The root must be something page-like. `page`, `frame`, a page object's
  // `this.page` — but NOT `expect(...)`, which is an assertion.
  const rootText = cursor.getText();
  const rooted = /(^|\.)page$|^frame$|^context$/.test(rootText);

  // A CHAIN IS SCOPE + TARGET, NOT ONE MERGED ELEMENT.
  //
  // `page.getByRole('navigation').getByText('Login')` addresses the text
  // "Login" *inside* the navigation landmark. Flattening the chain produced
  // role=navigation name="Login" — an element that does not exist, and a
  // locator that would never resolve on replay.
  //
  // So the TARGET is the last link that actually addresses something, and
  // everything before it is scope, kept as a hint rather than folded into the
  // element's own identity.
  let targetIndex = -1;
  for (let i = bits.length - 1; i >= 0; i--) {
    if (addresses(bits[i]!)) {
      targetIndex = i;
      break;
    }
  }
  const target: LocatorBit = targetIndex >= 0 ? bits[targetIndex]! : {};
  const scopeBits = targetIndex > 0 ? bits.slice(0, targetIndex).filter(addresses) : [];

  // nth, frameHint and hasText are positional/structural: they apply to the
  // target wherever in the chain they were written. hasText takes the LAST
  // one, matching nth — in practice a filter directly follows the locator it
  // narrows.
  const nth = [...bits].reverse().find((b) => b.nth !== undefined)?.nth;
  const frameHint = bits.find((b) => b.frameHint !== undefined)?.frameHint;
  const hasText = [...bits].reverse().find((b) => b.hasText !== undefined)?.hasText;
  const unsupported = bits.find((b) => b.unsupported !== undefined)?.unsupported;

  return {
    rooted,
    bare: bits.length === 0 && !unknown,
    merged: {
      ...target,
      ...(nth !== undefined ? { nth } : {}),
      ...(frameHint !== undefined ? { frameHint } : {}),
      ...(hasText !== undefined ? { hasText } : {}),
    },
    ...(scopeBits.length
      ? { scope: scopeBits.map((b) => (b.role ? `role=${b.role}` : b.css ? `css=${b.css}` : `name=${b.name?.source}`)) }
      : {}),
    ...(unknown ? { unknown } : {}),
    ...(unsupported ? { unsupported } : {}),
  };
}

/** The element's identity fields of an event. */
function who(m: LocatorBit): Partial<RawEvent> {
  return {
    ...(m.role ? { role: m.role } : {}),
    // `name` stays a plain string because sig(), selector dedupe and the
    // embeddings all key on it. When the source was a regex, the string is its
    // SOURCE and hints carry the regex-ness so replay can rebuild the real
    // matcher — `exact` would be wrong here, a source like `Version 2\.5`
    // never equals an accessible name.
    ...(m.name !== undefined ? { name: m.name.source } : {}),
    ...(m.exact ? { exact: m.exact } : {}),
  };
}

/** The element's fallback addressing fields of an event. */
function where(m: LocatorBit): Partial<RawEvent> {
  return {
    ...(m.css ? { css: m.css } : {}),
    ...(m.testId ? { testId: m.testId } : {}),
    ...(m.frameHint ? { frameHint: m.frameHint } : {}),
  };
}

/** The hints an addressed event carries, plus any the caller adds. */
function hintsOf(t: Target, extra: Record<string, unknown> = {}): { hints?: Record<string, unknown> } {
  const m = t.merged;
  const hints: Record<string, unknown> = {
    ...(m.nth !== undefined ? { nth: m.nth } : {}),
    ...(t.scope ? { scope: t.scope } : {}),
    ...(t.unknown ? { unparsedChainStep: t.unknown } : {}),
    ...(m.hasText
      ? { hasText: m.hasText.source, ...(m.hasText.regex ? { hasTextRegex: true, hasTextFlags: m.hasText.flags } : {}) }
      : {}),
    ...(m.name?.regex ? { nameRegex: true, nameFlags: m.name.flags } : {}),
    ...(m.by ? { by: m.by } : {}),
    ...extra,
  };
  return Object.keys(hints).length ? { hints } : {};
}

/**
 * `expect(x).toBeVisible()`, `expect.soft(x).not.toBeChecked()` → its parts.
 * `poll` is reported as its own kind: it takes a function, not a locator.
 */
function expectCall(node: ts.CallExpression): { matcher: string; negated: boolean; subject?: ts.Expression; flavour: string } | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const matcher = node.expression.name.text;
  let recv = node.expression.expression;
  let negated = false;
  if (ts.isPropertyAccessExpression(recv) && recv.name.text === 'not') {
    negated = true;
    recv = recv.expression;
  }
  if (!ts.isCallExpression(recv)) return undefined;
  const callee = recv.expression;
  const flavour = ts.isIdentifier(callee) && callee.text === 'expect'
    ? 'expect'
    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'expect'
      ? `expect.${callee.name.text}`
      : undefined;
  if (!flavour) return undefined;
  return { matcher, negated, flavour, ...(recv.arguments[0] ? { subject: recv.arguments[0] } : {}) };
}

/** Waits that sit in `Promise.all([...])` beside the action that triggers them. */
const WAIT_METHODS = new Set(['waitForURL', 'waitForSelector', 'waitForLoadState', 'waitForNavigation', 'waitForResponse', 'waitForRequest', 'waitForEvent']);

const isWaitCall = (e: ts.Expression): boolean => {
  const x = ts.isAwaitExpression(e) ? e.expression : e;
  return ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && WAIT_METHODS.has(x.expression.name.text);
};

export async function parseScript(
  filePath: string,
  appSlug: string,
  fallbackUrl?: string,
): Promise<ParsedScript> {
  const source = await readFile(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    basename(filePath),
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    filePath.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );

  const events: RawEvent[] = [];
  const warnings: string[] = [];
  const dropped: string[] = [];

  // A static read cannot know which page it is on, so the last goto (or literal
  // URL wait) stands in. Anything before the first goto is attributed to the
  // fallback URL. It is a guess: the first replay that passes replaces it with
  // the page each step actually ran on (flows/save.ts, stepsFrom).
  let currentUrl = fallbackUrl ?? '';
  let startUrl = fallbackUrl ?? '';

  const snippet = (node: ts.Node) => node.getText().replace(/\s+/g, ' ').slice(0, 80);
  const drop = (why: string, node: ts.Node) => dropped.push(`${why}: ${snippet(node)}`);

  /** A URL wait, from `waitForURL(x)` or `expect(page).toHaveURL(x)`. */
  const pushWaitUrl = (arg: ts.Expression | undefined, node: ts.Node) => {
    const match = textMatch(arg);
    if (!match) return drop('URL wait with a non-literal URL, not kept', node);
    events.push({
      seq: events.length,
      ts: events.length,
      action: 'wait_url',
      value: match.source,
      url: currentUrl,
      resolution: 'script-literal',
      ...(match.regex ? { hints: { urlRegex: true, urlFlags: match.flags } } : {}),
    });
    // A wait for a plain address says which page the steps after it are on —
    // the best a static read can do. A regex or a glob names no single page.
    // Only an address that is one: a bare word like 'dashboard' is a substring
    // replay looks for, not a path to resolve.
    const plain = !match.regex && !match.source.includes('*');
    if (plain && /^https?:\/\//.test(match.source)) currentUrl = match.source;
    else if (plain && match.source.startsWith('/') && fallbackUrl) currentUrl = absolute(match.source, fallbackUrl);
  };

  /** A `wait_response` step from what waitForResponse() was given. */
  const pushWaitResponse = (arg: ts.Expression | undefined, node: ts.Node) => {
    const { check, why } = responseWaitFrom(arg);
    if (!check) return drop(`${why ?? 'waitForResponse()'}, not kept`, node);
    const { url, ...rest } = check;
    events.push({
      seq: events.length, ts: events.length, action: 'wait_response', value: url,
      url: currentUrl, resolution: 'script-literal', ...(Object.keys(rest).length ? { hints: rest } : {}),
    });
  };

  // `const answer = page.waitForResponse(...)`, the click, then `await answer`:
  // Playwright's way of not missing a fast response. The wait belongs where it
  // is AWAITED — after the click — not where it was set up.
  const deferred = new Map<string, ts.CallExpression>();

  /** An `assert` step on an element (or, for `title`, the page). */
  const pushAssert = (t: Target, kind: AssertKind, arg: ts.Expression | undefined, node: ts.Node) => {
    const needsValue = kind === 'text' || kind === 'contains' || kind === 'value' || kind === 'title';
    let valued: { value?: string; valueRef?: string } = {};
    const extra: Record<string, unknown> = { assert: kind };
    if (needsValue) {
      const match = textMatch(arg);
      if (match) {
        valued = { value: match.source };
        if (match.regex) Object.assign(extra, { valueRegex: true, valueFlags: match.flags });
        // A literal password in an assertion is still a literal password.
        if (kind === 'value' && !match.regex) {
          const hint = t.merged.name?.source || t.merged.testId || t.merged.css || 'field';
          valued = redactValue(hint, match.source, undefined, [t.merged.name?.source, t.merged.css, t.merged.testId].filter(Boolean).join(' '));
        }
      } else if (arg && !ts.isArrayLiteralExpression(arg)) {
        valued = readArgument(arg);
      } else {
        return drop(`${kind} check with no single expected value, not kept`, node);
      }
    }
    events.push({
      seq: events.length,
      ts: events.length,
      action: 'assert',
      ...who(t.merged),
      ...valued,
      ...where(t.merged),
      url: currentUrl,
      resolution: 'script-literal',
      ...hintsOf(t, extra),
    });
  };

  /** `expect(...)` — kept if the IR can say it, otherwise reported. */
  const visitExpect = (node: ts.CallExpression, ex: NonNullable<ReturnType<typeof expectCall>>) => {
    if (SNAPSHOT_CALLS.has(ex.matcher)) return; // a visual checkpoint, handled above
    if (ex.flavour !== 'expect' && ex.flavour !== 'expect.soft') return drop(`${ex.flavour}() is not kept`, node);
    if (!ex.subject) return drop('expect() with nothing to check, not kept', node);

    const t = readTarget(ex.subject);
    if (!t.rooted) {
      return drop('assertion on a value or a locator held in a variable, not kept — write the locator inline, e.g. expect(page.getByRole(...))', node);
    }
    const arg = node.arguments[0];
    const { matcher, negated } = ex;

    if (t.bare) {
      if (matcher === 'toHaveURL' && !negated) return pushWaitUrl(arg, node);
      if (matcher === 'toHaveTitle' && !negated) return pushAssert(t, 'title', arg, node);
      return drop(`page assertion ${negated ? 'not.' : ''}${matcher}() is not kept`, node);
    }
    if (!addresses(t.merged)) return drop('assertion on an element with no usable locator, not kept', node);
    if (t.unsupported) warnings.push(`${t.unsupported} could not be represented: ${snippet(node)}`);

    const kind: AssertKind | undefined =
      matcher === 'toBeVisible' ? (negated ? 'hidden' : 'visible')
      : matcher === 'toBeHidden' ? (negated ? 'visible' : 'hidden')
      : matcher === 'toBeChecked' ? (negated ? 'unchecked' : 'checked')
      : negated ? undefined
      : matcher === 'toHaveText' ? 'text'
      : matcher === 'toContainText' ? 'contains'
      : matcher === 'toHaveValue' ? 'value'
      : undefined;
    if (!kind) return drop(`assertion ${negated ? 'not.' : ''}${matcher}() is not kept`, node);
    pushAssert(t, kind, arg, node);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isPropertyAccessExpression(node.initializer.expression) && node.initializer.expression.name.text === 'waitForResponse') {
      deferred.set(node.name.text, node.initializer);
      return;
    }
    if (ts.isAwaitExpression(node) && ts.isIdentifier(node.expression) && deferred.has(node.expression.text)) {
      const call = deferred.get(node.expression.text)!;
      deferred.delete(node.expression.text);
      pushWaitResponse(call.arguments[0], call);
      return;
    }

    // `Promise.all([page.waitForURL(x), page.click(y)])` — the wait is written
    // first but happens after the click it waits on. Replay is sequential, so
    // the actions go first and the waits after them.
    if (
      ts.isArrayLiteralExpression(node) &&
      ts.isCallExpression(node.parent) &&
      /^Promise\.(all|allSettled|race)$/.test(node.parent.expression.getText()) &&
      node.elements.some(isWaitCall)
    ) {
      for (const e of node.elements) if (!isWaitCall(e)) visit(e);
      for (const e of node.elements) if (isWaitCall(e)) visit(e);
      return;
    }

    // VISUAL CHECKPOINTS, WHICH ARE NOT PAGE METHODS.
    //
    // `expect(page).toHaveScreenshot('x.png')` is a chain off expect(), and a
    // helper like `checkpoint(page, testInfo, '01-bmi')` is a bare call — so
    // neither reaches the page-rooted walker below, and both were silently
    // dropped. They are the most valuable thing in the file for this purpose:
    // somebody decided, by hand, exactly where a picture is worth taking.
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : undefined;

      // A PERSON'S STEP: `human('Approve the visit in the provider portal',
      // { untilText: 'Visit accepted' })`. Not Playwright — a marker an agent
      // writes where it had to ask someone. Read, never run.
      if (callee === 'human' && ts.isIdentifier(node.expression)) {
        const instruction = node.arguments[0] ? text(node.arguments[0]) : undefined;
        if (!instruction) {
          warnings.push(`human() needs what the person must do, as a literal string: ${snippet(node)}`);
        } else {
          const until = readUntil(node.arguments[1]);
          for (const u of until.unsupported) warnings.push(`human({ ${u} }) cannot be represented: ${snippet(node)}`);
          events.push({
            seq: events.length,
            ts: events.length,
            action: 'human',
            value: instruction,
            url: currentUrl,
            resolution: 'script-literal',
            ...(until.url || until.text || until.response
              ? { hints: { ...(until.url ? { untilUrl: until.url } : {}), ...(until.text ? { untilText: until.text } : {}), ...(until.response ? { untilResponse: until.response } : {}) } }
              : {}),
          });
          if (until.url?.startsWith('/') && fallbackUrl && !until.url.includes('*')) currentUrl = absolute(until.url, fallbackUrl);
        }
        return;
      }

      if (callee && SNAPSHOT_CALLS.has(callee)) {
        // The label is the first string literal in the arguments, wherever it
        // sits — `toHaveScreenshot('x.png')` has it first, `checkpoint(page,
        // testInfo, 'x')` third.
        const raw = node.arguments.map(text).find((t) => t !== undefined);
        const label = raw?.replace(/\.png$/i, '');
        if (label) {
          events.push({
            seq: events.length,
            ts: events.length,
            action: 'snapshot',
            value: label,
            url: currentUrl,
            resolution: 'script-literal',
          });
        } else {
          warnings.push(`visual checkpoint with no literal name: ${snippet(node)}`);
        }
      }

      // ASSERTIONS. These used to vanish without a word, leaving a flow that
      // only proved its buttons exist. See KEPT_ASSERTIONS.
      const ex = expectCall(node);
      if (ex) {
        visitExpect(node, ex);
        // The subject's own chain is addressing, not actions — don't walk it.
        return;
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const action = ACTIONS[method];

      // An unmappable call is REPORTED, never dropped. See UNEXPRESSIBLE.
      if (!action && UNEXPRESSIBLE.has(method)) {
        const scroll = method.startsWith('evaluate') ? scrollContainerFrom(node) : undefined;
        if (scroll) {
          events.push({
            seq: events.length,
            ts: events.length,
            action: 'scroll_container',
            css: scroll.css,
            value: scroll.edge,
            url: currentUrl,
            // The pane was addressed by CSS in the spec and nothing resolved a
            // role or name for it, which is precisely what 'unresolved' means.
            resolution: 'unresolved',
          });
        } else {
          warnings.push(`${method}() cannot be expressed by the IR, step DROPPED: ${snippet(node)}`);
        }
      }

      // WAITS on the page.
      if (!action && WAIT_METHODS.has(method) && readTarget(node.expression.expression).rooted) {
        const arg = node.arguments[0];
        if (method === 'waitForURL') pushWaitUrl(arg, node);
        else if (method === 'waitForSelector') {
          const css = arg ? text(arg) : undefined;
          if (css === undefined) drop('waitForSelector with a non-literal selector, not kept', node);
          else {
            const state = readState(node.arguments[1]);
            const kind: AssertKind = state === 'hidden' || state === 'detached' ? 'hidden' : 'visible';
            pushAssert({ rooted: true, bare: false, merged: { css } }, kind, undefined, node);
          }
        } else if (method === 'waitForResponse') {
          pushWaitResponse(node.arguments[0], node);
        } else if (!SETTLING_WAITS.has(method)) {
          drop(`${method}() is not kept (replay can't wait on network events)`, node);
        }
        // waitForLoadState / waitForNavigation: replay settles after every step anyway.
      }

      if (action) {
        const t = readTarget(node.expression.expression);
        if (t.rooted) {
          const merged = t.merged;
          if (t.unsupported) {
            warnings.push(`${t.unsupported} could not be represented: ${snippet(node)}`);
          }

          if (action === 'goto') {
            const urlArg = node.arguments[0];
            const literal = urlArg ? text(urlArg) : undefined;
            // RESOLVE AGAINST THE BASE URL. Playwright specs are written with
            // relative paths on purpose — `page.goto('/overview')` plus a
            // `baseURL` in the config — so the literal alone is not navigable.
            // Storing it raw produced "Cannot navigate to invalid URL" on the
            // very first step of every imported spec.
            const url = literal && fallbackUrl ? absolute(literal, fallbackUrl) : literal;
            if (url) {
              currentUrl = url;
              if (!startUrl) startUrl = url;
              events.push({
                seq: events.length,
                ts: events.length,
                action: 'goto',
                value: url,
                url,
                resolution: 'script-literal',
              });
            } else {
              warnings.push(`goto with a non-literal URL: ${snippet(node)}`);
            }
          } else if (!addresses(merged)) {
            warnings.push(`unaddressable ${action}: ${snippet(node)}`);
          } else {
            const takesValue = VALUE_FIRST.has(method);
            const options = readActionOptions(node.arguments[takesValue ? 1 : 0], method);
            for (const o of options.unsupported) warnings.push(`${o} cannot be represented, ignored: ${snippet(node)}`);

            let raw: { value?: string; valueRef?: string } = {};
            if (takesValue) {
              const first = node.arguments[0];
              const option = method === 'selectOption' ? selectedOption(first) : undefined;
              if (option !== undefined) raw = { value: option };
              else if (first && (ts.isObjectLiteralExpression(first) || ts.isArrayLiteralExpression(first))) {
                warnings.push(`${method}() with ${ts.isArrayLiteralExpression(first) ? 'several values' : 'an options object'} cannot be represented: ${snippet(node)}`);
              } else raw = readArgument(first);
            }
            const fieldHint = merged.name?.source || merged.testId || merged.css || 'field';
            const secretSignal = [merged.name?.source, merged.css, merged.testId].filter(Boolean).join(' ');

            // A literal password in a committed test still must not reach the
            // corpus. A valueRef is already a reference and passes through.
            // An upload's argument is a PATH, not a value to redact — and it
            // needs resolving against the spec's own repo before it can be read.
            const valued =
              action === 'upload' && raw.value !== undefined
                ? { value: resolveFixture(raw.value, filePath) }
                : raw.value !== undefined
                  ? redactValue(fieldHint, raw.value, undefined, secretSignal)
                  : raw;

            events.push({
              seq: events.length,
              ts: events.length,
              action,
              ...who(merged),
              ...valued,
              ...where(merged),
              url: currentUrl,
              resolution: 'script-literal',
              ...hintsOf(t, options.force ? { force: true } : {}),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  for (const [name, call] of deferred) drop(`waitForResponse() kept in "${name}" but never awaited, not kept`, call);

  return {
    recording: buildRecording(
      { source: 'script', origin: filePath, appSlug, startUrl },
      events.map((e, i) => ({ ...e, seq: i })),
    ),
    warnings,
    dropped,
  };
}

/**
 * What `waitForResponse(x)` waits for. A string or glob is the address; a
 * predicate is read for the three things it usually tests —
 * `r.url().includes('/api/visits') && r.status() === 201 && r.request().method() === 'POST'`.
 * Read from source text, so anything cleverer is reported rather than guessed.
 */
function responseWaitFrom(arg: ts.Expression | undefined): { check?: Record<string, unknown> & { url: string }; why?: string } {
  if (!arg) return { why: 'waitForResponse() with nothing to wait for' };
  const literal = text(arg);
  if (literal) return { check: { url: literal } };
  if (ts.isRegularExpressionLiteral(arg)) return { why: 'waitForResponse(/regex/) — write the address as a string or glob' };
  if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) return { why: 'waitForResponse() with a predicate held in a variable' };
  const body = arg.body.getText();
  const url = body.match(/\.url\(\)\s*(?:\.(?:includes|endsWith|startsWith)\(\s*|===?\s*)['"`]([^'"`]+)['"`]/)?.[1];
  if (!url) return { why: 'waitForResponse() predicate with no literal address in it (r.url().includes(\'…\'))' };
  const status = body.match(/\.status\(\)\s*===?\s*(\d{3})/)?.[1];
  const method = body.match(/\.method\(\)\s*===?\s*['"`]([A-Za-z]+)['"`]/)?.[1];
  return { check: { url, ...(status ? { status: Number(status) } : {}), ...(method ? { method: method.toUpperCase() } : {}) } };
}

/** `{ untilUrl: '/done', untilText: 'Accepted' }`, literals only. */
function readUntil(node: ts.Node | undefined): { url?: string; text?: string; response?: unknown; unsupported: string[] } {
  const out: { url?: string; text?: string; response?: unknown; unsupported: string[] } = { unsupported: [] };
  if (!node) return out;
  if (!ts.isObjectLiteralExpression(node)) return { unsupported: ['options not written inline'] };
  for (const prop of node.properties) {
    const key = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : '?';
    const value = ts.isPropertyAssignment(prop) ? text(prop.initializer) : undefined;
    if (key === 'untilUrl' && value) out.url = value;
    else if (key === 'untilText' && value) out.text = value;
    else if (key === 'untilResponse' && value) out.response = value;
    else if (key === 'untilResponse' && ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
      // { url, method, status, field, equals | above } — literal values only.
      const o: Record<string, unknown> = {};
      for (const q of prop.initializer.properties) {
        if (!ts.isPropertyAssignment(q) || !ts.isIdentifier(q.name)) continue;
        const v = q.initializer;
        o[q.name.text] = ts.isNumericLiteral(v) ? Number(v.text)
          : v.kind === ts.SyntaxKind.TrueKeyword ? true : v.kind === ts.SyntaxKind.FalseKeyword ? false : text(v);
      }
      if (typeof o.url === 'string') out.response = o;
      else out.unsupported.push('untilResponse without a literal url');
    } else out.unsupported.push(key);
  }
  return out;
}

/** `{ state: 'hidden' }` → 'hidden'. */
function readState(node: ts.Node | undefined): string | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'state') return text(prop.initializer);
  }
  return undefined;
}
