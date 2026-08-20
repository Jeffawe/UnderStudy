# Understudy — Architecture

Two deployment modes, one codebase. This file is the build spec.

**Conceptual background and the full build plan live in `/Users/somua/.claude/plans/ok-i-love-what-humble-cocke.md`.** Part 1 explains how the system works, Part 2 is the day-by-day plan, schema, risks, and demo script. This file supersedes that plan's single-surface assumption: there are two modes, and the reasoner is an adapter.

---

## The three roles

Everything in the system that needs a model is one of these. Nothing else does.

```ts
interface Embedder  { embed(text: string): Promise<number[]> }        // text → 1024 floats
interface Distiller { distill(recording): Promise<DistilledFlow> }    // recording → IR + corrections
interface Reasoner  { decompose(goal, vocab), resolve(decision) }     // goal → sub-goals; judgment calls
```

**Embedder and distiller are functions.** Known input shape, known output shape, cacheable, run unattended.
**The reasoner is an agent.** It loops, decides what to do next, and can stop and ask a human. That's why it can be Claude Code and the others can't.

The distiller runs at ingest. The reasoner runs at request time. The embedder runs at **both** — it embeds chunks on write and the query on read, which is why its model can never change without re-embedding everything.

`understudy explore` is the reasoner doing a different task, not a fourth role.

---

## Mode A vs Mode B

| | **Mode A — hosted** | **Mode B — subscription** |
|---|---|---|
| **Embedder** | local ONNX | local ONNX |
| **Distiller** | Bedrock Sonnet 5 + Haiku 4.5 slice | host agent, one pass |
| **Reasoner** | Bedrock Sonnet 5 | host agent |
| **Entry point** | `understudy serve` — HTTP + web UI | `understudy mcp` — stdio |
| **Store** | CockroachDB Cloud | CockroachDB (local or Cloud) |
| **Artifacts** | S3 `raw/` `shots/` (traces stay local) | local disk |
| **External deps** | AWS | **none** |
| **Who it's for** | judges, teammates, anyone without a sub | daily use, attached to Claude Code / Codex |

Both modes have all three roles. The only difference is who provides them.

> **Embedder decision:** local ONNX in both modes. One vector space, portable corpora, and the AWS requirement is still met via distiller + reasoner. Titan v2 remains a drop-in alternative for Mode A if that changes — but see the embedder guard below before mixing.

---

## Recording

**Recording is local in both modes, always.** It needs a headed browser and a human; there is no hosted version of that.

```
        ┌──────────────── IDENTICAL IN BOTH MODES ────────────────┐
        │                                                          │
  understudy record <slug>                                          │
    → codegen wrapper, headed, human clicks          [local]        │
    → replay headless with tracing                   [local]        │
        · per-step screenshots + a11y snapshots                     │
        · console / network / request + response bodies             │
        · data-understudy-seq stamping for correlation              │
    → won't replay?  →  needs_review, never promoted                │
        └──────────────────────────┬───────────────────────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                          ▼
        ── MODE A ──                              ── MODE B ──
   upload raw/ → S3                          agent → promote_recording(path)
   Lambda ingest-recording fires               ← raw + trace + prompt + schema
     ├ distill    [Sonnet 5, structured]      agent distills in a SUBAGENT
     └ slice      [Haiku 4.5, cheap]            (steps[] + segments[] in one pass)
                                              agent → save_distilled(hash, json)
                                                → server validates against schema,
              └────────────────────┬───────────── returns error + retries on mismatch
                                   ▼
        ┌──────────────── IDENTICAL AGAIN ────────────────┐
        │  corrections applied                             │
        │  selectors deduped against the app                │
        │  destructive inferred (5 signals, fails open)     │
        │  embed every chunk                                │
        │  ONE TRANSACTION → flows · steps · flow_steps ·   │
        │    selectors · lessons · facts · memory_chunks    │
        │  macro mining runs across flows                   │
        └───────────────────────────────────────────────────┘
```

Two model calls in Mode A because Haiku is cheap and slicing is mechanical. One call in Mode B because there's no cost pressure and the agent already holds the recording in context.

**Cache by recording hash in both modes.** Build this on day one, not day seven.

**`record` and `import` are not yet interchangeable, and the difference is a
file input.** The live recorder has no `type === 'file'` branch, so it captures
an upload as a `fill` holding the browser's masked `C:\fakepath\…` string: the
step cannot replay and the file is not in the recording. `import` maps
`setInputFiles` to `upload` correctly. Until the recorder gains that branch, any
flow with an upload has to be written as a script and imported, which means the
"human clicks" path above does not actually cover the whole app. Closing this is
the top item in `STATUS.md`'s build order — it needs a decision about how a
recorded file resolves to a path at replay time, since the browser will not give
one up.

---

