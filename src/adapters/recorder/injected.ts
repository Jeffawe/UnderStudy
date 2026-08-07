/**
 * The in-page listener, as a STRING.
 *
 * It must not be authored as a TypeScript closure passed to addInitScript.
 * tsx/esbuild rewrites function declarations to preserve their names via a
 * `__name()` helper, and `addInitScript` serializes the function with
 * `.toString()` — so the injected body references a helper that does not exist
 * in the browser and dies with `ReferenceError: __name is not defined`.
 *
 * It fails SILENTLY: zero events captured, nothing logged, unless you happen to
 * have attached a `pageerror` listener. Shipping it as a string sidesteps the
 * compiler entirely.
 *
 * The script is deliberately dumb. It records WHAT happened and stamps WHICH
 * element; it does not decide what any of it means. Role and accessible name
 * are resolved on the Node side by Playwright's own engine — reimplementing
 * the accessible-name algorithm here would be wrong in exactly the cases that
 * matter (icon buttons, labelled inputs, aria-labelledby chains).
 */

export const STAMP_ATTR = 'data-understudy-seq';

export const INJECTED_LISTENER = `
(() => {
  if (window.__understudyInstalled) return;
  window.__understudyInstalled = true;

  var seq = 0;
  var STAMP = '${STAMP_ATTR}';

  // Best-effort name, used ONLY as a fallback when Playwright cannot resolve
  // the element (a click that navigates can destroy it before we get there).
  // Deliberately approximate — the authoritative answer comes from Node.
  // The authoritative path: a spec-compliant accname implementation, running
  // IN THE PAGE and SYNCHRONOUSLY at event time. This is the whole reason the
  // bundle is injected — clicking often destroys the element clicked, so
  // resolving later from Node loses the race. codegen gets correct names by
  // doing exactly this with Playwright's own bundle.
  function a11y() {
    return window.__understudyA11y;
  }

  // PLAYWRIGHT IS THE GROUND TRUTH, NOT THE SPEC.
  //
  // These names are fed back to getByRole(role, {name}) at replay, so they must
  // match what Playwright computes, not merely what the accname spec says.
  // Measured on saucedemo, dom-accessibility-api and Playwright disagree in
  // exactly two places — neither is wrong, they just draw the line differently:
  //
  //   input[type=password]  ARIA gives it NO implicit role, so getRole returns
  //                         null. Playwright pragmatically calls it a textbox.
  //   placeholder-only name computeAccessibleName returns "". Playwright falls
  //                         back to the placeholder, which is why it reports
  //                         textbox "Username" where the library reports "".
  //
  // Without this shim every placeholder-labelled field in every recording would
  // carry an empty name and be unaddressable on replay.
  function accName(el) {
    var lib = a11y();
    if (!lib) return null;
    try {
      var n = lib.computeAccessibleName(el);
      if (typeof n === 'string' && n.trim()) return n.trim();
    } catch (e) { /* fall through */ }

    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      var ph = el.getAttribute && el.getAttribute('placeholder');
      if (ph && ph.trim()) return ph.trim();
    }
    return null;
  }

  function accRole(el) {
    var lib = a11y();
    if (!lib) return null;
    try {
      var r = lib.getRole(el);
      if (r) return r;
    } catch (e) { /* fall through */ }

    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'password') return 'textbox';
    }
    return null;
  }

  // Fallback only, for when the bundle failed to load. Kept because a weaker
  // name still beats dropping the step.
  function hintName(el) {
    if (!el || !el.getAttribute) return '';
    var tag = (el.tagName || '').toLowerCase();

    // Follow the accessible-name priority order. This is an approximation of
    // the W3C algorithm, not an implementation of it — but the shortcuts that
    // seem harmless are exactly the ones that bite:
    //   . the 'name' ATTRIBUTE is not an accessible name. Using it recorded
    //     saucedemo's Login button as "login-button".
    //   . textContent of a <select> is every option concatenated, which
    //     produced "Name (A to Z)Name (Z to A)Price (low to high)…".
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var parts = [];
      labelledBy.split(/\\s+/).forEach(function (id) {
        var ref = document.getElementById(id);
        if (ref) parts.push((ref.textContent || '').trim());
      });
      var joined = parts.join(' ').trim();
      if (joined) return joined;
    }

    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    if (el.labels && el.labels[0]) {
      var lbl = (el.labels[0].textContent || '').trim();
      if (lbl) return lbl;
    }

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      var ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return ph.trim();
      var ttl = el.getAttribute('title');
      if (ttl && ttl.trim()) return ttl.trim();
      // A <select>'s text is its options; a value is not a name.
      if (tag === 'select') return '';
      if ((el.getAttribute('type') || '') === 'submit') return el.value || '';
      return '';
    }

    if (tag === 'img') return (el.getAttribute('alt') || '').trim();

    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, 80);

    // An icon-only control: its name usually comes from a nested image.
    var img = el.querySelector && el.querySelector('img[alt]');
    if (img) return (img.getAttribute('alt') || '').trim();

    return (el.getAttribute('title') || '').trim();
  }

  function hintRole(el) {
    var explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button') return 'button';
      return 'textbox';
    }
    return tag || 'generic';
  }

  // A short CSS path, used when role+name can't address the element.
  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var testId = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test'));
    if (testId) return '[data-testid="' + testId + '"]';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      var part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) part += '.' + [].slice.call(node.classList).join('.');
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function frameHint() {
    try {
      if (window.top === window) return undefined;
      return (window.frameElement && (window.frameElement.id || window.frameElement.name)) || 'iframe';
    } catch (e) {
      return 'cross-origin-iframe';
    }
  }

  // One element, ONE stamp. Reusing it lets a mousedown pre-resolution and the
  // click that follows refer to the same element, which is what makes the
  // pre-resolve cache hit.
  function stampOf(el) {
    var existing = el.getAttribute && el.getAttribute(STAMP);
    if (existing !== null && existing !== undefined && existing !== '') return Number(existing);
    var n = seq++;
    try { el.setAttribute(STAMP, String(n)); } catch (e) { /* readonly node */ }
    return n;
  }

  function emit(action, el, extra) {
    if (!el || el.nodeType !== 1) return;
    var n = stampOf(el);

    var payload = {
      seq: n,
      action: action,
      stamp: n,
      url: location.href,
      hintRole: accRole(el) || hintRole(el),
      hintName: accName(el) || hintName(el),
      // Records WHICH path produced the two fields above, so nothing
      // downstream has to guess how much to trust them.
      resolvedBy: a11y() ? 'accname' : 'heuristic',
      css: cssPath(el),
      testId: (el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test'))) || undefined,
      testIdAttr: (el.getAttribute && el.getAttribute('data-testid')) ? 'data-testid'
                : (el.getAttribute && el.getAttribute('data-test')) ? 'data-test' : undefined,
      inputType: (el.getAttribute && el.getAttribute('type')) || undefined,
      frameHint: frameHint(),
    };
    if (extra) for (var k in extra) payload[k] = extra[k];

    try { window.__understudyEmit(payload); } catch (e) { /* binding gone */ }
  }

  // TEXT INPUT IS DEFERRED, NOT IMMEDIATE.
  //
  // 'change' on a text field fires on BLUR, not on typing. Filling a login form
  // therefore emits the username only when the password field takes focus, and
  // emits the password NEVER — nothing blurs the last field before submit. The
  // final field of every form would vanish from every recording, silently.
  //
  // So: track the latest value per element on 'input' (which does fire per
  // keystroke), and flush it as one 'fill' when the field is done — on blur, or
  // when any other action happens, or when recording ends. Flushing before the
  // triggering action also keeps the order right: fill, then the click that
  // submits it.
  var pending = [];

  function flushOne(el) {
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].el !== el) continue;
      var entry = pending.splice(i, 1)[0];
      emit('fill', entry.el, { value: entry.value });
      return;
    }
  }

  function flushAll() {
    while (pending.length) {
      var entry = pending.shift();
      emit('fill', entry.el, { value: entry.value });
    }
  }

  // Called from Node before the recording is closed, so a field still focused
  // when the browser shuts is not lost.
  window.__understudyFlush = flushAll;

  // Diagnostic hook: resolve any element exactly as the recorder would. Used to
  // verify our role/name agree with Playwright's engine across a whole page,
  // which is the only check that catches a systematic naming drift.
  window.__understudyResolve = function (el) {
    return { role: accRole(el) || hintRole(el), name: accName(el) || hintName(el) };
  };

  document.addEventListener('input', function (e) {
    var el = (e.composedPath && e.composedPath()[0]) || e.target;
    var tag = (el.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return;
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return;

    for (var i = 0; i < pending.length; i++) {
      if (pending[i].el === el) {
        pending[i].value = el.value;
        return;
      }
    }
    pending.push({ el: el, value: el.value });
  }, true);

  document.addEventListener('blur', function (e) {
    var el = (e.composedPath && e.composedPath()[0]) || e.target;
    flushOne(el);
  }, true);

  // Capture phase, so we see the event before the app can stopPropagation it,
  // and before an anchor's default navigation tears the element down.
  document.addEventListener('click', function (e) {
    flushAll();
    var el = (e.composedPath && e.composedPath()[0]) || e.target;
    var tag = (el.tagName || '').toLowerCase();
    var type = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();

    // Checkboxes, radios, selects and text inputs report through 'change',
    // which carries the resulting VALUE. Emitting both would double-count.
    if (tag === 'select' || tag === 'textarea') return;
    if (tag === 'input' && type !== 'submit' && type !== 'button') return;

    emit('click', el);
  }, true);

  document.addEventListener('change', function (e) {
    var el = (e.composedPath && e.composedPath()[0]) || e.target;
    var tag = (el.tagName || '').toLowerCase();
    var type = (el.getAttribute && (el.getAttribute('type') || 'text')).toLowerCase();

    if (tag === 'select') {
      var opt = el.options && el.options[el.selectedIndex];
      emit('select', el, { value: el.value, label: opt ? opt.textContent : undefined });
      return;
    }
    if (type === 'checkbox' || type === 'radio') {
      emit(el.checked ? 'check' : 'uncheck', el);
      return;
    }
    // Text inputs are handled by the input+flush path above. Emitting here too
    // would double-count every field that happens to blur.
  }, true);

  // Enter often submits without any click at all — a step that would otherwise
  // vanish from the recording and make it unreplayable.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var el = (e.composedPath && e.composedPath()[0]) || e.target;
    var tag = (el.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return;
    flushAll();
    emit('press', el, { value: 'Enter' });
  }, true);
})();
`;
