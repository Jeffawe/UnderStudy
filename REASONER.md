# Being the reasoner

You are the **reasoner** (and the distiller) for Understudy. This file is how to
do that job, and in a local checkout it is loaded into every session
automatically, so you should never have to be told to read it.

It is not about *building* Understudy. The architecture, the concepts behind the
code and the running build status are working documents kept out of this repo —
they carry infrastructure detail no visitor needs. In a checkout that has them,
`CLAUDE.md` routes you.

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

That rule governs **a run that Understudy is executing**. It is not a claim that
Understudy must be the thing executing. See the next section.

---

## What Understudy is for

It is a tool for running end-to-end tests against the user's sites, so they do
not have to click through every flow by hand. That is the whole product. Every
rule in this file serves it, and none of them outranks it.

**The memory is the contract. The executor is not.** What makes Understudy worth
having is that it remembers an app — segments, facts, lessons, the page map, and
what each recording could not prove. Use that on every goal, always. *How* the
browser actually gets driven is an implementation detail you are free to choose.

- **Consult the memory first, every time.** `understudy_recall` is a database
  query: no login, no browser, no cost, no side effects. It tells you whether a
  flow is known, what its traps are, and — via `flows.corrections` — where a
  recording deliberately stops and why. Reading that before acting routinely
  saves an entire wasted run.
- **Decompose before you recall, no matter which path you end up driving with.**
  `understudy_run_plan` does this unconditionally — the deterministic pipeline
  calls `decompose` before recall ever runs, every time, whether or not it
  turns out to need a second question. That is not incidental: a single
  unbroken goal is a weak semantic-search query, and a multi-part goal binds
  one flow where several sub-goals would have bound the right ones. If you are
  driving by hand instead of through `run_plan` — a script, the browser
  directly, calling `understudy_recall` yourself — do the same decomposition
  yourself before you query. Not every model reaches for this on its own; do
  it deliberately, every run, not only when the pipeline forces it on you. See
  `decompose` below for how — phrase sub-goals in the app's own vocabulary.
- **Say the decomposition out loud, not just inside the tool call.** `subGoals`
  is an argument the user does not see. State it in your own turn too —
  "decomposing into: log in as a member, choose the premium plan" —
  before you act on it. It is the single highest-leverage judgment call in a
  run; one the user cannot see is one they cannot correct before it drives
  twenty minutes of the wrong retrieval.
- **If Understudy's executor cannot achieve the goal, use whatever can.** A
  Playwright script, the browser directly, MCP calls, curl against the app's
  API. Reaching the goal is the job; the executor is not sacred. A tail that
  needs an unimplemented IR action, a real purchase, or a third-party checkout
  page is an ordinary reason to drive it yourself, not a failure.
- **Unless the user explicitly asks for the Understudy executor.** Then use it —
  and if it genuinely cannot do the job, say so plainly rather than quietly
  substituting something else and reporting success.

**Say which you used.** "Recalled the corpus, then drove it with a script
because the checkout is a Stripe-hosted page the IR cannot express" is one
honest sentence. Hand-driving a flow while implying the tool ran it is the one
failure mode here that actually costs trust.

**A goal you drove by hand is still worth capturing** — see *When the corpus
does not know something*. But when the tail cannot be replayed (a real purchase,
an unimplemented action), skip the recording and bank what you learned as facts
and lessons instead. Memory gained is the point; a recording is just one way to
gain it.

---

## Setup

The `understudy` MCP server is in `.mcp.json`. Eleven tools, prefixed
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

### Writing down what you learned

```
understudy_remember(appSlug, { facts?, lessons?, findings? })
```

The only tool here that WRITES on your initiative rather than answering a
question the pipeline asked. One call takes all three kinds — batched on
purpose, because the rule below is to gather what you learned and put the whole
list to the user at a natural pause, and an API that took one item at a time
would quietly push you into interrupting them per row.

Same contract as `save_distilled`: validated first, **every** problem returned
at once, and nothing written unless the whole batch is clean. A `--dry-run`
equivalent is not needed — send the batch, and a bad one costs nothing.

`understudy remember <slug> <file.json>` is the same thing from the CLI.

### Recording a goal you drove yourself

```
understudy_record_run(appSlug, goal, passed, sigSequence?, drivenBy?, note?)
```

**Call this every time you reach a goal without the executor.** Driving it
yourself is allowed and often necessary — but it used to leave no trace at all:
no run row, no drift baseline, nothing showing the goal had ever worked.
Measured on a real corpus, a paid checkout succeeded while the newest run row
was still a week older. The reinforcement loop only turns when a run is
recorded.

