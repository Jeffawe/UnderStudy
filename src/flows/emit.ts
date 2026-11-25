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
import { forced, humanUntil, responseCheckOf, valueRefsOf, type ResponseCheck } from '../core/recording.js';
import { urlGlob } from '../core/replay.js';
import { valueEnvName } from '../store/settings.js';

export type Framework = 'playwright-ts' | 'cypress-js';

export interface Emitted {
  framework: Framework;
  code: string;
  warnings: string[];
  /** Value references the test reads from the environment. */
  requiredValues: string[];
}

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
/** SECRET.password → UNDERSTUDY_SECRET_PASSWORD: the same variable replay reads, so one setting serves both. */
const envName = valueEnvName;
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

/** hints.by → the Playwright lookup that found the name (script.ts NameLookup). */
const NAME_LOOKUP: Record<string, string> = {
  placeholder: 'getByPlaceholder', label: 'getByLabel', title: 'getByTitle', alt: 'getByAltText',
};

/** A text matcher as source: a regex stays a regex. */
const matcher = (s: Step, flag: 'valueRegex' | 'urlRegex', flags: 'valueFlags' | 'urlFlags') =>
  s.hints?.[flag] ? `/${s.value ?? ''}/${String(s.hints[flags] ?? '')}` : quote(s.value ?? '');

/** An assert step as `expect(...)`, or a Cypress `should`. */
function assertion(s: Step, loc: string, value: string, pw: boolean, warn: (w: string) => void): string {
  const kind = String(s.hints?.assert ?? 'visible');
  const expected = s.valueRef ? value : matcher(s, 'valueRegex', 'valueFlags');
  if (pw) {
    switch (kind) {
      case 'title': return `await expect(page).toHaveTitle(${expected});`;
      case 'visible': return `await expect(${loc}).toBeVisible();`;
      case 'hidden': return `await expect(${loc}).toBeHidden();`;
      case 'text': return `await expect(${loc}).toHaveText(${expected});`;
      case 'contains': return `await expect(${loc}).toContainText(${expected});`;
      case 'value': return `await expect(${loc}).toHaveValue(${expected});`;
      case 'checked': return `await expect(${loc}).toBeChecked();`;
      case 'unchecked': return `await expect(${loc}).not.toBeChecked();`;
    }
  } else {
    if (s.hints?.valueRegex) warn(`"${describe(s)}" checks a regex, which this Cypress output emits as a substring`);
    const v = s.valueRef ? value : quote(s.value ?? '');
    switch (kind) {
      case 'title': return `cy.title().should('eq', ${v});`;
      case 'visible': return `${loc}.should('be.visible');`;
      case 'hidden': return `${loc}.should('not.be.visible');`;
      case 'text': return `${loc}.invoke('text').should('eq', ${v});`;
      case 'contains': return `${loc}.should('contain.text', ${v});`;
      case 'value': return `${loc}.should('have.value', ${v});`;
      case 'checked': return `${loc}.should('be.checked');`;
      case 'unchecked': return `${loc}.should('not.be.checked');`;
    }
  }
  warn(`"${describe(s)}" is an assertion of a kind this output doesn't know (${kind}); skipped`);
  return `// TODO: assert ${kind}`;
}

/** `r => r.url().includes('/api/visits') && r.request().method() === 'POST' && r.status() === 201` */
function responsePredicate(c: ResponseCheck): string {
  const url = c.url.includes('*') ? `/${urlGlob(c.url).source}/.test(r.url())` : `r.url().includes(${quote(c.url)})`;
  return `(r) => ${[url, c.method && `r.request().method() === ${quote(c.method)}`, c.status !== undefined && `r.status() === ${c.status}`].filter(Boolean).join(' && ')}`;
}

/** `body.items[0].id` as optional chaining, so a missing field fails the expect, not the line. */
const fieldPath = (root: string, path: string) =>
  root + path.split('.').map((k) => (/^\d+$/.test(k) ? `?.[${k}]` : `?.${k}`)).join('');

function playwrightResponseCheck(c: ResponseCheck, name: string): string[] {
  if (!c.field) return [`await ${name};`];
  const v = fieldPath(`(await (await ${name}).json())`, c.field);
  return [`expect(${v})${c.equals !== undefined ? `.toBe(${JSON.stringify(c.equals)})` : c.above !== undefined ? `.toBeGreaterThan(${c.above})` : '.toBeDefined()'};`];
}

