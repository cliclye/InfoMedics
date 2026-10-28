// The check pipeline: read -> find claims -> gather evidence -> weigh it -> assemble a result.
// Network pieces are injectable (`deps`) so the whole flow can be tested offline.

import { randomUUID } from 'node:crypto';
import { fetchPage as defaultFetchPage, FetchError } from './http.js';
import { extractPage } from './html.js';
import { assessPage } from './page.js';
import { extractClaims, buildSearch, searchFromPlan, triage as triageText } from './claims.js';
import { findRedFlags } from './redflags.js';
import { searchPubMed as defaultSearchPubMed } from './pubmed.js';
import { searchMedlinePlus as defaultSearchMedline } from './medline.js';
import { searchNhs as defaultSearchNhs } from './nhs.js';
import { credibilityOf, SOURCE_NAMES } from './credibility.js';
import { sharedJudgeCache } from './judgecache.js';
import { estimateCost } from './usage.js';
import { judgeClaim as defaultJudge, aiEnabled as defaultAiEnabled, modelName, JudgeError } from './judge.js';
import { planSearches as defaultPlanSearches, plannerModel } from './planner.js';
import { searchLinks } from './sources.js';
import { truncate, titleMatchesTerms } from './text.js';

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
  searchNhs: defaultSearchNhs,
  judgeClaim: (args, options) => defaultJudge(args, { ...options, cache: sharedJudgeCache }),
  planSearches: defaultPlanSearches,
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
    return 'We found a health-agency page that may be related, but no matching research papers. No AI model is connected, so Infomedics does not give a verdict. That does not mean the claim is false; read the sources below or ask a clinician.';
  }
  return `We could not find research or health-topic pages matching "${truncate(search.terms.join(', ') || 'this claim', 80)}". That does not mean the claim is false, only that we could not check it here. Try rewording it as a simple statement, or ask a clinician.`;
}

// MedlinePlus search is fuzzy; keep only topics whose title matches the claim's search terms.
export function topicIsRelevant(topic, terms) {
  return titleMatchesTerms(topic.title, terms);
}

function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...[a[i], b[i]].filter(Boolean));
  return out;
}

// MedlinePlus ids are numbered per search; searching two topics needs them renumbered.
function mergeTopics(lists, limit) {
  const out = [];
  for (const t of lists.flat()) {
    if (out.length >= limit || out.some((x) => x.url === t.url)) continue;
    out.push({ ...t, id: 'mp' + (out.length + 1) });
  }
  return out;
}

async function gatherEvidence(claim, plan, deps, signal) {
  const search = plan ? searchFromPlan(plan) : buildSearch(claim.text);
  const warnings = [];
  const topicQueries = plan ? search.topics : [search.topicQuery];
  const none = Promise.resolve([]);
  const [pm, mp, nhs] = await Promise.allSettled([
    search.terms.length ? deps.searchPubMed(search, { signal }) : Promise.resolve({ articles: [], total: 0, query: '', log: [] }),
    search.terms.length ? Promise.all(topicQueries.map((q) => deps.searchMedlinePlus(q, { signal }))) : none,
    search.terms.length && deps.searchNhs ? deps.searchNhs(topicQueries, { terms: search.terms, signal }) : none
  ]);
  let articles = [];
  let total = 0;
  let screened = 0;
  let topics = [];
  const log = [];
  if (pm.status === 'fulfilled') { articles = pm.value.articles; total = pm.value.total; screened = pm.value.screened || articles.length; log.push(...(pm.value.log || [])); }
  else warnings.push('PubMed could not be reached, so research papers are missing from this check.');
  if (mp.status === 'fulfilled') {
    topics = mergeTopics(mp.value.map((list) => list.filter((t) => topicIsRelevant(t, search.terms))), 2);
    if (topicQueries.length) log.push({ source: 'MedlinePlus', query: topicQueries.join('; '), hits: mp.value.flat().length, kept: topics.length });
  } else warnings.push('MedlinePlus could not be reached, so health-topic summaries are missing.');
  let nhsPages = [];
  if (nhs.status === 'fulfilled') {
    nhsPages = nhs.value;
    if (topicQueries.length) log.push({ source: 'NHS website', query: topicQueries.join('; '), hits: null, kept: nhsPages.length, read: nhsPages.length });
  } else warnings.push('The NHS website could not be searched, so its pages are missing from this check.');
  return {
    search,
    planned: Boolean(plan),
    // At most 3 health-agency pages, alternating sources: more pages mostly repeat each other and cost tokens.
    evidence: [...interleave(topics, nhsPages).slice(0, 3), ...articles],
    screened,
    pubmedTotal: total,
    pubmedQuery: pm.status === 'fulfilled' ? pm.value.query : search.pubmedQuery,
    log,
    warnings
  };
}

// One line of the live search log: what was searched, where, and what came back.
export function describeSearch(e) {
  if (e.source === 'PubMed') return `PubMed (${e.scope}): ${e.query} → ${Number(e.hits || 0).toLocaleString('en-US')} found, ${e.kept} on topic kept`;
  if (e.source === 'NHS website') return `NHS website: "${e.query}" → ${e.read} page${e.read === 1 ? '' : 's'} read`;
  return `${e.source}: "${e.query}" → ${e.kept} matching topic${e.kept === 1 ? '' : 's'}`;
}

