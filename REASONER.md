# Being the reasoner

You are the **reasoner** (and the distiller) for Understudy. This file is how to
do that job. It is not about building Understudy — that is `STATUS.md` for
progress and `PLAN.md` for architecture.

Works the same whether you are Claude Code, Codex, Cursor or anything else that
speaks MCP. Nothing in the protocol is model-specific.

---

## The one thing to understand first

**You do not drive. You are consulted.**

Deterministic code owns the pipeline — replay, recall, binding, seam
resolution, execution. It calls no model. When it reaches a judgement it cannot
make alone, it **suspends and returns to you**, you answer, and it continues.

That is why a run is a sequence of tool calls rather than you clicking through a
browser. Eighty round trips would be slow and would eat the context window the
user is working in. You are asked perhaps three or four questions per run.

The corollary matters: **when a tool hands you a question, you are in your own
turn with all your own tools.** You can open a browser, read a file, query the
database, look at an image. That is the whole reason a host agent is worth more
here than an API call — an API call answers from the payload alone.

---

## Setup

The `understudy` MCP server is in `.mcp.json`. Nine tools, prefixed
`understudy_`. It needs CockroachDB running:

```bash
PATH="/opt/homebrew/bin:$PATH" ./scripts/db-start.sh
```

> **The MCP server is long-lived.** It loads `src/` once when the session
> connects. If anyone edits the source, the CLI picks it up immediately but the
> MCP tools keep running the old build — and the symptom is baffling: the same
> goal binds through `understudy test` and gaps through `understudy_run_plan`,
> quoting a rejection the current source no longer produces. Reconnect via
> `/mcp` after any change you intend the tools to use.

---

## The two handshakes

### Running a goal

```
understudy_run_plan(appSlug, goal)   → returns at the first question
understudy_resume_run(requestId, answer)   → returns at the NEXT question, or the end
```

Each call returns at a suspension or at completion. Keep calling `resume_run`
until `status` is `planned`, `executed`, `blocked` or `failed`.

Useful arguments: `dryRun: true` plans without opening a browser (free, and how
you should start); `values` supplies credentials the recording deliberately did
not store, e.g. `{"MEMBER.email": "...", "MEMBER.password": "..."}`;
`allowPurchases: true` permits a destructive plan, which is refused by default.

### Turning a recording into memory

```
understudy_recordings()              → find a hash
understudy_distill(hash, values)     → replays it, returns steps + vocabulary
understudy_save_distilled(hash, distilled)   → validates, then writes
```

Nothing is written until it validates. Invalid input returns **every** problem at
once so you can fix and retry.

---

## The four questions you will be asked

### 1. `decompose` — split a goal into sub-goals

You get the goal and the app's **entire vocabulary**. Answer:

```json
{ "subGoals": ["log in as a member", "choose the hair loss service"] }
```

**This is the highest-leverage thing you do.** Each sub-goal becomes a semantic
search query against that vocabulary. Phrase them in words the corpus already
uses — near-verbatim where a listed segment does the thing — or retrieval finds
nothing and the run stops. A sub-goal is one thing that must HAPPEN, not one UI
interaction: "log in as a member" is one sub-goal, not five.

Include prerequisites the user left implicit. Someone asking to "check out" on
an app that requires login means log in first.

### 2. `seam` — how do we get from one segment to the next?

You get `fromSlug`, `toSlug`, `fromState`, `toState` (page fingerprints). Answer:

```json
{ "steps": [{"action": "click", "role": "link", "name": "Services"}], "reasoning": "..." }
```

**Answer `[]` unless you actually know.** Whatever you return is written into the
page graph as a permanent bridge and reused forever without being asked again. A
plausible guess does not fail once — it becomes a wrong fact the system trusts.

This is the question where your tools earn their keep. Go look: open the page,
query the `pages` table, read the segment's steps. Do not answer from the four
strings alone.

### 3. `unexpected_page` — a step landed somewhere it didn't expect

Answer `{"action": "continue" | "abort", "reason": "..."}`.

Continue only if it is recognisably the same place doing the same job and the
difference is incidental — a banner, a reordered nav. **Bias to abort:**
continuing drives unverified steps that may click things.

### 4. `visual_diff` — a screenshot changed

You get **file paths**, not embedded images. Open them. The changed fraction
alone cannot tell a moved timestamp from a missing button.

