/* Infomedics toolbar popup: check text, reopen history, and set the server address. */
(function () {
  'use strict';

  var R = window.InfomedicsRender;
  var C = window.InfomedicsClient;
  var $ = function (s) { return document.querySelector(s); };

  var EXAMPLES = [
    'Vitamin C cures the common cold',
    'You should never take antibiotics with food',
    'https://www.nhs.uk/conditions/common-cold/'
  ];

  var views = { check: $('#view-check'), progress: $('#view-progress'), result: $('#view-result'), history: $('#view-history'), settings: $('#view-settings') };
  var form = $('#form');
  var claim = $('#claim');
  var err = $('#err');
  var go = $('#go');
  var resultEl = $('#result');
  var histEl = $('#hist');
  var histEmpty = $('#hist-empty');
  var clearBtn = $('#clear');
  var statusEl = $('#status');
  var running = null;

  function show(name) {
    if (running && name !== 'progress') { running.cancel(); running = null; go.disabled = false; }
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
    var tab = { result: 'check', progress: 'check' }[name] || name;
    document.querySelectorAll('.tab').forEach(function (t) {
      if (t.dataset.view === tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    if (name === 'history') renderHistory();
    if (name === 'settings') loadSettings();
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

  // ---- server status ----
  async function refreshStatus() {
    var server = await C.getServerUrl();
    statusEl.className = 'status';
    $('#status-text').textContent = 'Connecting to ' + server + '…';
    try {
      var res = await fetch(server + '/api/status');
      var s = await res.json();
      statusEl.className = 'status ok';
      $('#status-text').textContent = s.ai ? 'Connected · AI verdicts on (' + s.model + ')' : 'Connected · evidence-only mode (claims are not rated)';
    } catch (e) {
      statusEl.className = 'status bad';
      $('#status-text').textContent = 'Server not reachable at ' + server + '. Start it with “npm start”.';
    }
  }

  // ---- progress ----
  function renderSteps(steps) {
    $('#steps').innerHTML = steps.map(function (s) {
      return '<li class="is-pending" data-step="' + R.esc(s.id) + '"><span class="dot" aria-hidden="true"></span><span>' + R.esc(s.label) + '<small></small></span></li>';
    }).join('');
  }
  function updateStep(ev) {
    var li = document.querySelector('#steps [data-step="' + ev.id + '"]');
    if (!li) return;
    li.className = ev.status === 'done' ? 'is-done' : 'is-active';
    li.querySelector('.dot').textContent = ev.status === 'done' ? '✓' : '';
    if (ev.detail) li.querySelector('small').textContent = ev.detail;
  }

  R.bindCitations(resultEl);

  function showResult(result, serverUrl) {
    resultEl.innerHTML = R.renderResult(result, { serverUrl: serverUrl });
    show('result');
    resultEl.focus({ preventScroll: true });
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (running) return;
    var text = claim.value.trim();
    if (!text) {
      showError('Please paste a health claim, an AI answer, or a link first.');
      claim.focus();
      return;
    }
    clearError();
    go.disabled = true;
    $('#steps').innerHTML = '';
    show('progress');
    $('#progress-title').focus();

    var check = C.checkViaBackground(text, function (ev) {
      if (ev.type === 'plan') renderSteps(ev.steps); else if (ev.type === 'step') updateStep(ev);
    });
    running = check;
    try {
      var outcome = await check.promise;
      if (running !== check) return;
      running = null;
      go.disabled = false;
      showResult(outcome.result, outcome.serverUrl);
    } catch (e2) {
      if (running !== check) return; // cancelled
      running = null;
      go.disabled = false;
      show('check');
      showError(e2.message);
    }
  });

  claim.addEventListener('input', function () { if (!err.hidden) clearError(); });
  claim.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });

  $('#cancel').addEventListener('click', function () { show('check'); claim.focus(); });
  $('#again').addEventListener('click', function () { claim.value = ''; clearError(); show('check'); claim.focus(); });
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { show(t.dataset.view); });
  });

  EXAMPLES.forEach(function (text) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = text;
    b.addEventListener('click', function () { claim.value = text; clearError(); claim.focus(); });
    li.appendChild(b);
    $('#examples').appendChild(li);
  });

  // ---- history (chrome.storage.local, written by the background worker) ----
  async function loadHistory() {
    try {
      var s = await chrome.storage.local.get('history');
      return (Array.isArray(s.history) ? s.history : []).filter(function (r) { return r && Array.isArray(r.claims); });
    } catch (e) { return []; }
  }

  async function renderHistory() {
    var list = await loadHistory();
    histEl.innerHTML = '';
    histEmpty.hidden = list.length > 0;
    clearBtn.hidden = list.length === 0;
    list.forEach(function (r) {
      var snippet = r.kind === 'page' ? ((r.page && r.page.title) || r.input.url) : (r.claims[0] ? r.claims[0].claim : '');
      var when = new Date(r.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      var li = document.createElement('li');
      li.innerHTML = '<button type="button" class="hist-item" data-id="' + R.esc(r.id) + '">' + R.badge(r.overall, r.mode === 'ai') +
        '<span class="hist-snippet">' + R.esc(R.truncate(snippet, 100)) + '</span><span class="hist-time">' + R.esc(when) + '</span></button>';
      histEl.appendChild(li);
    });
  }

  histEl.addEventListener('click', async function (e) {
    var item = e.target.closest('.hist-item');
    if (!item) return;
    var entry = (await loadHistory()).filter(function (r) { return r.id === item.dataset.id; })[0];
    if (entry) showResult(entry, await C.getServerUrl());
  });

  clearBtn.addEventListener('click', async function () {
    await chrome.storage.local.set({ history: [] });
    renderHistory();
  });

  // ---- settings ----
  var serverInput = $('#server');
  var serverMsg = $('#server-msg');

  function setMsg(text, bad) {
    serverMsg.textContent = text;
    serverMsg.className = 'msg' + (bad ? ' bad' : '');
    serverMsg.hidden = !text;
  }

  async function loadSettings() {
    serverInput.value = await C.getServerUrl();
    setMsg('');
  }

  $('#settings-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var origin = C.normalizeServerUrl(serverInput.value);
    if (!origin) { setMsg('Enter a full address such as http://localhost:3000.', true); serverInput.focus(); return; }
    try {
      // Needs a user gesture; localhost:3000 is already granted, anything else asks once.
      var granted = await chrome.permissions.request({ origins: [origin + '/*'] });
      if (!granted) { setMsg('Permission to reach that server was not granted.', true); return; }
    } catch (e2) { setMsg('Could not request permission for that address.', true); return; }
    await chrome.storage.local.set({ serverUrl: origin });
    serverInput.value = origin;
    setMsg('Saved. Using ' + origin + '.');
    refreshStatus();
  });

  $('#reset-server').addEventListener('click', async function () {
    await chrome.storage.local.remove('serverUrl');
    serverInput.value = C.DEFAULT_SERVER;
    setMsg('Using the default address.');
    refreshStatus();
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
      if (sel && !claim.value) claim.value = sel.slice(0, 8000);
    } catch (e) { /* restricted page: just leave the box empty */ }
  })();

  show('check');
  refreshStatus();
})();
