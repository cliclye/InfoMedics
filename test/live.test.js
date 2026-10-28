// Hits the real PubMed / MedlinePlus services and a real web page. Run with: npm run test:live
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck } from '../lib/pipeline.js';

const live = process.env.INFOMEDICS_LIVE === '1';

test('live: a claim finds real PubMed reviews and a MedlinePlus topic', { skip: !live, timeout: 60_000 }, async () => {
  const r = await runCheck('Vitamin C cures the common cold', { deps: { aiEnabled: () => false } });
  const c = r.claims[0];
  const papers = c.evidence.filter((e) => e.kind === 'pubmed');
  assert.ok(papers.length >= 3, 'expected several papers, got ' + papers.length);
  assert.ok(papers.every((p) => /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/.test(p.url)));
  assert.ok(papers.some((p) => /vitamin c/i.test(p.title)));
  assert.ok(c.evidence.some((e) => e.kind === 'medlineplus' && /cold/i.test(e.title)));
  assert.equal(c.verdict, 'unclear');
  assert.deepEqual(c.warnings, []);
});

test('live: the NHS website is searched and its page is read, with credibility labels on every source', { skip: !live, timeout: 60_000 }, async () => {
  const r = await runCheck('Vitamin C cures the common cold', { deps: { aiEnabled: () => false } });
  const c = r.claims[0];
  const nhs = c.evidence.find((e) => e.kind === 'nhs');
  assert.ok(nhs, 'expected an NHS page');
  assert.match(nhs.url, /^https:\/\/www\.nhs\.uk\/conditions\//);
  assert.match(nhs.summary, /\w{5,}/);
  assert.equal(nhs.via, 'NHS website search');
  assert.ok(c.evidence.length > 0 && c.evidence.every((e) => e.credibility && e.credibility.label && e.via && /^https:\/\//.test(e.url)));
});

test('live: a narrow claim still finds evidence by falling back to fewer search terms', { skip: !live, timeout: 60_000 }, async () => {
  const r = await runCheck('Drinking apple cider vinegar melts belly fat', { deps: { aiEnabled: () => false } });
  const papers = r.claims[0].evidence.filter((e) => e.kind === 'pubmed');
  assert.ok(papers.length >= 3, 'expected papers, got ' + papers.length);
  assert.ok(papers.some((p) => /apple cider vinegar/i.test(p.title)));
});

test('live: a real web page is scraped, assessed, and its claims checked', { skip: !live, timeout: 90_000 }, async () => {
  const r = await runCheck('https://www.nhs.uk/conditions/common-cold/', { deps: { aiEnabled: () => false } });
  assert.equal(r.kind, 'page');
  assert.equal(r.page.domain.tier, 'trusted');
  assert.ok(r.page.wordCount > 300);
  assert.ok(r.claims.length >= 1);
  assert.ok(r.claims.every((c) => c.claim.length > 20));
});

test('live: private and local links are refused', { skip: !live }, async () => {
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1/', 'http://localhost/']) {
    await assert.rejects(runCheck(url), (e) => e.code === 'fetch_blocked', url);
  }
});

test('live: a planned search finds the knuckle-cracking studies that keyword search misses, and nothing off topic', { skip: !live, timeout: 60_000 }, async () => {
  const { searchPubMed } = await import('../lib/pubmed.js');
  const { searchFromPlan } = await import('../lib/claims.js');
  const r = await searchPubMed(searchFromPlan({ concepts: [['knuckle cracking', 'joint cracking'], ['osteoarthritis', 'arthritis']], topics: ['arthritis'] }));
  assert.ok(r.articles.length >= 2, 'expected at least two studies, got ' + r.articles.length);
  assert.ok(r.articles.every((a) => /knuckle|joint crack/i.test(a.title + a.abstract)));
  assert.ok(r.articles.some((a) => a.pmid === '21383216'), 'expected "Knuckle cracking and hand osteoarthritis" (2011)');
  assert.ok(r.log.some((e) => e.scope === 'all studies' && e.kept > 0), 'no reviews exist, so other study types must be searched');
});
