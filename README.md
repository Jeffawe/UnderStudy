# Understudy

![Understudy — record a flow once, replay it as a test](https://understudy.jeffawe.dev/og.png)

[![npm](https://img.shields.io/npm/v/@jeffawe/understudy)](https://www.npmjs.com/package/@jeffawe/understudy)

End-to-end tests for your own web apps, without clicking through every flow by
hand. Record a flow once; Understudy remembers it, replays it as a test, notices
when the app changes, and can run goals you describe in words — including goals
that need pieces of several recordings.

It's an npm package, [`@jeffawe/understudy`](https://www.npmjs.com/package/@jeffawe/understudy):

```sh
npm install -g @jeffawe/understudy
```

It works on its own from the command line, and it plugs into an AI agent
(Claude Code, Codex, Cursor) over MCP. The agent is optional; with one,
Understudy never calls a model itself — the agent is the model.

## What it does

```
record  →  save  →  replay / run  →  findings
```

- **record** — click through a flow in your own browser, with the
  [Understudy recorder](https://chromewebstore.google.com/detail/understudy-recorder/mdobdjogkgimabdpmbmhhcdeoahoapjf) extension from the Chrome Web Store. Passwords
  are never stored: a password field is kept as
  a reference like `SECRET.password`, and you supply the value when replaying.
- **save** — the recording is replayed headless first. It is kept only if every
  step passes, so memory only holds flows known to work. A flow that buys or
  submits something is replayed only up to that step: the button is checked,
  never pressed. Don't want a replay at all? `--no-verify` keeps it as
  unproven until a run passes.
- **replay / run** — `replay` runs a flow by name; `run` finds the flow that
  does a goal you describe ("go to my basket") and runs it. Matching is by
  meaning if you configure an embedding model, by name if you don't.
- **findings** — every run checks for console errors, failed requests, error
  responses, values that didn't stick, and whether the flow took a different
  path through the app than last time. Each problem is reported once, with a
  count, not once per run. A run that passes on a changed path is flagged until
  you say the change is meant to be there — then that path is the normal one.

With an agent attached it also splits recordings into reusable segments (a
login cut out of a checkout, say), plans a goal across segments of different
recordings, and writes down what it learns as facts and lessons that apply to
every future run.

## More than clicks

A flow is a list of steps. Besides clicking and typing, a step can:

- **wait for a person** — something only you can do, like accepting a visit in
  another system or typing a code from your phone. The run pauses, asks, and
  carries on when you say it's done (or when the page shows it).
- **wait for the server** — a response, its status, and one field of its JSON:
  "`POST /api/visits` returned 201 and `commission.amount` is above 0".
- **check how it ended** — after a save, Understudy offers what the last page
  showed (headings, ticked boxes, status messages) as checks. You choose which
  mean "it ended right".
- **need an app state** — "member has an active bundle". A plan runs the flow
  that makes it true first, or takes your word that it already is.

These come from a Playwright script (`page.waitForResponse`,
`human('what to do', { untilText: '…' })`), or can be added to a flow you've
already saved with `understudy edit`.

## Set up (about five minutes)

You need **Node 22+** and a **MongoDB** with vector search — a free
[Atlas](https://www.mongodb.com/atlas) cluster (nothing to install), or MongoDB
Community Edition with `mongot` running locally.

```bash
npm install -g @jeffawe/understudy               
npx playwright install --only-shell chromium     

understudy config set MONGODB_URI="mongodb+srv://…" EMBED_KEY="…"
```

That writes `~/.understudy/understudy.env`, readable only by you. `EMBED_KEY` is
a [Voyage](https://www.voyageai.com) API key (200M free tokens); it's optional —
without one, goals match flow names instead of meaning.

Already keep your settings in an env file? Point at it instead:

```bash
understudy config --env-file ~/secrets/understudy.env
```

To record, install the [Understudy recorder](https://chromewebstore.google.com/detail/understudy-recorder/mdobdjogkgimabdpmbmhhcdeoahoapjf) from the Chrome Web Store.
Not using Chrome or another Chromium browser? See
[extension/README.md](extension/README.md).

**On Safari, or prefer a fresh browser over your own?** Record in a browser
Understudy opens instead. It needs one extra download, the full Chromium
browser (about 350 MB, once):

```bash
npx playwright install chromium
understudy record myapp --new-browser --url https://your-app.example
```

Click through the flow in the window that opens, then close it to stop.

| Setting | What it's for |
|---|---|
| `MONGODB_URI` | your Atlas `mongodb+srv://…` string, or local Community |
| `EMBED_KEY` | optional: a Voyage key, to match goals by meaning (`voyage-4-lite`). Using another model? See below. |
| `UNDERSTUDY_<REF>` | login values. A recording never stores a password: the field is kept as a name like `SECRET.password`, and at replay Understudy reads the value from `UNDERSTUDY_SECRET_PASSWORD`. Or pass it per run (`--value SECRET.password=…`, or `values` from an agent). Not set? The terminal asks for it (hidden) and offers to save it; an agent is told which line to add to your env file.  |

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

Two things to know. One database holds one model's vectors, so switching later
means `understudy reembed`. And the line between "a flow I know" and "close,
but not it" was set for Voyage. Other models score on their own scale: with
the cutoffs set for Voyage, mxbai-embed-large called 12 of 14 goals an app didn't have
"known", so the wrong flow would have run. Fit the line to your app and model:

```bash
understudy calibrate myapp --template > goals.json   # every flow, to reword
# fill in 2–3 ways someone would ask for each flow, and 5+ goals that sound
# like the app but that it has no flow for
understudy calibrate myapp --goals goals.json
```

The goals are kept, so after any later `understudy reembed` the line is re-fit
for the new model on its own. `recall` says when it's using cutoffs that
weren't fitted for the model you have.

## Use it

```bash
understudy record myapp                     # record in your own browser, with the extension
understudy save <hash> "log in as a member" # prove it by replaying, then keep it
                                            #   --no-verify keeps it without a replay (unproven)
                                            #   --force keeps it even if the replay fails
understudy flows myapp                      # what it knows how to do
understudy replay myapp log-in-as-a-member  # run one flow
understudy run myapp "sign in"              # find the flow for a goal, and run it
understudy import myapp login.spec.ts       # turn a Playwright script into a recording, then save it
understudy prove myapp book-a-visit         # prove a saved flow without buying anything
understudy edit myapp book-a-visit --before 3 --step '{"action":"human","value":"Accept the visit"}'
                                            # add a person's step, a wait or a check to a saved flow
understudy findings myapp                   # what looked broken, most severe first
understudy findings myapp --triage <id>=expected
                                            # a changed path is meant to be there: make it the normal one
understudy emit myapp log-in-as-a-member    # print it as a Playwright (or Cypress) test
understudy app myapp --placeholder email    # keep email addresses out of memory (moves them to your env file)
```

An unproven flow is marked as such in `flows` and recall; the first run of
it that passes proves it. A flow that commits something real — a purchase, a
deletion — is marked destructive: saving and `prove` stop just before that
step, and a full run needs `--allow-purchases`. `understudy --help` lists
everything, and `understudy --version` says which one you have.

## Where your data goes

Everything stays with you. Understudy has no server, no account and no
telemetry.

- **Recordings** are files on your machine, in `~/.understudy` (or
  `UNDERSTUDY_HOME`) — the same place whichever folder you, or your agent, run
  it from. The Chrome extension sends what it records only to Understudy on
  `127.0.0.1`. Before 0.2.2 they went in a `.understudy` folder wherever it ran;
  those still load.
- **Saved flows, notes and findings** go to the MongoDB you configured.
- **Your embedding model** (Voyage by default, if you set a key) receives only
  the short texts used for search — flow names and descriptions, facts and
  lessons, the goals you ask for — never steps, typed values or cookies.
- **Passwords** are never stored; signed-in sessions and your env file are
  local files only you can read.
- **Your agent**, if you use one, sees what Understudy's tools return to it.

The recorder extension's privacy policy: [understudy.jeffawe.dev/privacy.html](https://understudy.jeffawe.dev/privacy.html).

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

Ten tools: `recall`, `run`, `answer`, `record`, `save`, `distill`,
`save_distilled`, `remember`, `findings`, `app`. Each tool says how to use it,
and a run's questions say how to answer them, so the server's own instructions
are one line — an agent pays only for the tools it uses.
[REASONER.md](REASONER.md) is the long version — how to split a goal, when to
answer a question and when to say "I don't know", and what to write down.

Mid-run, the agent may ask you to do a step only a person can do, or whether a
changed path in your app is meant to be there. Answer it in the chat; it
records your answer.

## Learn more

- [understudy.jeffawe.dev](https://understudy.jeffawe.dev) — the one-page overview
- [REASONER.md](REASONER.md) — how an agent should use it
- [extension/README.md](extension/README.md) — the Chrome recorder

## License

Apache-2.0 — see [LICENSE](LICENSE).
