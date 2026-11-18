# Using Understudy

Understudy runs end-to-end tests against the user's web apps so they don't have
to click through every flow by hand. It remembers each app — flows, facts,
lessons, the page map, what looked broken — in MongoDB, and you (the agent)
supply the judgement. It never calls a model; you are the model.

This file is loaded into every session. It is the whole contract.

## The two rules

**1. The memory is the contract. The executor is not.** Always consult memory
(`understudy_recall`, free, nothing runs). Then reach the goal however works:
`understudy_run`, your own Playwright, the Playwright MCP, curl. A third-party
checkout or a real purchase is an ordinary reason to drive it yourself. Unless
the user asks for Understudy's executor specifically — then use it, and if it
can't do the job, say so rather than quietly substituting.

**2. Say which you used.** "Recalled the flow, then drove the checkout myself
because it's a Stripe page" is one honest sentence. Implying the tool ran
something you drove is the failure that costs trust.

## Setup

Settings (`MONGODB_URI`, optional `EMBED_*`, login values) come from the
environment, `--env-file <path>`, or the env file saved with `understudy
config` — first wins. Check everything with `understudy doctor`. Without an
embedding model, recall matches flow names instead of meaning.

**Login values.** A recording stores a name like `SECRET.password`, never the
value. At replay Understudy uses, first, a value you pass in `values` — e.g.
one you fetched yourself from a secrets store or a test database — and
otherwise reads `UNDERSTUDY_SECRET_PASSWORD` from settings itself, without you
ever seeing it. Never ask the user to paste a password into chat; if you can't
get it, ask them to add it to their env file (`understudy config set
UNDERSTUDY_SECRET_PASSWORD=…`).

The MCP server is long-lived: after source changes, reconnect (`/mcp`) or the
tools keep running the old code.

## The tools

| Tool | Use it to |
|---|---|
| `understudy_recall` | see what memory knows about a goal: closest flows, notes, a verdict |
| `understudy_run` | plan a goal and run it headless; may return a question first |
| `understudy_answer` | answer a run's question; returns the next question or the result |
| `understudy_distill` | get a saved flow's numbered steps to name and split |
| `understudy_save_distilled` | store that (validated; every problem returned at once) |
| `understudy_remember` | store facts, lessons, findings, and goals you reached yourself |
| `understudy_findings` | list what looked broken; triage it |
| `understudy_record` | wait for the user to record a flow in their Chrome |
| `understudy_save` | prove a recording by replaying it, then keep it as a flow |

**Recall verdicts:** *known* — one flow clearly does it. *unsure* — something is
close but not clearly it; look before acting. *unknown* — nothing does it.
Judge the text, not just the score: a close match that is plainly a different
thing is a gap.

## Running a goal

`understudy_run(app, goal)` plans before any browser opens, and can stop with
one of two questions. Once the plan is complete it runs to the end; anything
odd on the way (an unexpected page, a 500) comes back as findings, not
questions. Start with `dryRun: true` — it's free.

Login values: pass ones you have in `values`, or leave them to settings (see
Setup).
Destructive flows are refused unless `allowPurchases: true`.

### Question 1: `decompose` — split the goal into sub-goals

Answer `{"subGoals": ["log in as a member", "open the cart"]}`.

**This is the highest-leverage thing you do.** Each sub-goal is a search
against the app's vocabulary, which comes with the question. Phrase sub-goals
in the words of a listed flow — its slug or title near-verbatim — or nothing
binds and the run blocks. A sub-goal is one thing that must *happen*, not one
click. Include prerequisites the user left out (log in first, if the next flow
needs it). **The list is an order**: put them in the order the app does them,
which may not be the order a person would say them. If one recorded flow
covers the whole goal, one sub-goal naming it beats several naming its parts.

**Say the sub-goals in your reply too**, not only in the tool call, so the user
can correct them before they drive the run. Pass `subGoals` to `understudy_run`
directly when you already know them.

### Question 2: `seam` — how to get from one flow to the next

Two bound flows often came from different recordings. The planner tries three
bridges itself (no bridge needed, the page map, a plain URL) and asks only when
all three fail. The question comes with evidence: where the first flow ends,
how the next begins, and every known link out of that page.

Answer `{"steps": [{"action": "click", "role": "link", "name": "Cart"}]}` or a
`goto`. **Answer `{"steps": []}` unless you actually know** — a one-click answer
is saved to the page map and reused forever, so a plausible guess becomes a
wrong fact. Go and look first if you can (open the page). `[]` blocks the run,
which is correct: it means "nobody knows how to get there".

