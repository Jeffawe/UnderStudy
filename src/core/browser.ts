/**
 * A browser someone else may own.
 *
 * Replay and the live recorder each used to launch their own Chromium and close
 * it unconditionally. That is correct when they are the only thing running, and
 * it is exactly what blocks the two flows this module exists for:
 *
 *  - REPLAY A PRELUDE, THEN CAPTURE. Wizard progress is server-side, so it is
 *    not in `storageState` and cannot be restored the way a login can. The only
 *    way past an intake is to actually walk it — in the SAME context the
 *    recorder is about to capture from. Two browsers cannot share that state.
 *
 *  - HAND A STUCK RUN TO A HUMAN. The run's context must stay alive and paused
 *    while something else drives.
 *
 * So ownership becomes explicit: whoever launched the browser closes it, and a
 * borrower closes nothing. Getting this wrong in either direction is quiet —
 * a double close throws into a `.catch(() => {})`, and a missing close leaks a
 * Chromium per run until the box runs out of memory.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { StorageState } from './auth-cache.js';

export interface BrowserLease {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** True when this lease launched the browser and is therefore responsible for it. */
  owned: boolean;
  /** Close the browser — a no-op for a borrowed lease. */
  close(): Promise<void>;
  /**
   * Replace cookies and origin storage in place.
   *
   * Playwright has no `context.setStorageState()`, so this is the closest thing:
   * it restores what a fresh `newContext({ storageState })` would have, on a
   * context that already exists. It cannot restore in-page JS state — an open
   * modal, an unsaved form — because that lives in a document this does not
   * touch. Callers navigate afterwards and verify with `sig()`.
   */
  reseed(state: StorageState): Promise<void>;
}

/**
 * Restore origin storage on the next document, since it cannot be set from here.
 *
 * AUTHORED AS A STRING, for the reason `injected.ts` opens with: tsx/esbuild
 * rewrites function declarations to preserve their names via a `__name()`
 * helper, `addInitScript` serializes a closure with `.toString()`, and the
 * injected body then references a helper the browser does not have. It fails
 * silently — no storage restored, nothing logged.
 */
async function seedOriginStorage(context: BrowserContext, state: StorageState): Promise<void> {
  const origins = state.origins ?? [];
  if (!origins.length) return;

  // U+2028/U+2029 are legal in JSON strings; escaping them keeps the embedded
  // literal valid JavaScript regardless of how the script is later parsed.
  const payload = JSON.stringify(origins)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  await context.addInitScript(`
(() => {
  var origins = ${payload};
  var here = window.location.origin;
  for (var i = 0; i < origins.length; i++) {
    if (origins[i].origin !== here) continue;
    var items = origins[i].localStorage || [];
    for (var j = 0; j < items.length; j++) {
      try { window.localStorage.setItem(items[j].name, items[j].value); } catch (e) {}
    }
  }
})();
`);
}

function leaseFor(browser: Browser, context: BrowserContext, page: Page, owned: boolean): BrowserLease {
  return {
    browser,
    context,
    page,
    owned,
    async close() {
      if (!owned) return;
      await browser.close().catch(() => {});
    },
    async reseed(state: StorageState) {
      await context.clearCookies();
      if (state.cookies?.length) await context.addCookies(state.cookies);
      await seedOriginStorage(context, state);
    },
  };
}

export async function openLease(
  opts: { headless?: boolean; storageState?: StorageState } = {},
): Promise<BrowserLease> {
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const context = await browser.newContext(opts.storageState ? { storageState: opts.storageState } : {});
  const page = await context.newPage();
  return leaseFor(browser, context, page, true);
}

/** Borrow a context someone else opened. Closing it is their business, not ours. */
export function adoptLease(context: BrowserContext, page: Page): BrowserLease {
  return leaseFor(context.browser()!, context, page, false);
}
