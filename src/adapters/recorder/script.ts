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
};

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
 * quietly missing a step the flow depends on. That is exactly how the hair loss
 * spec's `page.evaluate` scroll — the thing that unlocks Confirm & Submit —
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
    // Playwright's accname falls back to the placeholder, so a placeholder
    // lookup and an accessible name are the same thing to us.
    case 'getByPlaceholder':
    case 'getByLabel':
    case 'getByText':
    case 'getByTitle':
    case 'getByAltText': {
      const name = textMatch(first);
      const { exact } = readOptions(args[1]);
      return name !== undefined ? { name, ...(exact ? { exact } : {}) } : undefined;
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
 * `fill('standard_user')`   → value
 * `fill(MEMBER.email)`      → valueRef 'MEMBER.email'  ← already the IR shape
 */
function readArgument(arg: ts.Expression | undefined): { value?: string; valueRef?: string } {
  if (!arg) return {};
  const literal = text(arg);
  if (literal !== undefined) return { value: literal };

  if (ts.isPropertyAccessExpression(arg) || ts.isIdentifier(arg)) {
    return { valueRef: arg.getText() };
  }
  if (ts.isTemplateExpression(arg)) return { valueRef: arg.getText() };
  return { valueRef: arg.getText().slice(0, 80) };
}

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

  // A static read cannot know which page it is on, so the last goto stands in.
  // Anything before the first goto is attributed to the fallback URL.
  let currentUrl = fallbackUrl ?? '';
  let startUrl = fallbackUrl ?? '';

  const visit = (node: ts.Node): void => {
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
          warnings.push(`visual checkpoint with no literal name: ${node.getText().slice(0, 70)}`);
        }
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
          warnings.push(`${method}() cannot be expressed by the IR, step DROPPED: ${node.getText().slice(0, 70)}`);
        }
      }

      if (action) {
        // Unwind the chain back to its root, collecting addressing bits.
        const bits: LocatorBit[] = [];
        let cursor: ts.Expression = node.expression.expression;
        let rooted = false;
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
        rooted = /(^|\.)page$|^frame$|^context$/.test(rootText) || rootText === 'page';

        if (rooted) {
          // A CHAIN IS SCOPE + TARGET, NOT ONE MERGED ELEMENT.
          //
          // `page.getByRole('navigation').getByText('Login')` addresses the
          // text "Login" *inside* the navigation landmark. Flattening the chain
          // produced role=navigation name="Login" — an element that does not
          // exist, and a locator that would never resolve on replay.
          //
          // So the TARGET is the last link that actually addresses something,
          // and everything before it is scope, kept as a hint rather than
          // folded into the element's own identity.
          const addresses = (b: LocatorBit) =>
            b.role !== undefined || b.name !== undefined || b.css !== undefined || b.testId !== undefined;

          let targetIndex = -1;
          for (let i = bits.length - 1; i >= 0; i--) {
            if (addresses(bits[i]!)) {
              targetIndex = i;
              break;
            }
          }

          const target: LocatorBit = targetIndex >= 0 ? bits[targetIndex]! : {};
          const scopeBits = targetIndex > 0 ? bits.slice(0, targetIndex).filter(addresses) : [];

          // nth, frameHint and hasText are positional/structural: they apply to
          // the target wherever in the chain they were written. hasText takes
          // the LAST one, matching nth — in practice a filter directly follows
          // the locator it narrows.
          const nth = [...bits].reverse().find((b) => b.nth !== undefined)?.nth;
          const frameHint = bits.find((b) => b.frameHint !== undefined)?.frameHint;
          const hasText = [...bits].reverse().find((b) => b.hasText !== undefined)?.hasText;
          const unsupported = bits.find((b) => b.unsupported !== undefined)?.unsupported;

          if (unsupported) {
            warnings.push(`${unsupported} could not be represented: ${node.getText().slice(0, 70)}`);
          }

          const merged: LocatorBit = {
            ...target,
            ...(nth !== undefined ? { nth } : {}),
            ...(frameHint !== undefined ? { frameHint } : {}),
            ...(hasText !== undefined ? { hasText } : {}),
          };
          const scope = scopeBits.length
            ? scopeBits.map((b) => (b.role ? `role=${b.role}` : b.css ? `css=${b.css}` : `name=${b.name?.source}`))
            : undefined;

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
              warnings.push(`goto with a non-literal URL: ${node.getText().slice(0, 70)}`);
            }
          } else if (!merged.role && !merged.name && !merged.css && !merged.testId) {
            warnings.push(`unaddressable ${action}: ${node.getText().slice(0, 70)}`);
          } else {
            const raw = readArgument(node.arguments[0]);
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
              ...(merged.role ? { role: merged.role } : {}),
              // `name` stays a plain string because sig(), selector dedupe and
              // the embeddings all key on it. When the source was a regex, the
              // string is its SOURCE and hints carry the regex-ness so replay
              // can rebuild the real matcher — `exact` would be wrong here, a
              // source like `Minoxidil 2\.5mg` never equals an accessible name.
              ...(merged.name !== undefined ? { name: merged.name.source } : {}),
              ...(merged.exact ? { exact: merged.exact } : {}),
              ...valued,
              ...(merged.css ? { css: merged.css } : {}),
              ...(merged.testId ? { testId: merged.testId } : {}),
              ...(merged.frameHint ? { frameHint: merged.frameHint } : {}),
              url: currentUrl,
              resolution: 'script-literal',
              ...(merged.nth !== undefined || unknown || scope || merged.hasText || merged.name?.regex
                ? {
                    hints: {
                      ...(merged.nth !== undefined ? { nth: merged.nth } : {}),
                      ...(scope ? { scope } : {}),
                      ...(unknown ? { unparsedChainStep: unknown } : {}),
                      ...(merged.hasText
                        ? {
                            hasText: merged.hasText.source,
                            ...(merged.hasText.regex
                              ? { hasTextRegex: true, hasTextFlags: merged.hasText.flags }
                              : {}),
                          }
                        : {}),
                      ...(merged.name?.regex
                        ? { nameRegex: true, nameFlags: merged.name.flags }
                        : {}),
                    },
                  }
                : {}),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    recording: buildRecording(
      { source: 'script', origin: filePath, appSlug, startUrl },
      events.map((e, i) => ({ ...e, seq: i })),
    ),
    warnings,
  };
}
