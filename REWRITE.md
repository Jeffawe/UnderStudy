# Understudy rewrite plan

Written 2026-11-18. The plan for rebuilding Understudy in place on MongoDB.
Nothing here is built yet. When a phase ships, tick it off here.

## Goals

1. **Easy to understand.** Few ideas, plain names. You should be able to read
   any one file and know what it does without a map.
2. **Easy to set up.** One connection string. No database binary to install,
   no embedding model to download, no AWS.
3. **Cheap.** Free for one person on a free Atlas cluster or a local Community
   install.
4. **Still efficient.** Keep what made Understudy worth having: recall that
   hands back a working plan in about 1.5k tokens instead of 40–100k spent
   driving a browser blind.
5. **Works without AI.** Record, replay and run a named flow with no model and
   no agent. The AI agent is an add-on that makes it smarter, not a requirement.

## What changes, in one table

| | Today | After |
|---|---|---|
| Database | CockroachDB, 19 tables, 12 migrations | MongoDB, 6 collections (+ a one-document `meta`), no migrations |
| Where the DB runs | Local binary or CockroachDB Cloud | Your Atlas cluster **or** Community Edition — any `MONGODB_URI` |
| Embeddings | Local 1024-dim ONNX model, downloaded on first use | Any OpenAI-style endpoint — Voyage by default (200M free tokens), Ollama for free/offline — optional |
| Models | Bedrock (never used) + host agent | Host agent only, optional |
| Recording | Playwright opens a new browser | Chrome extension on the tab you already have open (Playwright recorder kept as a fallback until the extension is proven) |
| Replay | Local | Local only. A hosted instance never runs a browser |
| Code | ~14.5k lines | Target ~5–6k |
| Docs | ~28k words across 7 files | README + REASONER.md + ARCHITECTURE.md |
| MCP tools | 11 | 7 |

## The ideas you need — the whole list

These seven nouns are the entire model. If a piece of code doesn't serve one of
them, it goes.

| Idea | Plain meaning |
|---|---|
| **App** | A website you test. Has a slug, one or more base URLs (local, staging, prod). |
| **Flow** | A sequence of steps that does one thing — "log in as a member". A *recording* is a flow; a *segment* is a flow cut out of a recording so other flows can reuse it. |
| **Step** | One action: `{action, target, value}`. `target` is how to find the element — role + accessible name first, test id or CSS as fallback. |
| **Page** | A fingerprint of a page state (`sig()`): url pattern + title + landmarks + top control names. Lets a run check "am I where I expected?" Pages also store the known links between them. |
| **Note** | Something learned. A *fact* changes what you plan ("order history is at `/past-invoices`"). A *lesson* has a trigger and changes one step ("when filling Card number, dismiss Stripe Link first"). |
| **Finding** | "The app is broken here" — a 500 the UI swallowed, a value that didn't save. Someone fixes the app. |
| **Run** | One attempt at a goal: the plan, what happened, the pages it passed through, and — if it is paused waiting on the agent — the open question. |

Gone as separate ideas: mined macros, the shared selectors table, selector
health and quarantine, memory chunks, context requests, sessions/messages, the
embedder guard, run budgets.

## Collections

One collection per idea except Step, which lives inside its flow. A flow is
naturally one document — you always want its steps with it — so there are no
join tables and no composite keys to get wrong.

```
apps       { slug, name, urls: { local, staging, ... } }

flows      { app, slug, title, intent, kind: 'recording'|'segment',
             from?: { recording, steps: [start, end] },   // segments only
             preconditions: ['authenticated'|'not authenticated'],
             outcome, destructive, corrections: [...],
             steps: [{ action, role?, name?, testId?, css?, frameHint?,
                       value?, valueRef?, url, expectedSig? }],   // same shape the recorder emits
             embedding?: [...], searchText }

pages      { app, sig, urlPattern, title,
             links: [{ to: sig, via: {role, name} }] }

notes      { app, kind: 'fact'|'lesson', text,
             trigger?: { url?, action?, role?, name? },   // lessons only
             timesApplied, timesHelped, embedding?, searchText }

findings   { app, kind, severity, statement, evidence, fingerprint,
             occurrences, firstSeen, lastSeen, status: 'open'|'issue'|'lesson'|'noise' }

runs       { app, goal, mode: 'run'|'replay'|'attributed', plan, status,
             sigSequence: [...], events: [...], question?, startedAt, endedAt }

meta       { _id: 'embedder', model, dims, setAt }   // one document: which model filled this database
```

**Indexes.** Two vector indexes (`flows.embedding`, `notes.embedding`), each
with `app` as a filter field. The free Atlas tier allows three search indexes
per cluster, so this leaves one spare. Ordinary indexes on `{app, slug}`,
`{app, sig}` and `{app, fingerprint}`.

