# Status — 2026-08-06

Where the build actually is. `PLAN.md` is the architecture; this is the progress marker.

## Resume in 30 seconds

```bash
./scripts/db-start.sh                    # local node (dies with its shell otherwise)
./scripts/db.sh -e "SELECT count(*) FROM [SHOW TABLES];"    # expect 19
npm run typecheck                        # expect clean
```

```bash
npm run embedder:check                   # passes — model + DB round trip
npm run recall:check                     # passes — seeds 9 chunks, prints distances
```

Both pass. **The memory plane is proven end to end**: text → 1024-dim vector →
ANN index → ranked results, on real CockroachDB.

Next real thing: `understudy explore` on saucedemo, to replace the synthetic
fixture corpus with a real one.

---

## Done and verified

**Database — both targets, identical**

| | Local | Cloud |
|---|---|---|
| CockroachDB | v26.2.5 | v26.2.5 |
| Tables | 19 | 19 |
| `feature.vector_index.enabled` | `t` | `t` |
| `EXPLAIN` shows `• vector search` + `prefix spans` | ✅ | ✅ |

**Risk 1 is dead.** The plan's biggest fear — "free-tier cloud won't allow vector indexes, and it bites on Day 6" — was tested on day 1. Cloud Basic permitted `SET CLUSTER SETTING`, and the ANN plan on cloud is byte-identical to local. No fallback needed.

**Cloud cluster:** `spunky-faerie` · Basic · AWS us-east-1 · SQL user `jeffery` · capped at 50M RUs + 10 GiB = exactly the free allowance, so **max charge is $0**.

**Hackathon tools: 3 of 4** (needs 2)
- ✅ Distributed Vector Indexing — one ANN index over 9 chunk kinds, `app_id` prefix
- ✅ `ccloud` CLI — auth, create, list, user list, connection-string
- ✅ Cloud Managed MCP Server — authenticated, reading the real cluster
- ⬜ Agent Skills repo — stretch goal, nothing written

**Code written and RUN**
- `src/core/types.ts` — `Embedder` / `Distiller` / `Reasoner` interfaces
- `src/core/db.ts` — target resolution, pool, `tx()` with 40001 retry, `ensureMeta()`
- `src/adapters/embedder/local.ts` — mxbai via ONNX, 1.7s warm load
- `src/adapters/embedder/index.ts` — factory
- `src/adapters/embedder/check.ts` — ✅ all 5 gates pass
- `src/core/recall.ts` — ANN + re-rank + bindable/context split + gap detection
- `src/core/recall-check.ts` — ✅ seeds a fixture corpus, prints the distances
- `src/core/sig.ts` — page fingerprint; `urlPattern()` is pure and unit-tested
- `src/core/sig-check.ts` — ✅ stable across reloads, separates 3 states that
  share the title `Swag Labs` and two of which share a URL pattern
- `src/core/explore.ts` — BFS crawl, 3 refusal classes, writes pages/edges/
  selectors/facts + embedded chunks
- `src/core/explore-check.ts` — ✅ real saucedemo corpus in 10.4s:
  **6 pages · 18 edges · 15 selectors · 11 facts · 4 refusals**

**Playwright is now a dependency** (`^1.62.1`) and needs its own Chromium build
(1234) — the cached 1194/1228 from the sibling repo are not compatible.
`npx playwright install chromium`.

**Recorder (capture half) built and verified.**
`understudy record <slug>` opens a headed browser, captures via an injected DOM
listener, and writes `.understudy/recordings/<hash>.json`.
`understudy recordings [slug]` lists them. Persistence is content-hashed, so
re-saving an identical recording reports `existed: true` — that IS the
distillation cache CLAUDE.md asks for on day one.
Verified: round trip preserves the hash, **no credential reaches disk**
(passwords become `valueRef: SECRET.password`), an empty recording is refused
rather than saved (exit 2), and `.understudy/recordings/` is gitignored because
ordinary field values on a real app are customer data.

Captured on saucedemo: `goto → fill Username → fill Password → click Login →
click Add to cart → select`, with names matching `ariaSnapshot` ground truth.

**Script import built — `understudy import <slug> <file>`.**
Reads an existing Playwright script (codegen output OR a hand-written
`.spec.ts`) into the same `RawRecording` contract, via the **TypeScript
compiler AST** rather than regex — hand-written suites split chains across
lines, put parentheses in strings, and mix TS syntax in, none of which a regex
survives. (`typescript` moved from dev to runtime deps for this.)

