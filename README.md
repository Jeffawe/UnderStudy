# Understudy

An agent that learns a web app from browser recordings and stores what it learned
as **queryable memory**, so you can say *"test login"* and it works — including
for goals no single recording covers.

In practice: end-to-end tests against your own sites, without clicking through
every flow by hand.

## Why

Driving a browser blind is expensive. An agent that reads a page snapshot per
interaction spends 3–7k tokens per page, so a fourteen-step login-and-checkout
costs 40–100k tokens — and it re-reasons from scratch every run.

Understudy answers the same goal from memory in **~1.5k tokens**, and what comes
back is an executable plan rather than a description of one.

## How it works

```
record  →  replay  →  distil  →  recall  →  run
```

- **record** — capture a real browser session, or import a Playwright script.
- **replay** — every step must re-run and pass. Nothing enters memory unproven.
- **distil** — slice the recording into reusable **segments** that belong to the
  app, not to the recording they came from.
- **recall** — a vector query over segments, facts and lessons. The distance
  doubles as a confidence signal: too far away means *"I don't know this"*, and
  the agent asks instead of guessing.
- **run** — deterministic code binds segments to sub-goals, bridges the seams
  between them, and executes. It calls no model. When it hits a judgement it
  cannot make, it suspends and asks the agent driving it.

Recordings are stored as data (`{action, role, name, value}`), not code — so
values can be swapped per run, and the same flow can be re-emitted as Playwright
or Cypress.

## Setup

Needs Node 22+ and a CockroachDB instance (local or Cloud).

```bash
npm install
npm run db:start          # local single-node cockroach
npm run db:schema         # apply db/schema.sql
npm run build
```

Copy `.env.example` to `.env` and set your connection string. Credentials are
never stored in recordings — a password field records a reference like
`MEMBER.password`, and you supply the value per run.

## Use it

```bash
npx understudy record myapp            # capture a flow
npx understudy ingest <hash>           # replay it, then store it
npx understudy recall myapp "log in"   # ask what the memory knows — free, no browser
npx understudy test myapp "check out"  # plan and run a goal
```

Or attach it to any MCP-speaking agent (Claude Code, Codex, Cursor). The server
exposes eleven tools; register it in `.mcp.json`:

```json
{ "mcpServers": { "understudy": { "command": "npx", "args": ["understudy-mcp"] } } }
```

The agent is consulted, not in the loop — a run asks it perhaps three or four
questions rather than driving eighty round trips through it.

## For agents

**[`REASONER.md`](REASONER.md)** is the contract for driving Understudy: the
handshakes, the four questions a run will ask, and the gotchas that cost someone
an hour. If you are an agent working in this repo, read that.

## License

MIT
