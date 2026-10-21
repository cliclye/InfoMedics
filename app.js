/*
 * Infomedics prototype logic.
 * Single page: sections are toggled with JS. All verdicts are mocked (see data.js).
 */
(function () {
  'use strict';

  var D = window.INFOMEDICS;
  var STORAGE_KEY = 'infomedics.history.v1';
  var MAX_HISTORY = 25;
  var FAKE_DELAY_MS = 1500;

  // ---------- DOM ----------
  var $ = function (sel) { return document.querySelector(sel); };
  var views = {
    home: $('#view-home'),
    result: $('#view-result'),
    history: $('#view-history'),
    learn: $('#view-learn')
  };
  var headings = {
    home: $('#home-heading'),
    history: $('#history-heading'),
    learn: $('#learn-heading')
  };
  var form = $('#checker-form');
  var input = $('#claim-input');
  var errorEl = $('#claim-error');
  var checkBtn = $('#check-btn');
  var loadingEl = $('#loading');
  var examplesEl = $('#examples');
  var resultRegion = $('#result-region');
  var historyList = $('#history-list');
  var historyEmpty = $('#history-empty');
  var clearBtn = $('#clear-history');

  var checkToken = 0; // bumped on navigation so a stale "analysis" never pops up

  // ---------- Helpers ----------
  function esc(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function normalize(text) {
    return String(text).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // True if `term` appears in `text` starting at a word boundary (so "cure" also catches "cures").
  function hasTerm(text, term) {
    return new RegExp('(^|[^a-z0-9])' + escapeRegex(term), 'i').test(text);
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ---------- Storage (wrapped: it can throw in private windows) ----------
  function loadHistory() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function saveHistory(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (e) { /* history just won't persist */ }
  }

  // ---------- Mock analysis ----------
  function matchCuratedClaim(text) {
    var best = null;
    var bestScore = 0;
    D.CLAIMS.forEach(function (claim) {
      claim.match.forEach(function (group) {
        var allPresent = group.every(function (term) { return text.indexOf(term) !== -1; });
        if (allPresent && group.length > bestScore) {
          best = claim;
          bestScore = group.length;
        }
      });
    });
    return best;
  }

  function heuristicCheck(text) {
    var H = D.HEURISTIC;
    var redFlags = [];

    var absolutes = H.absoluteWords.filter(function (w) { return hasTerm(text, w); });
    if (absolutes.length) {
      redFlags.push(H.flagText.absolute + absolutes.map(function (w) { return '“' + w + '”'; }).join(', ') + '.');
    }

    var urgent = H.urgencyWords.filter(function (w) { return hasTerm(text, w); });
    if (urgent.length) {
      redFlags.push(H.flagText.urgency + urgent.map(function (w) { return '“' + w + '”'; }).join(', ') + '.');
    }

    var cites = H.sourceHints.some(function (h) { return text.indexOf(h) !== -1; });
    if (!cites) redFlags.push(H.flagText.noSource);

    var needsDoctor = H.doctorWords.some(function (w) { return hasTerm(text, w); });
    var base = needsDoctor ? H.results.doctor : H.results.mixed;
    var explanation = base.explanation;
    if (absolutes.length && !needsDoctor) {
      explanation += ' Strong words like these are a reason to be extra careful.';
    }

    return {
      verdict: base.verdict,
      explanation: explanation,
      redFlags: redFlags,
      sources: base.sources,
      confidence: base.confidence,
      origin: 'heuristic'
    };
  }

  /*
   * analyzeClaim: the single place where a real backend would plug in.
   *
   * REAL API HOOK: replace the body of this function with a call to your
   * fact-checking service, for example:
   *
   *   const res = await fetch('/api/check', {
   *     method: 'POST',
   *     headers: { 'Content-Type': 'application/json' },
   *     body: JSON.stringify({ claim: rawText })
   *   });
   *   return await res.json(); // must return the result shape documented below
   *
   * A real version might: (1) send the claim to an LLM, (2) retrieve passages
   * from trusted medical sources (WHO, CDC, NIH, NHS...), (3) verify every
   * citation really exists and says what the answer claims, and (4) route
   * high-risk topics to human clinician review.
   *
   * Result shape: { verdict: 'supported'|'mixed'|'unsupported'|'doctor',
   *                 explanation: string, redFlags: string[],
   *                 sources: string[] (keys of SOURCES), confidence: {level, note},
   *                 origin?: 'heuristic' }
   */
  async function analyzeClaim(rawText) {
    await sleep(FAKE_DELAY_MS); // simulated network + "thinking" time
    var text = normalize(rawText);

    // MOCK STEP 1: keyword match against the pre-written library in data.js.
    var curated = matchCuratedClaim(text);
    if (curated) {
      return {
        verdict: curated.verdict,
        explanation: curated.explanation,
        redFlags: curated.redFlags,
        sources: curated.sources,
        confidence: curated.confidence
      };
    }

    // MOCK STEP 2: simple rule-based fallback. A real model would replace this too.
    return heuristicCheck(text);
  }

  // ---------- Rendering ----------
  function badgeHtml(verdict, large) {
    var v = D.VERDICTS[verdict];
    return '<span class="badge v-' + verdict + (large ? ' badge-lg' : '') + '">' +
      v.icon + '<span>' + esc(v.label) + '</span></span>';
  }

  function renderResult(entry) {
    var r = entry.result;
    var v = D.VERDICTS[r.verdict];
    var level = r.confidence.level;
    var filled = D.CONFIDENCE_LEVELS[level] || 1;

    var flags = r.redFlags.length
      ? '<ul class="flag-list">' + r.redFlags.map(function (f) {
          return '<li><span class="flag-icon" aria-hidden="true">⚑</span><span>' + esc(f) + '</span></li>';
        }).join('') + '</ul>'
      : '<p class="no-flags">No major red flags found in this claim.</p>';

    var sources = r.sources.map(function (key) {
      var s = D.SOURCES[key];
      return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<span>' + esc(s.name) + '<span class="visually-hidden"> (opens in a new tab)</span></span>' +
        '<span aria-hidden="true">↗</span></a></li>';
    }).join('');

    var segs = '';
    for (var i = 1; i <= 3; i++) segs += '<span class="seg' + (i <= filled ? ' on' : '') + '"></span>';

    var originNote = r.origin === 'heuristic'
      ? '<p class="origin-note">This claim is not in the prototype’s library, so a simple rule-based check was used instead of a real review.</p>'
      : '';

    resultRegion.innerHTML =
      '<article class="card result v-' + r.verdict + '">' +
        '<div class="result-top">' +
          '<h1 id="result-heading" class="result-title" tabindex="-1">Result</h1>' +
          badgeHtml(r.verdict, true) +
          '<p class="verdict-blurb">' + esc(v.blurb) + '</p>' +
        '</div>' +
        '<div class="result-body">' +
          '<blockquote class="claim-quote"><span class="claim-quote-label">Claim checked</span>' + esc(entry.text) + '</blockquote>' +
          originNote +
          '<section aria-labelledby="r-explain"><h2 id="r-explain">What we found</h2><p>' + esc(r.explanation) + '</p></section>' +
          '<section aria-labelledby="r-flags"><h2 id="r-flags">Red flags found</h2>' + flags + '</section>' +
          '<section aria-labelledby="r-sources"><h2 id="r-sources">Trusted sources</h2><ul class="source-list">' + sources + '</ul></section>' +
          '<section aria-labelledby="r-conf"><h2 id="r-conf">Confidence</h2>' +
            '<div class="confidence">' +
              '<span class="meter" role="img" aria-label="Confidence: ' + esc(level) + ', ' + filled + ' of 3">' + segs + '</span>' +
              '<span class="confidence-level">' + esc(level) + '</span>' +
              '<p class="confidence-note">' + esc(r.confidence.note) + '</p>' +
            '</div></section>' +
          '<div class="result-actions">' +
            '<button type="button" class="btn btn-primary" data-nav="home" data-reset="1">Check another claim</button>' +
            '<button type="button" class="btn btn-quiet" data-nav="history">View history</button>' +
          '</div>' +
          '<p class="disclaimer" role="note"><strong>Important:</strong> Infomedics is a prototype and does not provide medical advice. Talk to a qualified clinician about health decisions.</p>' +
        '</div>' +
      '</article>';
  }

  function renderHistory() {
    var list = loadHistory();
    historyList.innerHTML = '';
    historyEmpty.hidden = list.length > 0;
    clearBtn.hidden = list.length === 0;

    list.forEach(function (entry) {
      var snippet = entry.text.length > 110 ? entry.text.slice(0, 110).trim() + '…' : entry.text;
      var when = new Date(entry.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      var li = document.createElement('li');
      li.innerHTML =
        '<button type="button" class="history-item" data-id="' + esc(entry.id) + '">' +
          badgeHtml(entry.result.verdict, false) +
          '<span class="history-text"><span class="history-snippet">' + esc(snippet) + '</span><br>' +
          '<span class="history-time">' + esc(when) + '</span></span>' +
        '</button>';
      historyList.appendChild(li);
    });
  }

  function renderExamples() {
    D.EXAMPLES.forEach(function (text) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = text;
      btn.addEventListener('click', function () {
        input.value = text;
        clearError();
        input.focus();
      });
      li.appendChild(btn);
      examplesEl.appendChild(li);
    });
  }

  // ---------- Navigation ----------
  function show(name, opts) {
    opts = opts || {};
    checkToken++; // cancels any analysis still "in flight"
    setLoading(false);

    Object.keys(views).forEach(function (key) { views[key].hidden = key !== name; });

    var navTarget = name === 'result' ? 'home' : name;
    document.querySelectorAll('.nav-btn').forEach(function (btn) {
      if (btn.dataset.nav === navTarget) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });

    if (name === 'history') renderHistory();
    if (name === 'home' && opts.reset) {
      input.value = '';
      clearError();
    }

    window.scrollTo(0, 0);
    var focusEl = name === 'result' ? $('#result-heading') : headings[name];
    if (focusEl && !opts.noFocus) focusEl.focus({ preventScroll: true });
  }

  // ---------- Form behavior ----------
  function setLoading(on) {
    loadingEl.hidden = !on;
    checkBtn.disabled = on;
    input.readOnly = on;
    checkBtn.textContent = on ? 'Checking…' : 'Check claim';
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
    input.removeAttribute('aria-invalid');
  }

  async function handleSubmit(evt) {
    evt.preventDefault();
    if (checkBtn.disabled) return;

    var text = input.value.trim();
    if (!text) {
      showError('Please paste or type a health claim first, or pick one of the examples below.');
      input.focus();
      return;
    }
    clearError();

    var myToken = ++checkToken;
    setLoading(true);

    var result;
    try {
      result = await analyzeClaim(text);
    } catch (e) {
      if (myToken === checkToken) {
        setLoading(false);
        showError('Something went wrong while checking. Please try again.');
      }
      return;
    }
    if (myToken !== checkToken) return; // user navigated away meanwhile

    var entry = { id: String(Date.now()) + Math.random().toString(36).slice(2, 6), text: text, ts: Date.now(), result: result };
    var list = loadHistory();
    list.unshift(entry);
    saveHistory(list.slice(0, MAX_HISTORY));

    renderResult(entry);
    show('result');
  }

  // ---------- Events ----------
  form.addEventListener('submit', handleSubmit);

  input.addEventListener('input', function () { if (!errorEl.hidden) clearError(); });
  input.addEventListener('keydown', function (evt) {
    if (evt.key === 'Enter' && (evt.ctrlKey || evt.metaKey)) {
      evt.preventDefault();
      form.requestSubmit();
    }
  });

  document.addEventListener('click', function (evt) {
    var navBtn = evt.target.closest('[data-nav]');
    if (navBtn) {
      show(navBtn.dataset.nav, { reset: navBtn.dataset.reset === '1' });
      return;
    }
    var item = evt.target.closest('.history-item');
    if (item) {
      var entry = loadHistory().filter(function (e) { return e.id === item.dataset.id; })[0];
      if (entry) {
        renderResult(entry);
        show('result');
      }
    }
  });

  clearBtn.addEventListener('click', function () {
    saveHistory([]);
    renderHistory();
    headings.history.focus({ preventScroll: true });
  });

  // ---------- Init ----------
  renderExamples();
  show('home', { noFocus: true });
})();
