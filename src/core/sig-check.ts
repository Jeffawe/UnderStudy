/**
 * Smoke test for sig() against the real saucedemo.
 *
 *   npm run sig:check
 *
 * The two properties that matter, and they pull in opposite directions:
 *   STABLE    — same page twice must produce the same sig, or every run looks
 *               like flow drift and the page graph never converges.
 *   SENSITIVE — genuinely different states must produce different sigs, or the
 *               executor can't tell "logged in" from "bounced to login".
 *
 * Also checks urlPattern() normalization, which has no browser dependency.
 */

import { chromium } from 'playwright';
import { computeSig, urlPattern } from './sig.js';

const BASE = 'https://www.saucedemo.com';

async function main() {
  // Pure-function checks first — no browser needed, fail fast.
  const patterns: Array<[string, string]> = [
    [`${BASE}/inventory.html`, '/inventory.html'],
    [`${BASE}/inventory-item.html?id=4`, '/inventory-item.html'],
    [`${BASE}/orders/1043/receipt`, '/orders/:id/receipt'],
    [`${BASE}/u/3f2a9c1b-1111-2222-3333-444455556666`, '/u/:id'],
    [`${BASE}/`, '/'],
  ];
  console.log('urlPattern:');
  let patternsOk = true;
  for (const [input, expected] of patterns) {
    const got = urlPattern(input);
    const ok = got === expected;
    patternsOk &&= ok;
    console.log(`  ${ok ? 'ok  ' : 'WRONG'} ${input.replace(BASE, '')} -> ${got}`);
  }
  console.log(`  ${patternsOk ? 'all normalize correctly' : 'NORMALIZATION BROKEN'}\n`);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  const at = async (url: string) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return computeSig(page);
  };

  // STABLE — the same page, loaded twice
  const a1 = await at(`${BASE}/`);
  const a2 = await at(`${BASE}/`);
  console.log('stability (login page loaded twice):');
  console.log(`  ${a1.sig}`);
  console.log(`  ${a2.sig}`);
  console.log(`  ${a1.sig === a2.sig ? 'ok — stable' : 'WRONG — sig is not reproducible'}\n`);

  // SENSITIVE — the auth bounce. Same URL family, same title, different state.
  const bounced = await at(`${BASE}/inventory.html`);
  console.log('sensitivity (unauthenticated /inventory.html):');
  console.log(`  login   ${a1.sig}  title="${a1.title}"`);
  console.log(`  bounced ${bounced.sig}  title="${bounced.title}"`);
  console.log(
    `  ${bounced.sig !== a1.sig ? 'ok — distinguished despite identical title' : 'WRONG — collided'}\n`,
  );

  // SENSITIVE — the real inventory page, after logging in
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Username' }).fill('standard_user');
  await page.getByRole('textbox', { name: 'Password' }).fill('secret_sauce');
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL('**/inventory.html');
  const inventory = await computeSig(page);

  console.log('authenticated inventory:');
  console.log(`  ${inventory.sig}`);
  console.log(`  landmarks: [${inventory.landmarks.join(', ')}]`);
  console.log(`  names:     ${inventory.names.slice(0, 6).join(', ')}`);
  const distinct = new Set([a1.sig, bounced.sig, inventory.sig]).size === 3;
  console.log(`  ${distinct ? 'ok — three states, three sigs' : 'WRONG — states collided'}`);

  await browser.close();
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