Stored as `mode='attributed'`, deliberately never `'execute'` — *"this goal
works"* and *"the executor can do this"* are different claims, and only the
second is self-verifying. Supply `sigSequence` **only if you actually observed
page fingerprints**; a path you did not watch is not a baseline, and an empty
one is honest (drift skips it rather than reporting a phantom diff).

`understudy attribute <slug> <goal> [--failed] [--sig …] [--driven-by …] [--note …]`
from the CLI.

Two rejections worth knowing before they surprise you:

- **An empty `trigger` on a lesson is refused.** JSONB containment means `{}` is
  contained by every step context, so the lesson would fire on all of them.
- **A fact carrying `scope.key` is refused.** That key marks a crawler-generated
  page-map claim, and the planning vocabulary filters those out — so an authored
  fact wearing one would hide itself from every future `decompose`.

---

## The four questions you will be asked

### 1. `decompose` — split a goal into sub-goals

Always do this — see *What Understudy is for* above if you are not driving
through `run_plan` and so have to trigger it yourself rather than the pipeline
doing it for you. And say the sub-goals in your own reply, not only inside the
tool call — the user should see the breakdown before it drives retrieval, not
only the flows it eventually binds.

You get the goal and the app's **entire vocabulary**. Answer:

```json
{ "subGoals": ["log in as a member", "choose the premium plan"] }
```

**This is the highest-leverage thing you do.** Each sub-goal becomes a semantic
search query against that vocabulary. Phrase them in words the corpus already
uses — near-verbatim where a listed segment does the thing — or retrieval finds
nothing and the run stops. A sub-goal is one thing that must HAPPEN, not one UI
interaction: "log in as a member" is one sub-goal, not five.

Include prerequisites the user left implicit. Someone asking to "check out" on
an app that requires login means log in first.

**A sub-goal list is an ORDER, not a set.** Each binding is judged from the
state its predecessor leaves behind, so listing the right segments in the wrong
sequence manufactures seams that do not exist and can send you probing a gap
across nothing. This is easy to get wrong because a *sensible* order and the
*recorded* order are often different: on one real multi-step intake the contact
details came before the date of birth, and the eligibility questions came
**last** — decomposing it in the order a person would describe it produced two
"unresolved" seams that vanished once the order matched the recording.

When the segments you are about to name all came from one recording, check what
that recording actually did before committing to an order:

```sql
SELECT seg.slug, min(pfs.ordinal), max(pfs.ordinal)
FROM flows seg
JOIN flow_steps sfs ON sfs.flow_id = seg.flow_id
JOIN flow_steps pfs ON pfs.step_id = sfs.step_id
JOIN flows p ON p.flow_id = pfs.flow_id AND p.source = 'recorded'
WHERE p.slug = '<the recording>' AND seg.source = 'sliced'
GROUP BY seg.slug ORDER BY 2;
```

And if a whole recording already covers the goal, **one sub-goal naming that
flow beats seven naming its parts** — it binds the parent directly and has no
seams to resolve at all.

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
plainly the wrong thing: "complete a business account application" returned the
personal-account ID-upload segment at 0.8072, which reads as known but is a
different flow. Judge the text, not just the number.

**If it is a gap: drive it by hand, then write down what you did.** Exploration
that is not captured is work done twice. Note that anything with a file upload
must be captured as a script and imported, never with `record` — see the
gotchas below. Write the flow as a Playwright spec
under `.understudy/explorations/` (gitignored — the steps carry whatever was
typed into a real form), then `import` → `replay` → distil → ingest. Going
through `import` means replay has to *prove* every step, which is what separates
a recording from a story about one.

**When the flow cannot be ingested, capture the knowledge instead.** Ingest
replays, so a flow ending in a real purchase or an unimplemented action must not
become a recording — it would file an order every time. That is not a reason to
come away with nothing. Bank what the run taught as facts and lessons, and note
in the recording's `corrections` where the capture had to stop and why. The
`corrections` field is read by whoever picks the flow up next; treating it as the
place to explain an edge is what makes the edge cheap the second time.

---

## Recording a flow without recording how you got there

**Shipped 2026-08-21.** You no longer have to capture the login (or anything
else upstream) to capture the thing you actually care about.

```bash
understudy record myapp --arm-manually \
    --value MEMBER.email=… --value SECRET.password=…
```

The browser opens, **nothing is captured**, and you drive to wherever the flow
you want actually starts. Press Enter in the terminal and capture arms from
there. Step 0 becomes a `goto` to wherever you armed, so the recording is still
self-contained and still replays.

