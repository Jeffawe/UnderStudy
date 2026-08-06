/**
 * explore — learn an app by driving it, without a recording and without a human.
 *
 * THE RULE: click things that REVEAL, never things that COMMIT.
 *
 * Three refusal classes, and every refusal becomes a `boundary` fact — the
 * edge of what exploration dared to touch is itself knowledge worth storing,
 * and it's what later tells the planner "checkout exists, but I've never been
 * through it" rather than leaving a silent hole in the map.
 *
 * What this writes:
 *   pages       one row per distinct sig
 *   page_edges  from → to, via the selector that caused the transition
 *   selectors   observed_only — seen, never yet used by a real run
 *   facts       structure / capability / boundary / auth
 *   memory_chunks  the facts, embedded, so recall() can find them
 *
 * What it does NOT write: flows or segments. Those need intent, and intent
 * comes from a recording or the distiller. Exploration learns the MAP, not the
 * journeys.
 */

import { chromium, type Browser, type Page } from 'playwright';
import type { Embedder } from './types.js';
import { getPool } from './db.js';
import { computeSig, parseAria, type PageSig } from './sig.js';
import { toVector } from './recall.js';

/**
 * Refusal vocabulary. Substring matched against the accessible name, lowercased.
 *
 * Deliberately broad and deliberately dumb: a false refusal costs one unexplored
 * control and yields a boundary fact, while a false ACCEPT can place an order.
 * The asymmetry is the whole design. No model is consulted — a keyword list
 * that can be read and audited beats a judgment call that can't.
 */
const COMMIT_WORDS = [
  'pay', 'purchase', 'buy', 'order', 'checkout', 'confirm', 'submit order',
  'delete', 'remove account', 'reset', 'cancel subscription', 'deactivate',
  'destroy', 'archive', 'publish', 'send', 'invite', 'charge', 'subscribe',
];

const SESSION_ENDING_WORDS = ['logout', 'log out', 'sign out', 'signout'];

export type Refusal = 'commit' | 'session-ending' | 'unnamed';

/** Why exploration would refuse this control, or null to proceed. */
export function classify(role: string, name: string | null): Refusal | null {
  // No accessible name means there is nothing to reason about and nothing to
  // write down — it cannot be cleared, so it is never clicked.
  if (!name || !name.trim()) return 'unnamed';

  const n = name.toLowerCase();
  if (SESSION_ENDING_WORDS.some((w) => n.includes(w))) return 'session-ending';
  if (COMMIT_WORDS.some((w) => n.includes(w))) return 'commit';
  return null;
}

const CLICKABLE = new Set(['link', 'button']);

/** One canonical phrasing, so the same control set always yields the same text. */
const structureStatement = (pattern: string, title: string, controls: string[]): string =>
  `The ${pattern} page (titled "${title}") offers ${[...controls].sort().join(', ')}`;

export interface ExploreOptions {
  slug: string;
  baseUrl: string;
  /** Optional seeded auth. Exploration of a logged-out app sees almost nothing. */
  login?: { username: string; password: string };
  maxPages?: number;
  maxActionsPerPage?: number;
  headless?: boolean;
}

export interface ExploreResult {
  appId: string;
  pages: number;
  edges: number;
  selectors: number;
  /** Facts written for the first time. */
  facts: number;
  /** Facts already known — confirmed, counter bumped, no embed call spent. */
  reobserved: number;
  refusals: Array<{ page: string; name: string; why: Refusal }>;
}

interface FactRow {
  kind: 'structure' | 'capability' | 'boundary' | 'auth';
  statement: string;
  scope: Record<string, unknown>;
}

