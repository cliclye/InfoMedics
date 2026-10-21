/*
 * Shared result-card renderer, used by the in-page panel (content.js) and the popup.
 * Returns an HTML string; every dynamic value goes through esc().
 */
(function (root) {
  'use strict';

  var D = root.INFOMEDICS;

  function esc(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function badge(verdict) {
    var v = D.VERDICTS[verdict];
    return '<span class="im-badge v-' + verdict + '">' + v.icon + '<span>' + esc(v.label) + '</span></span>';
  }

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max).trim() + '…' : text;
  }

  // opts.maxQuote: shorten the echoed claim (default 160 chars)
  function renderCard(entry, opts) {
    opts = opts || {};
    var r = entry.result;
    var v = D.VERDICTS[r.verdict];
    var level = r.confidence.level;
    var filled = D.CONFIDENCE_LEVELS[level] || 1;

    var flags = r.redFlags.length
      ? '<ul class="im-flags">' + r.redFlags.map(function (f) {
          return '<li><span class="im-flag-icon" aria-hidden="true">⚑</span><span>' + esc(f) + '</span></li>';
        }).join('') + '</ul>'
      : '<p class="im-noflags">No major red flags found in this claim.</p>';

    var sources = r.sources.map(function (key) {
      var s = D.SOURCES[key];
      return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<span>' + esc(s.name) + '<span class="im-sr"> (opens in a new tab)</span></span>' +
        '<span aria-hidden="true">↗</span></a></li>';
    }).join('');

    var segs = '';
    for (var i = 1; i <= 3; i++) segs += '<span class="im-seg' + (i <= filled ? ' on' : '') + '"></span>';

    var origin = r.origin === 'heuristic'
      ? '<p class="im-origin">Not in the prototype’s library, so a simple rule-based check was used.</p>'
      : '';

    return '<article class="im-card v-' + r.verdict + '">' +
      '<div class="im-top">' + badge(r.verdict) + '<p class="im-blurb">' + esc(v.blurb) + '</p></div>' +
      '<div class="im-body">' +
        '<blockquote class="im-quote">' + esc(truncate(entry.text, opts.maxQuote || 160)) + '</blockquote>' +
        origin +
        '<h3>What we found</h3><p class="im-explain">' + esc(r.explanation) + '</p>' +
        '<h3>Red flags found</h3>' + flags +
        '<h3>Trusted sources</h3><ul class="im-sources">' + sources + '</ul>' +
        '<h3>Confidence</h3>' +
        '<div class="im-conf"><span class="im-meter" role="img" aria-label="Confidence: ' + esc(level) + ', ' + filled + ' of 3">' + segs + '</span>' +
          '<strong>' + esc(level) + '</strong></div>' +
        '<p class="im-conf-note">' + esc(r.confidence.note) + '</p>' +
        '<p class="im-disclaimer" role="note">Infomedics is a prototype and does not provide medical advice. Talk to a qualified clinician about health decisions.</p>' +
      '</div>' +
    '</article>';
  }

  root.InfomedicsRender = { esc: esc, badge: badge, renderCard: renderCard, truncate: truncate };
})(self);
