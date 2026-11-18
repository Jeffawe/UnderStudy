# Understudy

End-to-end tests for your own web apps, without clicking through every flow by
hand. Record a flow once; Understudy remembers it, replays it as a test, notices
when the app changes, and can run goals you describe in words — including goals
that need pieces of several recordings.

It works on its own from the command line, and it plugs into an AI agent
(Claude Code, Codex, Cursor) over MCP. The agent is optional; with one,
Understudy never calls a model itself — the agent is the model.

## What it does

```
record  →  save  →  replay / run  →  findings
```

- **record** — click through a flow in your own Chrome (with the extension) or
  in a fresh browser. Passwords are never stored: a password field is kept as
  a reference like `SECRET.password`, and you supply the value when replaying.
- **save** — the recording is replayed headless first. It is kept only if every
  step passes, so memory only holds flows known to work.
- **replay / run** — `replay` runs a flow by name; `run` finds the flow that
  does a goal you describe ("go to my basket") and runs it. Matching is by
  meaning if you configure an embedding model, by name if you don't.
- **findings** — every run checks for console errors, failed requests, error
  responses, values that didn't stick, and whether the flow took a different
  path through the app than last time. Each problem is reported once, with a
  count, not once per run.

With an agent attached it also splits recordings into reusable segments (a
login cut out of a checkout, say), plans a goal across segments of different
recordings, and writes down what it learns as facts and lessons that apply to
every future run.

## Set up (about five minutes)

You need **Node 22+** and a **MongoDB** with vector search — either a free
[Atlas](https://www.mongodb.com/atlas) cluster, or MongoDB Community Edition
with `mongot` running locally.

```bash
git clone https://github.com/Jeffawe/UnderStudy.git && cd UnderStudy
npm install
npx playwright install chromium
cp .env.example .env          # then set MONGODB_URI
npx tsx src/entry/cli.ts doctor
```

`doctor` connects, creates what it needs, and reports whether vector search is
ready. To match goals by meaning, add an embedding model to `.env` — any
OpenAI-style endpoint works; Voyage (`voyage-4-lite`, 200M free tokens) is the
default, and Ollama works offline for free. Without one, goals match flow names.

> **Atlas free clusters** allow 3 search indexes; Understudy uses 2, so one free
> cluster holds one Understudy database.

## Use it

```bash
understudy record myapp --extension         # record in your own Chrome (see extension/README.md)
understudy record myapp --url https://…     # or in a fresh browser
understudy save <hash> "log in as a member" # prove it by replaying, then keep it
understudy flows myapp                      # what it knows how to do
understudy replay myapp log-in-as-a-member  # run one flow
understudy run myapp "sign in"              # find the flow for a goal, and run it
understudy findings myapp                   # what looked broken
understudy emit myapp log-in-as-a-member    # print it as a Playwright (or Cypress) test
```

(`understudy` is `npx tsx src/entry/cli.ts` until you `npm run build && npm link`.)
`understudy --help` lists everything. A flow that commits something real — a
purchase, a deletion — is marked destructive and refused unless you pass
`--allow-purchases`.

## With an agent

Register the MCP server (this repo's `.mcp.json` already does):

```json
{ "mcpServers": { "understudy": { "command": "npx", "args": ["tsx", "src/entry/mcp.ts"] } } }
```

Seven tools: `recall`, `run`, `answer`, `distill`, `save_distilled`,
`remember`, `findings`. [REASONER.md](REASONER.md) is the contract for using
them — how to split a goal, when to answer a question and when to say "I don't
know", and what to write down.

## Learn more

- [ARCHITECTURE.md](ARCHITECTURE.md) — how it fits together, for changing the code
- [REASONER.md](REASONER.md) — how an agent should use it
- [extension/README.md](extension/README.md) — the Chrome recorder
- [ROADMAP.md](ROADMAP.md) — what's next

The previous CockroachDB version is on the
[`legacy-cockroach`](../../tree/legacy-cockroach) branch.

## License

MIT
