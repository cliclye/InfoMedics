/* Infomedics toolbar popup: type or paste a claim, or reopen one from history. */
(function () {
  'use strict';

  var D = window.INFOMEDICS;
  var R = window.InfomedicsRender;
  var $ = function (s) { return document.querySelector(s); };

  var views = { check: $('#view-check'), result: $('#view-result'), history: $('#view-history') };
  var form = $('#form');
  var claim = $('#claim');
  var err = $('#err');
  var go = $('#go');
  var loading = $('#loading');
  var resultEl = $('#result');
  var histEl = $('#hist');
  var histEmpty = $('#hist-empty');
  var clearBtn = $('#clear');
  var token = 0;

  function show(name) {
    token++;
    setBusy(false);
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
    document.querySelectorAll('.tab').forEach(function (t) {
      if (t.dataset.view === (name === 'result' ? 'check' : name)) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    if (name === 'history') renderHistory();
  }

  function setBusy(on) {
    loading.hidden = !on;
    go.disabled = on;
    claim.readOnly = on;
  }

  function showError(msg) {
    err.textContent = msg;
    err.hidden = false;
    claim.setAttribute('aria-invalid', 'true');
  }

  function clearError() {
    err.hidden = true;
    claim.removeAttribute('aria-invalid');
  }

  function showResult(entry) {
    resultEl.innerHTML = R.renderCard(entry, { maxQuote: 140 });
    show('result');
    resultEl.focus({ preventScroll: true });
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (go.disabled) return;
    var text = claim.value.trim();
    if (!text) {
      showError('Please paste or type a health claim first, or pick an example below.');
      claim.focus();
      return;
    }
    clearError();
    var my = ++token;
    setBusy(true);

    var resp = null;
    try { resp = await chrome.runtime.sendMessage({ type: 'analyze', text: text }); } catch (e2) { /* worker unavailable */ }
    if (my !== token) return;
    if (!resp || !resp.ok) {
      setBusy(false);
      showError('Something went wrong while checking. Please try again.');
      return;
    }
    showResult(resp.entry);
  });

  claim.addEventListener('input', function () { if (!err.hidden) clearError(); });
  claim.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });

  $('#again').addEventListener('click', function () {
    claim.value = '';
    clearError();
    show('check');
    claim.focus();
  });

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { show(t.dataset.view); });
  });

  // ---- examples ----
  D.EXAMPLES.forEach(function (text) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = text;
    b.addEventListener('click', function () { claim.value = text; clearError(); claim.focus(); });
    li.appendChild(b);
    $('#examples').appendChild(li);
  });

  // ---- history (shared with the in-page panel via chrome.storage.local) ----
  async function loadHistory() {
    try {
      var s = await chrome.storage.local.get('history');
      return Array.isArray(s.history) ? s.history : [];
    } catch (e) { return []; }
  }

  async function renderHistory() {
    var list = await loadHistory();
    histEl.innerHTML = '';
    histEmpty.hidden = list.length > 0;
    clearBtn.hidden = list.length === 0;
    list.forEach(function (entry) {
      var when = new Date(entry.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      var li = document.createElement('li');
      li.innerHTML = '<button type="button" class="hist-item" data-id="' + R.esc(entry.id) + '">' +
        R.badge(entry.result.verdict) +
        '<span class="hist-snippet">' + R.esc(R.truncate(entry.text, 100)) + '</span>' +
        '<span class="hist-time">' + R.esc(when) + '</span></button>';
      histEl.appendChild(li);
    });
  }

  histEl.addEventListener('click', async function (e) {
    var item = e.target.closest('.hist-item');
    if (!item) return;
    var entry = (await loadHistory()).filter(function (x) { return x.id === item.dataset.id; })[0];
    if (entry) showResult(entry);
  });

  clearBtn.addEventListener('click', async function () {
    await chrome.storage.local.set({ history: [] });
    renderHistory();
  });

  // ---- prefill with the current page's selection (activeTab is granted by opening the popup) ----
  (async function prefill() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0] || tabs[0].id === undefined) return;
      var out = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: function () { return String(window.getSelection()); }
      });
      var sel = out && out[0] && out[0].result ? out[0].result.trim() : '';
      if (sel && !claim.value) claim.value = sel.slice(0, 2000);
    } catch (e) { /* restricted page: just leave the box empty */ }
  })();

  show('check');
})();
