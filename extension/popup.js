// Understudy recorder — popup. Shows whether `understudy record <app>`
// is waiting, and starts or stops recording on the current tab.

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function show(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

// The tab this popup was opened on. Looked up as soon as the popup opens,
// because Firefox only lets an extension ask for a site's permission straight
// from the click — with no waiting on anything first.
let here;
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => { here = tab; });

async function refresh() {
  const { port = 7397 } = await chrome.storage.local.get('port');
  $('port').value = port;
  const s = await send({ type: 'understudy:status' });
  $('startPane').hidden = true;
  $('stopPane').hidden = true;
  if (s.rec) {
    show(s.cli?.error
      ? 'The terminal that was recording has stopped, so this recording can\'t be saved. Click Stop to clear it.'
      : `Recording "${s.rec.app}". Use the page as normal, then stop here.`, s.cli?.error ? 'err' : 'rec');
    $('stopPane').hidden = false;
    // Saving here only when it was asked for — and never when an agent started
    // the recording: then the agent saves it.
    const saving = s.rec.save && s.rec.savedBy !== 'agent' && !s.cli?.error;
    $('nameRow').hidden = !saving;
    $('stop').textContent = saving ? 'Stop and save as a flow' : 'Stop';
    $('stopHint').textContent = s.rec.savedBy === 'agent' ? 'Your agent will save it.' : saving ? '' : 'The recording is kept; save it as a flow from the terminal.';
    if (saving) $('flowName').focus();
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
    $('saveOnStopRow').hidden = s.cli.savedBy === 'agent';
  }
}

$('start').addEventListener('click', async () => {
  const tab = here;
  // Clicking the toolbar icon grants activeTab, which is what lets the popup
  // see this tab's address — browsers hide it from extensions otherwise.
  if (!tab?.url) return show('Couldn\'t read this tab\'s address — close this popup and click the Understudy icon again.', 'err');
  if (!/^https?:/.test(tab.url)) return show('This page can\'t be recorded (only http and https pages).', 'err');
  const site = new URL(tab.url).origin;
  const signedIn = $('signedIn').checked;
  const save = $('saveOnStop').checked;
  $('start').disabled = true;

  // Per-site access, asked for now — while you're clicking — rather than for
  // every site at install; already allowed, it answers yes without asking. If it
  // does ask, the browser may close this popup, so leave a note first: the
  // background worker starts recording the moment you allow it. Nothing is
  // awaited before the request — Firefox refuses one that isn't straight from the click.
  chrome.storage.session.set({ pending: { tabId: tab.id, origin: site, signedIn, save, at: Date.now() } });
  const allowed = await chrome.permissions.request({ origins: [`${site}/*`] }).catch(() => false);
  await chrome.storage.session.remove('pending');
  if (!allowed) {
    $('start').disabled = false;
    return show('Understudy needs access to this site to record it.', 'err');
  }

  const r = await send({ type: 'understudy:start', tabId: tab.id, signedIn, save });
  $('start').disabled = false;
  if (!r.ok && !/Already recording/.test(r.error)) return show(r.error, 'err');
  window.close();
});

$('stop').addEventListener('click', async () => {
  const saving = !$('nameRow').hidden;
  const name = $('flowName').value.trim();
  if (saving && !name) {
    $('flowName').focus();
    return show('Say what the flow does, so it can be found later.', 'err');
  }
  $('stop').disabled = true;
  const r = await send({ type: 'understudy:stop', ...(saving ? { name } : {}) });
  $('stop').disabled = false;
  if (!r.ok) return show(r.error, 'err');
  $('stopPane').hidden = true;
  if (r.saving) show(`Recorded ${r.events ?? 0} steps. Now checking it works — the terminal shows the result.`);
  else if (r.savedBy === 'agent') show(`Recorded ${r.events ?? 0} steps. Your agent will save it.`);
  else show(`Recorded ${r.events ?? 0} steps. To keep it as a flow, run in the terminal:\nunderstudy save ${r.hash} "<what it does>"`);
});

$('flowName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('stop').click();
});

$('port').addEventListener('change', async () => {
  await chrome.storage.local.set({ port: Number($('port').value) || 7397 });
  refresh();
});

refresh();
