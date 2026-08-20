/**
 * Emitters — print the IR as code.
 *
 * This closes the loop the whole project rests on: recordings are stored as
 * DATA, and code is an OUTPUT format, never an input one. Because the IR knows
 * `{action, role, name, value}`, the same flow can be printed as Playwright or
 * Cypress, with values swapped, without re-recording anything.
 *
 * TWO THINGS THE EMITTER REFUSES TO DO QUIETLY:
 *
 *   · A `value_ref` is NEVER inlined. The recording deliberately never stored
 *     the credential, and printing one into a file someone will commit would
 *     undo that at the last step. It emits a named reference instead.
 *   · A step it cannot address cleanly produces a WARNING alongside the line,
 *     rather than a plausible-looking locator. Generated code that looks right
 *     and is subtly wrong is worse than generated code that says so.
 */

import { getPool } from './db.js';

export type Framework = 'playwright-ts' | 'cypress-js';

export interface EmitResult {
  framework: Framework;
  code: string;
  warnings: string[];
  /** Refs the caller must supply — never inlined. */
  requiredValues: string[];
}

interface EmitStep {
  action: string;
  role: string | null;
  name: string | null;
  test_id: string | null;
  css: string | null;
  frame_hint: string | null;
  value_ref: string | null;
  args: Record<string, unknown>;
  semantic: string;
}

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** SECRET.password -> SECRET_PASSWORD, a shape that works as an env var. */
const refToConst = (ref: string) => ref.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();

/**
 * How to address the element, best first — the same order the executor uses, so
 * emitted code fails in the same places real execution does rather than
 * diverging.
 */
function playwrightLocator(step: EmitStep, warn: (w: string) => void): string {
  const scope = step.frame_hint
    ? `page.frameLocator(${quote(`[id$="${step.frame_hint}"]`)})`
    : 'page';

  if (step.role && step.name) {
    return `${scope}.getByRole(${quote(step.role)}, { name: ${quote(step.name)} })`;
  }
  if (step.test_id) {
    const attr = typeof step.args.testIdAttr === 'string' ? step.args.testIdAttr : 'data-testid';
    // Not getByTestId: it only consults `data-testid` unless the project
    // reconfigures it globally, and emitting code that depends on ambient
    // config is how a generated file works here and not there.
    return `${scope}.locator(${quote(`[${attr}="${step.test_id}"]`)})`;
  }
  if (step.name) return `${scope}.getByText(${quote(step.name)})`;
  if (step.css) {
    warn(`"${step.semantic}" is addressed only by CSS — brittle, and it will break on any markup change`);
    return `${scope}.locator(${quote(step.css)})`;
  }
  warn(`"${step.semantic}" has no usable locator; emitted as a TODO`);
  return `${scope}.locator('TODO')`;
}

function cypressLocator(step: EmitStep, warn: (w: string) => void): string {
  if (step.test_id) {
    const attr = typeof step.args.testIdAttr === 'string' ? step.args.testIdAttr : 'data-testid';
    return `cy.get(${quote(`[${attr}="${step.test_id}"]`)})`;
  }
  if (step.role && step.name) {
    // Cypress has no first-class role engine, so this is a real fidelity loss
    // rather than a formatting difference — say so rather than pretending.
    warn(`"${step.semantic}" used role+name, which Cypress cannot express; emitted as a text match`);
    return `cy.contains(${quote(step.name)})`;
  }
  if (step.name) return `cy.contains(${quote(step.name)})`;
  if (step.css) return `cy.get(${quote(step.css)})`;
  warn(`"${step.semantic}" has no usable locator; emitted as a TODO`);
  return `cy.get('TODO')`;
}

function valueExpression(step: EmitStep, required: Set<string>): string {
  if (step.value_ref) {
    required.add(step.value_ref);
    return refToConst(step.value_ref);
  }
  const literal = typeof step.args.value === 'string' ? step.args.value : '';
  return quote(literal);
}

