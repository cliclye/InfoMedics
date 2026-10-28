import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNhsResults, nhsTitleRelevant, searchNhs } from '../lib/nhs.js';

const RESULTS = `<ul class="nhsuk-list">
<li><a class="app-search-results-item" data-score="45" href="/search/click?url=%2Fconditions%2Fcold-sores%2F&amp;pos=1&amp;hash=x"> Cold sores </a>
<p class="nhsuk-body-s">Find out about <strong>cold</strong> sores.</p></li>
<li><a class="app-search-results-item" href="/search/click?url=%2Fconditions%2Fcommon-cold%2F&amp;pos=2"> Common cold </a>
<p>Colds are <strong>very</strong> common.</p></li>
<li><a class="app-search-results-item" href="/search/click?url=%2Fnhs-services%2Fgps%2F&amp;pos=3">Find a GP</a><p>x</p></li>
<li><a class="app-search-results-item" href="/search/click?url=%2F%2Fevil.example%2F&amp;pos=4">Evil</a><p>x</p></li>
</ul>`;

test('parseNhsResults reads titles, paths and snippets and skips service pages and off-site paths', () => {
  const r = parseNhsResults(RESULTS);
  assert.deepEqual(r.map((x) => x.path), ['/conditions/cold-sores/', '/conditions/common-cold/']);
  assert.equal(r[1].title, 'Common cold');
  assert.equal(r[1].snippet, 'Colds are very common.');
});

test('nhsTitleRelevant needs every meaningful word of a search term', () => {
  assert.equal(nhsTitleRelevant('Common cold', ['vitamin c', 'common cold']), true);
  assert.equal(nhsTitleRelevant('Cold sores', ['vitamin c', 'common cold']), false);
  assert.equal(nhsTitleRelevant('Vitamin C', ['vitamin c']), true);
  assert.equal(nhsTitleRelevant('Anything', ['hi']), false);
});

test('searchNhs searches, keeps relevant pages, and reads each one', async () => {
  const page = '<html><body><article><h1>Common cold</h1><p>' + 'You can ease cold symptoms with rest, fluids and over the counter remedies. '.repeat(8) + '</p></article></body></html>';
  const asked = [];
  const out = await searchNhs('vitamin c common cold', {
    terms: ['vitamin c', 'common cold'],
    getHtml: async (url) => { asked.push(url); return RESULTS; },
    read: async (url) => { asked.push(url); return { finalUrl: url, html: page }; }
  });
  assert.match(asked[0], /^https:\/\/www\.nhs\.uk\/search\/results\?q=vitamin\+c\+common\+cold/);
  assert.equal(asked[1], 'https://www.nhs.uk/conditions/common-cold/');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'nhs1');
  assert.equal(out[0].kind, 'nhs');
  assert.match(out[0].summary, /rest, fluids/);
});

test('searchNhs falls back to the search snippet when a page cannot be read', async () => {
  const out = await searchNhs('common cold', {
    terms: ['common cold'],
    getHtml: async () => RESULTS,
    read: async () => { throw new Error('blocked'); }
  });
  assert.equal(out[0].summary, 'Colds are very common.');
});
