# Status — 2026-08-13

Where the build actually is. `PLAN.md` is the architecture; this is the progress
marker. **If you are here to ACT as the reasoner rather than to build, read
`REASONER.md` instead** — this file is about how far the build has got.

## Resume in 30 seconds

```bash
PATH="/opt/homebrew/bin:$PATH" ./scripts/db-start.sh   # cockroach is not on a bare PATH
npm run typecheck && npm run build                     # expect clean
npx tsx src/entry/cli.ts test providernow "start a weight loss plan" \
  --sub-goal "log in as a member" --sub-goal "choose the weight loss service" --dry-run
```

That last command is the end-to-end proof: it binds two segments that came from
**different recordings** and reports the seam between them. If it prints
`dry run — plan is executable`, the whole stack is alive.

**Mode B is live.** The `understudy` MCP server is registered in `.mcp.json` and
exposes nine tools; the host agent is the reasoner and the distiller. Mode A
(Bedrock) is written but has never made a real call — model access is still
pending.

**Two corpora.** `saucedemo` (synthetic, first corpus, has known data defects —
see below) and `providernow` (real telehealth app on `localhost:3000`, 19
segments across three services, built this session).

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

**Replay + signal capture built — `understudy replay <hash>`.**
Walks the IR headless, and **this step-walker IS the executor's step-walker** —
running a recording and running a bound plan are the same operation, so it is
not scaffolding.

Does three jobs: verifies the recording reproduces (`needsReview`, exit 3, never
promoted), captures per-step `sig()` + console + `pageerror` + failed requests +
non-2xx bodies, and proves each locator still resolves. Every signal is tagged
with the step it fired during — a 500 is noise, a 500 *during checkout* is a
finding.

Verified on saucedemo: 5/5 steps, and the sigSequence
`/#6aeef289 → /inventory.html#bf3dd322 → /inventory.html#b885fc85` **matches the
fingerprints explore recorded independently**. Credentials are supplied at
replay (`--value SECRET.password=…`); without them the run fails loudly and
prints exactly which refs it needs, rather than filling empty strings.

Two things replay found immediately:
- **`getByTestId` only looks at `data-testid`.** saucedemo uses `data-test`, so
  every step resolved to nothing. Recordings now store `testIdAttr` and replay
  builds an explicit attribute selector rather than relying on ambient config.
- **Ambiguity is not success.** `"Add to cart"` is the accessible name of SIX
  buttons; the step passed only by `.first()`, which would pick a different
  product the moment the list reorders. Replay now detects `matched > 1`,
  disambiguates via the captured test id, and records
  `ambiguousByName` — which is exactly what `selectors.fragility` needs.

**Mechanical ingest built — `understudy ingest <hash>`. `recall()` NOW RETURNS
`bindable=1`, for the first time.**
Replay-then-write in one command: one `flow` (`source='recorded'`), its `steps`,
`flow_steps` membership, selector dedupe, and one embedded chunk.

```
"log in to the app"   top=0.8425   verdict: known — would bind and run
BINDABLE (1)  [flow] Recorded flow on saucedemo: Go to …; Fill the textbox …
```

- **The gate holds:** a recording that fails replay gets a flow row with
  `needs_review=true` and **no chunk**, so `recall()` can never surface it.
  `--force` writes it anyway and it stays unbindable.
- **Idempotent** on `recording_hash` — re-ingesting updates in place; 1 flow,
  5 flow_steps, 1 chunk after repeated runs.
- **Selectors are shared with explore**: an element explore only *observed*
  becomes `observed_only=false` once a replayed step *proves* it.
- **Chunk text is enumerative, not intentional** — "Recorded flow on saucedemo:
  Go to …; Fill the textbox "Username"…". Mechanical ingest knows what a flow
  *does*, not what it is *for*; claiming "log in as a member" would be inventing
  intent. The distiller replaces this text and re-embeds in place.
- Credentials stay references: `steps.value_ref = SECRET.password`, literal
  values live in `steps.args`.

**`UNIQUE (app_id, role, name, frame_hint)` WAS INERT — fixed in
`db/02-selector-frame-hint-not-null.sql`, applied to both targets.**
`frame_hint` was NULL for nearly every element, and SQL never treats NULL as
equal to NULL, so the unique index constrained almost nothing and
`ON CONFLICT DO UPDATE` never fired. Observed: "Add to cart" x3, "Login" x2,
"Username" x2. That silently breaks the property the whole health model rests
on — one row per element. Split across duplicates, a failing element never
reaches the quarantine threshold and never heals consistently.
`frame_hint` is now `NOT NULL DEFAULT ''` ('' = main frame), duplicates merged
with references repointed, and explore/ingest both write `''`. Verified: 0
duplicate groups after a full explore + ingest cycle.
**Migration ordering matters** — normalize AFTER deduping, or setting `''`
creates the very collision it is trying to remove.

**Distillation handshake built — `understudy distill <hash>` / `--save <file>`.**
Exercised end to end with the host agent (me) as the Mode B distiller. No
Bedrock needed to validate the shape.

**THE MODEL ANNOTATES; IT DOES NOT AUTHOR STEPS.** The request hands over
numbered, replay-verified steps and the answer may only reference them BY
INDEX. A distillation can partition and name; it cannot fabricate a selector or
invent an action. That constraint is what makes it safe to let an agent do this
at all — and `DistilledSegment.stepRange` was always this shape.

The request also carries `sigAfter` per step, which makes segment boundaries
obvious: steps 0–3 all end on `/#6aeef289`, step 3 transitions to
`/inventory.html` — so the cut is after step 3, visible without guessing.

**Validation is the SERVER's job.** A malformed answer writes nothing and
returns every problem at once. Verified against a deliberately bad file — all
6 caught: empty intent, non-array preconditions, non-kebab slug, out-of-range
`stepRange`, duplicate slug, inverted range.

