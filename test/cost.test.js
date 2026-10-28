import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, dailyBudget, recordTokens, budgetExhausted, budgetStatus, resetBudget } from '../lib/usage.js';
import { createJudgeCache } from '../lib/judgecache.js';
import { aiEnabled, hasApiKey } from '../lib/judge.js';
import { parseArticles } from '../lib/pubmed.js';
import { runCheck } from '../lib/pipeline.js';

test('estimateCost prices Haiku 5.5 input, output and cache reads', () => {
  assert.equal(estimateCost('claude-haiku-5-5', { inputTokens: 1_000_000 }), 0.1);
  assert.equal(estimateCost('claude-haiku-5-5', { outputTokens: 1_000_000 }), 0.5);
  assert.ok(Math.abs(estimateCost('claude-haiku-5-5', { cacheReadTokens: 1_000_000 }) - 0.01) < 1e-9);
  assert.equal(estimateCost('some-other-model', { inputTokens: 5 }), null);
});

test('the daily token budget pauses AI verdicts until the next day', () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, budget: process.env.INFOMEDICS_DAILY_TOKEN_BUDGET };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.INFOMEDICS_DAILY_TOKEN_BUDGET = '1000';
  try {
    resetBudget();
    assert.equal(aiEnabled(), true);
    recordTokens(999);
    assert.equal(budgetExhausted(), false);
    recordTokens(5);
    assert.equal(budgetExhausted(), true);
    assert.equal(aiEnabled(), false);
    assert.equal(hasApiKey(), true);
    assert.equal(budgetStatus().used, 1004);
    process.env.INFOMEDICS_DAILY_TOKEN_BUDGET = '0'; // 0 = no limit
    assert.equal(aiEnabled(), true);
    delete process.env.INFOMEDICS_DAILY_TOKEN_BUDGET;
    assert.equal(dailyBudget(), 2_000_000);
  } finally {
    resetBudget();
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.budget === undefined) delete process.env.INFOMEDICS_DAILY_TOKEN_BUDGET; else process.env.INFOMEDICS_DAILY_TOKEN_BUDGET = saved.budget;
  }
});

test('the judge cache keys on claim and evidence, expires, and evicts the oldest', () => {
  const cache = createJudgeCache({ max: 2, ttlMs: 50 });
  const base = { model: 'm', effort: 'low', claim: 'Vitamin C cures colds', evidence: [{ id: 'pm2' }, { id: 'pm1' }], triage: {}, redFlags: [] };
  assert.equal(cache.key(base), cache.key({ ...base, claim: '  vitamin c   CURES colds ', evidence: [{ id: 'pm1' }, { id: 'pm2' }] }));
  assert.notEqual(cache.key(base), cache.key({ ...base, evidence: [{ id: 'pm1' }] }));
  assert.notEqual(cache.key(base), cache.key({ ...base, effort: 'high' }));
  cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('c'), 3);
  return new Promise((resolve) => setTimeout(() => { assert.equal(cache.get('c'), null); resolve(); }, 80));
});

test('the abstract digest keeps results and conclusions and is shorter than the abstract', () => {
  const sec = (label, text) => `<AbstractText Label="${label}">${text}</AbstractText>`;
  const xml = `<PubmedArticle><MedlineCitation Status="MEDLINE"><PMID>9</PMID><Article><Journal><Title>J</Title></Journal><ArticleTitle>T</ArticleTitle><Abstract>
    ${sec('BACKGROUND', 'Colds are common. '.repeat(40))}${sec('METHODS', 'We searched many databases. '.repeat(40))}
    ${sec('RESULTS', 'Supplements did not reduce incidence in 29 trials. '.repeat(30))}${sec('CONCLUSIONS', 'Routine supplementation is not justified.')}
    </Abstract></Article></MedlineCitation></PubmedArticle>`;
  const [a] = parseArticles(xml);
  assert.ok(a.digest.length < a.abstract.length / 2, `${a.digest.length} vs ${a.abstract.length}`);
  assert.match(a.digest, /RESULTS: Supplements did not reduce/);
  assert.match(a.digest, /CONCLUSIONS: Routine supplementation is not justified\./);
});

const PAPER = { id: 'pm1', kind: 'pubmed', pmid: '1', title: 'Vitamin C and colds', journal: 'J', year: 2020, design: 'Meta-analysis', abstract: 'a', conclusion: 'c', tone: 'unknown', url: 'https://pubmed.ncbi.nlm.nih.gov/1/' };
const mkDeps = (judge) => ({ aiEnabled: () => true, searchPubMed: async (s) => ({ articles: [PAPER], total: 1, query: s.pubmedQuery }), searchMedlinePlus: async () => [], searchNhs: async () => [], planSearches: async (c) => ({ plans: c.map(() => null), usage: null }), judgeClaim: judge });

test('emergency wording is answered without an AI call', async () => {
  let calls = 0;
  const r = await runCheck('I think I am having a heart attack and my chest pain is severe', { deps: mkDeps(async () => { calls++; throw new Error('should not be called'); }) });
  assert.equal(calls, 0);
  assert.equal(r.claims[0].verdict, 'doctor');
  assert.equal(r.claims[0].emergency, true);
  assert.equal(r.mode, 'evidence');
  assert.equal(r.aiOn, true);
});

test('token usage and estimated cost are totalled per check, and cached answers are counted separately', async () => {
  let n = 0;
  const judge = async () => {
    n++;
    return { verdict: 'unsupported', explanation: 'Reviews found no benefit for preventing colds [1].', citations: ['pm1'], confidence: { level: 'High', note: 'ok' }, redFlags: [], evidenceNotes: [],
      usage: n === 1 ? { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, cached: false } : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cached: true } };
  };
  const first = await runCheck('Vitamin C cures the common cold', { deps: mkDeps(judge) });
  assert.equal(first.usage.calls, 1);
  assert.equal(first.usage.inputTokens, 2000);
  assert.ok(Math.abs(first.usage.estCostUsd - (2000 * 0.1 + 300 * 0.5) / 1e6) < 1e-12);
  const second = await runCheck('Vitamin C cures the common cold', { deps: mkDeps(judge) });
  assert.equal(second.usage.cachedCalls, 1);
  assert.equal(second.usage.calls, 0);
});
