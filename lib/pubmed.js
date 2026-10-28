// PubMed (US National Library of Medicine) search via the free NCBI E-utilities.
// Finds systematic reviews, meta-analyses and randomized trials related to a claim.

import { getText } from './http.js';
import { decodeEntities, stripTags, squash, truncate } from './text.js';

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const EVIDENCE_FILTER = '(systematic[sb] OR meta-analysis[pt] OR "randomized controlled trial"[pt])';

// NCBI allows 3 requests/second without an API key (10 with one).
function createLimiter(intervalMs) {
  let chain = Promise.resolve();
  return (task) => {
    const run = chain.then(task, task);
    chain = run.then(() => new Promise((r) => setTimeout(r, intervalMs)), () => new Promise((r) => setTimeout(r, intervalMs)));
    return run;
  };
}
const limiter = createLimiter(process.env.NCBI_API_KEY ? 110 : 360);

function commonParams() {
  const p = new URLSearchParams({ tool: 'infomedics' });
  if (process.env.NCBI_EMAIL) p.set('email', process.env.NCBI_EMAIL);
  if (process.env.NCBI_API_KEY) p.set('api_key', process.env.NCBI_API_KEY);
  return p;
}

async function esearch(term, { retmax = 12, signal } = {}) {
  const params = commonParams();
  params.set('db', 'pubmed');
  params.set('retmode', 'json');
  params.set('retmax', String(retmax));
  params.set('sort', 'relevance');
  params.set('term', term);
  const text = await limiter(() => getText(`${BASE}/esearch.fcgi?${params}`, { signal }));
  let json;
  try { json = JSON.parse(text); } catch { return { count: 0, ids: [] }; }
  const result = json.esearchresult || {};
  return { count: Number(result.count) || 0, ids: Array.isArray(result.idlist) ? result.idlist : [] };
}

async function efetch(ids, { signal } = {}) {
  if (!ids.length) return [];
  const params = commonParams();
  params.set('db', 'pubmed');
  params.set('retmode', 'xml');
  params.set('rettype', 'abstract');
  params.set('id', ids.join(','));
  const xml = await limiter(() => getText(`${BASE}/efetch.fcgi?${params}`, { signal, timeoutMs: 20_000 }));
  return parseArticles(xml);
}

function textOf(fragment) {
  return squash(decodeEntities(stripTags(fragment)));
}

function designFromTypes(types) {
  const lower = types.map((t) => t.toLowerCase());
  if (lower.includes('meta-analysis')) return 'Meta-analysis';
  if (lower.includes('systematic review')) return 'Systematic review';
  if (lower.includes('randomized controlled trial')) return 'Randomized trial';
  if (lower.includes('review')) return 'Review';
  return 'Study';
}

// The part of an abstract a judge needs: aim, key methods, results, conclusion. Roughly half the tokens of the
// whole abstract, and the conclusion is what the authors actually claim.
function digestOf(sections) {
  const pick = (re, max) => {
    const s = sections.find((x) => re.test(x.label));
    return s ? `${s.label}: ${truncate(s.text, max)}` : null;
  };
  const parts = [pick(/objective|aim|purpose|background/i, 220), pick(/method|design|setting|participants|selection criteria/i, 160),
    pick(/result|finding|main outcome/i, 480), pick(/conclusion|interpretation|implication/i, 420)].filter(Boolean);
  if (parts.length >= 2) return parts.join(' ');
  const all = sections.map((s) => s.text).join(' ');
  return all.length <= 700 ? all : `${all.slice(0, 240)} … ${all.slice(-440)}`;
}