function cypressIntercept(c: ResponseCheck, name: string): string {
  const url = c.url.includes('*') ? quote(c.url) : `new RegExp(${quote(c.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))})`;
  return `cy.intercept({ ${c.method ? `method: ${quote(c.method)}, ` : ''}url: ${url} }).as(${quote(name)});`;
}

function cypressResponseCheck(c: ResponseCheck, name: string): string[] {
  const checks = [
    c.status !== undefined && `expect(response?.statusCode).to.eq(${c.status});`,
    c.field && `expect(${fieldPath('response?.body', c.field)})${c.equals !== undefined ? `.to.eq(${JSON.stringify(c.equals)})` : c.above !== undefined ? '.to.be.greaterThan(' + c.above + ')' : '.to.exist'};`,
  ].filter(Boolean);
  return checks.length ? [`cy.wait(${quote('@' + name)}).then(({ response }) => { ${checks.join(' ')} });`] : [`cy.wait(${quote('@' + name)});`];
}

/** Best locator first — the same order replay tries, so the code fails where replay would. */
function playwrightLocator(s: Step, warn: (w: string) => void): string {
  const scope = s.frameHint ? `page.frameLocator(${quote(`[id$="${s.frameHint}"]`)})` : 'page';
  if (s.role && s.name) return `${scope}.getByRole(${quote(s.role)}, { name: ${quote(s.name)}${s.exact ? ', exact: true' : ''} })`;
  // Not getByTestId: it only looks at data-testid unless the project reconfigures it.
  if (s.testId) return `${scope}.locator(${quote(`[${s.testIdAttr ?? 'data-testid'}="${s.testId}"]`)})`;
  if (s.name) return `${scope}.${NAME_LOOKUP[String(s.hints?.by)] ?? 'getByText'}(${quote(s.name)}${s.exact ? ', { exact: true }' : ''})`;
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
  /** Where the last action's code starts: a response wait is set up just before it. */
  let lastActionAt = -1;
  for (const [i, s] of flow.steps.entries()) {
    if (s.action === 'snapshot') continue;
    const startsAt = lines.length;
    const pageLevel = ['goto', 'wait_url', 'wait_text', 'wait_response', 'human'].includes(s.action) || (s.action === 'assert' && s.hints?.assert === 'title');
    const loc = pageLevel ? '' : narrow(s, pw ? playwrightLocator(s, warn) : cypressLocator(s, warn), pw, warn);
    const ref = valueRefsOf([s])[0];
    const value = ref ? (required.add(ref), envName(ref).replace(/^UNDERSTUDY_/, '')) : quote(s.value ?? (s.action === 'goto' ? s.url : ''));

    // Both frameworks spell it the same way.
    const force = forced(s) ? '{ force: true }' : '';

    switch (s.action) {
      case 'goto': lines.push(pw ? `await page.goto(${value});` : `cy.visit(${value});`); break;
      case 'fill': lines.push(pw ? `await ${loc}.fill(${value});` : `${loc}.type(${value});`); break;
      case 'select': lines.push(pw ? `await ${loc}.selectOption(${value});` : `${loc}.select(${value});`); break;
      case 'check': lines.push(pw ? `await ${loc}.check(${force});` : `${loc}.check(${force});`); break;
      case 'uncheck': lines.push(pw ? `await ${loc}.uncheck(${force});` : `${loc}.uncheck(${force});`); break;
      case 'press': lines.push(pw ? `await ${loc}.press(${value});` : `${loc}.type(${value});`); break;
      case 'upload': lines.push(pw ? `await ${loc}.setInputFiles(${value});` : `${loc}.selectFile(${value});`); break;
      case 'scroll_container':
        if (s.value === 'bottom' || s.value === 'top') {
          lines.push(pw
            ? `await ${loc}.evaluate((el) => { el.scrollTop = ${s.value === 'bottom' ? 'el.scrollHeight' : '0'}; });`
            : `${loc}.scrollTo('${s.value}');`);
        } else lines.push(pw ? `await ${loc}.scrollIntoViewIfNeeded();` : `${loc}.scrollIntoView();`);
        break;
      case 'wait_url':
        lines.push(pw
          ? `await page.waitForURL(${s.hints?.urlRegex ? matcher(s, 'urlRegex', 'urlFlags') : s.value?.includes('*') ? quote(s.value) : `(u) => u.href.includes(${value})`});`
          : `cy.url().should('${s.hints?.urlRegex ? 'match' : 'include'}', ${s.hints?.urlRegex ? matcher(s, 'urlRegex', 'urlFlags') : value});`);
        break;
      case 'assert': lines.push(assertion(s, loc, value, pw, warn)); break;
      case 'human': {
        // A person's step: say what, then wait for its sign — or pause.
        lines.push(`// A PERSON DOES THIS: ${(s.value ?? '').replace(/\n/g, ' ')}`);
        const t = typeof s.hints?.untilText === 'string' ? s.hints.untilText : undefined;
        const u = typeof s.hints?.untilUrl === 'string' ? s.hints.untilUrl : undefined;
        const r = humanUntil(s)?.response;
        if (r) {
          // The person acts after this line, so waiting here misses nothing.
          if (pw) lines.push(`const response${i} = page.waitForResponse(${responsePredicate(r)}, { timeout: 15 * 60_000 });`, ...playwrightResponseCheck(r, `response${i}`));
          else lines.push(cypressIntercept(r, `response${i}`), ...cypressResponseCheck(r, `response${i}`).map((l) => l.replace(/\)\.then/, ', { timeout: 15 * 60_000 }).then')));
        }
        if (pw) {
          if (u) lines.push(`await page.waitForURL(${u.includes('*') ? quote(u) : `(u) => u.href.includes(${quote(u)})`}, { timeout: 15 * 60_000 });`);
          if (t) lines.push(`await page.getByText(${quote(t)}).first().waitFor({ timeout: 15 * 60_000 });`);
          if (!u && !t && !r) lines.push('await page.pause();');
        } else {
          if (u) lines.push(`cy.url({ timeout: 15 * 60_000 }).should('include', ${quote(u)});`);
          if (t) lines.push(`cy.contains(${quote(t)}, { timeout: 15 * 60_000 });`);
          if (!u && !t && !r) lines.push('cy.pause();');
        }
        warn(`step "${s.value ?? 'human'}" needs a person — run this test headed, with someone there`);
        break;
      }
      case 'wait_text': lines.push(pw ? `await page.getByText(${value}).waitFor();` : `cy.contains(${value});`); break;
      case 'wait_response': {
        const check = responseCheckOf(s.value, s.hints);
        if (!check) break;
        // Set up BEFORE the action that triggers it, or a fast answer is missed.
        const name = `response${i}`;
        const setup = pw ? `const ${name} = page.waitForResponse(${responsePredicate(check)});` : cypressIntercept(check, name);
        const at = lastActionAt >= 0 ? lastActionAt : lines.length;
        lines.splice(at, 0, setup);
        if (lastActionAt >= 0) lastActionAt++;
        lines.push(...(pw ? playwrightResponseCheck(check, name) : cypressResponseCheck(check, name)));
        break;
      }
      default: lines.push(pw ? `await ${loc}.click(${force});` : `${loc}.click(${force});`);
    }
    if (!['wait_url', 'wait_text', 'wait_response', 'assert', 'human'].includes(s.action)) lastActionAt = startsAt;
  }

  const refs = [...required];
  // Values come from the environment, never the file.
  const preamble = refs.length ? refs.map((r) => `const ${envName(r).replace(/^UNDERSTUDY_/, '')} = process.env.${envName(r)} ?? '';`).join('\n') + '\n\n' : '';
  const header = `// ${flow.intent}\n// Generated by understudy from flow "${flow.app}/${flow.slug}". Regenerate rather than edit.\n\n`;
  const body = (indent: string) => lines.map((l) => indent + l).join('\n');
  const code = pw
    ? `import { test${lines.some((l) => l.includes('expect(')) ? ', expect' : ''} } from '@playwright/test';\n\n${header}${preamble}test(${quote(flow.title)}, async ({ page }) => {\n${body('  ')}\n});\n`
    : `${header}${preamble}describe(${quote(flow.title)}, () => {\n  it(${quote(flow.title)}, () => {\n${body('    ')}\n  });\n});\n`;
  return { framework, code, warnings, requiredValues: refs };
}
