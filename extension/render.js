/*
 * Shared result renderer for the in-page panel (content.js) and the popup.
 * Takes the server's result object and returns an HTML string. Every dynamic value goes through esc().
 */
(function (root) {
  'use strict';

  var ICONS = {
    supported: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    mixed: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2.5 22.5 21h-21z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 9.5v5M12 17.2v.3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>',
    unsupported: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8.2 8.2l7.6 7.6M15.8 8.2l-7.6 7.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>',
    doctor: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="currentColor"/><path d="M12 7v10M7 12h10" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>',
    unclear: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.9 2.4c-.9.5-1.3 1-1.3 2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.3" fill="#fff"/></svg>'
  };

  var VERDICTS = {
    supported: { label: 'Supported', blurb: 'The evidence backs this up.' },
    mixed: { label: 'Mixed evidence', blurb: 'Partly true, or it depends on the situation.' },
    unsupported: { label: 'Unsupported', blurb: 'Good evidence does not back this up.' },
    doctor: { label: 'Needs a doctor', blurb: 'This depends on the person. Ask a qualified professional.' },
    unclear: { label: 'Not rated', blurb: 'No AI verdict. Here is the evidence we found.' }
  };

  var STANCE = {
    supports: ['Supports the claim', '✓'],
    contradicts: ['Contradicts the claim', '✕'],
    neutral: ['Neutral or unclear', '–'],
    unrelated: ['Not about this claim', '–']
  };

  var TONE = { benefit: 'reports a benefit', no_benefit: 'no or limited benefit', mixed: 'mixed' };

  function esc(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function truncate(text, max) {
    text = String(text);
    return text.length > max ? text.slice(0, max).trim() + '…' : text;
  }

  function verdictMeta(verdict, rated) {
    var base = VERDICTS[verdict] || VERDICTS.unclear;
    if (verdict === 'unclear' && rated) return { label: 'Not enough evidence', blurb: 'We could not find enough to judge this claim.' };
    return base;
  }

  function badge(verdict, rated) {
    return '<span class="im-badge v-' + esc(verdict) + '">' + (ICONS[verdict] || ICONS.unclear) + '<span>' + esc(verdictMeta(verdict, rated).label) + '</span></span>';
  }

  function safeUrl(url) {
    return /^https?:\/\//i.test(String(url)) ? String(url) : '#';
  }

  function link(url, inner) {
    return '<a href="' + esc(safeUrl(url)) + '" target="_blank" rel="noopener noreferrer">' + inner + '<span class="im-sr"> (opens in a new tab)</span></a>';
  }

  function evidenceItem(e) {
    var stance = e.stance && STANCE[e.stance]
      ? '<span class="im-stance s-' + esc(e.stance) + '"><span aria-hidden="true">' + STANCE[e.stance][1] + '</span>' + esc(STANCE[e.stance][0]) + '</span>'
      : (e.tone && TONE[e.tone] ? '<span class="im-stance s-neutral" title="A keyword guess from the conclusion’s wording, not a judgement">Wording: ' + esc(TONE[e.tone]) + '</span>' : '');
    if (e.kind === 'medlineplus') {
      return '<li class="im-ev"><div class="im-ev-meta"><span class="im-ev-kind">MedlinePlus</span>' + stance + '</div>' +
        link(e.url, '<span class="im-ev-title">' + esc(e.title) + '</span>') +
        '<p>' + esc(truncate(e.note || e.summary || '', 220)) + '</p></li>';
    }
    return '<li class="im-ev"><div class="im-ev-meta"><span class="im-ev-kind">' + esc(e.design) + '</span>' + (e.year ? '<span>' + esc(e.year) + '</span>' : '') + stance + '</div>' +
      link(e.url, '<span class="im-ev-title">' + esc(truncate(e.title, 150)) + '</span>') +
      (e.note ? '<p>' + esc(truncate(e.note, 220)) + '</p>' : (e.conclusion ? '<p><b>Conclusion:</b> ' + esc(truncate(e.conclusion, 220)) + '</p>' : '')) + '</li>';
  }

  function claimHtml(c, index, total) {
    var meta = verdictMeta(c.verdict, c.rated);
    var filled = { Low: 1, Medium: 2, High: 3 }[c.confidence.level] || 1;
    var segs = '';
    for (var i = 1; i <= 3; i++) segs += '<span class="im-seg' + (i <= filled ? ' on' : '') + '"></span>';

    var flags = c.redFlags.length
      ? '<ul class="im-flags">' + c.redFlags.slice(0, 4).map(function (f) {
          return '<li><span class="im-flag-icon" aria-hidden="true">⚑</span><span><b>' + esc(f.label) + '.</b> ' + esc(f.text) + '</span></li>';
        }).join('') + '</ul>'
      : '<p class="im-noflags">No red flags found in the wording.</p>';

    var papers = c.evidence.filter(function (e) { return e.kind === 'pubmed'; }).slice(0, 3);
    var topics = c.evidence.filter(function (e) { return e.kind === 'medlineplus'; }).slice(0, 1);
    var shown = topics.concat(papers);
    var evidence = shown.length
      ? '<details class="im-details"><summary>Evidence (' + c.evidence.length + ')</summary><ul class="im-evlist">' + shown.map(evidenceItem).join('') + '</ul></details>'
      : '<p class="im-muted">No matching research or health-topic pages were found.</p>';

    var refs = c.references.topics.slice(0, 2).map(function (t) { return { name: t.title, note: 'MedlinePlus', url: t.url }; })
      .concat(c.references.search.slice(0, 3));
    var links = '<details class="im-details"><summary>Read more from trusted sources</summary><ul class="im-links">' + refs.map(function (r) {
      return '<li>' + link(r.url, '<span>' + esc(r.name) + '<small> · ' + esc(r.note) + '</small></span><span aria-hidden="true">↗</span>') + '</li>';
    }).join('') + '</ul></details>';

    var notes = (c.warnings || []).map(function (w) { return '<p class="im-notice">' + esc(w) + '</p>'; }).join('');
    var ungrounded = c.rated && !c.grounded ? '<p class="im-notice">No sources were found, so the AI relied on its background knowledge.</p>' : '';

    return '<section class="im-claim v-' + esc(c.verdict) + '">' +
      '<div class="im-top">' +
        (total > 1 ? '<p class="im-index">Claim ' + (index + 1) + ' of ' + total + '</p>' : '') +
        '<span class="im-badge v-' + esc(c.verdict) + '">' + (ICONS[c.verdict] || ICONS.unclear) + '<span>' + esc(meta.label) + '</span></span>' +
        '<p class="im-blurb">' + esc(meta.blurb) + '</p>' +
      '</div>' +
      '<div class="im-body">' +
        '<blockquote class="im-quote">' + esc(truncate(c.claim, 220)) + '</blockquote>' +
        notes +
        '<h3>' + (c.rated ? 'What the evidence says' : 'What we found') + '</h3><p class="im-explain">' + esc(c.explanation) + '</p>' + ungrounded +
        '<div class="im-conf"><span class="im-meter" role="img" aria-label="Confidence: ' + esc(c.confidence.level) + ', ' + filled + ' of 3">' + segs + '</span><b>' + esc(c.confidence.level) + ' confidence</b></div>' +
        '<p class="im-muted">' + esc(c.confidence.note) + '</p>' +
        '<h3>Red flags</h3>' + flags +
        '<h3>Evidence</h3>' + evidence +
        links +
      '</div></section>';
  }

  function pageHtml(page) {
    var tier = { trusted: 'Known health organization', institutional: 'Government or university site', unknown: 'Reputation unknown' }[page.domain.tier];
    var signals = page.signals.map(function (s) {
      return '<li class="im-signal ' + esc(s.status) + '"><span class="im-signal-icon" aria-hidden="true">' + ({ good: '✓', warn: '!', info: 'i' }[s.status] || 'i') + '</span><span><b>' + esc(s.label) + '.</b> ' + esc(s.detail) + '</span></li>';
    }).join('');
    return '<section class="im-page"><p class="im-index">Page checked</p><p class="im-page-title">' + esc(truncate(page.title || page.host, 120)) + '</p>' +
      '<p class="im-muted">' + esc(page.host) + ' · ' + esc(tier) + '</p><ul class="im-signals">' + signals + '</ul></section>';
  }

  /**
   * @param {object} result  the server's result
   * @param {{serverUrl?: string}} opts
   */
  function renderResult(result, opts) {
    opts = opts || {};
    var emergency = result.claims.some(function (c) { return c.emergency; })
      ? '<p class="im-emergency" role="alert">If this might be an emergency, call your local emergency number now (911 in the US, 999 in the UK, 112 in the EU).</p>' : '';
    var summary = result.claims.length > 1
      ? '<div class="im-summary"><b>' + result.claims.length + ' claims:</b> ' + result.claims.map(function (c) { return badge(c.verdict, c.rated); }).join(' ') + '</div>' : '';
    var modeLine = result.mode === 'ai'
      ? 'AI verdict by ' + esc(result.model) + ', weighed against the sources shown.'
      : 'Evidence-only mode: no AI model is connected, so claims are not rated.';
    var site = opts.serverUrl ? ' ' + link(opts.serverUrl, 'Open Infomedics') : '';

    return '<article class="im-card">' + emergency + (result.page ? pageHtml(result.page) : '') + summary +
      result.claims.map(function (c, i) { return claimHtml(c, i, result.claims.length); }).join('') +
      '<div class="im-foot"><p class="im-muted">' + modeLine + site + '</p>' +
      '<p class="im-disclaimer" role="note">Infomedics is a prototype and does not provide medical advice. Talk to a qualified clinician about health decisions.</p></div>' +
    '</article>';
  }

  root.InfomedicsRender = { esc: esc, badge: badge, renderResult: renderResult, truncate: truncate, verdictMeta: verdictMeta };
})(globalThis);