**Retrieval improvement is the whole point** — intent text vs enumerated steps:

| query | mechanical | distilled segment |
|---|---|---|
| `log in to the app` | 0.8425 | **0.7062** |
| `sign in with username and password` | 0.8278 | **0.6716** |
| `add a product to the cart` | 0.7708 | **0.6936** |
| `put an item in my basket` | — | **0.8120** |

The last one matters most: "basket" appears nowhere in the corpus, and it still
binds. That is meaning, not keywords.

**Segments share the parent's step rows** — `flow_steps` doing its job.
Verified stable over 3 consecutive re-ingests: `steps=5, flows=3`, sliced
memberships 5/5 shared with the parent. A login block cut from a checkout
recording is literally reusable, not aspirationally.

**And the seam already chains:** `log-in-as-standard-user` ends at
`/inventory.html#bf3dd322`; `add-product-to-cart` starts at
`/inventory.html#bf3dd322`. That is rung 1 of seam resolution (sig match →
concatenate, 0 bridging steps) confirmed on real data.

### Four bugs this uncovered, all in the re-ingest path

- **Parent lookup returned segments.** Segments carry the SAME `recording_hash`
  as their parent, so `WHERE recording_hash = $2` matched all three rows and
  `existing[0]` was sometimes a SEGMENT — which then received the parent's
  steps, tore down the wrong children, and died on a foreign key the run after.
  Fixed with `AND source = 'recorded'`. **Root cause of the other three.**
- **Segment `start_state` was off by one** — it used the sig AFTER the
  segment's first step instead of the state it begins FROM. Seam resolution
  matches `A.end_state` against `B.start_state`, so this made every segment
  uncomposable.
- **Orphaned step rows** — re-ingest inserted a new generation and left the old
  one unreferenced (10 rows for a 5-step flow).
- **Teardown/GC ordering.** Collecting garbage while old segment memberships
  still existed let dead steps survive, after which rebuilt segments pointed at
  a different generation than the parent — silently un-sharing them. Now the
  entire previous generation is torn down and collected BEFORE anything is
  written.

**Vocabulary built — `src/core/vocabulary.ts`, used at BOTH ends.**
`fetchVocabulary(appId)` returns existing segment slugs/titles/intents, flow
titles, and facts (boundary facts first). It is deliberately one function for
two callers:
- **distill time** — so a second recording of the same login block reuses the
  existing name instead of minting a synonym. Two segments meaning one thing
  compete for the same bind slot and quietly break "reusable by every future
  flow".
- **test time** — so `decompose` can rewrite a goal INTO this vocabulary before
  recall runs. That is the documented answer to the polarity problem: the
  measured difference between `"what did exploration refuse"` (works) and
  `"what should I avoid clicking"` (fails) is purely whether the query speaks
  the corpus's language.

Verified: the second distillation of the same recording is handed both existing
segments with their exact slugs and intents.

**MCP entry point built — `src/entry/mcp.ts`, `understudy-mcp` bin.**
Five tools: `understudy_recordings`, `understudy_distill`,
`understudy_save_distilled`, `understudy_recall`, `understudy_vocabulary`.

Full handshake exercised over real stdio MCP:

| | result |
|---|---|
| distill without the credential | refuses, and returns `needsValues: ["SECRET.password"]` |
| distill with it | `needs_distillation` + 5 verified steps + vocabulary |
| save a malformed answer | `isError`, every problem listed, **nothing written** |
| save a valid answer | ingested, 2 segments, bindable |
| distill again | `already_distilled` — cache short-circuits, asks nothing |

**The agent does not drive; it is consulted.** Every tool is one half of a
handshake, never a step in a loop — PLAN.md's reason being that eighty MCP
round-trips would consume the context window the user is working in.
`stdout` is the protocol channel, so all logging goes to `stderr`.

**Runs, findings, lessons and run-inferred page edges built — `src/core/run.ts`.**
Replay was already collecting console errors, non-2xx bodies, failed requests
and round-trip mismatches on every execution and then **throwing them away**,
which made "detection is free, judgment is the reasoner" untrue. Now:

- **`runs` / `run_events`** — every ingest records the replay that verified it.
  `sig_sequence` is the flow-drift baseline: you cannot diff against last week
  unless last week was recorded. Verified: 5 events, all with `step_id`, 4 with
  `selector_id` (the `goto` has no element — correct).
- **`findings`** — deduped by fingerprint ACROSS runs. Verified with three runs
  whose ids and line numbers differed each time: `orders/8891`, `orders/4402`,
  `orders/7317` all normalize to `orders/:id`, so it is **1 finding at 3
  occurrences**, not 3 findings. Severity is mechanical (5xx and `pageerror`
  high, console low, persistence medium); triage stays a human call.
  The generated round-trip assertion caught a field silently reformatting
  `555-1234` → `5551234`.
- **`lessons`** — persisted with the structured trigger predicate
  (`{url_pattern, action, role, name}`), `source='distilled'`, linked to its
  flow through `lesson_links`. Matched by EXACT trigger at execution time, which
  is why the trigger is JSON and not prose.
- **`page_edges kind='inferred_from_run'`** — the sig sequence IS a set of
  observed transitions, so every run now grows the route map:
  `/#6aeef289 → /inventory.html#bf3dd322` **via Login**, then
  `→ /inventory.html#b885fc85` **via Add to cart**. Correctly attributed to the
  control that caused each transition.

### Two bugs found here

- **`xmax` does not exist in CockroachDB.** `RETURNING (xmax = 0) AS inserted`
  is the standard PostgreSQL "was this an insert?" trick and it throws
  `UndefinedColumn` here. It was a **latent crash** — invisible until a run
  actually captured a signal. Replaced with `RETURNING occurrences`, which is
  portable: the column defaults to 1 on insert and is incremented on conflict.
