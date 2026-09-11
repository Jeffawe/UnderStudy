# AGENTS.md

**Understudy** is an agent-assist tool that learns web apps from browser
recordings and stores that knowledge as queryable memory in CockroachDB. The
user should be able to ask for a goal, such as "test login", and have the
agent use the remembered corpus instead of clicking blindly through the app.

This file is the Codex entry point. Keep it small. It mirrors `CLAUDE.md` as a
router, with the extra Codex-specific detail needed because Codex does not
expand Claude's `@REASONER.md` import syntax.

## Launch Profile

When starting Codex specifically for this repository, use the scoped profile:

```bash
codex --profile understudy-only --cd /Users/somua/Documents/Projects/Tester/understudy
```

That profile is intentionally Understudy-only. Do not use broader profiles or
approve access outside this folder unless the user explicitly asks for that
specific task.

## Every Session

- Read `REASONER.md` before using Understudy to run, plan, distill, ingest, or
  remember app behavior. That file is the operating contract.
- You are the reasoner/distiller, not the browser driver by default.
  Deterministic code owns replay, recall, binding, seam resolution, and
  execution; it asks you questions when judgement is needed.
- Memory comes first. For goals, decompose the request into app-vocabulary
  sub-goals, say that decomposition to the user, then recall or plan from the
  corpus. Do not drive blind before checking memory.
- Be honest about the executor. If Understudy runs it, say so. If you drive by
  script, browser, MCP, or API because that is the viable path, say that too
  and record the attributed run or proposed memory at a natural pause.
- When the corpus has a gap, use the best tool to reach the goal, then preserve
  what was learned. Record ingestible flows; for non-replayable tails such as
  real purchases, bank facts, lessons, or findings instead.

## Goal Handshake

Use MCP tools when available; otherwise use the CLI equivalents in this repo.

- Plan/run: `understudy_run_plan(appSlug, goal, { dryRun: true })`, then keep
  calling `understudy_resume_run(requestId, answer)` until the status is
  `planned`, `executed`, `blocked`, or `failed`.
- Recall first when driving manually: `understudy_recall(appSlug, goal)`.
- Vocabulary grounding: `understudy_vocabulary(appSlug)` helps phrase
  sub-goals in the corpus's own language.
- Distill/ingest: `understudy_recordings` -> `understudy_distill(hash)` ->
  `understudy_save_distilled(hash, distilled)`.
- Remember learned knowledge with `understudy_remember`; batch proposed facts,
  lessons, and findings and confirm before writing.
- Attribute manually achieved goals with `understudy_record_run` or
  `understudy attribute`.

## Code Work

- If changing code, read `BUILDING.md` first. Read `PLAN.md` for architecture
  changes and `STATUS.md` for current build state. Grep `STATUS-HISTORY.md`;
  do not read it whole.
- Prefer the existing TypeScript patterns and local adapters. Keep the package
  dependency-light unless the user explicitly approves a new dependency.
- Do not hand-write SQL for memory facts or lessons; use the existing memory
  APIs/tools so embeddings and relational rows stay transactional.
- The MCP server is long-lived and loads `src/` once. After changing source
  that MCP tools should use, reconnect the MCP server before trusting tool
  behavior.

## Safe Checks

- `npm run typecheck`
- `npm run build`
- `npm run recall:check`
- `npm run auth:check`
- `npm run prelude:check`
- `npm run handoff:check`

`npm run explore:check` is not a routine safe check: it deletes the whole
`saucedemo` corpus as part of fixture setup.

The 30-second stack proof from `STATUS.md` is:

```bash
PATH="/opt/homebrew/bin:$PATH" ./scripts/db-start.sh
npm run typecheck && npm run build
npx tsx src/entry/cli.ts test providernow "start a weight loss plan" \
  --sub-goal "log in as a member" \
  --sub-goal "choose the weight loss service" \
  --dry-run
```

## Sharp Edges

- Needs Node 22+ and CockroachDB. Local Cockroach lives at
  `/opt/homebrew/bin/cockroach`; a bare `PATH` may not find it.
- Credentials never belong in recordings. They are supplied as value refs such
  as `MEMBER.password`.
- Do not record file-upload flows with the live recorder; write/import a
  Playwright script so `setInputFiles` becomes an `upload`.
- Stop recordings before irreversible steps. Ingest replays recordings and can
  repeat real side effects.
- Answer seam questions with `[]` unless you actually know the bridge. Seam
  answers become persistent page-graph knowledge.
- For visual diffs, open the screenshot paths. Do not judge from percentages
  alone.
