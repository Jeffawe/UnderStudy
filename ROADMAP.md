# Roadmap

What's next, roughly in order. Why things are the way they are today is in
ARCHITECTURE.md.

## Learn the "known" cutoff instead of hand-setting it

`recall` decides *known* / *unsure* / *unknown* with constants in
`src/memory/recall.ts` (`MEANING`), pinned by `test/recall.test.ts`:

> known if score ≥ 0.78, or ≥ 0.70 and ≥ 0.08 ahead of the next flow

They were set by hand from one calibration (2026-11-18, voyage-4-lite, the
28-flow providernow corpus): 15 differently-worded goals the app has, and 14
plausible ones it doesn't. No single score separates them — "download my medical
records" (not in the app) scored 0.735–0.740, above "sign in" (in the app) at
0.730. What separates them is the lead over the runner-up: right answers lead
by 0.09+, goals the app doesn't have scatter across similar flows (≤ 0.06).
29/29 correct, re-checked through MongoDB's vector search on the real corpus.
On a tiny 2-flow corpus the margin was much tighter (0.003), which is the
reason to learn it rather than trust one run.

**The idea:** fit the constants from data the app already has, per app and per
embedding model.
- Known goals: each flow's title and intent, plus the goals `run` was asked for
  that bound to that flow and passed.
- Unknown goals: `run` calls that ended *unknown* and were later recorded as a
  new flow.
- Re-fit when the corpus changes a lot, or the embedding model changes.

## Small things noticed during the rewrite

- **One unexpected page raises two findings** (the step's unexpected page, and
  the path drift). Fold them into one.
- **`import` names a value reference after the code it read**: a script that
  types `process.env.SHOP_PASSWORD!` gets a reference literally called
  `process.env.SHOP_PASSWORD!`. It works, but should become `ENV.SHOP_PASSWORD`.
- **A replay that lands on an unexpected page still passes** (on purpose: a
  cookie banner shouldn't fail a test), so that path joins the history and stops
  drifting next time. Triage is where it gets called a bug — worth making that
  more visible.
- **`src/core/replay.ts` is still ~1,100 lines** from the old version. It works;
  simplify it when something needs to change in it, not for its own sake.
- **The extension's toolbar button has never been clicked by a test** —
  Playwright can't. Tests drive its background worker. Try it by hand after
  changing the popup.

## Not started

- **The old corpus on Atlas.** It was copied into the local `understudy`
  database only, by a one-off script from `.understudy/export/`.
- **Parked from the old version:** recording after a known flow (`--after`),
  the automatic crawler (`explore`), screenshot diffs.