```json
{ "verdicts": [{"label": "calculate-bmi", "verdict": "regression", "why": "..."}] }
```

- `regression` → recorded as a finding
- `expected` → the current shot becomes the new baseline, so it stops firing
- `noise` → ignored, baseline kept

`expected` is the one that matters most. Without it, an intentional redesign
fires forever on every run, which is how visual testing gets switched off.

---

## When the corpus does not know something

**Check first — it is free.** `understudy_recall(appSlug, goal)` is a database
query. No login, no browser.

A top distance near or above **0.92** is a gap. So is a *close* match that is
plainly the wrong thing: "complete a general rash intake" returned the hair-loss
photo-upload segment at 0.8072, which reads as known but is a different intake.
Judge the text, not just the number.

**If it is a gap: drive it by hand, then write down what you did.** Exploration
that is not captured is work done twice. Write the flow as a Playwright spec
under `.understudy/explorations/` (gitignored — the steps carry whatever was
typed into a real form), then `import` → `replay` → distil → ingest. Going
through `import` means replay has to *prove* every step, which is what separates
a recording from a story about one.

---

## Writing a distillation

You are given verified steps, numbered. **You annotate and partition. You do not
author.** Reference steps by index only; never restate or invent them. The steps
were captured by the recorder and proven by replay — that constraint is what
makes it safe to let a model do this at all.

```json
{
  "intent": "what this flow is FOR, phrased as someone would ask for it",
  "preconditions": ["not authenticated"],
  "outcome": "the state the app is in afterwards",
  "segments": [
    { "slug": "log-in-as-a-member", "title": "...", "intent": "...",
      "stepRange": [0, 16], "preconditions": ["not authenticated"],
      "outcome": "authenticated as a member and on the account overview" }
  ],
  "candidateLessons": [...],
  "corrections": [...]
}
```

Four rules that are easy to get wrong:

**Preconditions must be exactly `"authenticated"` or `"not authenticated"`.**
The filter does whole-string set membership, so "authenticated as a member"
silently never matches and the gate never fires.

**Reuse existing slugs.** The request includes every segment the app already
has. If a block does the same thing as one of those, reuse its exact slug —
segments dedupe by slug, so reusing merges while inventing a synonym creates two
rows competing for the same bind slot.

**Segments belong to the app, not the recording.** A login block cut out of a
checkout recording must be reusable by every future flow. Name and scope it that
way.

**Only report a lesson or correction the recording actually shows.** Inventing
them is worse than leaving the arrays empty.

---

## Findings and lessons

Detection is free and already ran — console errors, non-2xx bodies, failed
requests, values that did not survive, flow drift. What is missing is judgement.

`understudy_findings(appSlug)` lists what is open; `understudy_triage_finding`
routes each one. The distinction:

> A **finding** is "X is wrong" and the APP gets fixed.
> A **lesson** is "when X, do Y first" and the AGENT adapts.
> The same observation is one or the other depending on whether you accept it.

Triage the noise or it buries the signal — third-party telemetry and framework
lint warnings will outnumber real findings by occurrence count. A lesson is the
valuable outcome: it fires automatically on every future run whose step matches
its trigger, including in flows nobody has recorded yet.

---

## Things that will cost you an hour if you don't know them

**Logins are often rate limited.** ProviderNow locks the account for 15 minutes
after a handful of attempts. Every replay does a cold login and `distill`
replays *again*, so verify-then-ingest is 2–3 logins per recording. Plan for it:
use `dryRun` while iterating, batch your ingests, and do not debug by re-running
the same replay.

**Stop before the irreversible step.** Ingest replays the recording every time,
so a captured "Confirm & Submit" or Stripe checkout files a real order on every
ingest. Trim with `import --until <n>` and say why in `corrections`.

**Credentials never live in recordings.** A password field records a
`valueRef` like `MEMBER.password`, never the value. Supply them per run through
`values`.

**Some IR actions are legal in the schema but unimplemented** — `wait_url`,
`wait_text`, `scroll_container`, `dispatch_click`. A flow gated behind a
scrolled pane, an explicit wait, or a `dispatchEvent` submit cannot be captured
past that point yet. That is usually where a capture has to stop.

**An unresolved seam blocks execution, and that is correct.** It means "I don't
know how to get from here to there". Do not work around it by loosening
something — either probe it properly, or let it block.