Verified against the real sibling repo: `weight-loss-intake.spec.ts` → **76
events, 0 warnings**; `hair-loss-intake.spec.ts` → 75 events. Codegen-shaped
input → 11/11 including `getByTestId`, `locator(css)`, `selectOption`, `check`,
and correctly ignoring `expect(...)`.

Two things it gets right that matter:
- **`fill(MEMBER.email)` becomes `valueRef: 'MEMBER.email'`** — a non-literal
  argument is already the parameterised IR shape, for free.
- **A literal `secret_sauce` in a committed test is redacted** to
  `SECRET.password` before it can reach the corpus.

**A chain is scope + target, not one merged element.**
`page.getByRole('navigation').getByText('Login')` first flattened to
`role=navigation name="Login"` — an element that does not exist and a locator
that would never resolve on replay. The target is now the last addressing link;
earlier links are kept as `hints.scope`.

**Not yet built:** replay + tracing, and turning a recording into
`flows`/`steps` rows. A recording currently lands on disk and stops there.

**CLI built — `src/entry/cli.ts`, dependency-free arg parsing.**
`understudy explore <slug>` · `recall <slug> <goal>` · `record` / `test` (both
exit 2 with the specific reason they're blocked, rather than being hidden from
`--help` — a missing command should be discoverable, not invisible).
`npm run build` produces `dist/entry/cli.js` with the shebang intact and the
`bin` target resolves, so the package is installable and runnable now.
Base URL is remembered per app after the first `--url`. Verified against the
built artifact, not just `tsx`.

**Cloud proven end to end (2026-08-06).** `TARGET=cloud npm run explore:check`
wrote a full corpus to `spunky-faerie` — 8 pages · 33 edges · 15 selectors ·
13 facts · 13 chunks — and `recall()` against it returns distances **identical
to local** (`logout` 0.7374, `add to cart` 0.7315). Same embedder, same vector
space, both stores. Mode A's storage layer is no longer theoretical.

**Wiring gaps found and closed by audit:**
- `ensureMeta()` was only called by *check scripts* — the embedder guard was
  not on the real path. `explore()` now calls it before the first embed.
- `tx()` existed, typechecked, and was **never called**. Facts and their chunks
  were two separate statements; a crash between them leaves a fact `recall()`
  can never return — invisible, permanent, and nothing reports it missing. Now
  written in one transaction, with the embed OUTSIDE it so a slow model call
  doesn't hold a transaction open into 40001 territory.

**`explore` writes NO executable chunks — by design.** Every recall against the
explored corpus returns `bindable=0`, `topDistance=null`, `gap=YES`. Context
retrieval is good (0.76–0.78 on relevant facts); there is simply nothing to run.
Exploration learns the MAP; segments need recordings.

**The embedder guard is real, not decorative.** Positive controls confirm it
refuses a wrong embedder id and wrong dims, and accepts the correct pair.

**`recall()` verified:** the CTE form still plans as `• vector search` with
`prefix spans` — wrapping the ANN scan did not cost index acceleration. Known
queries rank the right segment first; kind filtering doesn't leak.

---

## Not built at all

- **No recorder, distiller, reasoner, or executor.** The entire upper half. The
  memory plane is done; nothing yet writes segments into it or reads them out.
- **Titan embedder** throws `not implemented` (intended — local ONNX is the
  decision for both modes).

## Next, in order

1. **Decide the sig sensitivity dial** (see open items) — it changes every page
   row already written, so settle it before the corpus grows.
2. **The recorder.** `explore` cannot produce segments, so nothing is bindable
   until recordings exist. This is now the critical path, not an optional extra.
3. **Re-derive `GAP_DISTANCE` / `GAP_MARGIN`** once segments exist. Current 0.92
   comes from 9 synthetic chunks — enough to prove 0.85 was too tight, not
   enough to ship.
4. **Binding** — prefer one flow covering ≥2 sub-goals; filter candidates on
   `start_state` / `preconditions` before ranking (see antonym note).

---

## Open items