**Fixing a selector once fixes every flow.** The old shared selectors table
existed for this. In Mongo it is one `updateMany` with an array filter on
`steps.target` — no table needed.

**Recordings stay on disk** under `.understudy/recordings/`, as now. They can
hold typed values from real forms, so they never go to a shared database.
Credentials are still `valueRef`s, never values.

## Embeddings: any model, one adapter

**Built 2026-11-18** — `src/store/embed.ts`, `src/store/reembed.ts`.

Understudy makes the vectors itself and stores them on the document. MongoDB
doesn't care where a vector came from, so **any embedding model works**.

Most providers speak the same format — POST `{ model, input: [texts] }` to
`/v1/embeddings`, get back `data[].embedding` — so there is **one adapter**,
configured by four settings, not one adapter per vendor:

```
EMBED_URL=https://api.voyageai.com/v1/embeddings   # or OpenAI, Mistral, Together…
EMBED_MODEL=voyage-4-lite                          # or http://localhost:11434/v1/embeddings (Ollama: free, offline)
EMBED_KEY=…                                        # if the endpoint needs one
EMBED_DIMS=1024                                    # vector length the model returns
```

The one vendor-specific line: Voyage embeds search queries and stored documents
differently and is told which by `input_type`, so that field is sent to Voyage
only (other providers reject unknown fields).

**Two rules that come with choosing:**

1. **One model per database.** Vectors from two models can't be compared, and
   mixing them returns confident nonsense with no error. The first model seen
   is recorded in a one-document `meta` collection; a different model in `.env`
   stops everything with a message saying so.
2. **Changing model = `understudy reembed`.** Rebuilds every vector and resizes
   the indexes. A corpus is a few hundred short texts — a handful of requests.

**Voyage is the default.** Cheapest is `voyage-4-lite` at $0.02 per 1M tokens
after the free allowance. The first 200M tokens per model are free, one-time; a
recall query is tens of tokens and a whole corpus is well under a million, so
one person never pays. **But without a payment method on the Voyage account it
is capped at 3 requests and 10K tokens per minute.** Adding a card lifts the cap
and still costs $0 inside the free tokens. The adapter sends up to 128 texts per
request and waits and retries on a 429, which keeps it usable under the cap.

**MongoDB's own embedding** ("automated embedding", index type `autoEmbed`)
would be a *second mode*, not another adapter: Understudy sends text, the index
embeds it, the adapter goes unused. Not used for now — it is **Preview** on
Atlas and Community, and it embeds one query per `$vectorSearch` where the
adapter batches several sub-goals into one request.

**No model at all?** Leave `EMBED_URL` and `EMBED_MODEL` unset. Recall falls
back to matching flow names and titles. Record, replay and "run flow X by
name" don't need search at all.

## How it works after the rewrite

**Without AI** — the whole loop:

```
record (extension)  →  understudy save <name>   → a flow
understudy replay <flow>                        → runs it headless, reports pass/fail,
                                                   console errors, failed requests,
                                                   page drift vs last run
understudy run "<flow name or goal>"            → picks the best-matching flow, runs it
```

**With an agent** (Claude Code, Codex, Cursor — over MCP), it adds four things:

1. **Split** a recording into reusable segments (the distill step: annotate and
   partition by step index, never invent steps).
2. **Decompose** a goal into sub-goals so it can bind several flows.
3. **Bridge** two segments that never appeared together (seams).
4. **Judge** findings and propose notes.

The pause-and-ask mechanism stays as it is: the run suspends, returns a
question, the agent answers, the run continues. The open question lives on the
run document instead of a separate table.

**Seams get simpler.** Five rungs become three: (1) the pages already match,
(2) the page graph has a link from here to there, (3) same site, so `goto` the
URL. Otherwise ask the agent, and if it doesn't know, the run stops. The
bridge-segment search and the live probe go.

## The seven MCP tools

| Tool | Does |
|---|---|
| `recall` | What does memory know about this goal? Free, no browser. |
| `run` | Start a goal. Returns at the first question or the end. |
| `answer` | Answer the run's open question. Returns at the next one or the end. |
| `distill` | Hand the agent a recording's verified steps to split. |
| `save_distilled` | Validate and store the split. Returns every problem at once. |
| `remember` | Store facts, lessons and findings in one batch. Also records a goal the agent drove by hand. |
| `findings` | List open findings; triage them when given a verdict. |

