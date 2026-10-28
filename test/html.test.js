import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPage } from '../lib/html.js';
import { assessPage } from '../lib/page.js';

const PAGE = `<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="Does ginger help nausea?">
<meta property="og:site_name" content="Example Health">
<meta name="author" content="Dr. Jane Roe">
<meta property="article:published_time" content="2024-03-02T10:00:00Z">
<script type="application/ld+json">{"@type":"Article","datePublished":"2020-01-01","dateModified":"2024-05-01","author":{"name":"Someone Else"}}</script>
<style>.x{color:red}</style><script>var secret = "do not show";</script>
</head><body>
<nav><a href="/home">Home</a> NAVIGATION TEXT</nav>
<article>
<h1>Does ginger help nausea?</h1>
<p>Ginger has been used for centuries. Several trials suggest ginger may reduce nausea in pregnancy &amp; after surgery.[1] Dosage matters.[citation needed]</p>
<p>Read the <a href="https://pubmed.ncbi.nlm.nih.gov/12345/">trial</a> and <a href="https://doi.org/10.1000/xyz">review</a>. See <a href="/relative">more</a>.</p>
<p>${'Filler sentence about wellness and diet. '.repeat(40)}</p>
<h2>References</h2><ol><li>Smith 2020</li></ol>
</article>
<aside>SIDEBAR ADS</aside>
<footer>FOOTER TEXT</footer>
</body></html>`;

test('extractPage pulls text, metadata, links and drops chrome', () => {
  const p = extractPage(PAGE, 'https://example.com/ginger');
  assert.equal(p.title, 'Does ginger help nausea?');
  assert.equal(p.siteName, 'Example Health');
  assert.equal(p.author, 'Dr. Jane Roe');
  assert.equal(p.published, '2024-03-02');
  assert.equal(p.modified, '2024-05-01');
  assert.match(p.text, /Ginger has been used for centuries/);
  assert.match(p.text, /nausea in pregnancy & after surgery\./);
  assert.doesNotMatch(p.text, /NAVIGATION|SIDEBAR|FOOTER|secret|\[1\]|citation needed/);
  assert.ok(p.links.includes('https://pubmed.ncbi.nlm.nih.gov/12345/'));
  assert.ok(p.links.includes('https://example.com/relative'));
  assert.equal(p.hasReferences, true);
});

test('assessPage reports signals from the extracted page', () => {
  const extracted = extractPage(PAGE, 'https://example.com/ginger');
  const page = assessPage({ url: 'https://example.com/ginger', finalUrl: 'https://example.com/ginger', extracted });
  const status = Object.fromEntries(page.signals.map((s) => [s.id, s.status]));
  assert.equal(status.author, 'good');
  assert.equal(status.date, 'good');
  assert.equal(status.citations, 'good');
  assert.equal(status.commerce, 'good');
  assert.equal(page.domain.tier, 'unknown');
  assert.equal(page.researchLinks, 2);
});

test('assessPage warns on missing author, old date, no citations, and selling', () => {
  const html = `<html><head><title>Miracle</title><meta name="date" content="2012-01-01"></head><body><main><p>${'Buy now and get free shipping on our detox tea that cures everything. '.repeat(20)}</p></main></body></html>`;
  const extracted = extractPage(html, 'https://shop.example.org/tea');
  const page = assessPage({ url: 'https://shop.example.org/tea', finalUrl: 'https://shop.example.org/tea', extracted });
  const status = Object.fromEntries(page.signals.map((s) => [s.id, s.status]));
  assert.equal(status.author, 'warn');
  assert.equal(status.date, 'warn');
  assert.equal(status.citations, 'warn');
  assert.equal(status.commerce, 'warn');
  assert.ok(page.commerce.length >= 1);
});

test('trusted and institutional domains are recognised', () => {
  const ex = extractPage('<html><body><p>' + 'word '.repeat(200) + '</p></body></html>', 'https://www.nhs.uk/x');
  assert.equal(assessPage({ url: 'https://www.nhs.uk/x', finalUrl: 'https://www.nhs.uk/x', extracted: ex }).domain.tier, 'trusted');
  assert.equal(assessPage({ url: 'https://med.stanford.edu/x', finalUrl: 'https://med.stanford.edu/x', extracted: ex }).domain.tier, 'institutional');
});

test('hostile markup cannot stall extraction', () => {
  const nasty = {
    unclosedNav: '<html><body>' + '<nav>'.repeat(200_000) + '</body></html>',
    unclosedComment: '<html><body>' + '<!--'.repeat(200_000) + '</body></html>',
    unclosedTitle: '<title>'.repeat(200_000),
    strayLt: '<html><body>' + '<'.repeat(600_000) + '</body></html>',
    openAnchors: '<body>' + '<a '.repeat(300_000),
    giantTag: '<html><body><a ' + 'a'.repeat(1_400_000) + '>x</a></body></html>'
  };
  for (const [name, html] of Object.entries(nasty)) {
    const started = Date.now();
    extractPage(html, 'https://example.com/');
    assert.ok(Date.now() - started < 1500, `${name} took ${Date.now() - started}ms`);
  }
});

test('extractPage keeps the content of pages wrapped in a single <form>', () => {
  const body = '<p>Vitamin C is a nutrient that supports the immune system and some studies suggest it may shorten colds slightly.</p>'.repeat(12);
  const p = extractPage(`<html><body><form id="aspnetForm">${body}</form></body></html>`, 'https://example.com/');
  assert.ok(p.wordCount > 100, `only ${p.wordCount} words`);
});

test('extractPage reads titles and rel=author links without regex backtracking', () => {
  const p = extractPage('<html><head><TITLE>Big &amp; Small</TITLE></head><body><main><a REL="author nofollow" href="/x">Dr Ana Ruiz</a> wrote this. ' + 'Words about health. '.repeat(10) + '</main></body></html>', 'https://example.com/');
  assert.equal(p.title, 'Big & Small');
  assert.equal(p.author, 'Dr Ana Ruiz');
});