- **MCP read-only unverified.** The write probe was blocked by Claude Code's own classifier before it reached CockroachDB, so the server's setting is still unconfirmed. You believe you set it read-only. Low urgency — only this session is connected, and the classifier blocks writes independently. Verify in the Console when convenient.
- **`sharp` CVEs** (high, no fix available) come in transitively via `@huggingface/transformers` for *image* preprocessing. We only embed text, so the path never executes. Revisit before publishing the package.
- **Index recommendation not taken.** CockroachDB suggested `CREATE INDEX ON memory_chunks (app_id) STORING (text, embedding)` to skip the lookup join after the ANN scan. Deliberately deferred — it duplicates every 1024-dim vector and there's no data yet to measure against. Regular indexes can be added later without the vector-index backfill problem.
- **Oracle ARM Playwright check** still unrun (`npx playwright install --with-deps chromium` on `129.213.113.8`).
- **Bedrock model access** still pending — blocks Mode A's distiller and reasoner, blocks nothing in Mode B.

---

- **saucedemo's cart is UNREACHABLE by exploration.** `.shopping_cart_link` is a
  CSS-icon anchor with empty inner HTML and `aria-label=null`, so it has no
  accessible name, so `classify()` refuses it as `unnamed`. Cart unreachable ⇒
  checkout unreachable. This is the refusal rule working *correctly*, and it is
  exactly the handoff the design intends — but it means **the checkout half of
  the demo corpus can only come from a recording.** Don't discover this on demo
  day.

- **`explore` is nondeterministic — and that is FINE, now that facts merge.**
  Two runs gave **6 pages / 18 edges / 11 facts** then **5 / 13 / 8**: BFS
  ordering and animation timing change which frontier gets reached before
  `maxPages` truncates.

  **Measured: runs never CONFLICT.** A second run against the same app produced
  **0 new statements** — variance shows up only as *missing* facts, never as
  disagreeing ones. So a repeat sighting is pure confirmation, and repeated
  explores should converge on fuller coverage than any single traversal.

  That only works if re-seen facts merge, which they did not — the second run
  wrote **8 duplicate rows**. Fixed: `explore` now `UPDATE`s
  `observed_count`/`last_verified_at` on `(app_id, statement)` and only inserts
  on a genuine miss, **skipping the embed call entirely on re-observation**.
  Verified over three runs: 8 rows stay 8 rows, `observed_count` reaches 3, no
  duplicates, no wasted embeds.

  Still true that a *snapshot* is needed for threshold calibration, since a
  given run may miss facts. Snapshot to `.understudy/fixtures/` when the time
  comes; don't chase determinism in the crawler.

- **Facts are now ONE PER CLAIM, keyed and merged on that key.** Three
  granularity mistakes were fixed in sequence, each exposed by reading the data
  rather than the code:

  1. *per-sig* → 5 near-identical "the /inventory.html page offers…" statements
     for 2 real pages. Not exact duplicates, so statement-dedupe missed them.
  2. *per-page* → one blob averaging 17 unrelated control names into a single
     embedding. Measured: `"where is the logout option"` scored **1.0111**
     against a statement literally containing the word Logout — past
     `GAP_DISTANCE`, so the system claimed ignorance of its own memory.
  3. *sourced from `sig.names`* → a hash input, alphabetically sorted and
     truncated to `TOP_N`. Opening a menu pushed real controls out of the
     page's own description. A fingerprint and a description want opposite
     things.

  Now: the full aria snapshot is read, grouped into claims
  (`#list-add-to-cart`, `#actions`, `#navigation`, `#external`), each carrying
  a stable `scope.key`. Facts merge on that key, restating in place and
  **re-embedding only when the text actually changed**. Verified: repeat runs
  add 0 rows, 8 re-observed, 0 embed calls.

  Retrieval after the split: `"logout"` **0.7374 KNOWN** (was 1.0111 gap),
  `"add a product to my cart"` 0.7315, `"social media"` 0.7130.

  **The claim grouping is a heuristic placeholder for the reasoner**; the claim
  KEYS and the merge are not — they exist so the reasoner's statements can be
  revised in place without duplicating rows.

- **A URL identifies a document, not a state.** Re-navigating to
  `current.url` before reading a queued state reloads it, which closes any menu
  — so revealed states became permanently unreachable and four consecutive runs
  found **zero** new facts. The frontier now carries `via: {role, name}`, the
  control to re-click after landing, and reveals are replayed.