## Distilling a flow

Optional. A saved flow runs as-is; distilling makes it better: what it's FOR,
and reusable **segments** (e.g. "log in as a member" cut out of a checkout
recording) — which is what lets one goal combine pieces of several recordings.

You annotate and partition; you never author. Refer to steps by index only.
`stepRange` is `[start, end)`. Easy to get wrong:

- **Preconditions are exactly `"authenticated"` or `"not authenticated"`** (or
  empty). Any other wording is rejected.
- **Reuse existing slugs.** The request lists the app's segments; if a block
  does the same thing as one, use its exact slug — that merges them. A synonym
  creates two rivals for the same goal.
- **Segments belong to the app, not the recording.** Name them so any future
  flow could use them.
- **Only report lessons or corrections the recording actually shows.**

## Writing down what you learned

You will learn things memory doesn't have — driving a flow by hand, reading an
API response, losing an hour to a selector. **Write them down**: one row saves
the next run.

**Confirm first, and batch the ask.** Don't interrupt per item. Keep a list as
you work and put it to the user at a natural pause: one line per item, tagged
fact / lesson / finding. Then send the approved list in one `understudy_remember`.

- A **fact** changes what you plan, and is found by meaning: "order history is
  at `/past-invoices`", "reaching checkout texts a real phone". Prefer facts
  about consequences over structure you could see by loading the page. A fact
  with `marksDestructive: "<control name>"` makes any flow clicking that
  control destructive.
- A **lesson** changes one step, matched by exact trigger during execution:
  "when filling Card number, dismiss Stripe Link first". Trigger keys are
  `url_pattern`, `action`, `role`, `name`; an empty trigger is refused (it
  would fire everywhere). `kind: "wait"` makes replay let the page settle
  before that step.
- A **finding** says the app is broken and someone should fix the app.

The same observation is a lesson if you accept it and a finding if you don't.

**Reached a goal without `understudy_run`? Record it** with `reached:
[{goal, passed, drivenBy}]`. It is stored as *attributed*, never as a replay —
"this goal works" and "the executor can do this" are different claims. Pass
`sigSequence` only if you actually observed page fingerprints.

## Triaging findings

Detection already ran on every replay (console errors, failed requests, non-2xx
responses, values that didn't stick, path drift). What's missing is judgement.
`understudy_findings` lists them; route each as `issue` (fix the app), `lesson`
(work around it — store the lesson), or `noise` (third-party telemetry,
framework warnings). Triage the noise or it buries the signal.

A lesson with `timesHelped` at 0 has never fired on a step that previously
failed — usually its trigger is too broad, or its cause is gone.

## When memory doesn't know something

Check with `understudy_recall` first — it's free. If it's a gap, reach the goal
however works, then capture it so it isn't done twice:

- Something the user can click through: **ask them to record it.** Call
  `understudy_record` — it returns at once with what to tell them (start in
  Chrome with the extension, do the flow, stop). When they say they've
  stopped, call `understudy_save` with a name: it replays the recording to
  prove it, and keeps it only if every step passes. (From a terminal it's
  `understudy record <app>`, then `understudy save <hash> "<name>"`.)
- **Anything with a file upload: never `record`.** Neither recorder can say
  which file was picked. Write a Playwright script, then `understudy import <app>
  <file>`. Read the import warnings: a dropped step is not a clean import.
- **Anything irreversible** (a real order, a submission): don't save it as a
  flow — saving replays it, and so does every run. Stop before that step
  (`import --until <n>`), and store what you learned as facts and lessons.

## Things that cost an hour if you don't know them

- **Logins are often rate-limited.** One test app locks the account for 15
  minutes. Every replay logs in cold. Use `dryRun`, and don't debug by
  re-running the same replay. A recording made with `--arm-manually` restores
  a saved session instead.
- **"Locator matched no elements" isn't always a bad selector.** One app
  rendered only its sidebar on the first visit after login. Check the page
  rendered at all (`document.body.innerText`) before rewriting a selector.
- **On Atlas, a newly saved flow takes a few seconds to become searchable.**
  A recall straight after saving can miss it.
- **A free Atlas cluster holds one Understudy database** (3 search indexes per
  cluster; Understudy uses 2).