**The session is saved at arm time and reused next run.** Keyed on a hash of
the `--value` credentials you passed, so a different member is a different
session and misses the cache. Miss means you sign in by hand once and it is
banked for next time. `--fresh` ignores the cache and signs in again.

This matters beyond convenience: every replay does a cold login and `distill`
replays *again*, so verify-then-ingest used to cost 2–3 logins per recording
against an app that locks the account for 15 minutes. `replay`, `ingest` and
`distill` all restore the session automatically for recordings that need one.

Three things to know before it surprises you:

- **A saved session may only satisfy what was NOT recorded.** If the flow you
  are capturing IS the login, do not arm late — the steps have to run, or
  ingest "proves" a login it never performed.
- **A stale session announces itself properly.** The arm-time fingerprint rides
  on step 0 as an ordinary `expectedSig`, so an expired session surfaces as an
  unexpected page (the app serves the login page at the URL that used to be the
  account page — exactly what `sig()` catches and a URL check cannot). The
  cached entry then deletes itself; re-record with `--arm-manually` to refresh.
- **To skip an INTAKE, use `--after` — a session alone cannot.** Wizard progress
  is server-side and is not in `storageState`, so it has to be walked. See
  *Starting a recording after a whole intake* below.

`.understudy/sessions/` is gitignored and written 0600. It holds live tokens;
treat it like a password file and never mirror it to the database.

---

## Starting a recording after a whole intake

**Shipped 2026-08-24.** `--arm-manually` skips a login; this skips anything the
corpus already knows how to do.

```bash
understudy record myapp \
    --after log-in-as-a-member --after complete-onboarding-intake \
    --value MEMBER.email=… --value SECRET.password=…
```

Those flows are replayed in the browser about to be recorded, **unrecorded**,
and capture arms where they finish. Repeatable and ORDERED. Add
`--arm-manually` as well to adjust by hand before capture arms.

The recording stores the prelude **by reference** — the flow slugs, not their
steps — so `replay`, `ingest` and `distill` all walk it automatically, and
fixing the referenced segment once fixes every recording built on it.

Five things worth knowing before they surprise you:

- **Name a flow slug that exists.** `understudy flows <app>` lists them. An
  unknown slug fails before the browser opens, which is the cheap failure.
- **A prelude that will not replay aborts the recording**, and reports
  `preludeOk: false` rather than blaming the recording — its own steps never
  ran. Fix or re-ingest the referenced flow.
- **A destructive prelude is refused** unless you pass `--allow-purchases`. It
  would otherwise run on record, replay, ingest *and* distill — four real
  orders per recording.
- **Prelude flows that fill credentials need the same `--value` here**, because
  they are actually executed.
- **The planner blocks a bound flow whose prelude the plan does not run**,
  naming the missing slug. Fix it by adding a sub-goal that binds the prelude
  flow first — usually just "log in as a member" — not by working around it.
  Running the prelude automatically during execution is not built.

`npm run prelude:check` gates all of this and is **safe** — like `auth:check`
and unlike `explore:check`, it scopes to a reserved slug and deletes nothing
else.

---

## When a run gets stuck and asks YOU to record

**Shipped 2026-08-25.** A run that cannot do something no longer dies. It parks,
hands you a command, and continues from wherever you get to.

You will see a `needs_decision` with `kind: "needs_capture"`:

```jsonc
{ "kind": "needs_capture", "trigger": "unimplemented_action",
  "why": "replay does not implement action 'dispatch_click'",
  "atStep": 34,
  "from": { "url": "https://…/checkout/summary", "sig": "/checkout/summary#3f2a…",
            "sessionFile": ".understudy/sessions/handoff-<runId>.json" },
  "howTo": { "run": "understudy record myapp --seed-session … --seed-url …" } }
```

Do exactly this:

1. **Run the `howTo.run` command.** It opens a browser already signed in and
   already on the page the run is stuck on, with capture disarmed.
2. **Drive the piece the run could not do**, then press Enter to arm and record
   only what matters. Close the window when done.
3. **Send back the hash it printed**: `understudy_resume_run(requestId,
   { recordingHash: "…" })`.

The run reseeds its own browser from where you finished and carries on.

Five things worth knowing:

- **Your steps are NOT re-executed.** You and the run share the app's
  server-side session, so by the time you close the window the work is already
  done. Re-driving your steps would advance an already-advanced flow and apply
  every side effect twice. The run adopts the state you reached and continues at
  the next step.
- **A seam handoff is the exception, and it is handled for you.** There, what
  you recorded is the BRIDGE between two segments, so the destination's own
  first step still runs afterwards.
- **You can decline.** `{ action: 'skip' }` lets the run fail at that step;
  `{ action: 'abort', reason }` stops it. Both are honest answers — a real
  purchase is a good reason to skip.
