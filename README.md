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
npm install -g @jeffawe/understudy               # 
npx playwright install --only-shell chromium     # the headless browser replay uses, ~200 MB

understudy config set MONGODB_URI="mongodb+srv://…" EMBED_KEY="…"
```

That writes `~/.understudy/understudy.env`, readable only by you. `EMBED_KEY` is
a [Voyage](https://www.voyageai.com) API key (200M free tokens); it's optional —
without one, goals match flow names instead of meaning.

Already keep your settings in an env file? Point at it instead:

```bash
understudy config --env-file ~/secrets/understudy.env
```

Optional, any time: `understudy doctor` checks the connection, search, model and
browser; `understudy config` shows where every setting came from (no secrets
shown); `understudy extension` says where the Chrome recorder is, for loading it
once.

Settings come from, highest first: real environment variables, `--env-file
<path>` on any command, the env file saved with `understudy config`, then a
`.env` in the current folder.

| Setting | What it's for |
|---|---|
| `MONGODB_URI` | your Atlas `mongodb+srv://…` string, or local Community |
| `EMBED_KEY` | optional: a Voyage key, to match goals by meaning (`voyage-4-lite`). Using another model? See below. |
| `UNDERSTUDY_<REF>` | login values. A recording never stores a password: the field is kept as a name like `SECRET.password`, and at replay Understudy reads the value from `UNDERSTUDY_SECRET_PASSWORD`. Or pass it per run (`--value SECRET.password=…`, or `values` from an agent). Exported tests read the same variable. |

### Using a different embedding model

Voyage is the default, so a key is all it needs. For any other model, also set
`EMBED_URL` and `EMBED_MODEL` — any endpoint that speaks the OpenAI
`/v1/embeddings` format works (OpenAI, Mistral, Together, Ollama…) — and
`EMBED_DIMS` if its vectors aren't 1024 numbers long. Free and offline, with
[Ollama](https://ollama.com):

```bash
ollama pull mxbai-embed-large
understudy config set EMBED_URL=http://localhost:11434/v1/embeddings EMBED_MODEL=mxbai-embed-large EMBED_DIMS=1024
```

Two things to know: one database holds one model's vectors, so switching later
means `understudy reembed`; and the line between "a flow I know" and "close,
but not it" was calibrated on Voyage — other models score differently, so check
a few goals with `understudy recall` first.

## Use it

```bash
understudy record myapp                     # record in your own Chrome, with the extension
understudy save <hash> "log in as a member" # prove it by replaying, then keep it
understudy flows myapp                      # what it knows how to do
understudy replay myapp log-in-as-a-member  # run one flow
understudy run myapp "sign in"              # find the flow for a goal, and run it
understudy findings myapp                   # what looked broken
understudy emit myapp log-in-as-a-member    # print it as a Playwright (or Cypress) test
understudy app myapp --placeholder email    # keep email addresses out of memory (moves them to your env file)
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

- [REASONER.md](REASONER.md) — how an agent should use it
- [extension/README.md](extension/README.md) — the Chrome recorder

## License

Apache-2.0 — see [LICENSE](LICENSE).
