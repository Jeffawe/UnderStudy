# Understudy recorder (browser extension)

Record a flow in the browser you already use — on the tab you're already on,
signed in or not — instead of a fresh browser that Understudy opens.

## Install (once)

**Chrome, Brave, Arc, Opera, Vivaldi, Edge:** install it from the
[Chrome Web Store](https://chromewebstore.google.com/detail/understudy-recorder/mdobdjogkgimabdpmbmhhcdeoahoapjf), then pin it (puzzle-piece icon → pin
**Understudy recorder**) so it's one click away. Edge asks you to allow
extensions from other stores first.

**Or load it by hand** (to try a change, or offline) — `understudy extension`
prints where this folder is:

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

**Firefox:** until it's listed on Firefox Add-ons, load the Firefox build
yourself — it ships with Understudy, and `understudy extension` prints where.
In Firefox open `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on…** → choose `manifest.json` in that folder. Firefox removes temporary
add-ons when it restarts.

**Safari (and anywhere else the extension won't run):** record in a fresh
browser that Understudy opens instead. It's a one-time extra download — the
full Chromium browser, about 350 MB:

```bash
npx playwright install chromium
understudy record <app> --new-browser --url https://your-app.example
```

A Chromium window opens on that address. Click through the flow, then close
the window to stop; the terminal prints the recording's hash for `understudy
save`. The address is remembered, so next time `--new-browser` alone is
enough. Signed-in flows: add `--arm-manually`, sign in first, then press Enter
in the terminal to start recording from there.

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
5. Click the icon → say what the flow does → **Stop**. With **Save as a flow
   when I stop** ticked (the default), the terminal replays it headless to
   prove it works, then keeps it.
6. Unticked, it's only recorded: the popup shows the command to save it later,
   `understudy save <hash> "<what it does>"`. (Ctrl+C in the terminal also
   stops.) If an agent started the recording, the agent saves it.

If the replay fails — say the page started in a state the replay can't repeat —
the terminal asks whether to keep it anyway. Kept, it's marked **unproven**
until a run of it passes.

## What it can't record

- **File uploads.** A page can see that a file was picked, never which one, so
  it can't be replayed. Write that part as a Playwright script and
  `understudy import` it.
- **Other sites mid-flow** (a payment provider's page, say) unless you've
  allowed them too. Steps there aren't recorded.
- **The browser's own pages** (`chrome://`, `edge://`…) **and its extension store.** Browsers don't allow it.

Passwords are never recorded: a password field is stored as a reference like
`SECRET.password`, and you supply the value when replaying.
