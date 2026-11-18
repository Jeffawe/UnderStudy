# Architecture

For changing the code. If you only want to use Understudy, read the README; if
you're an agent using it, read REASONER.md.

## The ideas

Seven nouns, one MongoDB collection each (steps live inside their flow):

| Idea | Collection | What it is |
|---|---|---|
| App | `apps` | A site you test, with its base URL. |
| Flow | `flows` | Steps that do one thing. A *recording* is captured whole; a *segment* is cut from one so other goals can reuse it. |
| Step | inside `flows` | `{action, role, name, value / valueRef, url, expectedSig}` — exactly what the recorder emits. |
| Page | `pages` | A page fingerprint (`sig()`: url pattern + title + landmarks + top controls) and the known links out of it. |
| Note | `notes` | A *fact* (changes the plan, found by meaning) or a *lesson* (changes one step, matched by exact trigger). |
| Finding | `findings` | "The app is broken here", deduplicated by fingerprint across runs. |
| Run | `runs` | One attempt at a goal: the plan, the path taken, events, findings — and, while planning, its open question. |

Plus `meta`: one document saying which embedding model filled the database.

## The code

```
src/
  store/      db.ts (connect, collections, indexes, vector search)
              embed.ts (any OpenAI-style embeddings endpoint)  reembed.ts  types.ts
  core/       recording.ts (the step format)  replay.ts (the player)  sig.ts
              distill.ts (the distill contract)  auth-cache.ts (saved sessions)
  adapters/recorder/
              injected.ts (the in-page recorder)  wire.ts (its events → steps)
              live.ts (Playwright recorder)  extension.ts (Chrome extension's server)
              script.ts (import a Playwright script)
  flows/      save.ts  execute.ts  runs.ts  drift.ts  findings.ts  destructive.ts
              distill.ts  emit.ts
  memory/     recall.ts  notes.ts (remember, lessons)  vocabulary.ts
  plan/       planner.ts  seams.ts
  entry/      cli.ts  mcp.ts
extension/    the Chrome recorder (recorder.js is generated: npm run extension:build)
test/         node --test, against local MongoDB and a tiny local shop (fixture-app.ts)
```

## How a goal runs

1. **recall** (`memory/recall.ts`) — exact name, else vector search (else word
   match with no model). Verdict: *known* / *unsure* / *unknown*. Only *known*
   acts. The cutoff (`MEANING`) is calibrated, not guessed — see REWRITE.md.
2. **plan** (`plan/planner.ts`) — split the goal (or ask the agent), bind each
   part to a known flow, refuse destructive flows, bridge the seams between
   flows (`plan/seams.ts`: no bridge needed → the page map → a plain URL → ask).
   Every question is asked here, before a browser opens; a waiting run's
   progress is its `planning` field, so nothing is held open.
3. **execute** (`flows/execute.ts`) — one recording for the whole plan, replayed
   headless, with a saved session if it starts signed in and lessons applied
   per step.
4. **record** (`flows/runs.ts`) — drift against recent passed runs, findings,
   pages and links, and the run.

Saving a recording (`flows/save.ts`) is the same replay, without lessons, and
it refuses a recording that doesn't pass.

## Rules that are easy to break

- **Deterministic code never calls a model.** Judgement goes to the agent as a
  question, during planning only.
- **Memory only holds proven flows.** Save replays first; distill refers to
  steps by index and can't invent them.
- **Credentials never reach disk or the database.** Password fields become
  `valueRef`s; sessions are 0600 files in `.understudy/sessions/`.
- **One embedding model per database** — `meta` enforces it; `reembed` switches.
- **Write memory through `remember` / `saveDistilled` / `saveFlow`**, which
  validate (empty lesson triggers, inexact preconditions) and embed.
- **An agent's seam answer is permanent** (it becomes a page link), which is
  why the question tells it to answer `[]` unless it knows.
- **Two vector indexes, never more** — a free Atlas cluster allows three.
- **Drop collections, never databases** — the Atlas read/write role can't.

## Checks

```bash
npm run typecheck && npm run build
npm test      # local MongoDB + Playwright Chromium; ~50s
```
