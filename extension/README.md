# Understudy recorder (browser extension)

Record a flow in the browser you already use — on the tab you're already on,
signed in or not — instead of a fresh browser that Understudy opens.

## Install (once)

`understudy extension` prints where this folder is.

1. Open your browser's extensions page and turn on **Developer mode**:
   | Browser | Extensions page |
   |---|---|
   | Chrome | `chrome://extensions` |
   | Edge | `edge://extensions` |
   | Brave | `brave://extensions` |
   | Arc, Opera, Vivaldi | their extensions page (all accept Chrome extensions) |
2. Click **Load unpacked** and choose this `extension/` folder.
3. Pin it (puzzle-piece icon → pin **Understudy recorder**) so it's one click away.

Tested in Chrome and Chromium. Other Chromium-based browsers load Chrome
extensions the same way and should work.

**Firefox and Safari aren't supported yet** — they need their own build of the
extension. Record with a fresh browser instead:
`understudy record <app> --new-browser --url https://…`, after
`npx playwright install chromium`.

## Record

1. In a terminal: `understudy record <app>`. It waits for the extension.
2. In your browser, go to the page where the flow starts.
3. Click the Understudy icon → **Record from this page**. The first time on a
   site, the browser asks to let Understudy access it — that's the only site
   it gets.
   - **I'm signed in here:** tick it if the flow starts signed in, and replay
     will start signed in too. Not sure? Leave it: Understudy copies the tab's
     sign-in anyway, then when you `save` it tries the flow without it first,
     and deletes the copy if it wasn't needed. Either way it's a file on your
     machine (`.understudy/sessions/`, readable only by you), never sent
     anywhere else.
4. Use the page as normal. The icon shows **REC**.
5. Click the icon → **Stop and save** (or press Ctrl+C in the terminal).
6. The terminal prints a hash. Then: `understudy save <hash> "<what it does>"`
   — that replays it headless to prove it works, then keeps it.

## What it can't record

- **File uploads.** A page can see that a file was picked, never which one, so
  it can't be replayed. Write that part as a Playwright script and
  `understudy import` it.
- **Other sites mid-flow** (a payment provider's page, say) unless you've
  allowed them too. Steps there aren't recorded.
- **The browser's own pages** (`chrome://`, `edge://`…) **and its extension store.** Browsers don't allow it.

Passwords are never recorded: a password field is stored as a reference like
`SECRET.password`, and you supply the value when replaying.