function conclusionOf(sections) {
  const labelled = sections.find((s) => /conclusion|interpretation|implication|authors' conclusions|summary/i.test(s.label));
  if (labelled && labelled.text) return truncate(labelled.text, 480);
  const all = sections.map((s) => s.text).join(' ').trim();
  if (!all) return '';
  const sentences = all.split(/(?<=[.!?])\s+/);
  return truncate(sentences.slice(-2).join(' '), 480);
}

const NEGATIVE_TONE = /\b(?:no (?:significant |clear |convincing |consistent |strong |good |high-quality )*(?:evidence|benefit|effect|difference|association|reduction|improvement)|not (?:effective|associated|significantly|supported|recommended|beneficial)|did not|does not|do not|failed? to|failure of|insufficient|inconclusive|(?:limited|little|weak|low[- ]quality|poor) evidence|lack of evidence|cannot be recommended|no role)\b/i;
const STRONG_POSITIVE = /\b(?:significantly (?:reduced|improved|lower|decreased|increased|shortened|better)|effective|beneficial|promising|supports? the use|associated with (?:a )?(?:lower|reduced|decreased|improved))\b/i;
const WEAK_POSITIVE = /\b(?:benefits?|improves?|improved|reduces?|reduced|shortened|useful)\b/i;

/**
 * Keyword guess at the direction of a conclusion. It only reads wording and knows nothing about the
 * claim, so it is shown as a hint, never as a verdict.
 * @returns {'benefit'|'no_benefit'|'mixed'|'unknown'}
 */
export function conclusionTone(text) {
  const negative = NEGATIVE_TONE.test(text);
  // "not effective" must not count as a positive hit.
  const rest = text.replace(new RegExp(NEGATIVE_TONE.source, 'gi'), ' ');
  if (negative) return STRONG_POSITIVE.test(rest) ? 'mixed' : 'no_benefit';
  if (STRONG_POSITIVE.test(rest) || WEAK_POSITIVE.test(rest)) return 'benefit';
  return 'unknown';
}

/** Parse PubMed efetch XML into plain article objects. Exported for tests. */
export function parseArticles(xml) {
  const articles = [];
  for (const block of String(xml).match(/<PubmedArticle\b[\s\S]*?<\/PubmedArticle>/g) || []) {
    const pmid = (/<PMID[^>]*>(\d+)<\/PMID>/.exec(block) || [])[1];
    if (!pmid) continue;

    const title = textOf((/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/.exec(block) || [])[1] || '');
    const journal = textOf((/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/.exec(block) || [])[1] || '');
    const yearMatch = /<(?:ArticleDate|PubDate)[^>]*>[\s\S]*?<Year>(\d{4})<\/Year>/.exec(block)
      || /<MedlineDate>(\d{4})/.exec(block);
    const year = yearMatch ? Number(yearMatch[1]) : null;

    const pubTypes = [...block.matchAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g)].map((m) => textOf(m[1]));
    // Never present retracted papers, preprints, or opinion pieces as evidence.
    if (pubTypes.some((t) => /^(?:retract|expression of concern|preprint|comment|editorial|letter|news|published erratum|erratum)/i.test(t) || /retract/i.test(t))) continue;
    // MEDLINE indexes only journals NLM selects after review; PMC deposit is another quality gate.
    const status = (/<MedlineCitation\b[^>]*\bStatus="([^"]+)"/.exec(block) || [])[1] || '';
    const indexed = status === 'MEDLINE' || /<ArticleId\b[^>]*IdType="pmc"/.test(block);

    const sections = [...block.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map((m) => ({
      label: (/Label="([^"]*)"/.exec(m[1]) || [])[1] || '',
      text: textOf(m[2])
    })).filter((s) => s.text);

    const abstract = sections.map((s) => (s.label ? `${s.label}: ${s.text}` : s.text)).join(' ');
    if (!abstract) continue; // nothing to quote or judge

    articles.push({
      id: 'pm' + pmid,
      kind: 'pubmed',
      pmid,
      title: title || '(untitled)',
      journal,
      year,
      pubTypes,
      indexed,
      design: designFromTypes(pubTypes),
      abstract,
      digest: digestOf(sections),
      conclusion: conclusionOf(sections),
      tone: conclusionTone(conclusionOf(sections)),
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
    });
  }
  return articles;
}

const DESIGN_SCORE = { 'Meta-analysis': 40, 'Systematic review': 40, 'Randomized trial': 25, Review: 12, Study: 4 };

// terms: the search terms; papers whose title mentions them rank higher than ones that only match in the abstract.
export function rankArticles(articles, order, terms = []) {
  return articles
    .map((a) => {
      const position = order.indexOf(a.pmid);
      const recency = a.year ? Math.max(0, Math.min(15, (a.year - 2005) * 0.75)) : 0;
      const relevance = position === -1 ? 0 : Math.max(0, 14 - position) * 1.5;
      const title = a.title.toLowerCase();
      const inTitle = terms.filter((t) => title.includes(t.toLowerCase())).length * 12;
      return { ...a, _score: (DESIGN_SCORE[a.design] || 0) + recency + relevance + inTitle + (a.indexed ? 0 : -20) };
    })
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...rest }) => rest);
}

/**
 * @param {{pubmedQuery: string, pubmedBroad: string, pubmedNarrow?: string}} search from buildSearch()
 * @returns {Promise<{articles: object[], total: number, query: string, filtered: boolean}>}
 */
export async function searchPubMed(search, { limit = 4, signal } = {}) {
  const attempts = [
    { term: `${search.pubmedQuery} AND ${EVIDENCE_FILTER}`, filtered: true, query: search.pubmedQuery },
    { term: `${search.pubmedBroad} AND ${EVIDENCE_FILTER}`, filtered: true, query: search.pubmedBroad },
    { term: `${search.pubmedNarrow} AND ${EVIDENCE_FILTER}`, filtered: true, query: search.pubmedNarrow },
    { term: `${search.pubmedBroad} AND hasabstract`, filtered: false, query: search.pubmedBroad }
  ].filter((a, i, all) => a.query && all.findIndex((b) => b.term === a.term) === i);

  for (const attempt of attempts) {
    const { count, ids } = await esearch(attempt.term, { signal });
    if (!ids.length) continue;
    const articles = await efetch(ids, { signal });
    if (!articles.length) continue;
    return { articles: rankArticles(articles, ids, search.terms || []).slice(0, limit), total: count, query: attempt.query, filtered: attempt.filtered };
  }
  return { articles: [], total: 0, query: search.pubmedQuery || search.pubmedBroad || '', filtered: true };
}
