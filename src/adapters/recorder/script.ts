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
import { basename } from 'node:path';
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
  name?: string;
  exact?: boolean;
  css?: string;
  testId?: string;
  frameHint?: string;
  nth?: number;
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
};

export interface ParsedScript {
  recording: RawRecording;
  /** Calls that looked like Playwright actions but could not be mapped. */
  warnings: string[];
}

const text = (node: ts.Node): string | undefined =>
  ts.isStringLiteralLike(node) ? node.text : undefined;

/**
 * Read `{ name: 'Login', exact: true }`.
 * Only literal properties are useful; a computed name can't be known statically.
 */
function readOptions(node: ts.Node | undefined): { name?: string; exact?: boolean } {
  if (!node || !ts.isObjectLiteralExpression(node)) return {};
  const out: { name?: string; exact?: boolean } = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    if (prop.name.text === 'name') {
      const literal = text(prop.initializer);
      if (literal !== undefined) out.name = literal;
    }
    if (prop.name.text === 'exact') {
      out.exact = prop.initializer.kind === ts.SyntaxKind.TrueKeyword;
    }
  }
  return out;
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
      const name = first ? text(first) : undefined;
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
    // Refinements that don't change which element we're addressing.
    case 'filter':
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
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const action = ACTIONS[method];

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

          // nth and frameHint are positional/structural: they apply to the
          // target wherever in the chain they were written.
          const nth = [...bits].reverse().find((b) => b.nth !== undefined)?.nth;
          const frameHint = bits.find((b) => b.frameHint !== undefined)?.frameHint;

          const merged: LocatorBit = {
            ...target,
            ...(nth !== undefined ? { nth } : {}),
            ...(frameHint !== undefined ? { frameHint } : {}),
          };
          const scope = scopeBits.length
            ? scopeBits.map((b) => (b.role ? `role=${b.role}` : b.css ? `css=${b.css}` : `name=${b.name}`))
            : undefined;

          if (action === 'goto') {
            const urlArg = node.arguments[0];
            const url = urlArg ? text(urlArg) : undefined;
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
            const fieldHint = merged.name || merged.testId || merged.css || 'field';
            const secretSignal = [merged.name, merged.css, merged.testId].filter(Boolean).join(' ');

            // A literal password in a committed test still must not reach the
            // corpus. A valueRef is already a reference and passes through.
            const valued =
              raw.value !== undefined
                ? redactValue(fieldHint, raw.value, undefined, secretSignal)
                : raw;

            events.push({
              seq: events.length,
              ts: events.length,
              action,
              ...(merged.role ? { role: merged.role } : {}),
              ...(merged.name !== undefined ? { name: merged.name } : {}),
              ...(merged.exact ? { exact: merged.exact } : {}),
              ...valued,
              ...(merged.css ? { css: merged.css } : {}),
              ...(merged.testId ? { testId: merged.testId } : {}),
              ...(merged.frameHint ? { frameHint: merged.frameHint } : {}),
              url: currentUrl,
              resolution: 'script-literal',
              ...(merged.nth !== undefined || unknown || scope
                ? {
                    hints: {
                      ...(merged.nth !== undefined ? { nth: merged.nth } : {}),
                      ...(scope ? { scope } : {}),
                      ...(unknown ? { unparsedChainStep: unknown } : {}),
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
