// Rule-based "red flag" detection for the *wording* of a claim. These are reliable, cheap signals
// (miracle language, absolute words, fear tactics...) that don't need an AI to spot.

import { escapeRegex } from './text.js';

const RULES = [
  {
    type: 'miracle',
    label: 'Miracle-cure language',
    terms: ['miracle', 'cure-all', 'cures everything', 'secret remedy', 'breakthrough', 'revolutionary', 'one weird trick', 'magic', 'melts', 'melt away', 'detox', 'cleanse', 'flushes', 'flush out', 'toxins', 'reverses', 'cures', 'cured', 'cure for', 'heals everything', 'works instantly', 'instantly'],
    // "cure" alone is only a flag when used as a promise (cures / cured / cure for)
    explain: (hits) => `Miracle or quick-fix wording (${quoteList(hits)}) promises more than most real treatments can.`
  },
  {
    type: 'absolute',
    label: 'Absolute words',
    terms: ['always', 'never', 'guaranteed', 'guarantee', '100%', 'every time', 'everyone', 'no one', 'nobody', 'completely safe', 'totally safe', 'permanently', 'all natural cures', 'proven to', 'impossible', 'without exception', 'no side effects', 'zero risk'],
    explain: (hits) => `Absolute words (${quoteList(hits)}) rarely fit health; most advice depends on the person.`
  },
  {
    type: 'urgency',
    label: 'Urgency or fear tactics',
    terms: ['urgent', 'act now', 'right now', 'before it\'s too late', 'limited time', 'warning:', 'shocking', 'deadly', 'they don\'t want you to know', 'what doctors won\'t tell you', 'doctors hate', 'banned', 'you won\'t believe', 'must read', 'hurry', 'danger'],
    explain: (hits) => `Urgency or fear tactics (${quoteList(hits)}) push you to react before you think.`
  },
  {
    type: 'conspiracy',
    label: 'Conspiracy framing',
    terms: ['big pharma', 'cover-up', 'cover up', 'suppressed', 'mainstream medicine', 'hidden truth', 'wake up', 'they are hiding', 'the establishment', 'censored'],
    explain: (hits) => `Conspiracy framing (${quoteList(hits)}) is a common sign of misinformation.`
  },
  {
    type: 'vague_authority',
    label: 'Vague authority',
    terms: ['studies show', 'research shows', 'experts say', 'scientists say', 'doctors say', 'many people say', 'it is well known', 'everyone knows', 'science proves', 'clinically proven', 'doctor recommended'],
    explain: (hits) => `Vague authority (${quoteList(hits)}) without naming the study or expert makes the claim impossible to check.`
  },
  {
    type: 'anecdote',
    label: 'Personal story as proof',
    terms: ['worked for me', 'worked for my', 'i tried it', 'my friend', 'my aunt', 'my uncle', 'i swear', 'changed my life', 'before and after', 'testimonial'],
    explain: (hits) => `A personal story (${quoteList(hits)}) is not evidence that something works for everyone.`
  }
];

const SOURCE_HINTS = [
  /\baccording to\b/i, /\bstud(?:y|ies)\b/i, /\bresearch(?:ers)?\b/i, /\bjournal\b/i, /\btrial\b/i,
  /\bmeta-?analysis\b/i, /\bpubmed\b/i, /\bwho\b/, /\bcdc\b/i, /\bnih\b/i, /\bnhs\b/i, /https?:\/\//i, /\bdoi:/i, /\(\d{4}\)/
];

function quoteList(hits) {
  return hits.slice(0, 3).map((h) => `“${h}”`).join(', ');
}

function termRegex(term) {
  // Word-boundary matching, except for terms that start/end with non-word characters (100%, "warning:").
  const start = /^\w/.test(term) ? '\\b' : '';
  const end = /\w$/.test(term) ? '\\b' : '';
  return new RegExp(`${start}${escapeRegex(term)}${end}`, 'i');
}

const COMPILED = RULES.map((rule) => ({ ...rule, regexes: rule.terms.map((t) => [t, termRegex(t)]) }));

/**
 * @param {string} text
 * @param {{checkSource?: boolean}} opts  checkSource: flag when nothing in the text names a source
 * @returns {{type: string, label: string, text: string}[]}
 */
export function findRedFlags(text, { checkSource = true } = {}) {
  const flags = [];
  const normalized = String(text).replace(/[‘’]/g, "'");

  for (const rule of COMPILED) {
    const hits = [];
    for (const [term, re] of rule.regexes) {
      if (re.test(normalized)) hits.push(term);
    }
    // Drop "cure"/"cures" doubles etc. so the explanation stays short.
    const unique = [...new Set(hits)];
    if (unique.length) flags.push({ type: rule.type, label: rule.label, text: rule.explain(unique) });
  }

  const letters = normalized.replace(/[^A-Za-z]/g, '');
  const upper = normalized.replace(/[^A-Z]/g, '');
  if (letters.length >= 30 && upper.length / letters.length > 0.5) {
    flags.push({ type: 'shouting', label: 'ALL CAPS', text: 'Writing in ALL CAPS is a common attention-grabbing tactic.' });
  }
  if ((normalized.match(/!/g) || []).length >= 3) {
    flags.push({ type: 'exclamation', label: 'Excessive exclamation marks', text: 'Lots of exclamation marks signal hype rather than careful reporting.' });
  }

  if (checkSource && !SOURCE_HINTS.some((re) => re.test(normalized))) {
    flags.push({ type: 'no_source', label: 'Doesn’t say where this comes from', text: 'The text states this as fact without naming a study or organization behind it. Check the sources Infomedics found instead.' });
  }
  return flags;
}

// Wording-only flags that are safe to run on a sentence from a web page (no "no source" check).
export function findPageClaimFlags(text) {
  return findRedFlags(text, { checkSource: false });
}