Removed: `vocabulary` (it comes with `run`'s decompose question), `recordings`
(the CLI lists them), `record_run` (folded into `remember`), `triage_finding`
(folded into `findings`).

## What happens to each part of the code

**Keep, mostly as is** — this is the valuable part:
`sig.ts`, the step format (`flow-ir.ts`), `injected.ts` and the accessible-name
bundle (the in-page recorder — becomes the extension's content script), the
script importer (`script.ts`, the only way to capture file uploads),
`destructive.ts`, `lessons.ts`/`trigger.ts`, `drift.ts`, the distill contract
(`distill.ts`), `emit.ts` (export a flow as a Playwright test).

**Rewrite, smaller:**
- `replay.ts` + `execute.ts` + `run.ts` → one **player** (walks steps in
  Playwright, checks pages, applies lessons, collects events) and one **runner**
  (plans and pauses). Currently 1,800 lines across three files with overlap.
- `recall.ts`, `plan.ts`, `seams.ts` → on `$vectorSearch`, with the three-rung
  seams above.
- `ingest.ts` → `save.ts`: replay to prove it, then write one flow document.
- `cli.ts` (1,378 lines) and `mcp.ts` → thin wrappers over the same functions.
- `session.ts` + `auth-cache.ts` → one small saved-login cache.

**Remove:**
- `adapters/bedrock/*`, `adapters/distiller/*`, `adapters/reasoner/bedrock.ts`,
  `adapters/embedder/*` (~800 lines)
- `db/` (schema + 12 migrations), `scripts/db*.sh`, `cockroach-data/` (2 GB)
- `macros.ts`, `health.ts`, `selector-identity.ts`, `budget.ts`, `vocabulary.ts`
- The `*-check.ts` scripts → replaced by a real test suite (`node --test`)
  against the local Community instance.

**Park — not in the first version, maybe later:**
- `explore.ts` (the automatic crawler) — 632 lines; useful but not core.
- `visual.ts` + pixelmatch — screenshot diffs.
- Preludes (`record --after`) and the mid-run handoff (`needs_capture`). The
  extension changes both problems: recording in your real browser means you are
  already logged in and already wherever you need to be.

## Chrome extension recorder

- Click the extension icon on the tab you're already using. That grants it the
  page (`activeTab`), with no relaunch and no special flags.
- A content script (today's `injected.ts`) records clicks, typing, selects and
  navigation, using accessible names, as now.
- It streams events to `understudy` over a localhost WebSocket. The CLI is the
  thing that saves the recording; the extension stores nothing.
- No `chrome.debugger` — it shows a "debugging this browser" banner and isn't
  needed. Console and network capture happen at replay, which already does it.
- Password fields become `valueRef`s in the content script, before anything
  leaves the page.
- Known limits: cross-origin iframes (payment forms) may be unreachable,
  `chrome://` pages can't be recorded, file inputs give a name but no path (so
  uploads still go through the script importer).
- Distributed as an unpacked extension in the repo first; Chrome Web Store
  later if there's demand.

## Build order

The rewrite happens on `main`. The old CockroachDB version is preserved on the
`legacy-cockroach` branch (cut from `b47aac3`); each phase deletes from `main`
what it replaces.

| Phase | Builds | Done when |
|---|---|---|
| **0. Spike** | Connect to local Community + your Atlas free cluster. Create both vector indexes, embed via Voyage, query with `app` filter. | Same test passes on both URIs. **Done 2026-11-18.** Local: `npm test` + `doctor`. Atlas: `doctor` + a real Voyage search, same rankings and scores as local. See *What phase 0 taught us*. |
| **1. Store** | `src/store/`: types for the six collections, connect from `MONGODB_URI`, create indexes on first run. Delete Cockroach + Bedrock + ONNX code. | `understudy doctor` reports a healthy connection on both URIs. **Done 2026-11-18** — see *Phase 1 notes*. |
| **2. Record & replay, no AI** | Player, `save`, `replay`, `flows`. Live recorder + script import ported. | Record login on a test app, replay it, see drift and findings. No key, no agent. **Done 2026-11-18** — see *Phase 2 notes*. |
| **3. Run by goal, no AI** | Recall on Voyage (name match without a key), `run` picks one flow, safety gate, run documents. | `understudy run myapp "log in"` binds and runs the login flow. |
| **4. Agent layer** | The seven MCP tools: distill/segments, decompose, three-rung seams, remember, findings. Rewrite `REASONER.md` to match. | A goal spanning two recordings binds two segments and runs. |
| **5. Extension** | Chrome extension + localhost WebSocket. | Record a flow in your normal Chrome, replay it headless. |
| **6. Clean up** | Copy the corpus across (one-off script). Rewrite README, write ARCHITECTURE.md, delete BUILDING/PLAN/STATUS/STATUS-HISTORY. | Fresh clone → working in under five minutes. |
| **7. Hosted (later)** | Memory-only server: anyone points it at their own Mongo URI. No browsers. | Not scheduled. |

## What phase 0 taught us (2026-11-18)

- **A free Atlas cluster holds one Understudy database.** The 3-search-index
  limit is per *cluster*, not per database, and each Understudy database uses
  2. So the test suite runs against local Community; Atlas is checked with
  `understudy doctor`. Someone wanting several Understudy databases on one
  free cluster can't — that is a reason to keep it at 2 indexes, never more.
- **New documents take seconds to become searchable on Atlas** (search is
  eventually consistent; ~6s observed, near-instant locally). A recall right
  after saving a flow can miss it. Anything that saves then searches must
  either wait or not depend on the new document.
- **The ordinary Atlas read/write role can't `dropDatabase`.** Understudy and
  its tests drop collections, never databases.
- **Voyage scores are compressed**: right matches ~0.76–0.81, runner-ups
  ~0.65–0.78. The old 0.92 gap distance means nothing now; recall's
  "I don't know this" cutoff gets calibrated on real flows in phase 3.
- Atlas free runs MongoDB 8.0.37; local Community runs 9.0.8. No difference
  seen for anything used so far.

## Phase 1 notes (2026-11-18)

- **What `main` can do now:** `doctor`, `reembed`, `record`, `import`,
  `recordings`, `replay`. The CLI remembers an app's base URL in MongoDB's
  `apps` collection (`urls.default`). Everything else returns in phases 2–4.
- **Not yet back:** `record --after` and replaying a recording that has a
  prelude (refused with a clear message), and lessons during replay (phase 3).
- **Removed:** Bedrock, ONNX embedder, reasoner/distiller adapters, the MCP
  server, `pg`, the schema and migrations, the `db*.sh` scripts, all
  `*-check.ts` scripts, and the core modules that only talked to CockroachDB.
  `node_modules` went from 514 MB to 95 MB; `src/` went from ~14.5k lines to
  ~5k (before phases 2–4 add back what they rebuild).
- **Ported later, not rewritten from memory:** several removed files hold logic
  the plan keeps (`destructive`, `lessons`, `drift`, `emit`, `flow-ir`,
  `remember`, `seams`). When a phase needs one, start from
  `git show legacy-cockroach:src/core/<file>.ts` and swap SQL for MongoDB.
- **The old corpus is exported** to `.understudy/export/*.json` (all 19 tables,
  2.5 MB, gitignored, vectors dropped — they get re-embedded with Voyage). That
  is the input to the phase 6 copy; CockroachDB is no longer needed to read it.
- **Known replay failure, not a regression:** old saucedemo recordings predate
  `testIdAttr`, so a bare `data-test` id like `shopping-cart-link` matches
  nothing. Re-record or re-import them.

## Phase 2 notes (2026-11-18)

- **New commands:** `save <hash> "<name>"` (replays to prove it, refuses if it
  fails unless `--force`), `flows <app>`, `replay <app> <flow>`,
  `findings <app>`. `replay <hash>` still runs an unsaved recording file.
- **New code, `src/flows/`:** `save.ts` (recording → flow document, flow →
  recording), `runs.ts` (every saved-flow replay records a run, findings,
  drift and pages), `drift.ts` + `findings.ts` (ported, pure), and
  `destructive.ts` (2 of the old 5 signals — the 3 that need stored knowledge
  come with the phase 3 safety gate).
- **Fixed on the way:** the destructive check now only looks at clicks and key
  presses. The old one judged every step, so a "Confirm password" field marked
  a whole signup flow destructive.
- **A destructive flow is refused by `replay`** unless `--allow-purchases`.
- **Tests:** `test/fixture-app.ts` is a tiny local shop (log in → shop → cart)
  with switches to add a promo page or break the cart, so the end-to-end test
  never depends on a public site. 17 tests, ~30s.
- **Not done here, on purpose:** `replay.ts` is still the old 1,100-line
  player. It works, so splitting it is deferred to when the runner (phase 3)
  needs to reuse its pieces — not done for its own sake.
- **Small things noticed:**
  - One unexpected page currently raises two findings (the step's
    unexpected page + the path drift). Consider folding them into one.
  - `import` turns `process.env.X!` into a value reference named literally
    `process.env.X!`. It works (`--value 'process.env.X!=…'`) but should
    become a clean name like `ENV.X`.
  - A replay that lands on an unexpected page still counts as passed (by
    design — a banner shouldn't fail a test), so that path joins the history
    and stops drifting next time. Triage is where someone says "that's a bug".

## Decisions (2026-11-18)

1. **Existing corpus:** a one-off script copies CockroachDB → Mongo, then is
   deleted. Keeps facts and lessons no recording holds.
2. **Playwright live recorder:** kept permanently as a fallback people can
   choose. It is not removed in phase 6.
3. **Export:** keep both Playwright and Cypress.
4. **Build against local Community first.** Atlas is the same driver and the
   same queries — switching is a connection-string change.