- **`page_edges.via_selector` is implicitly NOT NULL** because it is part of
  `PRIMARY KEY (app_id, from_page, to_page, via_selector)`. The schema's model
  of an edge is "A → B **via this control**", not merely "A → B". An observed
  transition whose cause cannot be named is therefore not representable and is
  skipped — which is why a bare `replay` contributes no edges while an `ingest`
  (which knows each step's selector) does.

**Macro mining built — `src/core/macros.ts`, `understudy mine <slug>`, and it
runs automatically at ingest.**
Steps carry `fingerprint = sha1(action|role|name|url_pattern)`, so two
recordings doing the same thing produce byte-identical runs. Mining finds runs
of ≥3 appearing in ≥2 flows.

**Contiguous runs, not subsequences.** The master plan says "common
subsequences", but a macro has to be RUNNABLE and a non-contiguous subsequence
is a pattern with holes. This finds common *substrings*.

**It defers to named segments.** A mined macro can only describe itself
mechanically ("a block that recurs"), which retrieves far worse than a real
intent — so if a distilled segment already covers exactly that fingerprint run,
mining bumps its `used_by` and creates nothing. Verified on 3 recorded flows:

```
5 steps x2   mined macro-1d421029-5
4 steps x3   already named "log-in-as-standard-user" — used_by updated, no macro created
```

Both are reported because they cover **different flow sets** — the login block
genuinely recurs more widely than login+sort, so neither subsumes the other.
The macro shares all 5 of its steps with the recordings (another view over the
same rows, never a copy).

This is the deterministic backstop for distillation: a distiller only ever sees
ONE recording, so it cannot know this one opens with the same block as the last
three. Vocabulary helps it notice; mining notices regardless.

### Three bugs found here

- **`UNIQUE (app_id, role, name, frame_hint)` was STILL inert.** Migration 02
  made `frame_hint` NOT NULL and I stopped there — but `role` and `name` were
  also nullable, and saucedemo's sort dropdown genuinely has no accessible name.
  Every ingest inserted another `combobox / NULL` row; four of them, one
  element, four health scores, none of which would ever reach quarantine.
  **When a UNIQUE constraint spans several columns, EVERY one must be NOT NULL
  or the constraint is decorative.** Fixed in
  `db/04-selector-role-name-not-null.sql`, applied to both targets.
- **Run history blocked re-ingest.** `run_events.step_id` referenced `steps`
  with the default RESTRICT, so replacing step rows failed the moment anything
  had recorded a run — which, now that ingest records its own verifying run, was
  immediately. `db/03-run-events-detach.sql` makes both links `ON DELETE SET
  NULL`: a run event is a historical record, and its outcome, error, sig,
  timings, console and network stay true without the pointer.
- **Plain `ingest` silently discarded a distillation.** The teardown removed
  segments unconditionally, so re-ingesting an already-distilled recording left
  it with only enumerated text — and then mining "discovered" the login block
  whose name had just been deleted. `ingestRecording` now falls back to the
  cached distillation: a recording that has been distilled stays distilled.

**Planning + execution built — `understudy test <slug> "<goal>"`.**
`src/core/plan.ts` (bind, seams, safety gate) and `src/core/execute.ts`.

**There is ONE executor.** Rather than write a second step walker, `execute`
reconstructs IR steps out of the database into exactly the shape `replay()`
already consumes. Everything replay learned the hard way — ambiguity detection,
`testIdAttr`, settle-before-fingerprint, the round-trip assertion, signal
correlation — applies to real execution for free and cannot rot separately.

Working end to end:

```
SUB-GOAL "log in to the app"
  bound  0.7062  log-in-as-standard-user (4 steps)
SUB-GOAL "add a product to the cart"
  bound  0.5688  add-product-to-cart (1 steps)
SEAM contiguous — states match, no bridging steps
EXECUTED log-in-as-standard-user -> add-product-to-cart
  PASSED in 1.4s
  path: /#6aeef289 -> /inventory.html#bf3dd322 -> /inventory.html#b885fc85
```

**BINDING IS NOT RETRIEVAL — and this is the polarity fix, working.**
`recall()` proposes by meaning; binding decides what is LEGAL from where
execution is. Asked for `"add a product to the cart"` from a fresh browser, the
CLOSEST match is rejected and a worse-scoring one wins:

```
bound   0.6650  fill-username-...-login-e4f3fd  (logs in first)
reject  0.5688  add-product-to-cart — requires "authenticated" but state is "not authenticated"
```

Initial state defaults to `['not authenticated']` because a fresh browser
context has no cookies — a fact about how execution begins, not an assumption.
Without it the first sub-goal is judged against "we know nothing" and a segment
requiring auth binds as step one, then fails on a locator that was never going
to be there.

**Safety gate verified in both directions:** a destructive plan exits 5 with
`BLOCKED` naming the offending flow; `--allow-purchases` runs it. It fails
closed — no configured environment means "we do not know if spend is allowed",
which must not read as permitted.

### Bugs found here

- **Repeatable flags were never repeatable.** `parseArgs` stored flags in a
  `Map<string, value>`, so `--sub-goal a --sub-goal b` planned only `b`. That
  also means **`--value` could never have supplied more than one credential** —
  it only ever appeared to work because we passed one. Values now accumulate
  per key.

### A safety hole worth naming

Marking only a SEGMENT destructive did not block the plan: `recall()`'s +0.50
destructive penalty pushed it down the ranking, the planner bound a
differently-labelled flow that **does the same thing**, and the plan never
registered as destructive. **The penalty can route around the gate.**
Destructive marking must be consistent across a flow and the segments cut from
it, or the gate is advisory. Ties into destructive inference signals 2–5 still
being unimplemented — today only commit-word matching runs, and it never looked
at "Add to cart".

**Reasoner adapter built — `src/adapters/reasoner/host-agent.ts` +
`src/core/session.ts` + `understudy_run_plan` / `understudy_resume_run`.**

The stateful half of the handshake. Unlike distillation (no live state, so a
clean two-call split that survives a restart), a run holds an OPEN BROWSER on a
particular page — that cannot be serialised, so the process holds the promise
and a dead process abandons its runs. Deliberate trade, not an oversight.

`HostAgentReasoner` computes nothing: it writes a pending `context_requests`
row and returns a promise that resolves when `resume_run` arrives. The executor
never learns which adapter it has — it writes `await reasoner.decompose(...)`
and in Mode A that resolves from Bedrock in ~2s, here in however long the agent
takes. **A tool call never blocks on a human**: `startRun` races the pipeline
against its own next suspension and returns whichever comes first.

Verified over real stdio MCP:

```
1. run_plan("sign in and put something in my basket")
     → needs_decision, requestId, + the app's vocabulary
2. resume_run({ subGoals: [...] })
     → bound, seam contiguous, EXECUTED, passed=true
     → path /#6aeef289 -> /inventory.html#bf3dd322 -> /inventory.html#b885fc85
3. answering the same request twice → isError, "no run is waiting on request …"
```

**VOCABULARY GROUNDING MEASURABLY WORKS** — the same two sub-goals, phrased in
the user's words vs the corpus's:

| query | distance |
|---|---|
| `log in to the app` | 0.7062 |
| `Sign in to the app with a username and password` | **0.6251** |
| `add a product to the cart` | 0.5688 |
| `Put an item into the shopping cart from the product list` | **0.4124** |

That is the documented fix for the polarity problem, working end to end: the
reasoner rewrites the goal INTO the vocabulary before recall runs, and
retrieval improves sharply. Combined with the precondition filter at bind time,
both halves of the answer are now in place.

**Schema note:** `context_requests` has no `answered_at` column — `status` plus
the stored `answer` is the record. The first draft wrote to it and would have
failed silently inside its own catch.

**Seam ladder built — `src/core/seams.ts`. Rungs 1–4 resolve; rung 5 refuses.**
A seam now produces STEPS that actually execute, rather than only describing
itself. Each rung is more speculative than the last, so the first that answers
wins. Verified against the real corpus:

| rung | case | result |
|---|---|---|
| 1 | identical states | `contiguous` — 0 steps |
| 2 | `/#6aeef289 → /inventory.html#b885fc85` | chained **two** segments, spliced 5 steps |
| 3 | `/inventory.html#b885fc85 → /inventory-item.html#0128d5ba` | `click link "Sauce Labs Fleece Jacket"` |
| 4 | `/inventory.html → /cart.html` | `goto https://www.saucedemo.com/cart.html` |
| 5 | same route, unknown state | **unresolved — refuses to guess** |

**Rung 3 is the one that pays for exploration.** That pair of page states was
never visited together by any recording — the connection came from
`page_edges`, as a graph query rather than a browser session, and it emitted the
control that bridges them.

**Escalation is real, not decorative:** a case built to test rung 3 was answered
at rung 2 instead, because a known segment covered that exact gap. A named
segment beats a bare click, and the ladder picked correctly without being told.

**An unresolved seam BLOCKS execution.** `executePlan` throws rather than
running the two halves back to back — otherwise the second flow starts from a
state it was never recorded in, which is how a plan quietly does the wrong thing
instead of failing.

**Flow drift + the expectation check built — `src/core/drift.ts`.**

**"Am I where I expected to be?"** Both sides of that comparison already existed
and were being thrown away: every step records the sig it produced
(`steps.state_after`), and execution computes the sig after every step anyway.
Worse, `execute.ts` was loading `state_after` and assigning it to `url` — so the
expectation was fetched and then overwritten into the wrong field. Now carried
as `expectedSig`, compared, and a mismatch sets `StepOutcome.unexpectedPage`.
It is **not** treated as a failure — an app may legitimately gain a banner —
it becomes a `flow_drift` finding, because judging it is the reasoner's job.

**Flow drift.** `runs.sig_sequence` was WRITE-ONLY: recorded on all 18 runs and
never once read back. Now each run diffs its path against the last N passing
runs of the same goal:

```
run 1  first run of this goal — nothing to compare against yet
run 2  drift none (matches the last 1 passing run)
run 3  DRIFT path changed vs the last 2 passing runs:
           + /inventory.html#b885fc85
run 4  drift none (matches the last 3 passing runs)
```

A text diff over sigs. No model, no pixels — **visual drift stays out of
scope**; this is structural. A conventional suite cannot do this at all: it has
no memory of what the flow looked like last week, and `sig_sequence` is that
memory.

**Three implementation bugs found on review — the decisions were right, the code
was not:**

- **A sig diff conflated "different page" with "same page, different state".**
  `sig()` is state-granular by design and `/inventory.html` alone has FOUR sigs
  in this corpus (empty cart, one item, menu open, …), so an ordinary state
  difference reported as "a page disappeared and a different one appeared".
  Given how often cart state differs between runs, this would have produced
  near-constant false drift. An adjacent removed+added pair on the same
  url_pattern now collapses to one `changed` entry, tracked separately and at
  lower severity — a page nobody has ever seen is a much bigger deal than a
  known page in another state.
- **The alternation filter was one-directional.** `added` was filtered against
  "has any recent run taken this?" and `removed` was not filtered at all. So a
  flow alternating A→B→C and A→C reported nothing in one direction and drift in
  the other. Now symmetric.
- **The finding fingerprint truncated away the discriminating part.** It was
  `` `drift:${goal}:${changes}`.slice(0, 60) `` — with the goal first, so any
  goal longer than ~55 characters lost the change list entirely and **every
  distinct drift on that goal collided into one finding**. Now hashed.

Verified with crafted histories:

```
same page, different state   =6aeef289 ~b885fc85    added=[] stateChanged=[…]
alternation, either order    changed=false in BOTH directions
genuinely new page           =6aeef289 +deadbeef =bf3dd322   added=[…]
```

Details worth keeping:
- **LCS diff, not substring** — unlike macro mining, which needs contiguity
  because a macro must be runnable. A drift diff is for a human to read, and
  alignment across an inserted step is what makes "one new page appeared in the
  middle" legible.
- **Baseline is the most recent PASSED run.** Diffing against a failure would
  report its truncated path as "removed steps" — noise, not drift.
- **A sig is only "new" if NO recent run took it**, so a flow that legitimately
  alternates between two paths does not drift every time.
- Drift becomes a `flow_drift` finding, fingerprinted on WHAT changed rather
  than the whole path, so a recurring drift accumulates instead of minting a new
  finding every run.

**Mid-run escalation built — the executor now STOPS AND ASKS.**
`ReplayOptions.onDecision` is deliberately a plain callback rather than the
`Reasoner` interface, so replay stays decoupled from who answers. **Omitting it
means no escalation** — right for a verification replay, wrong for a real test.

Escalates on two things:
- **unexpected page** — the sig after a step is not the sig that step recorded
- **a failed step** — a missing element may be rot to heal or a genuine gap

Verified over MCP, with **two suspensions in a single run**:

```
ASKED: Split this goal into sub-goals…            -> answered with sub-goals
ASKED: The executor needs a decision: unexpected_page
         expected /inventory.html#WRONG999
         observed /inventory.html#b885fc85        -> answered "continue"
final: executed, passed=true
```

and the other answer genuinely stops it:

```
-> answered "abort"
status=executed passed=false
  step 4 click: aborted by reasoner: this is not the page the plan expected
```

That is the same handshake as decompose, reused for a different question —
which is the point of `context_requests` modelling "agent asks human" and
"server asks reasoner" with one state machine.

**Seam rung 5 built — `persistProbedBridge`.** The reasoner does the probing
with its own Playwright access (PLAN.md: it "reaches for Playwright MCP directly
just for live probing and selector repair") and hands back steps; we persist
them as **both** a bridge segment and a `page_edge`, stored exactly as a
distilled segment would be. So the next composition over that gap lands on rung
2 or 3 and never probes again — probing is the expensive rung and should happen
once per gap.

**Rung 5 is now wired into the planner.** An unresolved seam calls
`onSeamProbe`, which in Mode B is the same reasoner answering a different
question. Its steps are persisted, then the seam is **re-resolved from the
database rather than using the returned steps directly** — so a successful probe
must land on rung 2 to count, which proves the write-back actually took:

```
BEFORE probe:  rung 5 unresolved
AFTER  probe:  rung 2 bridge-segment — spliced bridge-0fd1b19119 (2 steps)
persisted:     bridge-0fd1b19119  source=sliced  steps=2
page_edge:     written
```

Probing is the expensive rung; this is what makes "once per gap" true rather
than aspirational. Omitting `onSeamProbe` leaves an unresolved seam unresolved,
which **blocks execution** rather than guessing.

**Corrections persisted — `db/05-flow-corrections.sql`, both targets.**
`flows.corrections JSONB`. They went there and not elsewhere on purpose: not
`findings` (a finding says the APP is wrong; a correction says the RECORDING was
noisy — different subject, and mixing them puts recorder artefacts in front of
someone triaging real defects), not `facts` (retrieved by meaning at planning
time; "codegen emitted a redundant click" is not knowledge about the app and
would only dilute retrieval), not `lessons` (a lesson has a trigger and fires
during execution; a correction has already been applied). A correction is
PROVENANCE for one flow's distillation. `understudy flows <slug>` surfaces the
count.

**Emitters built — `understudy emit <slug> <flow> [--framework]`.**
This closes the loop the project rests on: recordings are DATA, and code is an
OUTPUT format, never an input one.

```ts
test('Log in as a standard user', async ({ page }) => {
  await page.goto('https://www.saucedemo.com');
  await page.getByRole('textbox', { name: 'Username' }).fill('standard_user');
  await page.getByRole('textbox', { name: 'Password' }).fill(SECRET_PASSWORD);
  await page.getByRole('button', { name: 'Login' }).click();
});
```

Two refusals built in:
- **A `value_ref` is never inlined.** The recording deliberately never stored the
  credential; printing it into a file someone will commit would undo that at the
  last possible step. It emits `process.env.SECRET_PASSWORD` and tells you what
  to export.
- **A step it cannot address cleanly produces a WARNING**, not a
  plausible-looking locator. Generated code that looks right and is subtly wrong
  is worse than generated code that admits it. Cypress has no role engine, so
  every role+name step it downgrades to a text match says so.

**A bug the emitter exposed: `testIdAttr` was dropped at ingest.** Captured in
the recording, never written to `steps.args` — so anything reading it back
defaulted to `data-testid`, and saucedemo uses `data-test`. Cypress output
(which prefers test ids) emitted selectors that would match nothing. The
executor had the same latent hole via `execute.ts`; it only stayed hidden
because role+name is tried first. Same family as the original `getByTestId` bug
— losing the attribute at ingest just moved it downstream.

**Findings triage built — `src/core/triage.ts`, `understudy findings <slug>`,
plus `understudy_findings` / `understudy_triage_finding` over MCP.**

The problem was concrete rather than theoretical: this corpus had **three of
five findings being third-party analytics 401s at 29 occurrences**, while the
one arguably real observation sat at 1. Noise was outvoting signal, and nothing
ever moved a finding off `open`.

**MECHANICAL FIRST, JUDGEMENT SECOND.** A finding whose request went to a
different origin than the app under test is almost certainly not about the app —
that is a filter, not a judgement, and asking a model whether someone else's
telemetry endpoint is our bug wastes a call and the reader's attention. The
origin filter suppressed both `events.backtrace.io` findings for free.

It is deliberately conservative: only findings with a URL in evidence, only when
it parses, only when the origin genuinely differs. **A suppressed real defect is
far worse than a surviving piece of noise.** The console-error twin of those
same 401s survived, because console messages carry no URL — honest, and exactly
the case where judgement is needed.

**`promoted_to` is now live**, which is the part that changes future behaviour:

```
finding  "Failed to load resource: 401"  (29x)
   -> triaged_lesson
   -> lesson "Telemetry 401s on load are not app failures"
              trigger { url_pattern: "/", action: "goto" }   source=promoted_finding
```

That is PLAN.md's distinction working: *the same observation is a lesson if you
accept it and a finding if you don't.* Without that path a finding could only
ever be a complaint, and the agent would rediscover the same problem forever.

Every disposition records **who decided and why** in `evidence.triage`, so
`origin-filter` and `reasoner` decisions are distinguishable after the fact:

```
triaged_lesson  reasoner       third-party telemetry 401s on every page load…
wontfix         origin-filter  request went to a different origin than the app…
wontfix         reasoner       artefact of a deliberately corrupted expected sig…
```

Summary went `open=5` → `open=1, triaged_lesson=1, wontfix=3`.

**`lessons_for` wired — `src/core/lessons.ts`. The learning loop now closes.**
Lessons were written by the distiller and promoted from findings and then never
once read: the difference between recording that you learned something and
acting on it.

**Matched by EXACT trigger predicate, never by similarity** — which is why the
trigger is structured JSON and not prose. A lesson that fired approximately
would be worse than no lesson, because it would change behaviour on steps it
was never about. Implemented as JSONB containment in SQL (`$context @>
trigger`), so an absent key is a wildcard and a lesson is exactly as broad as
whoever wrote it made it:

```
goto /                                 -> ignore
click Add to cart on /inventory.html   -> wait
click Login on /                       -> none
click Add to cart on the WRONG page    -> none      <- scoping holds
```

**A `goto` looks FORWARD, not back.** The relevant page for a navigation is the
one being navigated *to*; on step 0 there is no previous page at all, so a
lesson about a landing page would never have fired if context only looked
backwards.

**The payoff is measurable.** Every previous run reported `findings 0 new, 3
seen before` as those telemetry 401s re-incremented. With the promoted lesson
active: **`findings 0 new, 0 seen before`**, and `console_error` stayed at 29
instead of climbing. That is what "the same observation is a lesson if you
accept it" actually buys — the thing stops being re-reported as a defect on
every single run.

`times_applied` / `times_helped` are tracked per firing, because a lesson that
fires constantly and never helps is noise with a trigger attached, and only the
ratio shows that.

**All five destructive signals + the routing hole closed —
`src/core/destructive.ts`, `db/06-step-destructive.sql`, both targets.**

**The fix was structural, not more signals.** Destructiveness now lives on the
STEP. Segments share their parent's step rows through `flow_steps`, so marking
the step propagates in every direction for free — parent, segment, and any mined
macro containing it. Verified: marking ONE step marked both its recorded parent
and the segment cut from it, and synced `memory_chunks`.

Signal 4 (fingerprint match) closes the last gap — an equivalent step captured
in a *different* recording gets marked on next ingest:

```
"Click the button Add to cart"  t  commit-shaped control
"Click the button Add to cart"  t  fingerprint matches an already-destructive step
```

### THE PENALTY WAS ROUTING AROUND THE GATE — three compounding bugs

1. **A soft penalty cannot express "forbidden".** `recall()` adds +0.50 to
   destructive chunks when spend is disallowed. That re-orders; it does not
   refuse. Asked to add an item to the cart with the cart step destructive, the
   planner bound a mined macro **that does not touch the cart at all** — a plan
   that would have run cleanly and not done what was asked.
2. **The penalty hid the candidate from the filter.** Penalised, the correct
   segment (0.4124) sorted *behind* the unrelated macro (0.8936 → score 0.7186
   vs 0.7225), so binding took the macro before ever reaching the candidate it
   was supposed to refuse. The penalty and the hard filter were fighting.
   **Retrieval now ranks by MEANING and binding applies POLICY** — the planner
   deliberately does not pass `allowsSpend` to `recall()`.
3. **A far-worse fallback is not an alternative.** After a safety refusal,
   binding only accepts a candidate within `FALLBACK_MARGIN` (0.12) of the
   refused one. Beyond that it is a different intent, and the honest answer is
   blocked.

Result — and `BLOCKED` is now checked before `unbound`, because "I know how and
I am not allowed" is more useful than "I could not bind anything":

```
reject 0.7355 …e4f3fd  destructive, and (none configured) does not allow purchases
reject 0.8936 macro    too far from the refused candidate (0.4124) to be the same intent
BLOCKED — 1 sub-goal(s) can only be achieved destructively…          exit 5
--allow-purchases -> EXECUTED, PASSED
```

**Selector health + quarantine built — `src/core/health.ts`.**
`recall()` has excluded quarantined selectors since it was written; nothing
could ever set the flag. Now each run folds its `run_events` outcomes into the
per-element counts.

Health is a **smoothed** rate `(s+1)/(s+f+2)`, not raw `s/(s+f)`: with one
observation the raw ratio is 0 or 1, so a single flake would look identical to a
permanently broken element.

Quarantine is deliberately strict — **≥3 failures AND zero successes** — because
quarantining removes an element from retrieval entirely. One success proves it
can work. Verified both directions:

```
Ghost Button  s=0 f=3  health=0.200  quarantined=true    <- only ever failed
Flaky Button  s=1 f=5  health=0.250  quarantined=false   <- flaky, not dead
Ghost Button  s=1 f=3  health=0.333  quarantined=false   <- released once it worked
```

**Bedrock adapters written, unverified — `src/adapters/bedrock/`,
`distiller/bedrock.ts`, `reasoner/bedrock.ts`, `embedder/bedrock.ts`.**
Mode A now has a distiller (Haiku 4.5, structured outputs, re-prompted with
`validateDistilled`'s own errors on failure — up to 3 attempts), a reasoner
(Sonnet 5: `decompose`, plus `seam` and `unexpected_page` judgements), and an
optional Titan embedder. Everything typechecks; **nothing has made a real call**,
because model access is still pending. `npm run bedrock:check` is the one
command that answers "has it landed?" — three probes, no database, no browser.

Two things fell out of writing them:

- **`Distiller` in `core/types.ts` was stale.** It read
  `distill(recording: string, context: string) => DistilledFlow`, where
  `DistilledFlow` carried `steps[]` — i.e. the model re-emitting the actions,
  which `distill.ts` explicitly forbids ("the model annotates; it does not
  author steps"). Nothing implemented or consumed it, so it was dead code
  pointing at a superseded design. Now `DistillRequest -> Distilled`, matching
  the handshake that actually ships.
- **The pipeline was trapped inside Mode B.** `decompose -> buildPlan ->
  executePlan` lived in a closure inside `startRun`, wrapped in suspension
  machinery only MCP needs. Extracted to `runPipeline()`; `startRun` races it,
  Mode A awaits it. Same body, no behaviour change — the deterministic CLI
  regression is byte-identical.

**`understudy test <app> "<goal>" --reasoner bedrock`** is the Mode A entry
point. Without the flag the CLI never calls a model, so the deterministic path
stays exactly as it was.

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

## OPEN CHALLENGE — embeddings do not represent polarity

Deliberately parked, not blocked. Revisit against a real corpus.

**The problem, one root cause with two faces:**

```
binding    "sign in to the app"          -> binds to "Log out"      (0.9077 vs 0.9201)
retrieval  "what should I avoid clicking" -> returns "you can click…" (0.8836)
```

Both are polarity. A single-vector bi-encoder compresses meaning into one
vector, and the polarity token is a rounding error on top of the shared content:
"log in" and "log out" differ in one word out of two; "avoid clicking" and
"clicking" differ in a word the model barely weights.

**Measured (2026-08-07), against the live saucedemo corpus:**

| query | top hit | right? |
|---|---|---|
| `what should I avoid clicking` | ACTIONS 0.8836 | **no** |
| `what is unsafe to click` | ACTIONS 0.9040 | **no** |
| `what did exploration refuse` | BOUNDARY 0.9345 | yes |
| `which controls are dangerous` | BOUNDARY 1.0966 | yes, but all >1.09 → correctly a gap |
| `what can I click` | ACTIONS 0.7978 | yes |

Row 1 vs row 5 is the proof: the *negated* and *positive* forms land on the
SAME document. Row 3 is the tell — it works only because the query happens to
use the corpus's own word ("refuse").

**The failure shape is what makes it dangerous.** 0.8836 is well under
`GAP_DISTANCE`, so the system does not say "I don't know" — it answers
confidently with the opposite. Row 4 shows the healthy contrast: everything
beyond the threshold, so it reports a gap instead.

### Why this is safe to defer — blast radius of each fix

The containment is structural, not luck: polarity is a RETRIEVAL concern, and
retrieval sits behind one function with a fixed return shape. Nothing
downstream of `recall()` knows how ranking happened; it consumes `bindable`,
`context`, `topDistance`, `margin`. Distillation is UPSTREAM and emits
polarity-agnostic output (intent, preconditions, outcome, kind) — a fix
*consumes* those fields, it never redefines them.

| option | touches | schema | re-embed |
|---|---|---|---|
| vocabulary-grounded `decompose` | goal phrasing, before recall | none | no |
| `start_state`/`preconditions` filter at bind | binding + a recall option | none — columns exist, ingest fills them | no |
| `kind` filter for polarity questions | the caller | none — already supported | no |
| cross-encoder reranker | recall's re-rank stage only | none | no |
| hybrid lexical + vector | recall + one index | one index migration | no |

**The edges — where it stops being free:**
- **Changing chunk TEXT** (e.g. folding `outcome`/`preconditions` into segment
  chunks so "outcome: authenticated" separates from "outcome: session ended")
  is not a rewrite but IS a full re-embed, ~$1.20. The `meta` guard and
  `recording_hash` cache exist to make that safe.
- **Multi-vector / late-interaction retrieval** would be an actual rewrite —
  different vector shape, different index, everything re-embedded. Ruled out;
  nothing here justifies it.

**Invariant to protect:** as long as what goes INTO the chunk text is unchanged,
every option above is confined to `recall()` and `decompose()`. Keep it that way
and this stays freely explorable.

**First things to try, cheapest first:** `kind` filtering (free, already
supported) → `start_state`/`preconditions` at bind (free, deterministic, fails
closed) → vocabulary grounding via `decompose` → reranker only if those are
insufficient.

## 2026-08-13 — real app, visual checkpoints, and the seam ladder proven

**A real corpus.** Three ProviderNow intakes imported from the sibling Playwright
suite, plus one captured from live exploration. 19 segments, 3 flows, 5 lessons.
Shared blocks — `log-in-as-a-member`, `provide-shipping-address`,
`provide-contact-details-and-consents`, `submit-the-intake-questionnaire` — are
ONE row each, reused across recordings rather than duplicated as synonyms.

**Nine bugs in the import path, all silent.** It had never run against a real
app. `.filter({hasText})` was dropped entirely (turning
`locator('div').filter(/^Services$/).nth(1)` into "the second div on the page");
regex names dropped; `page.goto('/')` never resolved against the base URL;
`locator.count()` does not auto-wait, so every step failed in milliseconds on a
client-rendered app; replay threw away the parser's scope/target split;
`setInputFiles` paths were not resolved against the source repo; `sig()` was
computed before client-side redirects landed; the `FALLBACK_MARGIN` guard only
covered safety refusals, not state ones; and `stateAllows` demanded exact sig
equality, which made the corpus self-invalidating.

**That last one is the interesting one.** A sig covers title, landmarks and
control names, so `/overview` re-fingerprints once the account has a pending
request — six distinct `/overview` sigs exist. Because segments dedupe by slug,
ingesting one flow broke another's seams, and re-ingesting that one broke the
first. Binding now compares the ROUTE and lets the seam ladder decide.

**The ladder is real, and each service reaches it differently:** weight-loss at
rung 1 (sigs match), hair-loss at rung 2 (bridge segment found on its own), and
the rash flow at **rung 5** — a live probe through the MCP handshake, answered
by the reasoner. The honest probe answer there was "no steps, because none are
needed", which exposed that the model could not distinguish that from "I don't
know". Added **rung 1b**: a destination whose first step is a `goto` navigates
itself, so no bridge can be needed.

**Lessons closed a loop on themselves.** Replay of the rash capture kept failing
at OTP sign-in. A lesson for exactly that already existed, distilled from the
weight-loss recording — but `lessonsFor` was only wired into `executePlan`, so
the replay that VERIFIES recordings was the one place that ignored what the
corpus knew; and the settle only fired on `kind === 'wait'` while the distiller
had called it `timing`. Both fixed; the next replay passed 30/30.

**Visual checkpoints** (`src/core/visual.ts`). `checkpoint(...)` /
`toHaveScreenshot(...)` now parse into the schema's long-allowed `snapshot`
action, and `executePlan` adds one at every segment boundary keyed by slug — so
a novel composition gets visual coverage even where no recording had a
checkpoint. Cheap pixel diff filters; anything above the floor escalates to the
reasoner WITH IMAGE PATHS to judge as regression / expected / noise. Verified
across three runs: baseline, unchanged (ratio 0, silent), corrupted (ratio
0.0068, escalated).

## Not built at all

- **Bedrock adapters have never made a real call.** Written and typechecking;
  model access still pending. `npm run bedrock:check` is the one command that
  answers whether it has landed.
- **`wait_url`, `wait_text`, `scroll_container`, `dispatch_click`.** All four are
  permitted by the schema's action CHECK and none are implemented. This is not
  cosmetic: it is what stops a capture at the review-page scroll gate, and it is
  why all three intake recordings are trimmed before their final submit.
- **No session reuse.** Every replay does a cold login, and `distill` replays
  again — so verify-then-ingest costs 2–3 logins per recording. ProviderNow
  locks the account for 15 minutes after a handful, which cost real time this
  session. The Playwright suite keeps `playwright/.auth` storage state precisely
  to avoid this.

## Next, in order

1. **`scroll_container` and `wait_text`.** The two that unlock the rest of the
   intake flows. Both already legal in the schema.
2. **Execute a composed plan for real** — every plan so far has been `--dry-run`.
   The rash flow is the candidate, but its tail files a real care request, so
   decide that deliberately.
3. **Session reuse in replay** (storage state), which removes the rate-limit
   ceiling on how much can be ingested per window.
4. **Bedrock**, once model access lands.
5. **Dedupe lessons** — re-ingesting a recording writes a second copy of each.

---

## Open items

- **MCP read-only unverified.** The write probe was blocked by Claude Code's own classifier before it reached CockroachDB, so the server's setting is still unconfirmed. You believe you set it read-only. Low urgency — only this session is connected, and the classifier blocks writes independently. Verify in the Console when convenient.
- **`sharp` CVEs** (high, no fix available) come in transitively via `@huggingface/transformers` for *image* preprocessing. We only embed text, so the path never executes. Revisit before publishing the package.
- **Index recommendation not taken.** CockroachDB suggested `CREATE INDEX ON memory_chunks (app_id) STORING (text, embedding)` to skip the lookup join after the ANN scan. Deliberately deferred — it duplicates every 1024-dim vector and there's no data yet to measure against. Regular indexes can be added later without the vector-index backfill problem.
- **Oracle ARM Playwright check** still unrun (`npx playwright install --with-deps chromium` on `129.213.113.8`).
- **Bedrock model access** still pending — the adapters are written but have never made a real call. Enable `anthropic.claude-haiku-4-5` and `anthropic.claude-sonnet-5` (and `amazon.titan-embed-text-v2:0` only if you want the Titan embedder) in the Bedrock console for `AWS_REGION`, add credentials to `.env`, then `npm run bedrock:check`. Blocks nothing in Mode B, which needs no AWS at all.
- **Titan embedder is for a fresh database only.** It is 1024-dim like mxbai and occupies an unrelated vector space; the `meta` guard will refuse to connect rather than let the two mix. Mode A does *not* require it — the local ONNX embedder is the default in both modes, which is what keeps one vector space and makes corpora portable between them.
- **The Bedrock seam probe (rung 5) is deliberately weaker than the host agent's.** Rung 5 means "drive the browser and report what you find"; an API call cannot, so `BedrockReasoner` answers only when the transition is obvious from the state names and otherwise returns no steps, leaving the seam unresolved. That fails closed on purpose: `persistProbedBridge` **writes the answer back into the page graph**, so a plausible guess would become a permanent wrong fact every later run inherits.

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
