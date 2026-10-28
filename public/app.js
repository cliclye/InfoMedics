// Infomedics front end. Talks to POST /api/check (streamed progress) and renders results.
// All dynamic text goes through esc(); the page's CSP forbids inline scripts and styles.

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const HISTORY_KEY = 'infomedics.history.v2';
const MAX_HISTORY = 15;

const EXAMPLES = [
  { text: 'Vitamin C cures the common cold' },
  { text: 'You should never take antibiotics with food' },
  { text: 'Drinking apple cider vinegar melts belly fat' },
  { tag: 'Link', text: 'https://www.nhs.uk/conditions/common-cold/' }
];

const ICONS = {
  supported: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  mixed: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2.5 22.5 21h-21z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 9.5v5M12 17.2v.3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>',
  unsupported: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8.2 8.2l7.6 7.6M15.8 8.2l-7.6 7.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>',
  doctor: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="currentColor"/><path d="M12 7v10M7 12h10" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>',
  unclear: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.9 2.4c-.9.5-1.3 1-1.3 2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.3" fill="#fff"/></svg>'
};

const VERDICTS = {
  supported: { label: 'Supported', blurb: 'The evidence backs this up.' },
  mixed: { label: 'Mixed evidence', blurb: 'Partly true, or it depends on the situation.' },
  unsupported: { label: 'Unsupported', blurb: 'Good evidence does not back this up.' },
  doctor: { label: 'Needs a doctor', blurb: 'This depends on the person. Ask a qualified professional.' },
  unclear: { label: 'Not rated', blurb: 'No AI verdict. Here is the evidence we found.' }
};

function verdictMeta(verdict, rated) {
  const base = VERDICTS[verdict] || VERDICTS.unclear;
  if (verdict === 'unclear' && rated) return { ...base, label: 'Not enough evidence', blurb: 'We could not find enough to judge this claim.' };
  return base;
}

const badge = (verdict, rated) => `<span class="badge v-${esc(verdict)}">${ICONS[verdict] || ICONS.unclear}<span>${esc(verdictMeta(verdict, rated).label)}</span></span>`;

// ---------- State ----------
let status = { ai: false, model: null };
let currentResult = null;
let activeCheck = null; // AbortController of the running check

const views = {
  check: $('#view-check'), progress: $('#view-progress'), result: $('#view-result'),
  history: $('#view-history'), about: $('#view-about')
};
const input = $('#input');
const inputError = $('#input-error');
const checkBtn = $('#check-btn');

// ---------- History (localStorage; every access guarded) ----------
function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    // Ignore anything that is not shaped like a result (old versions, edited storage).
    return Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string' && Array.isArray(r.claims) && r.claims.length) : [];
  } catch { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* quota or private mode */ }
}
function addToHistory(result) {
  const list = loadHistory().filter((r) => r.id !== result.id);
  list.unshift(result);
  // Keep storage small if the browser is tight on space.
  let trimmed = list.slice(0, MAX_HISTORY);
  while (trimmed.length > 1) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed)); return; } catch { trimmed = trimmed.slice(0, -1); }
  }
  saveHistory(trimmed);
}

// ---------- Views and routing ----------
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let firstView = true;

// Cross-fade between pages when the browser can (View Transitions API).
function showView(name, options = {}) {
  const apply = () => applyView(name, options);
  if (!firstView && document.startViewTransition && !reducedMotion.matches) document.startViewTransition(apply);
  else apply();
  firstView = false;
}

function applyView(name, { focus = true } = {}) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  const navKey = name === 'result' || name === 'progress' ? 'check' : name;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === navKey) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  placePill();
  window.scrollTo(0, 0);
  if (!focus) return;
  const heading = name === 'result' ? $('#result-heading') : $('h1', views[name]);
  if (heading) heading.focus({ preventScroll: true });
}

