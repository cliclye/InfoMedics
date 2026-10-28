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