async function weighClaim({ claim, gathered, page, ai, state, deps, signal }) {
  const { search, evidence, warnings } = gathered;
  const triage = triageText(claim.text);
  const ruleFlags = findRedFlags(claim.text, { checkSource: !page });
  const grounded = evidence.length > 0;

  let judgement = null;
  // Emergency wording goes straight to "call emergency services"; no model call is needed to say that.
  if (ai && !state.aiFailed && !triage.emergency) {
    try {
      judgement = await deps.judgeClaim({ claim: claim.text, evidence, redFlags: ruleFlags, triage, page }, { signal });
    } catch (err) {
      if (!(err instanceof JudgeError)) throw err;
      warnings.push(`AI analysis was unavailable for this claim: ${err.message}`);
      if (err.code === 'auth') state.aiFailed = true;
    }
  }

  const offTopic = new Set((judgement ? judgement.evidenceNotes : []).filter((n) => n.stance === 'unrelated').map((n) => n.id));
  const references = {
    topics: evidence.filter((e) => (e.kind === 'medlineplus' || e.kind === 'nhs') && !offTopic.has(e.id)).map((e) => ({ title: e.title, url: e.url, organization: e.organization, source: e.kind === 'nhs' ? 'NHS' : 'MedlinePlus' })),
    search: searchLinks(search.topicQuery || claim.text.slice(0, 80))
  };

  const notes = new Map((judgement ? judgement.evidenceNotes : []).map((n) => [n.id, n]));
  const citedIds = judgement && Array.isArray(judgement.citations) ? judgement.citations : [];
  const evidenceOut = evidence.map((e) => {
    const n = notes.get(e.id);
    const cited = citedIds.indexOf(e.id) + 1; // 0 = not cited
    const common = { id: e.id, url: e.url, via: SOURCE_NAMES[e.kind], credibility: credibilityOf(e), ...(cited ? { cited } : {}) };
    let base;
    if (e.kind === 'pubmed') base = { ...common, kind: 'pubmed', title: e.title, source: e.journal || 'PubMed', year: e.year, design: e.design, conclusion: e.conclusion, tone: e.tone };
    else if (e.kind === 'nhs') base = { ...common, kind: 'nhs', title: e.title, source: 'NHS', summary: truncate(e.summary, 320), reviewed: e.reviewed };
    else base = { ...common, kind: 'medlineplus', title: e.title, source: 'MedlinePlus', summary: truncate(e.summary, 320) };
    return n ? { ...base, stance: n.stance, note: n.note } : base;
  });

  const base = {
    claim: claim.text,
    emergency: triage.emergency,
    redFlags: ruleFlags.map((f) => ({ type: f.type, label: f.label, text: f.text })),
    evidence: evidenceOut,
    ...(judgement && judgement.usage ? { usage: judgement.usage } : {}),
    evidenceSummary: { pubmedTotal: gathered.pubmedTotal, shown: evidence.filter((e) => e.kind === 'pubmed').length, query: gathered.pubmedQuery },
    citedCount: citedIds.length,
    searchPlan: gathered.planned ? { concepts: search.concepts, topics: search.topics } : null,
    searches: gathered.log,
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
  if (ai) plan.push({ id: 'plan', label: 'Working out what to search for' });
  plan.push({ id: 'evidence', label: 'Searching PubMed, MedlinePlus and the NHS website' });
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

  // With AI on, one small call turns every claim into the terms researchers use; without it (or if it
  // fails) the claim's own keywords are searched.
  let plans = claims.map(() => null);
  let planUsage = null;
  if (ai && deps.planSearches) {
    step('plan', 'active');
    ({ plans, usage: planUsage } = await deps.planSearches(claims.map((c) => c.text), { signal }));
    checkAbort();
    const shown = plans.filter(Boolean).map((p) => p.concepts.map((g) => g[0]).join(' + '));
    step('plan', 'done', shown.length ? truncate(shown.join(' · '), 160) : 'Using the claim’s own words');
  }

  step('evidence', 'active');
  const gathered = await Promise.all(claims.map(async (c, i) => {
    const g = await gatherEvidence(c, plans[i], deps, signal);
    for (const entry of g.log) emit({ type: 'log', step: 'evidence', text: describeSearch(entry) });
    return g;
  }));
  checkAbort();
  const total = gathered.reduce((n, g) => n + g.evidence.length, 0);
  const screened = gathered.reduce((n, g) => n + g.screened, 0);
  step('evidence', 'done', `${total} source${total === 1 ? '' : 's'} kept${screened ? ` after reading ${screened} paper${screened === 1 ? '' : 's'}` : ''}`);

  step('judge', 'active');
  const pageContext = page ? { title: page.title, host: page.host } : null;
  const results = await Promise.all(claims.map((claim, i) =>
    weighClaim({ claim, gathered: gathered[i], page: pageContext, ai, state, deps, signal })));
  checkAbort();
  const rated = results.some((r) => r.rated);
  step('judge', 'done', rated ? 'AI verdicts ready' : 'No AI model: evidence only');

  // What the AI part of this check cost (cached answers cost nothing).
  const usage = { calls: 0, cachedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const add = (u) => { for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) usage[k] += u[k] || 0; };
  for (const r of results) {
    if (!r.usage) continue;
    if (r.usage.cached) usage.cachedCalls++; else usage.calls++;
    add(r.usage);
  }
  const judgeCost = estimateCost(modelName(), usage);
  const planCost = planUsage ? estimateCost(plannerModel(), planUsage) : 0;
  if (planUsage) { usage.calls++; add(planUsage); }
  usage.estCostUsd = judgeCost === null || planCost === null ? null : judgeCost + planCost;

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
    aiOn: ai,
    usage: usage.calls + usage.cachedCalls ? usage : null,
    elapsedMs: Date.now() - started
  };
}