function route() {
  const [name, arg] = (location.hash.replace(/^#\/?/, '') || 'check').split('/');
  if (activeCheck) { activeCheck.abort(); activeCheck = null; }
  switch (name) {
    case 'history': renderHistory(); showView('history'); break;
    case 'about': showView('about'); break;
    case 'result': {
      const found = loadHistory().find((r) => r.id === arg) || (currentResult && currentResult.id === arg ? currentResult : null);
      if (found) { renderResult(found); showView('result'); } else { location.hash = '#check'; }
      break;
    }
    default: showView('check', { focus: false }); break;
  }
}
window.addEventListener('hashchange', route);

// ---------- Rendering: results ----------
function overallRated(result) { return result.mode === 'ai'; }

function verdictCard(c, { showClaim = true, headingId = false } = {}) {
  const meta = verdictMeta(c.verdict, c.rated);
  return `<div class="verdict-card v-${esc(c.verdict)}">
    <div class="verdict-icon">${ICONS[c.verdict] || ICONS.unclear}</div>
    <div>
      <h2 class="verdict-label"${headingId ? ' id="verdict-heading"' : ''}>${esc(meta.label)}</h2>
      <p class="verdict-blurb">${esc(meta.blurb)}</p>
    </div>
    ${showClaim ? `<blockquote class="verdict-claim"><span class="label">Claim checked</span>${esc(c.claim)}</blockquote>` : ''}
  </div>`;
}

function flagsBlock(c) {
  const body = c.redFlags.length
    ? `<ul class="flags">${c.redFlags.map((f) => `<li class="tile flag"><span class="flag-icon" aria-hidden="true">⚑</span><span><small>${esc(f.label)}</small>${esc(f.text)}</span></li>`).join('')}</ul>`
    : '<p class="no-flags">No red flags found in the wording of this claim.</p>';
  return `<section class="block"><h2>Red flags</h2>${body}</section>`;
}

const STANCE = {
  supports: ['Supports the claim', '✓'],
  contradicts: ['Contradicts the claim', '✕'],
  neutral: ['Neutral or unclear', '–'],
  unrelated: ['Not about this claim', '–']
};

const TONE = { benefit: 'reports a benefit', no_benefit: 'no or limited benefit', mixed: 'mixed' };

function evidenceItem(e) {
  const stance = e.stance && STANCE[e.stance]
    ? `<span class="stance s-${esc(e.stance)}"><span aria-hidden="true">${STANCE[e.stance][1]}</span>${esc(STANCE[e.stance][0])}</span>` : '';
  const link = `<a class="ev-title" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}<span class="sr-only"> (opens in a new tab)</span></a>`;
  if (e.kind === 'medlineplus') {
    return `<li class="tile ev"><div class="ev-meta"><span class="ev-design">MedlinePlus</span><span>Plain-language topic</span>${stance}</div>${link}
      ${e.note ? `<p class="ev-note"><span class="label">What it says:</span> ${esc(e.note)}</p>` : `<p class="ev-note">${esc(e.summary)}</p>`}</li>`;
  }
  return `<li class="tile ev"><div class="ev-meta"><span class="ev-design">${esc(e.design)}</span>${e.year ? `<span>${esc(e.year)}</span>` : ''}<span>${esc(e.source)}</span>${stance}${!e.stance && TONE[e.tone] ? `<span class="stance s-neutral" title="A keyword guess from the conclusion's wording, not a judgement">Wording: ${esc(TONE[e.tone])}</span>` : ''}</div>${link}
    ${e.note ? `<p class="ev-note"><span class="label">What it found:</span> ${esc(e.note)}</p>` : ''}
    ${e.conclusion ? `<p class="ev-note"><span class="label">Authors’ conclusion:</span> ${esc(e.conclusion)}</p>` : ''}</li>`;
}

function evidenceBlock(c, { collapsible = false } = {}) {
  const papers = c.evidence.filter((e) => e.kind === 'pubmed');
  const topics = c.evidence.filter((e) => e.kind === 'medlineplus');
  const s = c.evidenceSummary || {};
  let inner = '';
  if (!c.evidence.length) {
    inner = '<p class="muted">No matching research papers or health-topic pages were found.</p>';
  } else {
    if (papers.length) {
      inner += `<p class="ev-summary">Top ${papers.length} of ${Number(s.pubmedTotal || papers.length).toLocaleString('en-US')} matching PubMed result${s.pubmedTotal === 1 ? '' : 's'}, ranked by study type, relevance and recency. Search: <code>${esc(s.query || '')}</code></p><ul class="ev-list">${papers.map(evidenceItem).join('')}</ul>`;
    }
    if (topics.length) inner += `<p class="ev-summary ev-gap">Plain-language summaries from the US National Library of Medicine:</p><ul class="ev-list">${topics.map(evidenceItem).join('')}</ul>`;
  }
  const title = `Evidence (${c.evidence.length})`;
  return collapsible
    ? `<details class="block"><summary><strong>${esc(title)}</strong></summary>${inner}</details>`
    : `<section class="block"><h2>${esc(title)}</h2>${inner}</section>`;
}

function confidenceBlock(c, { card = false } = {}) {
  const filled = { Low: 1, Medium: 2, High: 3 }[c.confidence.level] || 1;
  const segs = [1, 2, 3].map((i) => `<span class="seg${i <= filled ? ' on' : ''}"></span>`).join('');
  const inner = `<div class="confidence"><span class="meter" role="img" aria-label="Confidence: ${esc(c.confidence.level)}, ${filled} of 3">${segs}</span><strong>${esc(c.confidence.level)} confidence</strong></div><p class="muted">${esc(c.confidence.note)}</p>`;
  return card ? `<section class="glass side-card"><h2>Confidence</h2>${inner}</section>` : `<section class="block"><h2>Confidence</h2>${inner}</section>`;
}

function linksBlock(c, { card = false, bare = false } = {}) {
  const topics = c.references.topics.map((t) => `<a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(t.title)}<small> · MedlinePlus</small></span><span aria-hidden="true">↗</span></a>`).join('');
  const search = c.references.search.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(s.name)}<small> · ${esc(s.note)}</small></span><span aria-hidden="true">↗</span></a>`).join('');
  const inner = `${topics ? `<div class="links">${topics}</div>` : ''}<p class="links-title">Search it yourself</p><div class="links">${search}</div>`;
  if (bare) return inner;
  return card ? `<section class="glass side-card"><h2>Read more</h2>${inner}</section>` : `<section class="block"><h2>Read more from trusted sources</h2>${inner}</section>`;
}

function warningsBlock(c) {
  return c.warnings && c.warnings.length ? c.warnings.map((w) => `<p class="notice">${esc(w)}</p>`).join('') : '';
}

function explanationBlock(c) {
  const ungrounded = c.rated && !c.grounded ? '<p class="notice">No sources were found for this claim, so the AI relied on its background knowledge.</p>' : '';
  return `<section class="block"><h2>${c.rated ? 'What the evidence says' : 'What we found'}</h2><p class="explain">${esc(c.explanation)}</p>${ungrounded}</section>`;
}

const DISCLAIMER = '<p class="disclaimer" role="note"><strong>Important:</strong> Infomedics is a prototype and does not provide medical advice. Talk to a qualified clinician about health decisions.</p>';

function singleClaim(c) {
  return `<article>
    ${verdictCard(c, { headingId: true })}
    <div class="result-grid has-side">
      <div>${warningsBlock(c)}${explanationBlock(c)}${flagsBlock(c)}${evidenceBlock(c)}</div>
      <aside class="side-sticky" aria-label="Confidence and sources">${confidenceBlock(c, { card: true })}${linksBlock(c, { card: true })}${DISCLAIMER}</aside>
    </div>
  </article>`;
}

function claimCard(c, index, total) {
  return `<article class="glass claim-card" aria-label="Claim ${index + 1} of ${total}">
    <p class="claim-index">Claim ${index + 1} of ${total}</p>
    ${verdictCard(c)}
    ${warningsBlock(c)}${explanationBlock(c)}${confidenceBlock(c)}${flagsBlock(c)}
    ${evidenceBlock(c, { collapsible: true })}
    <details class="block"><summary><strong>Read more from trusted sources</strong></summary>${linksBlock(c, { bare: true })}</details>
  </article>`;
}

function pageCard(page) {
  const tier = { trusted: 'Known health organization', institutional: 'Government or university site', unknown: 'Reputation unknown' }[page.domain.tier];
  const signals = page.signals.map((s) => `<li class="tile signal ${esc(s.status)}"><span class="signal-icon" aria-hidden="true">${{ good: '✓', warn: '!', info: 'i' }[s.status] || 'i'}</span><div><strong>${esc(s.label)}</strong><p>${esc(s.detail)}</p></div></li>`).join('');
  return `<section class="glass page-card" aria-label="Page assessment">
    <p class="eyebrow">Page checked</p>
    <h2>${esc(page.title || page.host)}</h2>
    <p class="page-host"><a href="${esc(page.finalUrl)}" target="_blank" rel="noopener noreferrer">${esc(page.host)}</a> · ${esc(tier)} · ${esc(page.wordCount.toLocaleString('en-US'))} words read</p>
    <ul class="signals">${signals}</ul>
  </section>`;
}

function resultText(r) {
  const lines = ['Infomedics result' + (r.mode === 'ai' ? '' : ' (evidence only, not rated)')];
  if (r.page) lines.push(`Page: ${r.page.title || r.page.host} (${r.page.finalUrl})`);
  r.claims.forEach((c, i) => {
    lines.push('', `${r.claims.length > 1 ? `Claim ${i + 1}: ` : 'Claim: '}${c.claim}`, `Verdict: ${verdictMeta(c.verdict, c.rated).label} (${c.confidence.level} confidence)`, c.explanation);
    c.evidence.filter((e) => e.kind === 'pubmed').slice(0, 3).forEach((e) => lines.push(`- ${e.design}, ${e.year || 'n.d.'}: ${e.title} ${e.url}`));
  });
  lines.push('', 'Infomedics is a prototype and does not provide medical advice. Talk to a qualified clinician about health decisions.');
  return lines.join('\n');
}

function renderResult(r) {
  currentResult = r;
  const multi = r.claims.length > 1 || r.kind === 'page';
  const emergency = r.claims.some((c) => c.emergency)
    ? '<p class="emergency" role="alert">If this might be an emergency, call your local emergency number now (911 in the US, 999 in the UK, 112 in the EU).</p>' : '';

  let body;
  if (multi) {
    const strip = r.claims.length > 1
      ? `<div class="summary-strip"><strong>${r.claims.length} claims checked:</strong>${r.claims.map((c) => badge(c.verdict, c.rated)).join('')}</div>` : '';
    body = `${r.page ? pageCard(r.page) : ''}${strip}${r.claims.map((c, i) => claimCard(c, i, r.claims.length)).join('')}${DISCLAIMER}`;
  } else {
    body = singleClaim(r.claims[0]);
  }

  const seconds = (r.elapsedMs / 1000).toFixed(1);
  const modeLine = r.mode === 'ai'
    ? `AI verdict by ${esc(r.model)}, weighed against the sources shown.`
    : 'Evidence-only mode: no AI model is connected, so claims are not rated.';

  $('#result-region').innerHTML = `
    <h1 class="sr-only" id="result-heading" tabindex="-1">Result</h1>
    <div class="result-top">
      <a class="btn btn-primary btn-small" href="#check" data-action="again">← Check another</a>
      <div class="result-top-actions">
        <button type="button" class="btn btn-quiet btn-small" data-action="copy">Copy summary</button>
        <a class="btn btn-quiet btn-small" href="#history">History</a>
      </div>
    </div>
    ${emergency}${body}
    <p class="meta-line">${modeLine} Checked in ${esc(seconds)}s.</p>`;
}

// ---------- Rendering: history ----------
function renderHistory() {
  const list = loadHistory();
  $('#history-empty').hidden = list.length > 0;
  $('#clear-history').hidden = list.length === 0;
  $('#history-list').innerHTML = list.map((r) => {
    const snippet = r.kind === 'page'
      ? (r.page && r.page.title) || r.input.url
      : (r.claims[0] ? r.claims[0].claim : r.input.text);
    const when = new Date(r.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const extra = r.kind === 'page' ? `Page · ${r.claims.length} claim${r.claims.length === 1 ? '' : 's'}` : (r.claims.length > 1 ? `${r.claims.length} claims` : 'Claim');
    return `<li><a class="glass history-item" href="#result/${esc(r.id)}">${badge(r.overall, overallRated(r))}<span><span class="history-snippet">${esc(snippet.length > 120 ? snippet.slice(0, 120) + '…' : snippet)}</span><span class="history-meta">${esc(extra)} · ${esc(when)}</span></span></a></li>`;
  }).join('');
}

// ---------- Progress ----------
const progressBar = $('#progress-bar');
function setProgress(fraction) { progressBar.style.setProperty('--p', String(Math.max(0.06, Math.min(1, fraction)))); }

function renderPlan(steps) {
  setProgress(0.06);
  $('#progress-steps').innerHTML = steps.map((s) =>
    `<li class="step is-pending" data-step="${esc(s.id)}"><span class="step-icon" aria-hidden="true"></span><div><div class="step-label">${esc(s.label)}</div><p class="step-detail"></p></div></li>`).join('');
}
function updateStep({ id, status: state, detail }) {
  const el = $(`[data-step="${CSS.escape(id)}"]`);
  if (!el) return;
  el.classList.remove('is-pending', 'is-active', 'is-done');
  el.classList.add(state === 'done' ? 'is-done' : 'is-active');
  $('.step-icon', el).textContent = state === 'done' ? '✓' : '';
  if (detail) $('.step-detail', el).textContent = detail;
  const all = document.querySelectorAll('#progress-steps .step').length || 1;
  const done = document.querySelectorAll('#progress-steps .is-done').length;
  setProgress((done + (state === 'done' ? 0 : 0.5)) / all);
}

// ---------- Talking to the server ----------
class CheckError extends Error {}

async function streamCheck(text, signal, onEvent) {
  let res;
  try {
    res = await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: text }), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new CheckError(['localhost', '127.0.0.1'].includes(location.hostname)
      ? 'Could not reach the Infomedics server. Start it with “npm start” and open http://localhost:3000.'
      : 'Could not reach the Infomedics server. Check your connection and try again.');
  }
  if (!res.ok) {
    let message = `The server returned an error (${res.status}).`;
    try { message = (await res.json()).error || message; } catch { /* keep default */ }
    throw new CheckError(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

function showInputError(message) {
  inputError.textContent = message;
  inputError.hidden = false;
  input.setAttribute('aria-invalid', 'true');
}
function clearInputError() {
  inputError.hidden = true;
  inputError.textContent = '';
  input.removeAttribute('aria-invalid');
}

async function submit() {
  if (activeCheck) return;
  const text = input.value.trim();
  if (!text) {
    showInputError('Please paste a health claim, an AI answer, or a link first, or pick one of the examples.');
    input.focus();
    return;
  }
  clearInputError();

  const controller = new AbortController();
  activeCheck = controller;
  checkBtn.disabled = true;
  $('#progress-input').textContent = text.length > 400 ? text.slice(0, 400) + '…' : text;
  $('#progress-steps').innerHTML = '';
  showView('progress');

  let result = null;
  let failure = null;
  try {
    await streamCheck(text, controller.signal, (event) => {
      if (event.type === 'plan') renderPlan(event.steps);
      else if (event.type === 'step') updateStep(event);
      else if (event.type === 'result') result = event.result;
      else if (event.type === 'error') failure = event.message;
    });
  } catch (err) {
    if (err.name === 'AbortError') { checkBtn.disabled = false; return; } // user cancelled or navigated away
    failure = err instanceof CheckError ? err.message : 'Something went wrong while checking. Please try again.';
  } finally {
    if (activeCheck === controller) activeCheck = null;
    checkBtn.disabled = false;
  }

  if (failure || !result) {
    showView('check', { focus: false });
    showInputError(failure || 'No result came back. Please try again.');
    input.focus();
    return;
  }
  addToHistory(result);
  renderResult(result);
  history.pushState(null, '', `#result/${result.id}`);
  showView('result');
}

// ---------- Events ----------
$('#checker').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
input.addEventListener('input', () => { if (!inputError.hidden) clearInputError(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
});
$('#cancel-btn').addEventListener('click', () => {
  if (activeCheck) { activeCheck.abort(); activeCheck = null; }
  checkBtn.disabled = false;
  showView('check');
  input.focus();
});
$('#clear-history').addEventListener('click', () => { saveHistory([]); renderHistory(); $('#history-heading').focus({ preventScroll: true }); });

document.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'again') {
    input.value = '';
    clearInputError();
    if (location.hash === '#check' || location.hash === '') { e.preventDefault(); showView('check', { focus: false }); }
    setTimeout(() => input.focus(), 0);
  } else if (action.dataset.action === 'copy' && currentResult) {
    try {
      await navigator.clipboard.writeText(resultText(currentResult));
      action.textContent = 'Copied ✓';
    } catch { action.textContent = 'Copy failed'; }
    action.classList.remove('bump');
    void action.offsetWidth; // restart the animation
    action.classList.add('bump');
    setTimeout(() => { action.textContent = 'Copy summary'; }, 2000);
  }
});

