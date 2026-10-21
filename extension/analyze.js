/*
 * Mock analysis for the Infomedics extension (same logic as app.js on the website).
 * Runs in the background service worker. All verdicts are SIMULATED.
 */
(function (root) {
  'use strict';

  var D = root.INFOMEDICS;
  var FAKE_DELAY_MS = 1200;

  function normalize(text) {
    return String(text).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // True if `term` appears at a word start (so "cure" also catches "cures").
  function hasTerm(text, term) {
    return new RegExp('(^|[^a-z0-9])' + escapeRegex(term), 'i').test(text);
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

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
    var quote = function (w) { return '“' + w + '”'; };

    var absolutes = H.absoluteWords.filter(function (w) { return hasTerm(text, w); });
    if (absolutes.length) redFlags.push(H.flagText.absolute + absolutes.map(quote).join(', ') + '.');

    var urgent = H.urgencyWords.filter(function (w) { return hasTerm(text, w); });
    if (urgent.length) redFlags.push(H.flagText.urgency + urgent.map(quote).join(', ') + '.');

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
   * REAL API HOOK: replace the body with a call to your fact-checking service.
   * Keep the call here in the background service worker, not in the content
   * script: content scripts are subject to each page's CORS rules, and API keys
   * must never be shipped to web pages.
   *
   *   const res = await fetch('https://api.example.com/check', {
   *     method: 'POST',
   *     headers: { 'Content-Type': 'application/json' },
   *     body: JSON.stringify({ claim: rawText })
   *   });
   *   return await res.json();
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

  root.InfomedicsAnalyze = { analyzeClaim: analyzeClaim };
})(self);
