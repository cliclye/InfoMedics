import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, UserError, topicIsRelevant } from '../lib/pipeline.js';
import { FetchError } from '../lib/http.js';
import { JudgeError } from '../lib/judge.js';

const ARTICLE = (id, design = 'Meta-analysis', tone = 'no_benefit') => ({
  id, kind: 'pubmed', pmid: id.slice(2), title: 'Vitamin C and colds ' + id, journal: 'J', year: 2020, design,
  abstract: 'abs', conclusion: 'No benefit found.', tone, url: 'https://pubmed.ncbi.nlm.nih.gov/' + id.slice(2) + '/'
});
const TOPIC = { id: 'mp1', kind: 'medlineplus', title: 'Common Cold', url: 'https://medlineplus.gov/commoncold.html', organization: 'NLM', summary: 'A mild infection.' };

function deps(overrides = {}) {
  const calls = { judge: [], pubmed: [], medline: [] };
  return {
    calls,
    deps: {
      aiEnabled: () => true,
      searchPubMed: async (s) => { calls.pubmed.push(s); return { articles: [ARTICLE('pm1'), ARTICLE('pm2')], total: 18, query: s.pubmedQuery, filtered: true }; },
      searchMedlinePlus: async (q) => { calls.medline.push(q); return [TOPIC]; },
      searchNhs: async () => [],
      // No plan by default, so the claim's own keywords are searched; the planner has its own tests.
      planSearches: async (claims) => ({ plans: claims.map(() => null), usage: null }),
      judgeClaim: async (args) => {
        calls.judge.push(args);
        return { verdict: 'unsupported', explanation: 'Reviews found no benefit for preventing colds.', confidence: { level: 'High', note: 'Reviews agree.' }, redFlags: ['Overclaims.'], evidenceNotes: [{ id: 'pm1', stance: 'contradicts', note: 'No effect.' }], model: 'claude-opus-5-5' };
      },
      ...overrides
    }
  };
}
const collect = () => { const events = []; return { events, emit: (e) => events.push(e) }; };

test('AI mode: rated result with evidence, notes, merged red flags, steps, and references', async () => {
  const { deps: d, calls } = deps();
  const { events, emit } = collect();
  const r = await runCheck('Vitamin C cures the common cold', { deps: d, emit });

  assert.equal(r.mode, 'ai');
  assert.equal(r.kind, 'text');
  assert.equal(r.claims.length, 1);
  const c = r.claims[0];
  assert.equal(c.verdict, 'unsupported');
  assert.equal(c.rated, true);
  assert.equal(c.grounded, true);
  assert.equal(c.confidence.level, 'High');
  assert.ok(c.redFlags.some((f) => f.type === 'miracle'));
  assert.ok(c.redFlags.some((f) => f.type === 'ai' && f.text === 'Overclaims.'));
  assert.equal(c.evidence.find((e) => e.id === 'pm1').stance, 'contradicts');
  assert.equal(c.evidence.find((e) => e.id === 'pm2').stance, undefined);
  assert.equal(c.references.topics[0].url, 'https://medlineplus.gov/commoncold.html');
  assert.equal(c.references.search.length, 4);
  assert.deepEqual(calls.pubmed[0].terms, ['vitamin c', 'common cold']);
  assert.equal(calls.judge[0].evidence.length, 3);

  const plan = events.find((e) => e.type === 'plan');
  assert.deepEqual(plan.steps.map((s) => s.id), ['claims', 'plan', 'evidence', 'judge']);
  assert.ok(events.some((e) => e.type === 'step' && e.id === 'judge' && e.status === 'done'));
});

test('evidence-only mode never rates a claim and says so', async () => {
  const { deps: d, calls } = deps({ aiEnabled: () => false });
  const r = await runCheck('Vitamin C cures the common cold', { deps: d });
  assert.equal(r.mode, 'evidence');
  assert.equal(r.model, null);
  assert.equal(r.claims[0].verdict, 'unclear');
  assert.equal(r.claims[0].rated, false);
  assert.equal(calls.judge.length, 0);
  assert.match(r.claims[0].explanation, /No AI model is connected/);
  assert.match(r.claims[0].explanation, /keyword count, not a verdict/);
  assert.equal(r.claims[0].evidence.find((e) => e.id === 'pm1').tone, 'no_benefit');
});