// ---------- Polish: sliding nav pill, pointer highlight, platform key hint ----------
const nav = $('#nav');
function placePill() {
  const active = $('a[aria-current="page"]', nav);
  if (!active) { nav.classList.remove('ready'); return; }
  nav.style.setProperty('--pill-x', `${active.parentElement.offsetLeft}px`);
  nav.style.setProperty('--pill-w', `${active.offsetWidth}px`);
  nav.classList.add('ready');
}
window.addEventListener('resize', placePill);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(placePill);

let glowFrame = 0;
document.addEventListener('pointermove', (e) => {
  if (glowFrame || e.pointerType === 'touch') return;
  const target = e.target.closest && e.target.closest('.glass');
  if (!target) return;
  glowFrame = requestAnimationFrame(() => {
    glowFrame = 0;
    const box = target.getBoundingClientRect();
    target.style.setProperty('--mx', `${e.clientX - box.left}px`);
    target.style.setProperty('--my', `${e.clientY - box.top}px`);
  });
});

// Backdrop orbs drift toward the pointer; the dock slips away while scrolling down and returns on scroll up.
const backdrop = $('.bg');
let parallaxFrame = 0;
document.addEventListener('pointermove', (e) => {
  if (parallaxFrame || e.pointerType === 'touch' || reducedMotion.matches) return;
  parallaxFrame = requestAnimationFrame(() => {
    parallaxFrame = 0;
    backdrop.style.setProperty('--px', (e.clientX / window.innerWidth - 0.5).toFixed(3));
    backdrop.style.setProperty('--py', (e.clientY / window.innerHeight - 0.5).toFixed(3));
  });
});

