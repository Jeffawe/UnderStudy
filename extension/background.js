// Understudy recorder — background service worker.
//
// Holds the one recording in progress (which tab, which token), injects the
// recorder into that tab after every page load, and forwards each action to
// the `understudy record --extension` process on this machine, in order.
// The extension stores nothing about the page itself.

const DEFAULT_PORT = 7397;

async function cliUrl() {
  const { port = DEFAULT_PORT } = await chrome.storage.local.get('port');
  return `http://127.0.0.1:${port}`;
}

/** Is `understudy record <app> --extension` running, and for which app? */
async function hello() {
  let res;
  try {
    res = await fetch(`${await cliUrl()}/hello`);
  } catch {
    throw new Error('Understudy is not waiting. In a terminal, run: understudy record <app> --extension');
  }
  if (!res.ok) throw new Error(`Understudy answered ${res.status}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${await cliUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Understudy answered ${res.status}`);
  return data;
}

async function current() {
  return (await chrome.storage.session.get('rec')).rec;
}

async function inject(tabId, frameIds) {
  await chrome.scripting.executeScript({
    target: frameIds ? { tabId, frameIds } : { tabId, allFrames: true },
    files: ['recorder.js'],
  });
}

/** This tab's cookies and local storage, in the shape Playwright restores. */
async function captureSession(tab) {
  const sameSite = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax' };
  const cookies = (await chrome.cookies.getAll({ url: tab.url })).map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    expires: c.session ? -1 : c.expirationDate ?? -1,
    httpOnly: c.httpOnly, secure: c.secure, sameSite: sameSite[c.sameSite] ?? 'Lax',
  }));
  const [{ result: entries = [] } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => Object.entries(localStorage),
  });
  const origin = new URL(tab.url).origin;
  return { cookies, origins: [{ origin, localStorage: entries.map(([name, value]) => ({ name, value })) }] };
}

// The tab's sign-in is always sent. Ticked "I'm signed in here": the flow starts
// signed in, full stop. Unticked: Understudy works it out when you save (it
// proves the recording without the sign-in first) and deletes it if unneeded.
async function startRecording(tabId, { signedIn = false } = {}) {
  if (await current()) throw new Error('Already recording — stop that one first.');
  const { app, token, started } = await hello();
  if (started) throw new Error('That Understudy recording has already started. Run the command again for a new one.');
  const tab = await chrome.tabs.get(tabId);
  const storageState = await captureSession(tab);
  await post('/start', { token, url: tab.url, storageState, signedIn });
  await chrome.storage.session.set({ rec: { tabId, token, app, origin: new URL(tab.url).origin } });
  await inject(tabId);
  await chrome.action.setBadgeText({ tabId, text: 'REC' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#c62828' });
  return { app };
}

async function stopRecording() {
  const rec = await current();
  if (!rec) return { stopped: false };
  // A field still being typed in hasn't been sent yet; flush it.
  await chrome.scripting
    .executeScript({ target: { tabId: rec.tabId, allFrames: true }, func: () => window.__understudyFlush && window.__understudyFlush() })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await queue;
  await chrome.storage.session.remove('rec');
  await chrome.action.setBadgeText({ tabId: rec.tabId, text: '' }).catch(() => {});
  const { events } = await post('/stop', { token: rec.token });
  return { stopped: true, events };
}

// Events go out one at a time, in the order they happened.
let queue = Promise.resolve();
function forward(event) {
  queue = queue.then(async () => {
    const rec = await current();
    if (rec) await post('/event', { token: rec.token, event }).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'understudy:event') {
    current().then((rec) => {
      if (rec && sender.tab && sender.tab.id === rec.tabId) forward(msg.event);
    });
    return false;
  }
  const handlers = {
    'understudy:status': async () => ({ rec: (await current()) ?? null, cli: await hello().catch((e) => ({ error: e.message })) }),
    'understudy:start': () => startRecording(msg.tabId, { signedIn: Boolean(msg.signedIn) }),
    'understudy:stop': () => stopRecording(),
  };
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler().then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: e.message }));
  return true; // answering asynchronously
});

// A click that loads a new page loses the recorder; put it back. Pages on a
// site you haven't allowed (a payment provider, say) can't be recorded.
chrome.webNavigation.onDOMContentLoaded.addListener(async ({ tabId, frameId }) => {
  const rec = await current();
  if (rec && rec.tabId === tabId) await inject(tabId, [frameId]).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await current();
  if (rec && rec.tabId === tabId) await stopRecording().catch(() => {});
});

// For tests and the console: drive it without the popup.
self.understudy = { startRecording, stopRecording, current };