- **The capture is saved but NOT distilled.** That is deliberate: the run
  continues without paying for a model call. Distil and ingest it afterwards, or
  the next run asks again. The finished run tells you so in `manualHandoffs`.
- **A run that needed you is not reported as a clean pass.** `passed: true`
  arrives alongside `manualHandoffs`, because a human did part of it.

### What makes a run ask

Four triggers, all tunable in `.env` (defaults in `.env.example`):

| Trigger | Env var | Default |
|---|---|---|
| a step failed too many times | `UNDERSTUDY_MAX_STEP_ATTEMPTS` | 1 (no retries) |
| too many questions | `UNDERSTUDY_MAX_DECISIONS` | 25 |
| the run has taken too long | `UNDERSTUDY_MAX_RUN_MINUTES` | 30 |
| too many tokens exchanged | `UNDERSTUDY_MAX_DECISION_TOKENS` | 120000 |

Plus two that always fire regardless of budget: an **unimplemented IR action**
(`dispatch_click` — `wait_url` and `wait_text` are now implemented) and an
**unresolved seam**.

**On the token budget, know what it can see.** Understudy calls no model in this
mode — you are the reasoner — so it cannot read your usage. It meters the
payloads it hands you and the answers coming back, plus a surcharge per image it
asks you to open. That under-counts your own thinking, so it trips early by
design. If you know your real figure, pass it on any resume:
`understudy_resume_run(requestId, answer, { totalTokens: 48000 })`. It is folded
in with `max()`, so it can only make the budget trip **sooner**, never later.

`npm run handoff:check` gates all of this and is the cheapest check in the repo
— no database, no corpus, no model.

`npm run auth:check` gates all of this and is **safe** — unlike `explore:check`,
it deletes nothing.

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

## Adding to memory as you work

You will learn things the corpus does not have — running a flow by hand, reading
an API response, watching `explore` refuse a control, losing an hour to a
selector. **Write those down.** A fact or a lesson costs one row and saves the
next run, and this is how the memory gets good: not from bulk recording, but
from the specific thing that surprised someone.

**Confirm before you write, and batch the ask.** Do not stop mid-task to request
permission for each row — that turns a working session into an interview. Note
what you propose to store, keep working, and put the whole list to the user at a
natural pause: one message, one line per item, each tagged with the kind you
propose. They approve or cut, then you write. Nothing blocks.

**Write it with `understudy_remember`** (see *Writing down what you learned*
above) — one call for the whole approved batch. Do not hand-write SQL for this:
a fact and its `memory_chunks` row must go in as one transaction, and a fact
written without its chunk is invisible to `recall()` **forever**, with nothing
ever reporting it missing.

Which kind it is:

> A **fact** is declarative and retrieved BY MEANING at planning time.
> "Order history is at `/past-invoices`, not `/orders`." "Reaching checkout
> texts a real phone." There is nothing to *do* at a step; it changes what you plan, and
> sometimes whether you run at all.
>
> A **lesson** is a conditional fix matched by EXACT TRIGGER during execution.
> "When filling Card number, dismiss Stripe Link first." It changes one step.
>
> A **finding** is "the app is broken" and someone fixes the app.

The test: if acting on it changes a single step, it is a lesson. If it changes
your plan or your willingness to run, it is a fact. If it changes the app, it is
a finding.

**Prefer facts about consequences over facts about structure.** "On page X you
can click Y" is the cheapest kind to generate and the least useful to retrieve —
you can see it by loading the page. The facts that earn their row are the ones
describing what *happens*: what a control commits to, what has a side effect,
what an environment does or forbids.

**A lesson with `times_applied = 0` is an untested lesson.** Its trigger has
never matched anything, and a trigger that never matches looks exactly like one
that was never right. When you write a lesson, check the trigger against a
plausible step context rather than assuming containment does what you meant.

**`times_helped` means something specific and strict:** the guarded step passed
**and** a step of that same fingerprint has failed before. Simply "the step
passed" was the old definition and it was nearly useless — on a healthy flow
every step passes, so the two counters moved together and the ratio could not
tell a load-bearing lesson from a harmless one. So `applied` high with `helped`
at zero is not a bug; it reads *"this has never fired on a step with a history
of going wrong"*, which usually means the trigger is too broad or the lesson has
outlived its cause.

---

## Things that will cost you an hour if you don't know them

