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

- **record** — click through a flow in your own Chrome, with the extension. Passwords are never stored: a password field is kept as
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

You need **Node 22+** and a **MongoDB** with vector search — a free
[Atlas](https://www.mongodb.com/atlas) cluster (nothing to install), or MongoDB
Community Edition with `mongot` running locally.

```bash
npm install -g @jeffawe/understudy               # ~80 MB  (not published yet — see below)
npx playwright install --only-shell chromium     # the headless browser replay uses, ~200 MB
understudy config set MONGODB_URI="mongodb+srv://…"
understudy doctor                                # connection, vector search, embedder, browser
understudy extension                             # where the Chrome recorder is, and how to load it
```

**Settings** come from, highest first: real environment variables, then
`--env-file <path>` on any command, then the env file saved with
`understudy config`, then a `.env` in the current folder. Keep them wherever
you like:

```bash
understudy config set MONGODB_URI="…" EMBED_KEY="…"   # writes ~/.understudy/understudy.env (only you can read it)
understudy config --env-file ~/secrets/understudy.env  # or point at an env file you already keep
understudy config                                      # where everything comes from (no secrets shown)
```

| Setting | What it's for |
|---|---|
| `MONGODB_URI` | your Atlas `mongodb+srv://…` string, or local Community |
| `EMBED_URL`, `EMBED_MODEL`, `EMBED_KEY` | optional: match goals by meaning. Any OpenAI-style endpoint; Voyage `voyage-4-lite` (200M free tokens) is the default, Ollama works offline. Without one, goals match flow names. |
| `UNDERSTUDY_<REF>` | login values. Passwords are never stored in a recording — a password field is kept as a reference like `SECRET.password`, read from `UNDERSTUDY_SECRET_PASSWORD`. |

> **Atlas free clusters** allow 3 search indexes; Understudy uses 2, so one free
> cluster holds one Understudy database.

**Until it's published:** clone the repo, `npm install`, and use
`npx tsx src/entry/cli.ts` wherever this says `understudy`.

## Use it

```bash
understudy record myapp                     # record in your own Chrome, with the extension
understudy save <hash> "log in as a member" # prove it by replaying, then keep it
understudy flows myapp                      # what it knows how to do
understudy replay myapp log-in-as-a-member  # run one flow
understudy run myapp "sign in"              # find the flow for a goal, and run it
understudy findings myapp                   # what looked broken
understudy emit myapp log-in-as-a-member    # print it as a Playwright (or Cypress) test
```

`understudy --help` lists everything. A flow that commits something real — a
purchase, a deletion — is marked destructive and refused unless you pass
`--allow-purchases`. Prefer a fresh browser over your own Chrome?
`understudy record myapp --new-browser --url https://…`, after
`npx playwright install chromium` (the full browser, ~350 MB).

## With an agent

Add the MCP server to your agent. It starts and stops with the agent's session;
settings come from the env file you point it at, so keys never go in the
agent's config or the chat:

```bash
claude mcp add understudy -- npx -y -p @jeffawe/understudy understudy-mcp --env-file ~/.understudy/understudy.env
```

```json
{ "mcpServers": { "understudy": {
    "command": "npx",
    "args": ["-y", "-p", "@jeffawe/understudy", "understudy-mcp", "--env-file", "~/.understudy/understudy.env"]
} } }
```

Nine tools: `recall`, `run`, `answer`, `record`, `save`, `distill`,
`save_distilled`, `remember`, `findings`. The server tells the agent how to use
them when it connects; [REASONER.md](REASONER.md) is the full version — how to
split a goal, when to answer a question and when to say "I don't know", and
what to write down.

## Learn more

- [ARCHITECTURE.md](ARCHITECTURE.md) — how it fits together, for changing the code
- [REASONER.md](REASONER.md) — how an agent should use it
- [extension/README.md](extension/README.md) — the Chrome recorder
- [ROADMAP.md](ROADMAP.md) — what's next

The previous CockroachDB version is on the
[`legacy-cockroach`](../../tree/legacy-cockroach) branch.

## License

Apache-2.0 — see [LICENSE](LICENSE).