## Testing

The executor is one piece of code. The only thing that changes between modes is who it asks when it gets stuck.

```
   MODE A: POST /test {goal, env}        MODE B: "run the checkout flow"
              │                                        │
              └────────────────┬───────────────────────┘
                               ▼
        ┌──────── SHARED, DETERMINISTIC ────────┐
        │ fetch vocabulary: segment titles +     │  SQL
        │   flow titles + facts                  │
        └───────────────────┬────────────────────┘
                            ▼
                    ╔═══ REASONER ═══╗
                    ║  decompose      ║   A: Bedrock   B: host agent
                    ║  → sub-goals[]  ║
                    ╚════════╤════════╝
                             ▼
        ┌──────── SHARED, DETERMINISTIC ────────┐
        │ per sub-goal: embed → ANN → re-rank    │
        │ bind if top_distance < threshold       │
        │ prefer 1 flow covering ≥2 sub-goals    │
        │ seams: sig → bridge → graph → goto     │
        │ safety gate: bool_or(destructive)      │
        └───────────────────┬────────────────────┘
                            │
                     gap, ambiguous seam,
                     or unexpected page?
                            │
                    ╔═══ REASONER ═══╗
                    ║  resolve()      ║   A: Bedrock   B: host agent
                    ╚════════╤════════╝
                             ▼
        ┌──────── SHARED EXECUTOR ──────────────┐
        │ walk IR steps, headless Playwright     │
        │  per step:                             │
        │   · lessons_for(url, action, role)     │  exact trigger, SQL
        │   · compute sig, compare to expected   │  deterministic
        │   · capture console / network / bodies │  free
        │   · round-trip assert on filled values │  mechanical
        │  page ≠ expected → REASONER            │
        └───────────────────┬────────────────────┘
                            ▼
        ┌──────── SHARED, DETERMINISTIC ────────┐
        │ finish_run:                            │
        │  · sig-sequence diff vs last N runs    │ ← flow drift
        │  · selector health rollup + quarantine │
        │  · page_edges kind=inferred_from_run   │
        │  · findings deduped by fingerprint     │
        └────────────────────────────────────────┘
```

---

## The pause-and-ask mechanism

Deterministic server code cannot call into a Claude Code session. So the executor never calls anyone — **it pauses and returns.**

```
Mode A                              Mode B
──────                              ──────
executor hits a decision            executor hits a decision
  → BedrockReasoner.resolve()         → HostAgentReasoner.resolve()
  → API call, resolves in ~2s         → writes a pending row, returns
  → executor resumes                  → run_plan() returns needs_decision
                                      → agent decides
                                      → resume_run(run_id, decision)
                                      → promise resolves, executor resumes
```

Same interface, same executor, different adapter. **`context_requests` already models this** — `pending → delivered → answered → ingested`. It was designed for "agent asks human" and works unchanged for "server asks reasoner."

The same handshake appears twice. Build it deliberately once:

| Server does the mechanical work | Pauses | Reasoner answers |
|---|---|---|
| `promote_recording(path)` | → | `save_distilled(hash, json)` |
| `run_plan(plan_id)` | → | `resume_run(run_id, decision)` |

**Corollary:** in Mode B the agent does **not** drive the browser step by step. Eighty MCP round-trips would be slow and would consume the context you're working in. The executor drives; the agent is consulted at decision points only. It reaches for Playwright MCP directly just for live probing and selector repair.

---

## Shared vs differs

**Shared — identical code in both modes:**
recorder · replayer + trace enrichment · signal capture · schema and every query · `recall()` with over-fetch and re-rank · binding · `sig()` · page graph · seam resolution · safety gate · executor · flow-drift diff · health rollup · quarantine · macro mining · emitters · MCP handler modules

**Differs:**
three adapter implementations · transport wrapper (HTTP vs stdio) · artifact location · DB connection string

Roughly ninety percent shared. One implementation, three adapters, two entry points.

---

## Package shape

```
understudy/
  core/        schema · recall · executor · sig · seams · findings   ← all shared
  adapters/
    embedder/  onnx-local.ts · titan-bedrock.ts
    distiller/ bedrock.ts    · host-agent.ts
    reasoner/  bedrock.ts    · host-agent.ts
  entry/
    serve.ts   HTTP + web UI      → Mode A
    mcp.ts     stdio MCP server   → Mode B
    cli.ts     record · explore · run · emit
```

`npm i understudy` stays a few MB. ONNX weights download once on first use and cache to disk.

---

## Key concepts

### Selectors

A step splits into **what to do** (`steps`) and **how to find the element** (`selectors`), joined by `steps.selector_id`. They're separate because the same element is used by dozens of steps across many flows:

