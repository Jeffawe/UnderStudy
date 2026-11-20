// Understudy recorder — popup. Shows whether `understudy record <app>`
// is waiting, and starts or stops recording on the current tab.

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function show(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const { port = 7397 } = await chrome.storage.local.get('port');
  $('port').value = port;
  const s = await send({ type: 'understudy:status' });
  $('startPane').hidden = true;
  $('stopPane').hidden = true;
  if (s.rec) {
    show(`Recording "${s.rec.app}". Use the page as normal, then stop here.`, 'rec');
    $('stopPane').hidden = false;
  } else if (s.lastError) {
    show(`Couldn't start recording: ${s.lastError}`, 'err');
    if (!s.cli?.error && !s.cli?.started) $('startPane').hidden = false;
  } else if (s.cli?.error) {
    show(s.cli.error, 'err');
  } else if (s.cli?.started) {
    show('That recording already ran. Run `understudy record <app>` again.', 'err');
  } else {
    show(`Ready to record "${s.cli.app}".`);
    $('startPane').hidden = false;
  }
}

$('start').addEventListener('click', async () => {
  const tab = await activeTab();
  // Clicking the toolbar icon grants activeTab, which is what lets the popup
  // see this tab's address — Chrome hides it from extensions otherwise.
  if (!tab?.url) return show('Couldn\'t read this tab\'s address — close this popup and click the Understudy icon again.', 'err');
  if (!/^https?:/.test(tab.url)) return show('This page can\'t be recorded (only http and https pages).', 'err');
  const site = new URL(tab.url).origin;
  const signedIn = $('signedIn').checked;
  $('start').disabled = true;

  // Per-site access, asked for now — while you're clicking — rather than for every site at install.
  // If it has to be asked, Chrome closes this popup, so leave a note first: the
  // background worker starts recording the moment you allow it.
  if (!(await chrome.permissions.contains({ origins: [`${site}/*`] }))) {
    await chrome.storage.session.set({ pending: { tabId: tab.id, origin: site, signedIn, at: Date.now() } });
    const allowed = await chrome.permissions.request({ origins: [`${site}/*`] }).catch(() => false);
    if (!allowed) {
      await chrome.storage.session.remove('pending');
      $('start').disabled = false;
      return show('Understudy needs access to this site to record it.', 'err');
    }
    // The popup usually doesn't survive the dialog; if it did, the worker is already starting.
  }

  const r = await send({ type: 'understudy:start', tabId: tab.id, signedIn });
  $('start').disabled = false;
  if (!r.ok && !/Already recording/.test(r.error)) return show(r.error, 'err');
  window.close();
});

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  const r = await send({ type: 'understudy:stop' });
  $('stop').disabled = false;
  if (!r.ok) return show(r.error, 'err');
  show(`Saved ${r.events ?? 0} steps. The terminal shows the recording's hash.`);
  $('stopPane').hidden = true;
});

$('port').addEventListener('change', async () => {
  await chrome.storage.local.set({ port: Number($('port').value) || 7397 });
  refresh();
});

refresh();