test('personal medical questions are forced to "Needs a doctor" even if the AI says supported', async () => {
  const { deps: d } = deps({
    judgeClaim: async () => ({ verdict: 'supported', explanation: 'Ibuprofen is fine for many people in general.', confidence: { level: 'High', note: 'x' }, redFlags: [], evidenceNotes: [], model: 'm' })
  });
  const r = await runCheck('Is it safe to take ibuprofen while pregnant?', { deps: d });
  assert.equal(r.claims[0].verdict, 'doctor');
});

test('emergencies force "Needs a doctor" and add emergency guidance', async () => {
  const { deps: d } = deps();
  const r = await runCheck('I have chest pain and my arm is numb, will aspirin fix it?', { deps: d });
  assert.equal(r.claims[0].verdict, 'doctor');
  assert.equal(r.claims[0].emergency, true);
  assert.match(r.claims[0].explanation, /emergency number/);
  const evidenceOnly = await runCheck('I have chest pain and my arm is numb, will aspirin fix it?', { deps: { ...d, aiEnabled: () => false } });
  assert.match(evidenceOnly.claims[0].explanation, /emergency number/);
});

test('without any retrieved evidence, AI confidence is capped at Low and flagged ungrounded', async () => {
  const { deps: d } = deps({ searchPubMed: async () => ({ articles: [], total: 0, query: '' }), searchMedlinePlus: async () => [] });
  const r = await runCheck('Vitamin C cures the common cold', { deps: d });
  assert.equal(r.claims[0].grounded, false);
  assert.equal(r.claims[0].confidence.level, 'Low');
  assert.match(r.claims[0].confidence.note, /background knowledge/);
});

test('a failing source degrades gracefully with a warning', async () => {
  const { deps: d } = deps({ searchPubMed: async () => { throw new FetchError('network', 'down'); } });
  const r = await runCheck('Vitamin C cures the common cold', { deps: d });
  assert.ok(r.claims[0].warnings.some((w) => /PubMed could not be reached/.test(w)));
  assert.equal(r.claims[0].evidence.length, 1);
});

test('AI failure falls back to evidence-only for that claim, and stops retrying after an auth error', async () => {
  let calls = 0;
  const { deps: d } = deps({ judgeClaim: async () => { calls++; throw new JudgeError('auth', 'The Anthropic API key was rejected.'); } });
  const text = 'Garlic boosts your immune system and prevents colds in everyone who eats it. Apple cider vinegar melts belly fat and cures diabetes every morning. Honey cures coughs better than any medicine ever made.';
  const r = await runCheck(text, { deps: d });
  assert.equal(r.mode, 'evidence');
  assert.ok(r.claims.length >= 2);
  assert.ok(r.claims.every((c) => c.rated === false));
  assert.ok(r.claims[0].warnings.some((w) => /AI analysis was unavailable/.test(w)));
  assert.ok(calls >= 1);
});

test('a link is fetched, assessed, and its claims are checked', async () => {
  const html = `<html><head><title>Cider vinegar</title><meta name="author" content="A. Writer"></head><body><article>
    <p>Apple cider vinegar melts belly fat and cures diabetes, guaranteed. ${'This is more wellness text about vinegar and diet. '.repeat(20)}</p>
    <p>Garlic boosts your immune system and prevents colds in everyone. </p></article></body></html>`;
  const { deps: d } = deps({ fetchPage: async (url) => ({ finalUrl: url, html, contentType: 'text/html', truncated: false }) });
  const { events, emit } = collect();
  const r = await runCheck('https://blog.example.com/vinegar', { deps: d, emit });
  assert.equal(r.kind, 'page');
  assert.equal(r.page.host, 'blog.example.com');
  assert.equal(r.page.author, 'A. Writer');
  assert.ok(r.claims.length >= 1);
  assert.deepEqual(events.find((e) => e.type === 'plan').steps.map((s) => s.id), ['read', 'claims', 'plan', 'evidence', 'judge']);
  // Page claims are not flagged for "no source" (the page is assessed separately).
  assert.ok(!r.claims[0].redFlags.some((f) => f.type === 'no_source'));
});