**Logins are often rate limited.** One app in testing locks the account for 15
minutes after a handful of attempts. Every replay does a cold login and `distill`
replays *again*, so verify-then-ingest is 2–3 logins per recording. Plan for it:
use `dryRun` while iterating, batch your ingests, and do not debug by re-running
the same replay. **Since 2026-08-21 a recording captured with `--arm-manually`
carries a saved session and skips the login entirely** — see *Recording a flow
without recording how you got there*. That does not help a recording whose own
steps are the login, which must still run them.

**Stop before the irreversible step.** Ingest replays the recording every time,
so a captured "Confirm & Submit" or Stripe checkout files a real order on every
ingest. Trim with `import --until <n>` and say why in `corrections`.

**Credentials never live in recordings.** A password field records a
`valueRef` like `MEMBER.password`, never the value. Supply them per run through
`values`.

**One IR action is legal in the schema but unimplemented** — `dispatch_click`.
A flow gated behind a `dispatchEvent` submit cannot be captured past that point
yet, and that is usually where a capture has to stop. It no longer kills a run,
though: since 2026-08-25 it escalates to a handoff and asks you to record the
piece by hand. `wait_url` and `wait_text` were implemented 2026-08-25;
`scroll_container` shipped 2026-08-19.

`scroll_container` **is** implemented (2026-08-19). Capture it by writing
`locator.scrollIntoViewIfNeeded()`, which the importer maps directly; a
`page.evaluate` that assigns `scrollTop` from a literal `querySelector` is also
recognised. It has two forms: `value: 'bottom' | 'top'` scrolls the pane itself,
and no value scrolls content into view within whatever ancestor scrolls. Reach
for it whenever a control is gated behind reading a summary — and note the gate
may keep the control **out of the DOM entirely** rather than merely disabling
it, so `isEnabled()` throws instead of returning false.

**The importer warns about calls it cannot express, and you must read those
warnings.** It used to skip an unmappable call in silence, so an import
"succeeded" while quietly dropping a load-bearing step and the recording only
failed later, at replay, somewhere else. Anything in `UNEXPRESSIBLE` —
`evaluate`, `dispatchEvent`, `hover`, `dragTo`, `waitForFunction`, `route` — now
prints `step DROPPED`. A clean import with warnings is not a clean import.

**Mined macros are context, never a bind target.** They are stored as
`kind='segment'` but excluded from `bindable`, because mining knows a block
*recurs* and cannot know what it is *for* — and mechanical text was repeatedly
outranking real intents ("log in as a member" bound to a login preamble block
instead of the named segment). You will see them in the CONTEXT list; they are
useful for splicing and for seams, which select them directly. If one looks like
the answer to a goal, the real answer is a segment that does not exist yet.

**Never ask the user to `record` a flow that has a file upload.** The live
recorder has no branch for `type === 'file'`, so it stores the browser's masked
`C:\fakepath\…` string as a `fill`. The step cannot replay and the file is not
in the recording at all — and none of that is reported, so a recording that
looks complete is quietly useless. Ask for the walkthrough if you like, then
write it as a Playwright script and `import` it, where `setInputFiles` becomes a
real `upload`. Costing a person ten minutes of recording for an unusable
artefact is the expensive version of this mistake.

**A step that fails "locator matched no elements" is not always a bad
selector.** On one app, `/choose-plan` rendered nothing but the sidebar on the
first visit after login; a second `goto` rendered the list. Two replays
were spent blaming the locator. Before rewriting a selector, check whether the
page rendered at all — `body.innerText` answers it in one call.

**A seam probe now arrives with EVIDENCE — read it before answering.** The
request carries the destination's opening steps, the source's closing steps,
the known page edges out of the state you are stuck in, and any segment
touching either end. That is there so you do not have to go digging, and so the
honest refusal is visible: if `knownEdgesFromHere` says the only way out is via
`(unnamed control)`, the answer is `[]`, not an approximation.

**Unnamed controls are flagged at ingest**, as `addressability` findings. A
recording containing one is telling you that some step cannot be expressed as
`{role, name}` — exactly what makes a seam involving it unresolvable later.
`understudy ingest` prints `UNNAMED n control(s)` when it happens; that line is
worth acting on rather than scrolling past.

**`npm run explore:check` DELETES the whole saucedemo corpus.** It opens with
`DELETE FROM apps WHERE slug = 'saucedemo'`, which cascades away every flow,
step, selector, finding and chunk stored under it — it is a fixture builder, not
a read-only test. (`recall:check` is safe; it scopes to its own `recall-check`
slug.) This bit during a routine regression pass and silently destroyed evidence
gathered ten minutes earlier. Do not keep anything you care about under
`saucedemo`, and re-ingest after running it.

**An unresolved seam blocks execution, and that is correct.** It means "I don't
know how to get from here to there". Do not work around it by loosening
something — either probe it properly, or let it block.