const dock = $('.dock-wrap');
let lastScroll = 0;
window.addEventListener('scroll', () => {
  const y = window.scrollY;
  const desktop = window.matchMedia('(min-width: 701px)').matches;
  dock.classList.toggle('away', desktop && y > 140 && y > lastScroll + 4);
  if (y < lastScroll - 4 || y <= 140) dock.classList.remove('away');
  lastScroll = y;
}, { passive: true });

const isApple = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
if (!isApple) { const key = $('#input-hint kbd'); if (key) key.textContent = 'Ctrl'; }

// ---------- Init ----------
function renderExamples() {
  const list = $('#examples');
  for (const ex of EXAMPLES) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'example';
    btn.innerHTML = (ex.tag ? `<span class="tag">${esc(ex.tag)}</span>` : '') + esc(ex.text);
    btn.addEventListener('click', () => { input.value = ex.text; clearInputError(); input.focus(); });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function renderLegend() {
  const desc = {
    supported: 'The research and medical consensus back the claim as worded.',
    mixed: 'Partly true, overstated, or true only for some people.',
    unsupported: 'Good evidence contradicts it, or there is none behind it.',
    doctor: 'A personal medical decision. A professional should decide.',
    unclear: 'Not enough evidence, or no AI model connected, so no verdict is given.'
  };
  $('#verdict-legend').innerHTML = Object.keys(desc).map((v) => `<li>${badge(v, false)}<span class="desc">${esc(desc[v])}</span></li>`).join('');
}

async function loadStatus() {
  const chip = $('#mode-chip');
  try {
    const res = await fetch('/api/status');
    status = await res.json();
  } catch { return; }
  chip.hidden = false;
  chip.classList.toggle('on', Boolean(status.ai));
  chip.innerHTML = '<span class="chip-dot" aria-hidden="true"></span><span class="chip-text"></span>';
  $('.chip-text', chip).textContent = status.ai ? `AI verdicts on · ${status.model}` : 'Evidence-only mode';
  chip.title = status.ai ? 'Claims are weighed against the evidence by an AI model.' : 'No AI model is connected, so claims are not rated. Add ANTHROPIC_API_KEY to enable verdicts.';
}

renderExamples();
renderLegend();
loadStatus();
route();