- **In-page reveals need a settle delay before fingerprinting.**
  `waitForLoadState('domcontentloaded')` returns instantly when no navigation
  occurs, so the sig was taken mid-animation, matched the pre-click state, and
  the reveal was discarded as "changed nothing". That single race is why
  `Logout` never entered the corpus.
  Fixed with `waitForAriaStable()` — poll the accessibility tree until two
  consecutive reads match, instead of sleeping a constant sized for the worst
  case, so a click that reveals nothing costs one poll. The settled snapshot is
  passed to `computeSig(page, known)` so the tree isn't recomputed a third time
  per click.
  **Cost: ~60s, from 5s before any settling and 73s with a flat 600ms sleep.**
  Run-to-run variance is ±5s, so network latency to saucedemo now dominates and
  further tuning of the wait isn't worth it.

- **How sensitive should `sig()` be? UNSETTLED, and it matters now.** Adding an
  item to the cart flips a button label `Add to cart → Remove`, which changes
  the sig — so one inventory page produced **four** page rows (`#bf3dd322`,
  `#b885fc85`, `#8e6ebd3d`, `#415c49f0`). That burned most of a 10-page budget
  on variants of one page and fragments the graph.
  Yet the *menu-open* state genuinely is a different state — it's the only
  reason `Logout` and `Reset App State` were ever seen, which is where two
  boundary facts came from. So "less sensitive" is not automatically right.
  The dial is `TOP_N` and which roles feed the hash in `sig.ts`.
  Meanwhile all five product links collapse to ONE sig, which is probably
  correct for a route map but is the opposite behaviour — worth being deliberate
  about rather than accepting both by accident.