```
selectors
  sel_44 │ role=textbox │ name="Street address" │ fragility=stable │ health=0.92

steps
  s_101 │ fill │ sel_44 │ MEMBER.street   ← weight-loss intake
  s_288 │ fill │ sel_44 │ MEMBER.street   ← hair-loss intake
  s_512 │ fill │ sel_44 │ MEMBER.street   ← mental-health intake
```

**Deduping at ingest:** look for an existing row on this app matching `(role, name, frame_hint)`. Found → reuse the id. Not found → insert.

Why it matters: one health score per element (a rename degrades every flow at once, and you see one cause not twelve); heal once and all flows are fixed; quarantine at ≥3 failures / 0 successes drops the chunk from `recall()`.

`fragility` is computed at ingest from the locator's shape — role+name → `stable`, `.nth(5)` → `positional`, `#a3f9b2` → `hashed`. It decides whether a failure is *rot* (heal silently) or a *genuine gap* (ask).

### Seams

The join between two bound segments: getting from where segment A ends to where segment B starts. No recording ever contained it, because A and B came from different recordings.

Escalate only as far as needed:

```
1  sig match          A.end_state == B.start_state         → concatenate, 0 steps
2  bridge segment     BFS over flow states, depth ≤ 2      → splice a known segment
3  page graph         page_edges has A.end → B.start       → emit that edge's control
4  navigation gap     same origin, different route          → synthetic goto + wait_url
5  live probe         Playwright MCP, headed                 → persist as segment + edge
```

Rung 3 is what pays for exploration — it connects page pairs no recording ever visited together, as a graph query rather than a browser session. Rung 5's result is written back as both a bridge segment and a `page_edge`, so the next composition lands on rung 2 or 3.

**At every seam, reconcile preconditions.** `authenticated as PROVIDER` after `authenticated as MEMBER` means `browser_set_storage_state`, not an attempted login.

### Findings — "X is wrong"

A fourth knowledge kind alongside segment / fact / lesson. The distinction is **who changes**:

| | Says | Who changes |
|---|---|---|
| segment | how to do X | — |
| fact | X is true | — |
| lesson | when X, do Y first | **the agent adapts** |
| **finding** | **X is wrong** | **the app gets fixed** |

The same observation is a lesson if you accept it and a finding if you don't — so findings get triaged into `lesson` (work around it) or `issue` (fix it). Only a human makes that call.

**Detection is free; judgment is the reasoner.** The harness collects console errors, non-2xx responses, unhandled rejections, and request/response bodies unconditionally on every run — no model involved. The reasoner is consulted only about what any of it means, and its value-add is **correlation with intent**: it knows which sub-goal was executing when the 500 fired.

Because capture is unconditional, findings dedupe by fingerprint across runs and accumulate `occurrences` whether or not anyone was watching.

**Scope for this build: backend/data findings, not visual.** Silent 500s the UI swallowed, response bodies missing fields that were sent, values that don't survive a reload, same request returning different shapes across runs. The round-trip assertion is generatable — the IR knows what value went into which field, so the replayer can check persistence with no assertion written by hand.

**Visual drift is explicitly out of scope.** Flow drift is in.

### Flow drift

Every run records its sequence of page fingerprints. Compare to the last N runs of the same flow:

```
run 47:  /login → /inventory → /cart → /checkout-one → /complete
run 52:  /login → /inventory → /cart → /promo-upsell → /checkout-one → /complete
                                       ^^^^^^^^^^^^^ new sig, never seen
```

A text diff. No model, no pixels. A conventional test suite cannot do this — it has no memory of what the flow looked like last week. The page graph is that memory.

Same mechanism detects nondeterminism: run twice, diff the sequences.

---

## Day-one guards

- **Embedder guard.** A `meta` table storing the embedder id, checked at startup; refuse to run on mismatch. Titan v2 and `mxbai-embed-large` are both 1024-dim but occupy unrelated vector spaces — mixing them returns confident nonsense with no error.
- **Every vector index inline in `CREATE TABLE`, on an empty table.** Adding one later blocks writes for the whole backfill.
- **Cache distillation by recording hash** before iterating on prompts.
- **Calibrate the 0.85 threshold empirically** against 10 known-good and 10 deliberately-unknown queries. Don't ship a guessed constant.

## Schema additions beyond the master plan

- `meta` — embedder id and schema version
- `findings` — kind, severity, statement, evidence JSONB, fingerprint, occurrences, first/last seen run, status, promoted_to
- `flow_steps(flow_id, step_id, ordinal)` — membership, so segments and mined macros reference steps without duplicating them
- `flows.source ∈ {recorded, sliced, mined}` — provenance; `is_macro` covers only the third
- `runs.sig_sequence` — the observed fingerprint path, for flow-drift diffing
- `run_events` — request/response bodies alongside status codes
- `memory_chunks.kind` — add `finding`
