# Using Understudy

Understudy runs end-to-end tests against the user's web apps from flows it
remembers. You supply the judgement; it never calls a model.

## Rules

- **Memory first.** `understudy_recall` is free and runs nothing. For a known
  flow it returns the steps and the login values they need, so you can drive it
  yourself if that's better.
- **Reach the goal however works** — `understudy_run`, or your own browser —
  and **say which you used**. Never imply Understudy ran something you drove.
- **Never ask the user to paste a password into chat.** Recordings store names
  like `SECRET.password`; Understudy reads the value from the user's settings
  (`UNDERSTUDY_SECRET_PASSWORD`), or you pass one you fetched yourself in
  `values`.
- **Destructive flows** (purchases, deletions) are refused unless
  `allowPurchases`. Start runs with `dryRun: true`.

## The two questions a run can ask

Runs plan before any browser opens.

- **decompose** → `{"subGoals": [...]}`: what must happen, **in the order the
  app does it**, phrased in the words of the app's flows (listed with the
  question). Include prerequisites the user left out, like logging in. One
  sub-goal naming a whole recorded flow beats several naming its parts. Tell
  the user the sub-goals.
- **seam** → `{"steps": [one click or goto]}` to get from one flow to the next,
  or `{"steps": []}` **unless you actually know** — an answer is saved and
  reused forever.

## Growing memory

- **The app doesn't have a flow?** Ask the user to record it
  (`understudy_record`, then `understudy_save` once they've stopped), or drive
  it yourself and save the Playwright script (`understudy_save` with `script`;
  read passwords from `process.env`). Saving replays it first and keeps it only
  if every step passes. Save what the user would want tested again; a one-off
  is enough as facts and lessons. Saving needs no permission.
- **Distilling** names a flow and splits it into reusable segments. **Ask the
  user before each one**; any flow may be distilled. Refer to steps by index
  only; preconditions are exactly `"authenticated"` or `"not authenticated"`;
  reuse existing segment slugs rather than inventing synonyms.
- **Learned something?** Keep a list and put it to the user at a natural pause,
  then write the approved items in one `understudy_remember`:
  a **fact** changes plans ("order history is at `/past-invoices`");
  a **lesson** changes one step, matched by an exact trigger
  (`url_pattern` / `action` / `role` / `name`, never empty);
  a **finding** says the app is broken.
  Reached a goal without `understudy_run`? Record it there as `reached`.
- **Findings**: `understudy_findings` lists what looked broken; triage each as
  `issue`, `lesson` or `noise`.
- **Emails out of memory**: `understudy_app` with `placeholders: ["email"]`
  makes email fields placeholders and moves the addresses to the user's env file.

## Traps

- **File uploads can't be recorded** — write a Playwright script instead.
- **Don't save anything irreversible** (a real order): saving replays it.
- **Logins are often rate-limited**; a missing login value stops a run before
  it opens a browser, so check `needs` from recall first.
- **"Matched no elements" isn't always a bad selector** — check the page
  rendered at all.
- **On Atlas, a just-saved flow takes a few seconds to be searchable.**