test('fetch errors and unreadable pages become friendly UserErrors', async () => {
  const { deps: d } = deps({ fetchPage: async () => { throw new FetchError('forbidden', 'That site would not let Infomedics read the page (HTTP 403). Paste the text instead.'); } });
  await assert.rejects(runCheck('https://example.com/x', { deps: d }), (e) => e instanceof UserError && e.code === 'fetch_forbidden');

  const thin = deps({ fetchPage: async (url) => ({ finalUrl: url, html: '<html><body><p>Hi</p></body></html>', contentType: 'text/html' }) }).deps;
  await assert.rejects(runCheck('https://example.com/x', { deps: thin }), (e) => e.code === 'thin_page');

  const noClaims = deps({ fetchPage: async (url) => ({ finalUrl: url, html: `<html><body><main><p>${'Our office is open on weekdays and parking is behind the building. '.repeat(15)}</p></main></body></html>`, contentType: 'text/html' }) }).deps;
  await assert.rejects(runCheck('https://example.com/x', { deps: noClaims }), (e) => e.code === 'no_claims');
});

test('input validation', async () => {
  const { deps: d } = deps();
  await assert.rejects(runCheck('   ', { deps: d }), (e) => e.code === 'empty');
  await assert.rejects(runCheck('a'.repeat(9000), { deps: d }), (e) => e.code === 'too_long');
  await assert.rejects(runCheck(undefined, { deps: d }), (e) => e.code === 'empty');
});

test('cancellation stops the pipeline', async () => {
  const { deps: d } = deps();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runCheck('Vitamin C cures the common cold', { deps: d, signal: controller.signal }), (e) => e.code === 'cancelled');
});

test('overall verdict is the most severe across claims', async () => {
  let n = 0;
  const verdicts = ['supported', 'unsupported', 'mixed'];
  const { deps: d } = deps({ judgeClaim: async () => ({ verdict: verdicts[n++ % 3], explanation: 'Some explanation of the evidence here.', confidence: { level: 'Medium', note: 'n' }, redFlags: [], evidenceNotes: [], model: 'm' }) });
  const text = 'Garlic boosts your immune system and prevents colds in everyone who eats it. Apple cider vinegar melts belly fat and cures diabetes every morning. Honey cures coughs better than any medicine ever made.';
  const r = await runCheck(text, { deps: d });
  assert.equal(r.overall, 'unsupported');
});

test('topicIsRelevant keeps topics that share a word with the search terms', () => {
  assert.equal(topicIsRelevant({ title: 'Common Cold' }, ['vitamin c', 'common cold']), true);
  assert.equal(topicIsRelevant({ title: 'Heart Attack' }, ['vitamin c', 'common cold']), false);
  assert.equal(topicIsRelevant({ title: 'Antibiotics' }, ['antibiotics', 'food']), true);
  assert.equal(topicIsRelevant({ title: 'Vitamin D' }, ['vitamin c', 'common cold']), false);
  assert.equal(topicIsRelevant({ title: 'Vitamin C' }, ['vitamin c', 'common cold']), true);
  assert.equal(topicIsRelevant({ title: 'Antibiotic' }, ['antibiotics']), true); // plurals match
});

test('text with nothing searchable is not treated as a claim', async () => {
  const { deps: d } = deps();
  for (const input of ['hi', '???', '维生素C治感冒']) {
    await assert.rejects(runCheck(input, { deps: d }), (e) => e instanceof UserError && e.code === 'no_claims', input);
  }
});

test('non-web links are rejected and bare web addresses are opened as links', async () => {
  const { deps: d } = deps();
  for (const input of ['ftp://example.com/a', 'javascript://x', 'https://']) {
    await assert.rejects(runCheck(input, { deps: d }), (e) => e.code === 'invalid_link', input);
  }
  let fetched;
  const page = '<html><body><article><p>' + 'Vitamin C may reduce the duration of colds in some adults according to research. '.repeat(10) + '</p></article></body></html>';
  const { deps: d2 } = deps({ fetchPage: async (url) => { fetched = url; return { finalUrl: url, html: page }; } });
  const r = await runCheck('www.example.com/colds', { deps: d2 });
  assert.equal(fetched, 'https://www.example.com/colds');
  assert.equal(r.kind, 'page');
});

test('full-width characters and control characters do not hide a claim', async () => {
  const { deps: d, calls } = deps();
  await runCheck('ＶＩＴＡＭＩＮ Ｃ cures the cold\u0000', { deps: d });
  assert.equal(calls.pubmed[0].terms[0], 'vitamin c');
});

