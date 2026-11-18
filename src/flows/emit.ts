/**
 * Print a saved flow as test code: Playwright (TypeScript) or Cypress.
 *
 * Flows are stored as data, so code is just an output format — the same flow
 * prints either way without re-recording. Two things it won't do quietly:
 *
 *   - inline a credential: a `valueRef` becomes an environment variable, never
 *     the value (the recording never stored it, and generated files get committed)
 *   - pretend: a step it can't address cleanly comes with a warning, not a
 *     plausible-looking locator
 *
 * Ported from the old emit.ts; it now reads the flow document directly.
 */

import type { Flow, Step } from '../store/types.js';

export type Framework = 'playwright-ts' | 'cypress-js';

export interface Emitted {
  framework: Framework;
  code: string;
  warnings: string[];
  /** Value references the test reads from the environment. */
  requiredValues: string[];
}

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
/** SECRET.password → SECRET_PASSWORD, usable as an environment variable. */
const envName = (ref: string) => ref.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
const describe = (s: Step) => `${s.action} ${s.role ?? ''} ${s.name ?? s.testId ?? s.css ?? ''}`.replace(/\s+/g, ' ').trim();

/**
 * Narrowing replay applies after finding the element, in the same order:
 * a text filter first, then position ("the 3rd of these"). The six boxes of a
 * one-time code share one selector and differ only by position, so dropping
 * this would type every digit into the first box.
 */
function narrow(s: Step, loc: string, pw: boolean, warn: (w: string) => void): string {
  const h = (s.hints ?? {}) as Record<string, unknown>;
  if (h.scope) warn(`"${describe(s)}" was scoped inside another element in the source; emitted unscoped`);
  if (typeof h.hasText === 'string') {
    const text = h.hasTextRegex ? `/${h.hasText}/${String(h.hasTextFlags ?? '')}` : quote(h.hasText);
    if (pw) loc += `.filter({ hasText: ${text} })`;
    else warn(`"${describe(s)}" filters by text, which this Cypress output doesn't express`);
  }
  if (typeof h.nth === 'number') loc += h.nth < 0 ? '.last()' : pw ? `.nth(${h.nth})` : `.eq(${h.nth})`;
  return loc;
}

/** Best locator first — the same order replay tries, so the code fails where replay would. */
function playwrightLocator(s: Step, warn: (w: string) => void): string {
  const scope = s.frameHint ? `page.frameLocator(${quote(`[id$="${s.frameHint}"]`)})` : 'page';
  if (s.role && s.name) return `${scope}.getByRole(${quote(s.role)}, { name: ${quote(s.name)}${s.exact ? ', exact: true' : ''} })`;
  // Not getByTestId: it only looks at data-testid unless the project reconfigures it.
  if (s.testId) return `${scope}.locator(${quote(`[${s.testIdAttr ?? 'data-testid'}="${s.testId}"]`)})`;
  if (s.name) return `${scope}.getByText(${quote(s.name)})`;
  if (s.css) {
    warn(`"${describe(s)}" is addressed only by CSS — it breaks on any markup change`);
    return `${scope}.locator(${quote(s.css)})`;
  }
  warn(`"${describe(s)}" has no usable locator; emitted as a TODO`);
  return `${scope}.locator('TODO')`;
}

function cypressLocator(s: Step, warn: (w: string) => void): string {
  if (s.testId) return `cy.get(${quote(`[${s.testIdAttr ?? 'data-testid'}="${s.testId}"]`)})`;
  if (s.role && s.name) {
    // Cypress has no role engine: a real loss of precision, so say so.
    warn(`"${describe(s)}" used role + name, which Cypress can't express; emitted as a text match`);
    return `cy.contains(${quote(s.name)})`;
  }
  if (s.name) return `cy.contains(${quote(s.name)})`;
  if (s.css) return `cy.get(${quote(s.css)})`;
  warn(`"${describe(s)}" has no usable locator; emitted as a TODO`);
  return `cy.get('TODO')`;
}

export function emitFlow(flow: Flow, framework: Framework = 'playwright-ts'): Emitted {
  const warnings: string[] = [];
  const warn = (w: string) => warnings.push(w);
  const required = new Set<string>();
  const pw = framework === 'playwright-ts';
  if (flow.destructive) warnings.push(`this flow is DESTRUCTIVE (${flow.destructiveBecause}) — running it commits a real action`);
  if (flow.requiresSession) warnings.push('this flow starts signed in; the generated test starts signed out — add a login first');

  const lines: string[] = [];
  for (const s of flow.steps) {
    if (s.action === 'snapshot' || s.action === 'assert') continue;
    const loc = s.action === 'goto' ? '' : narrow(s, pw ? playwrightLocator(s, warn) : cypressLocator(s, warn), pw, warn);
    const value = s.valueRef ? (required.add(s.valueRef), envName(s.valueRef)) : quote(s.value ?? (s.action === 'goto' ? s.url : ''));

    switch (s.action) {
      case 'goto': lines.push(pw ? `await page.goto(${value});` : `cy.visit(${value});`); break;
      case 'fill': lines.push(pw ? `await ${loc}.fill(${value});` : `${loc}.type(${value});`); break;
      case 'select': lines.push(pw ? `await ${loc}.selectOption(${value});` : `${loc}.select(${value});`); break;
      case 'check': lines.push(pw ? `await ${loc}.check();` : `${loc}.check();`); break;
      case 'press': lines.push(pw ? `await ${loc}.press(${value});` : `${loc}.type(${value});`); break;
      case 'upload': lines.push(pw ? `await ${loc}.setInputFiles(${value});` : `${loc}.selectFile(${value});`); break;
      case 'scroll_container':
        if (s.value === 'bottom' || s.value === 'top') {
          lines.push(pw
            ? `await ${loc}.evaluate((el) => { el.scrollTop = ${s.value === 'bottom' ? 'el.scrollHeight' : '0'}; });`
            : `${loc}.scrollTo('${s.value}');`);
        } else lines.push(pw ? `await ${loc}.scrollIntoViewIfNeeded();` : `${loc}.scrollIntoView();`);
        break;
      case 'wait_url': lines.push(pw ? `await page.waitForURL(new RegExp(${quote(s.value ?? '')}));` : `cy.url().should('include', ${value});`); break;
      case 'wait_text': lines.push(pw ? `await page.getByText(${value}).waitFor();` : `cy.contains(${value});`); break;
      default: lines.push(pw ? `await ${loc}.click();` : `${loc}.click();`);
    }
  }

  const refs = [...required];
  // Values come from the environment, never the file.
  const preamble = refs.length ? refs.map((r) => `const ${envName(r)} = process.env.${envName(r)} ?? '';`).join('\n') + '\n\n' : '';
  const header = `// ${flow.intent}\n// Generated by understudy from flow "${flow.app}/${flow.slug}". Regenerate rather than edit.\n\n`;
  const body = (indent: string) => lines.map((l) => indent + l).join('\n');
  const code = pw
    ? `import { test } from '@playwright/test';\n\n${header}${preamble}test(${quote(flow.title)}, async ({ page }) => {\n${body('  ')}\n});\n`
    : `${header}${preamble}describe(${quote(flow.title)}, () => {\n  it(${quote(flow.title)}, () => {\n${body('    ')}\n  });\n});\n`;
  return { framework, code, warnings, requiredValues: refs };
}