- **Antonym confusion is unsolved.** `"sign in to the app"` binds to **"Log out
  using the burger menu"** (0.9077) over **"Log in as a standard user"**
  (0.9201), and reports `gap=no` — so it would confidently run the opposite
  action. Embedding models put log-in and log-out ~0.01 apart because they share
  everything except polarity. `"test login"` and `"log the user out"` both rank
  correctly; the failure is specifically a *vocabulary mismatch* between the
  goal's words and the segment's title.

  The architecture's own answer is the vocabulary-grounded `decompose` step —
  the reasoner is handed segment/flow titles and rewrites the goal into them
  *before* recall runs, so the query should be "Log in as a standard user", not
  "sign in to the app". **Verify that actually holds once `decompose` exists.**
  If it doesn't, the fallback is enriching segment chunk text at ingest with
  `outcome` + `preconditions` (which segments have — they're `flows` rows), so
  "outcome: authenticated" separates from "outcome: session ended". That's an
  ingest-time decision: changing it later means re-embedding the corpus.

---

- **Accessible names ARE resolved authoritatively at capture time — in-page.**
  The first attempt resolved from Node after the event and lost a race it could
  not win: clicking usually destroys what you clicked ("Add to cart" becomes
  "Remove"; a submit re-renders), and an async `exposeBinding` call cannot block
  the page's default action. Pre-resolving on `mousedown` did not help either.

  The fix is what `playwright codegen` does: compute role and name **in the
  page, synchronously, at event time**. `dom-accessibility-api` is bundled to a
  13 KB IIFE (`npm run vendor:accname` → `accname-bundle.ts`, a committed
  constant so it works identically under `tsx`, in `dist`, and for anyone who
  installs the package) and injected ahead of the listener.

  **Playwright is the ground truth, not the spec** — these names are fed back to
  `getByRole(role, {name})` on replay. The library and Playwright disagree in
  exactly two measured places, and both are shimmed:
  - `input[type=password]` — ARIA gives it no implicit role so `getRole`
    returns null; Playwright calls it `textbox`
  - placeholder-only names — `computeAccessibleName` returns `""`; Playwright
    falls back to the placeholder. Without this, **every placeholder-labelled
    field in every recording would be unaddressable on replay.**

  **Verified 69/69** against `ariaSnapshot` across five saucedemo page states
  (login, inventory, menu-open, checkout, cart). Every recorded event now
  reports `resolution: 'accname'`; zero approximations.

## Recorder gotchas (each cost a debugging cycle)

- **`addInitScript` must take a STRING, never a TS closure.** esbuild/tsx
  rewrites functions to preserve names via a `__name()` helper, which gets
  serialized into the page and dies as `ReferenceError: __name is not defined`.
  It fails **silently** — zero events, nothing logged, unless a `pageerror`
  listener happens to be attached. Related: **backticks inside comments** in the
  injected script terminate the template literal.
- **`change` on a text input fires on BLUR.** Filling a login form emitted the
  username only when the password field took focus, and emitted the password
  **never** — nothing blurs the last field before submit. The final field of
  every form was silently dropped. Fixed with `input` + explicit flush (on blur,
  before any click, before Enter, and from Node before close).
- **The `name` ATTRIBUTE is not an accessible name.** It recorded saucedemo's
  Login button as `"login-button"`. And `textContent` of a `<select>` is every
  option concatenated — it produced `"Name (A to Z)Name (Z to A)Price (low to
  high)…"` as an element name.
- **saucedemo's login is a SAME-DOCUMENT navigation.** The init script does not
  re-run, so the in-page stamp counter continues across what look like separate
  pages. Stamps are per-document-lifetime, not per-URL — do not assume a fresh
  page means fresh stamps.

## Gotchas found today (not in the master plan)

- **CockroachDB `INT` is `bigint`, and node-postgres returns INT8 as a STRING**
  to avoid precision loss past 2^53. `"1024" !== 1024` silently broke the
  embedder guard on every run *after* the first — the first run took the INSERT
  path and never compared. Fixed globally in `db.ts` with a type parser, since
  every counter, ordinal, and health value in the schema has this type. Any new
  INT8 column large enough to exceed 2^53 would need that revisited.
- **transformers.js caches weights inside `node_modules`.** A plain `npm ci`
  throws away 337MB and re-downloads it. Pinned to `~/.understudy/models` via
  `env.cacheDir`; override with `UNDERSTUDY_MODEL_CACHE`. Warm load is 1.7s
  against 16s cold.
- **Don't `process.exit()` with the ONNX runtime loaded.** Its native threads
  are still live, and the process aborts with `libc++abi: mutex lock failed`,
  which buries the actual error above it. Set `process.exitCode` instead.
- **`memory_chunks.app_id` had no foreign key — FIXED.** It was the only table
  missing `REFERENCES apps(app_id) ON DELETE CASCADE`, so `DELETE FROM apps`
  cascaded pages/edges/selectors/facts and silently **orphaned every chunk**
  (20 had accumulated). `db/01-memory-chunks-fk.sql` applied to **both targets**
  and verified; `schema.sql` now declares it inline for fresh clusters. Cascade
  proven: dropping an app took its 9 chunks with it, 0 orphans left.

- **The optimizer will not use the ANN index on a small corpus, and that is
  correct.** After the migration refreshed statistics, `EXPLAIN` on the real
  recall query switched to `mc_ref_idx` + exact top-k — `estimated row count:
  11 (28% of the table)`. An exact sort over 11 rows beats an approximate
  search and is exact besides. **The index is fine**: hint it with
  `memory_chunks@mc_embed_idx` and the plan is `• vector search` + `prefix
  spans`. `recall:check` now asserts on the HINTED plan (capability) and merely
  reports the unhinted choice (a cost decision that should flip as the corpus
  grows). `recall()` itself is left unhinted deliberately — forcing ANN on a
  small corpus would be slower AND less accurate.

- **0.85 was too tight.** Measured knowns cluster ≤0.86 and unknowns ≥0.96;
  0.85 would have rejected `"test login"`. Now `GAP_DISTANCE = 0.92`, the
  midpoint of the observed empty band. Still provisional — see above.

- **The local node dies with the shell that started it.** Use `./scripts/db-start.sh` — it uses `nohup` + `disown`. This bit twice.
- **`ccloud cluster create` fails with `free trial is not active`** until billing is sorted in the Console. Not a syntax problem; the CLI gives no further detail and `ccloud billing` only exposes invoices.
- **The cluster auto-named itself `spunky-faerie`** — the name argument didn't take. Harmless, but scripts must not assume `understudy`.
- **mxbai is asymmetric.** Queries need `"Represent this sentence for searching relevant passages: "`, documents don't. This is why `Embedder` has `embedDocument`/`embedQuery` rather than one `embed()`. Getting it wrong doesn't error — retrieval just quietly degrades, which is the worst possible failure for a system whose confidence signal *is* the distance. Note the master plan chose Titan partly to avoid this; going local reintroduces it deliberately.
- **CockroachDB Cloud OAuth needs a browser**, which the Oracle box won't have. `understudy serve` will need a service-account API key instead. Nothing to do yet.
