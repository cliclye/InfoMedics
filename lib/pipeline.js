// The check pipeline: read -> find claims -> gather evidence -> weigh it -> assemble a result.
// Network pieces are injectable (`deps`) so the whole flow can be tested offline.

import { randomUUID } from 'node:crypto';
import { fetchPage as defaultFetchPage, FetchError } from './http.js';
import { extractPage } from './html.js';
import { assessPage } from './page.js';
import { extractClaims, buildSearch, triage as triageText } from './claims.js';
import { findRedFlags } from './redflags.js';
import { searchPubMed as defaultSearchPubMed } from './pubmed.js';
import { searchMedlinePlus as defaultSearchMedline } from './medline.js';
import { judgeClaim as defaultJudge, aiEnabled as defaultAiEnabled, modelName, JudgeError } from './judge.js';
import { searchLinks } from './sources.js';
import { truncate } from './text.js';

export const MAX_INPUT_CHARS = 8000;

export class UserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UserError';
    this.code = code;
  }
}

const SEVERITY = ['unsupported', 'doctor', 'mixed', 'unclear', 'supported'];

const defaultDeps = {
  fetchPage: defaultFetchPage,
  searchPubMed: defaultSearchPubMed,
  searchMedlinePlus: defaultSearchMedline,
  judgeClaim: defaultJudge,
  aiEnabled: defaultAiEnabled
};

function evidenceOnlyExplanation({ evidence, triage, search }) {
  const articles = evidence.filter((e) => e.kind === 'pubmed');
  const strong = articles.filter((e) => e.design === 'Meta-analysis' || e.design === 'Systematic review').length;
  if (triage.personal) {
    const lead = triage.emergency ? 'If this might be an emergency, contact your local emergency number now. ' : '';
    return `${lead}This claim ${triage.reasons.filter((r) => !/emergency/.test(r)).join(' and ') || 'involves a personal medical decision'}. The right answer depends on the person, including their health history and other medicines, so a website cannot decide for you. Ask a doctor, pharmacist, or midwife. The research below is general background, not advice for your situation.`;
  }
  if (articles.length) {
    const count = (t) => articles.filter((a) => a.tone === t).length;
    const [noB, ben, mix] = [count('no_benefit'), count('benefit'), count('mixed')];
    const tone = noB + ben + mix >= 2
      ? `Going only by the wording of their conclusions: ${noB} suggest no or limited effect, ${ben} suggest a benefit, ${mix} are mixed. That is a keyword count, not a verdict. `
      : '';
    return `We found ${articles.length} research paper${articles.length === 1 ? '' : 's'} on PubMed that may relate to this claim${strong ? `, including ${strong} systematic review${strong === 1 ? '' : 's'} or meta-analys${strong === 1 ? 'is' : 'es'}` : ''}. No AI model is connected, so Infomedics has not weighed them against the claim and does not give a verdict. ${tone}Read the conclusions below, or add an Anthropic API key to get a rating.`;
  }
  if (evidence.length) {
    return 'We found a plain-language health topic that may be related, but no matching research papers. No AI model is connected, so Infomedics does not give a verdict. That does not mean the claim is false; read the sources below or ask a clinician.';
  }
  return `We could not find research or health-topic pages matching "${truncate(search.terms.join(', ') || 'this claim', 80)}". That does not mean the claim is false, only that we could not check it here. Try rewording it as a simple statement, or ask a clinician.`;
}

// MedlinePlus search is fuzzy; keep only topics whose title shares a word with our search terms.
export function topicIsRelevant(topic, terms) {
  const title = topic.title.toLowerCase();
  return terms.some((term) => term.toLowerCase().split(/\s+/).some((w) => w.length >= 4 && title.includes(w.replace(/s$/, ''))));
}

async function gatherEvidence(claim, deps, signal) {
  const search = buildSearch(claim.text);
  const warnings = [];
  const [pm, mp] = await Promise.allSettled([
    search.terms.length ? deps.searchPubMed(search, { signal }) : Promise.resolve({ articles: [], total: 0, query: '' }),
    search.terms.length ? deps.searchMedlinePlus(search.topicQuery, { signal }) : Promise.resolve([])
  ]);
  let articles = [];
  let total = 0;
  let topics = [];
  if (pm.status === 'fulfilled') { articles = pm.value.articles; total = pm.value.total; }
  else warnings.push('PubMed could not be reached, so research papers are missing from this check.');
  if (mp.status === 'fulfilled') topics = mp.value.filter((t) => topicIsRelevant(t, search.terms));
  else warnings.push('MedlinePlus could not be reached, so health-topic summaries are missing.');
  return {
    search,
    evidence: [...topics, ...articles],
    pubmedTotal: total,
    pubmedQuery: pm.status === 'fulfilled' ? pm.value.query : search.pubmedQuery,
    warnings
  };
}

