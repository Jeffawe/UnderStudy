// Understudy recorder — popup. Shows whether `understudy record --extension`
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
  } else if (s.cli?.error) {
    show(s.cli.error, 'err');
  } else if (s.cli?.started) {
    show('That recording already ran. Run `understudy record <app> --extension` again.', 'err');
  } else {
    show(`Ready to record "${s.cli.app}".`);
    $('startPane').hidden = false;
    // Remembered per site: on your own app you tick it once.
    const tab = await activeTab();
    if (tab?.url && /^https?:/.test(tab.url)) {
      const key = `signedIn:${new URL(tab.url).origin}`;
      $('signedIn').checked = Boolean((await chrome.storage.local.get(key))[key]);
    }
  }
}

$('start').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab?.url || !/^https?:/.test(tab.url)) return show('This page can\'t be recorded (only http and https pages).', 'err');
  // Per-site access, asked for now — while you're clicking — rather than for every site at install.
  const origin = `${new URL(tab.url).origin}/*`;
  const allowed = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
  if (!allowed) return show('Understudy needs access to this site to record it.', 'err');
  $('start').disabled = true;
  await chrome.storage.local.set({ [`signedIn:${new URL(tab.url).origin}`]: $('signedIn').checked });
  const r = await send({ type: 'understudy:start', tabId: tab.id, signedIn: $('signedIn').checked });
  $('start').disabled = false;
  if (!r.ok) return show(r.error, 'err');
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