export async function emitFlow(
  appSlug: string,
  flowSlug: string,
  framework: Framework = 'playwright-ts',
): Promise<EmitResult> {
  const { rows: flowRows } = await getPool().query<{
    flow_id: string; title: string; intent: string; needs_review: boolean; destructive: boolean;
  }>(
    `SELECT f.flow_id, f.title, f.intent, f.needs_review, f.destructive
     FROM flows f JOIN apps a ON a.app_id = f.app_id
     WHERE a.slug = $1 AND f.slug = $2`,
    [appSlug, flowSlug],
  );
  const flow = flowRows[0];
  if (!flow) throw new Error(`no flow '${flowSlug}' on app '${appSlug}'`);

  const { rows: steps } = await getPool().query<EmitStep>(
    `SELECT s.action, sel.role, sel.name, sel.test_id, sel.css, sel.frame_hint,
            s.value_ref, s.args, s.semantic
     FROM flow_steps fs
     JOIN steps s ON s.step_id = fs.step_id
     LEFT JOIN selectors sel ON sel.selector_id = s.selector_id
     WHERE fs.flow_id = $1 ORDER BY fs.ordinal`,
    [flow.flow_id],
  );

  const warnings: string[] = [];
  const required = new Set<string>();
  const warn = (w: string) => warnings.push(w);

  if (flow.needs_review) {
    warnings.push('this flow is flagged needs_review — it did not replay cleanly');
  }
  if (flow.destructive) {
    warnings.push('this flow is marked DESTRUCTIVE — running it commits a real action');
  }

  const lines: string[] = [];
  const pw = framework === 'playwright-ts';

  for (const step of steps) {
    // A goto addresses no element, so asking for a locator would both compute
    // nothing useful and emit a spurious "no usable locator" warning against a
    // step that is perfectly fine.
    const loc =
      step.action === 'goto' ? '' : pw ? playwrightLocator(step, warn) : cypressLocator(step, warn);
    const value = valueExpression(step, required);

    switch (step.action) {
      case 'goto':
        lines.push(pw ? `await page.goto(${value});` : `cy.visit(${value});`);
        break;
      case 'fill':
        lines.push(pw ? `await ${loc}.fill(${value});` : `${loc}.type(${value});`);
        break;
      case 'select':
        lines.push(pw ? `await ${loc}.selectOption(${value});` : `${loc}.select(${value});`);
        break;
      case 'check':
        lines.push(pw ? `await ${loc}.check();` : `${loc}.check();`);
        break;
      case 'uncheck':
        lines.push(pw ? `await ${loc}.uncheck();` : `${loc}.uncheck();`);
        break;
      case 'press':
        lines.push(pw ? `await ${loc}.press(${value});` : `${loc}.type(${value});`);
        break;
      case 'upload':
        lines.push(pw ? `await ${loc}.setInputFiles(${value});` : `${loc}.selectFile(${value});`);
        break;
      case 'scroll_container':
        // Cypress has no scrollIntoViewIfNeeded; `scrollIntoView` is the
        // closest real equivalent and scrolls the nearest scrollable ancestor
        // the same way. The 'bottom'/'top' form addresses the pane itself.
        {
        const edge = step.args.value;
        if (edge === 'bottom' || edge === 'top') {
          lines.push(
            pw
              ? `await ${loc}.evaluate((el) => { el.scrollTop = ${edge === 'bottom' ? 'el.scrollHeight' : '0'}; });`
              : `${loc}.scrollTo('${edge}');`,
          );
        } else {
          lines.push(pw ? `await ${loc}.scrollIntoViewIfNeeded();` : `${loc}.scrollIntoView();`);
        }
        }
        break;
      default:
        lines.push(pw ? `await ${loc}.click();` : `${loc}.click();`);
    }
  }

  const refs = [...required];
  // Values come from the environment, never from the file. This is the last
  // place a credential could leak back into something committable.
  const preamble = refs.length
    ? refs.map((r) => `const ${refToConst(r)} = process.env.${refToConst(r)} ?? '';`).join('\n') + '\n\n'
    : '';

  const body = lines.map((l) => `  ${l}`).join('\n');

  const code = pw
    ? `import { test } from '@playwright/test';\n\n` +
      `// ${flow.intent}\n` +
      `// Generated by understudy from flow "${flowSlug}". Regenerate rather than edit.\n\n` +
      preamble +
      `test(${quote(flow.title)}, async ({ page }) => {\n${body}\n});\n`
    : `// ${flow.intent}\n` +
      `// Generated by understudy from flow "${flowSlug}". Regenerate rather than edit.\n\n` +
      preamble +
      `describe(${quote(flow.title)}, () => {\n  it(${quote(flow.title)}, () => {\n${body
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n')}\n  });\n});\n`;

  return { framework, code, warnings, requiredValues: refs };
}