async function weighClaim({ claim, gathered, page, ai, state, deps, signal }) {
  const { search, evidence, warnings } = gathered;
  const triage = triageText(claim.text);
  const ruleFlags = findRedFlags(claim.text, { checkSource: !page });
  const grounded = evidence.length > 0;

  let judgement = null;
  if (ai && !state.aiFailed) {
    try {
      judgement = await deps.judgeClaim({ claim: claim.text, evidence, redFlags: ruleFlags, triage, page }, { signal });
    } catch (err) {
      if (!(err instanceof JudgeError)) throw err;
      warnings.push(`AI analysis was unavailable for this claim: ${err.message}`);
      if (err.code === 'auth') state.aiFailed = true;
    }
  }

  const references = {
    topics: evidence.filter((e) => e.kind === 'medlineplus').map((e) => ({ title: e.title, url: e.url, organization: e.organization })),
    search: searchLinks(search.topicQuery || claim.text.slice(0, 80))
  };

  const notes = new Map((judgement ? judgement.evidenceNotes : []).map((n) => [n.id, n]));
  const evidenceOut = evidence.map((e) => {
    const n = notes.get(e.id);
    const base = e.kind === 'pubmed'
      ? { id: e.id, kind: 'pubmed', title: e.title, source: e.journal || 'PubMed', year: e.year, design: e.design, url: e.url, conclusion: e.conclusion, tone: e.tone }
      : { id: e.id, kind: 'medlineplus', title: e.title, source: 'MedlinePlus', url: e.url, summary: truncate(e.summary, 320) };
    return n ? { ...base, stance: n.stance, note: n.note } : base;
  });

  const base = {
    claim: claim.text,
    emergency: triage.emergency,
    redFlags: ruleFlags.map((f) => ({ type: f.type, label: f.label, text: f.text })),
    evidence: evidenceOut,
    evidenceSummary: { pubmedTotal: gathered.pubmedTotal, shown: evidence.filter((e) => e.kind === 'pubmed').length, query: gathered.pubmedQuery },
    references,
    warnings
  };

  if (judgement) {
    let verdict = judgement.verdict;
    if (triage.emergency) verdict = 'doctor';
    else if (triage.personal && ['supported', 'mixed', 'unclear'].includes(verdict)) verdict = 'doctor';
    let confidence = judgement.confidence;
    if (!grounded) {
      confidence = { level: 'Low', note: 'No sources could be retrieved, so this relies on the AI’s background knowledge. Treat it with extra caution.' };
    }
    const lead = triage.emergency ? 'If this might be an emergency, contact your local emergency number now. ' : '';
    return {
      ...base,
      rated: true,
      grounded,
      verdict,
      explanation: lead + judgement.explanation,
      confidence,
      redFlags: [...base.redFlags, ...judgement.redFlags.map((text) => ({ type: 'ai', label: 'Flagged by AI', text }))]
    };
  }

  const verdict = triage.personal ? 'doctor' : 'unclear';
  return {
    ...base,
    rated: false,
    grounded,
    verdict,
    explanation: evidenceOnlyExplanation({ evidence, triage, search }),
    confidence: triage.personal
      ? { level: 'Medium', note: 'Based on wording that suggests a personal medical decision, not on the evidence.' }
      : { level: 'Low', note: ai ? 'AI analysis failed, so this claim was not rated.' : 'No AI model is connected, so this claim was not rated.' }
  };
}

/**
 * @param {string} input   a claim, an AI answer, or a link to a web page
 * @param {{emit?: Function, signal?: AbortSignal, deps?: object}} options
 */