export async function explore(
  embedder: Embedder,
  opts: ExploreOptions,
): Promise<ExploreResult> {
  const {
    slug,
    baseUrl,
    login,
    maxPages = 12,
    maxActionsPerPage = 14,
    headless = true,
  } = opts;

  const pool = getPool();
  const origin = new URL(baseUrl).origin;

  const { rows: appRows } = await pool.query<{ app_id: string }>(
    `INSERT INTO apps (slug, name, base_url) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET base_url = excluded.base_url
     RETURNING app_id`,
    [slug, slug, baseUrl],
  );
  const appId = appRows[0]!.app_id;

  const browser: Browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const facts: FactRow[] = [];
  /** url_pattern -> union of interactive names seen across all its states. */
  const pageControls = new Map<string, Set<string>>();
  const pageTitles = new Map<string, string>();
  const refusals: ExploreResult['refusals'] = [];
  const pageIds = new Map<string, string>(); // sig -> page_id
  const selectorIds = new Map<string, string>(); // role|name -> selector_id
  let edgeCount = 0;

  /** Insert-or-fetch a page row. Pages are keyed by sig, not URL. */
  const upsertPage = async (s: PageSig): Promise<string> => {
    const cached = pageIds.get(s.sig);
    if (cached) return cached;
    const { rows } = await pool.query<{ page_id: string }>(
      `INSERT INTO pages (app_id, sig, url_pattern, title, requires_auth)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id, sig) DO UPDATE SET last_seen_at = now()
       RETURNING page_id`,
      [appId, s.sig, s.urlPattern, s.title, Boolean(login)],
    );
    const id = rows[0]!.page_id;
    pageIds.set(s.sig, id);
    return id;
  };

  /**
   * Selectors are per-APP and deduped on (role, name, frame_hint) — the same
   * "Add to cart" button is ONE row no matter how many pages or flows use it.
   * observed_only: explore saw it; no run has proven it works.
   */
  const upsertSelector = async (role: string, name: string): Promise<string> => {
    const key = `${role}|${name}`;
    const cached = selectorIds.get(key);
    if (cached) return cached;
    const { rows } = await pool.query<{ selector_id: string }>(
      `INSERT INTO selectors (app_id, role, name, fragility, observed_only)
       VALUES ($1, $2, $3, 'stable', true)
       ON CONFLICT (app_id, role, name, frame_hint)
         DO UPDATE SET last_seen_at = now()
       RETURNING selector_id`,
      [appId, role, name],
    );
    const id = rows[0]!.selector_id;
    selectorIds.set(key, id);
    return id;
  };

  const addEdge = async (from: string, to: string, via: string, kind: 'link' | 'reveal') => {
    if (from === to) return; // self-transition: the click revealed nothing new
    const { rowCount } = await pool.query(
      `INSERT INTO page_edges (app_id, from_page, to_page, via_selector, kind)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [appId, from, to, via, kind],
    );
    edgeCount += rowCount ?? 0;
  };

  // ---- authenticate, if given credentials ---------------------------------
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const landing = await computeSig(page);

  if (login) {
    await page.getByRole('textbox', { name: /user/i }).first().fill(login.username);
    await page.getByRole('textbox', { name: /pass/i }).first().fill(login.password);
    await page.getByRole('button', { name: /log ?in|sign ?in/i }).first().click();
    await page.waitForLoadState('domcontentloaded');

    const after = await computeSig(page);
    const worked = after.sig !== landing.sig;
    facts.push({
      kind: 'auth',
      statement: worked
        ? `The app authenticates from ${landing.urlPattern} using a username and password, landing on ${after.urlPattern}`
        : `Authentication from ${landing.urlPattern} did not change the page — the credentials may be wrong`,
      scope: { url_pattern: landing.urlPattern, authenticated: worked },
    });
  }

  // ---- breadth-first over page states -------------------------------------
  const start = await computeSig(page);
  const queue: Array<{ sig: PageSig; url: string }> = [{ sig: start, url: page.url() }];
  const visited = new Set<string>();

  while (queue.length && visited.size < maxPages) {
    const current = queue.shift()!;
    if (visited.has(current.sig.sig)) continue;
    visited.add(current.sig.sig);

    const fromId = await upsertPage(current.sig);

    // Accumulate controls per PAGE, not per sig. Pages are deliberately
    // state-granular — that's what edges connect, and it's how `Logout` behind
    // a menu gets discovered at all. Facts are not: one fact per sig produced
    // FIVE near-identical "the /inventory.html page offers…" statements for TWO
    // real pages, differing only by whether the menu was open or the cart had
    // an item. They aren't exact duplicates, so statement-dedupe can't catch
    // them, and they crowd each other out of retrieval — a query for
    // "add something to the cart" spent two of three context slots on variants
    // of the same fact. Union across states instead.
    const controls = pageControls.get(current.sig.urlPattern) ?? new Set<string>();
    for (const n of current.sig.names) controls.add(n);
    pageControls.set(current.sig.urlPattern, controls);
    pageTitles.set(current.sig.urlPattern, current.sig.title);

    const nodes = parseAria(await page.locator('body').ariaSnapshot());
    const candidates = nodes.filter((n) => CLICKABLE.has(n.role)).slice(0, maxActionsPerPage);

    for (const candidate of candidates) {
      const why = classify(candidate.role, candidate.name);

      if (why) {
        refusals.push({
          page: current.sig.urlPattern,
          name: candidate.name ?? '(unnamed)',
          why,
        });
        facts.push({
          kind: 'boundary',
          statement:
            why === 'unnamed'
              ? `A ${candidate.role} on ${current.sig.urlPattern} has no accessible name, so exploration could not identify or clear it`
              : `Exploration refused to click "${candidate.name}" on ${current.sig.urlPattern} because it looks ${why === 'commit' ? 'like it commits an action' : 'like it ends the session'}`,
          scope: { url_pattern: current.sig.urlPattern, control: candidate.name, refusal: why },
        });
        continue;
      }

      const name = candidate.name!;
      const selectorId = await upsertSelector(candidate.role, name);

      try {
        // Re-navigate rather than goBack(): back can restore a cached DOM whose
        // sig no longer matches what a fresh visit would produce, which would
        // poison the graph with edges that don't reproduce.
        if (page.url() !== current.url) {
          await page.goto(current.url, { waitUntil: 'domcontentloaded' });
        }

        const target = page.getByRole(candidate.role as 'link' | 'button', { name, exact: true }).first();
        if (!(await target.isVisible().catch(() => false))) continue;

        // Skip links that leave the app. Social links open a new tab, the
        // original page keeps rendering, and the sig shifts for unrelated
        // reasons — which minted edges that describe nothing real. Not a
        // refusal class: it isn't dangerous, it's just not this app.
        const href = await target.getAttribute('href').catch(() => null);
        if (href && /^https?:\/\//i.test(href) && new URL(href).origin !== origin) continue;

        await target.click({ timeout: 4000 });
        await page.waitForLoadState('domcontentloaded').catch(() => {});

        const next = await computeSig(page);
        if (next.sig === current.sig.sig) continue; // revealed nothing

        const toId = await upsertPage(next);
        // A url change is navigation; same url + different sig is in-page reveal.
        await addEdge(fromId, toId, selectorId, next.urlPattern === current.sig.urlPattern ? 'reveal' : 'link');

        if (!visited.has(next.sig)) queue.push({ sig: next, url: page.url() });
      } catch {
        // A control that won't click is not an error — it's a dead end in the
        // map. Exploration is best-effort by design.
      }
    }
  }

  await browser.close();

  // One structure fact per PAGE, built from the union of everything any of its
  // states offered. Sorted so the statement is stable when the same page is
  // re-explored in a different order — otherwise re-observation would miss and
  // insert a near-duplicate every run.
  for (const [pattern, controls] of pageControls) {
    // controls are carried in scope, not just baked into the prose, so a later
    // run can union against them instead of re-parsing English.
    facts.push({
      kind: 'structure',
      statement: structureStatement(pattern, pageTitles.get(pattern) ?? '', [...controls]),
      scope: { url_pattern: pattern, controls: [...controls].sort() },
    });
  }

  // ---- persist facts + embed them -----------------------------------------
  //
  // Dedupe by statement first. The same control recurs across several sigs of
  // one page (a cart badge changing splits the sig but not the page), so
  // "refused to click Logout" would otherwise be written once per variant —
  // and each duplicate costs an embed call and dilutes retrieval.
  const seen = new Set<string>();
  const unique = facts.filter((f) => {
    if (seen.has(f.statement)) return false;
    seen.add(f.statement);
    return true;
  });

  let factCount = 0;
  let reobserved = 0;
  for (const f of unique) {
    // RE-OBSERVATION, not re-insertion.
    //
    // Exploration is nondeterministic — BFS ordering and animation timing mean
    // two runs reach different frontiers. That is fine, and arguably useful:
    // repeated runs converge on fuller coverage than any single traversal.
    // But it only works if a fact seen again MERGES instead of duplicating.
    //
    // Measured: a second run against the same app produced 0 new statements
    // and 8 duplicate rows. Facts never conflict between runs — variance shows
    // up as missing facts, never as disagreeing ones — so seeing one again is
    // pure confirmation. Bump the counter, refresh the timestamp, and skip the
    // embed entirely, which is also the cheapest call in the loop to avoid.
    // Structure facts key on the PAGE, not the sentence. The control union is
    // run-scoped: a run that reaches fewer states builds a shorter list, which
    // would miss an exact-statement match and insert a near-duplicate — the
    // very bug per-page facts were meant to kill. Merge into the stored set so
    // coverage only ever grows, and re-embed only when it actually changed.
    if (f.kind === 'structure') {
      const pattern = f.scope.url_pattern as string;
      const { rows: prior } = await pool.query<{ fact_id: string; controls: string[] }>(
        `SELECT fact_id, coalesce(scope->'controls', '[]') AS controls
         FROM facts
         WHERE app_id = $1 AND kind = 'structure'
           AND scope->>'url_pattern' = $2 AND superseded_by IS NULL`,
        [appId, pattern],
      );

      if (prior.length) {
        const merged = [
          ...new Set([...(prior[0]!.controls ?? []), ...(f.scope.controls as string[])]),
        ].sort();
        const grew = merged.length > (prior[0]!.controls ?? []).length;
        const statement = structureStatement(pattern, pageTitles.get(pattern) ?? '', merged);

        await pool.query(
          `UPDATE facts
             SET observed_count = observed_count + 1, last_verified_at = now(),
                 statement = $2, scope = jsonb_set(scope, '{controls}', $3::JSONB)
           WHERE fact_id = $1`,
          [prior[0]!.fact_id, statement, JSON.stringify(merged)],
        );

        // Only pay for an embed when the text actually moved.
        if (grew) {
          const vec = await embedder.embedDocument(statement);
          await pool.query(
            `UPDATE memory_chunks SET text = $2, embedding = $3::VECTOR(1024), updated_at = now()
             WHERE app_id = $1 AND kind = 'fact' AND ref_id = $4`,
            [appId, statement, toVector(vec), prior[0]!.fact_id],
          );
        }
        reobserved++;
        continue;
      }
    }

    const { rows: existing } = await pool.query<{ fact_id: string }>(
      `UPDATE facts
         SET observed_count = observed_count + 1, last_verified_at = now()
       WHERE app_id = $1 AND statement = $2 AND superseded_by IS NULL
       RETURNING fact_id`,
      [appId, f.statement],
    );
    if (existing.length) {
      reobserved++;
      continue;
    }

    const { rows } = await pool.query<{ fact_id: string }>(
      `INSERT INTO facts (app_id, kind, statement, scope, source, confidence)
       VALUES ($1, $2, $3, $4, 'explored', 0.5)
       RETURNING fact_id`,
      [appId, f.kind, f.statement, JSON.stringify(f.scope)],
    );
    const factId = rows[0]!.fact_id;

    // embedDocument, not embedQuery — this text is being STORED.
    const vec = await embedder.embedDocument(f.statement);
    await pool.query(
      `INSERT INTO memory_chunks (app_id, kind, ref_id, text, meta, embedding)
       VALUES ($1, 'fact', $2, $3, $4, $5::VECTOR(1024))`,
      [appId, factId, f.statement, JSON.stringify({ fact_kind: f.kind, ...f.scope }), toVector(vec)],
    );
    factCount++;
  }

  return {
    appId,
    pages: pageIds.size,
    edges: edgeCount,
    selectors: selectorIds.size,
    facts: factCount,
    reobserved,
    refusals,
  };
}