test('cited sources are numbered, labelled with credibility, and say which search found them', async () => {
  const NHS = { id: 'nhs1', kind: 'nhs', title: 'Common cold', url: 'https://www.nhs.uk/conditions/common-cold/', organization: 'NHS', summary: 'Rest and fluids.', reviewed: '2024-05-01' };
  const { deps: d } = deps({
    searchNhs: async () => [NHS],
    judgeClaim: async () => ({ verdict: 'unsupported', explanation: 'Reviews found no effect [1]. The NHS agrees [2].', citations: ['pm2', 'nhs1'], confidence: { level: 'High', note: 'ok' }, redFlags: [], evidenceNotes: [], model: 'claude-haiku-5-5' })
  });
  const r = await runCheck('Vitamin C cures the common cold', { deps: d });
  const c = r.claims[0];
  assert.equal(c.citedCount, 2);
  const byId = Object.fromEntries(c.evidence.map((e) => [e.id, e]));
  assert.equal(byId.pm2.cited, 1);
  assert.equal(byId.nhs1.cited, 2);
  assert.equal(byId.pm1.cited, undefined);
  assert.equal(byId.pm2.via, 'PubMed search');
  assert.equal(byId.nhs1.via, 'NHS website search');
  assert.equal(byId.nhs1.credibility.tier, 'agency');
  assert.equal(byId.pm2.credibility.tier, 'journal'); // fixture is not MEDLINE-indexed
  assert.ok(c.references.topics.some((t) => t.url === NHS.url));
});

test('a failing NHS search is a warning, not a failure', async () => {
  const { deps: d } = deps({ searchNhs: async () => { throw new Error('down'); } });
  const r = await runCheck('Vitamin C cures the common cold', { deps: d });
  assert.ok(r.claims[0].warnings.some((w) => /NHS/.test(w)));
  assert.ok(r.claims[0].evidence.length > 0);
});

test('a search plan replaces the claim\'s keywords, its topics are searched, and the search is logged', async () => {
  const { deps: d, calls } = deps({
    planSearches: async (claims) => ({ plans: claims.map(() => ({ concepts: [['knuckle cracking', 'joint cracking'], ['osteoarthritis']], topics: ['osteoarthritis', 'joint pain'] })), usage: { inputTokens: 300, outputTokens: 60 } }),
    searchPubMed: async (s) => { calls.pubmed.push(s); return { articles: [ARTICLE('pm9', 'Study')], total: 7, query: s.pubmedQuery, filtered: false, log: [{ source: 'PubMed', query: s.pubmedQuery, scope: 'all studies', hits: 7, kept: 1 }] }; },
    searchMedlinePlus: async (q) => { calls.medline.push(q); return q === 'osteoarthritis' ? [{ ...TOPIC, title: 'Osteoarthritis', url: 'https://medlineplus.gov/osteoarthritis.html' }] : []; }
  });
  const { events, emit } = collect();
  const r = await runCheck('Cracking your knuckles causes arthritis', { deps: d, emit });
  assert.equal(calls.pubmed[0].pubmedQuery, '("knuckle cracking" OR "joint cracking") AND osteoarthritis');
  assert.deepEqual(calls.medline, ['osteoarthritis', 'joint pain']);
  const c = r.claims[0];
  assert.deepEqual(c.searchPlan.topics, ['osteoarthritis', 'joint pain']);
  assert.equal(c.evidence.find((e) => e.kind === 'medlineplus').title, 'Osteoarthritis');
  assert.ok(c.searches.some((e) => e.source === 'PubMed' && e.hits === 7));
  assert.ok(events.some((e) => e.type === 'log' && /PubMed \(all studies\)/.test(e.text)));
  assert.ok(events.some((e) => e.type === 'step' && e.id === 'plan' && e.status === 'done' && /knuckle cracking \+ osteoarthritis/.test(e.detail)));
  // The planner's tokens are part of the check's cost.
  assert.equal(r.usage.calls, 1);
  assert.equal(r.usage.inputTokens, 300);
});

test('a typed claim is not flagged for naming no source, but a pasted answer stating things as fact is', async () => {
  const { deps: d } = deps();
  const typed = await runCheck('milk helps with bone growth', { deps: d });
  assert.ok(!typed.claims[0].redFlags.some((f) => f.type === 'no_source'));
  const pasted = await runCheck('Great question! Milk helps with bone growth in children. Vitamin C cures the common cold. Garlic lowers your blood pressure fast.', { deps: d });
  assert.ok(pasted.claims.some((c) => c.redFlags.some((f) => f.type === 'no_source' && /Doesn’t say where/.test(f.label))));
});