export async function runCheck(input, { emit = () => {}, signal, deps: depOverrides } = {}) {
  const deps = { ...defaultDeps, ...depOverrides };
  const started = Date.now();
  // NFKC folds full-width and compatibility characters ("ＶＩＴ" -> "VIT") so they match; control characters are noise.
  let raw = String(input ?? '').normalize('NFKC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim();
  if (!raw) throw new UserError('empty', 'Please paste a health claim, an AI answer, or a link first.');
  if (raw.length > MAX_INPUT_CHARS) throw new UserError('too_long', `That is too long. Please keep it under ${MAX_INPUT_CHARS.toLocaleString('en-US')} characters.`);

  // A bare web address ("www.nhs.uk/conditions/flu") is a link, not a claim.
  if (/^(?:www\.[^\s/]+\.[a-z]{2,}|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|gov|edu|uk|io|info|health|co|us|ca|au))(?:\/\S*)?$/i.test(raw)) raw = 'https://' + raw;
  if (/^[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(raw) && !/^https?:\/\/\S+$/i.test(raw)) {
    throw new UserError('invalid_link', 'That does not look like a link we can open. Use a full web address that starts with http:// or https://.');
  }
  const isUrl = /^https?:\/\/\S+$/i.test(raw);
  const ai = deps.aiEnabled();
  const state = { aiFailed: false };

  const plan = [];
  if (isUrl) plan.push({ id: 'read', label: 'Reading the page' });
  plan.push({ id: 'claims', label: 'Finding the health claims' });
  plan.push({ id: 'evidence', label: 'Searching PubMed and MedlinePlus' });
  plan.push({ id: 'judge', label: ai ? 'Weighing the evidence' : 'Preparing evidence summary' });
  emit({ type: 'plan', steps: plan });
  const step = (id, status, detail) => emit({ type: 'step', id, status, detail });
  const checkAbort = () => { if (signal && signal.aborted) throw new UserError('cancelled', 'Cancelled.'); };

  let text = raw;
  let page = null;
  if (isUrl) {
    step('read', 'active');
    let fetched;
    try {
      fetched = await deps.fetchPage(raw, { signal });
    } catch (err) {
      if (err instanceof FetchError) throw new UserError('fetch_' + err.code, err.message);
      throw err;
    }
    const extracted = extractPage(fetched.html, fetched.finalUrl);
    if (extracted.wordCount < 40) {
      throw new UserError('thin_page', 'We could not find enough readable text on that page. It may need JavaScript or a login. Paste the text instead.');
    }
    page = assessPage({ url: raw, finalUrl: fetched.finalUrl, extracted });
    text = extracted.text;
    step('read', 'done', `${page.host} · ${extracted.wordCount.toLocaleString('en-US')} words`);
  }
  checkAbort();

  step('claims', 'active');
  // Text with nothing searchable in it ("hi", "???", non-English) is not a claim we can check.
  const claims = extractClaims(text, { max: 3, forceExtract: isUrl }).filter((c) => buildSearch(c.text).terms.length);
  if (!claims.length) {
    throw new UserError('no_claims', isUrl
      ? 'We read the page but did not find specific health claims to check. Try pasting the sentence you want checked.'
      : 'We could not find a health claim in that text. Try writing it as a simple statement, like “Vitamin C cures the common cold”. English only for now.');
  }
  step('claims', 'done', claims.length === 1 ? '1 claim' : `${claims.length} claims`);

  step('evidence', 'active');
  const gathered = await Promise.all(claims.map((c) => gatherEvidence(c, deps, signal)));
  checkAbort();
  const total = gathered.reduce((n, g) => n + g.evidence.length, 0);
  step('evidence', 'done', `${total} source${total === 1 ? '' : 's'} found`);

  step('judge', 'active');
  const pageContext = page ? { title: page.title, host: page.host } : null;
  const results = await Promise.all(claims.map((claim, i) =>
    weighClaim({ claim, gathered: gathered[i], page: pageContext, ai, state, deps, signal })));
  checkAbort();
  const rated = results.some((r) => r.rated);
  step('judge', 'done', rated ? 'AI verdicts ready' : 'No AI model: evidence only');

  const overall = SEVERITY.find((v) => results.some((r) => r.verdict === v)) || 'unclear';
  return {
    id: randomUUID(),
    ts: Date.now(),
    kind: isUrl ? 'page' : 'text',
    input: isUrl ? { url: raw } : { text: truncate(raw, 600) },
    page,
    claims: results,
    overall,
    mode: rated ? 'ai' : 'evidence',
    model: rated ? modelName() : null,
    elapsedMs: Date.now() - started
  };
}
