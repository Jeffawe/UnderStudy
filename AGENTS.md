# AGENTS.md

**Understudy** runs end-to-end tests against the user's web apps. It learns
each app from browser recordings and keeps that knowledge as searchable memory
in MongoDB, so the user can ask for a goal such as "test login" and you use
the remembered app instead of clicking blindly through it.

This file is the Codex entry point. Keep it small. Codex does not expand
Claude's `@REASONER.md` import, so it says what `CLAUDE.md` does by import.

## Launch profile

When starting Codex specifically for this repository, use the scoped profile:

```bash
codex --profile understudy-only --cd /Users/somua/Documents/Projects/Tester/understudy
```

That profile is intentionally Understudy-only. Do not use broader profiles or
approve access outside this folder unless the user explicitly asks for that
specific task.

## Every session

- **Read `REASONER.md` before using Understudy** to run, plan, distill or
  remember anything. It is the operating contract, and it is short.
- MongoDB must be reachable at `MONGODB_URI`; check with `understudy doctor`.
- Memory first: `understudy_recall` is free. Decompose goals into sub-goals in
  the app's own words, and say the sub-goals to the user before acting.
- Be honest about the executor: say whether Understudy ran it or you drove it
  yourself, and record goals you reached yourself (`understudy_remember`
  with `reached`).
- Propose facts, lessons and findings in one batch at a natural pause, and
  write them only after the user approves.

Without MCP, every tool has a CLI equivalent: `understudy --help`.

## Changing the code

- `main` is mid-rewrite onto MongoDB: **read `REWRITE.md` first** — it is the
  plan, the decisions and the progress. `BUILDING.md`, `PLAN.md` and
  `STATUS*.md` describe the old CockroachDB version on `legacy-cockroach`.
- Keep it simple and readable: fewer concepts, plain names. Keep dependencies
  minimal unless the user approves a new one.
- Write memory through `remember` / `saveDistilled`, never by hand: they
  validate, embed, and refuse what would silently break retrieval.
- The MCP server loads `src/` once; reconnect it after changing source.

## Checks

```bash
npm run typecheck && npm run build
npm test            # needs local MongoDB (MONGODB_URI) and Playwright's Chromium
understudy doctor   # connection, vector indexes, embedder
```

Tests use their own databases and empty them afterwards. Run them against local
Community, not a free Atlas cluster: it has no room for the test indexes.
