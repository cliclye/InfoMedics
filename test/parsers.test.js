import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArticles, rankArticles, conclusionTone } from '../lib/pubmed.js';
import { parseTopics } from '../lib/medline.js';

const XML = `<?xml version="1.0"?><PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID Version="1">111</PMID><Article>
<Journal><Title>Cochrane Database of Systematic Reviews</Title><JournalIssue><PubDate><Year>2013</Year></PubDate></JournalIssue></Journal>
<ArticleTitle>Vitamin C for preventing and treating the common cold.</ArticleTitle>
<Abstract><AbstractText Label="BACKGROUND">Colds are common.</AbstractText><AbstractText Label="AUTHORS' CONCLUSIONS">The failure of vitamin C supplementation to reduce the incidence of colds in the general population indicates that routine supplementation is not justified.</AbstractText></Abstract>
<PublicationTypeList><PublicationType UI="D017418">Meta-Analysis</PublicationType><PublicationType UI="D000">Systematic Review</PublicationType></PublicationTypeList>
</Article></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID>222</PMID><Article>
<Journal><Title>Some Journal</Title></Journal>
<ArticleTitle>A <i>small</i> trial &amp; its results</ArticleTitle>
<Abstract><AbstractText>Plain unlabeled abstract. It was effective. Participants improved significantly.</AbstractText></Abstract>
<ArticleDate><Year>2022</Year></ArticleDate>
<PublicationTypeList><PublicationType>Randomized Controlled Trial</PublicationType></PublicationTypeList>
</Article></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID>333</PMID><Article><ArticleTitle>Retracted thing</ArticleTitle>
<Abstract><AbstractText>Bad data.</AbstractText></Abstract>
<PublicationTypeList><PublicationType>Retracted Publication</PublicationType></PublicationTypeList></Article></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID>444</PMID><Article><ArticleTitle>No abstract here</ArticleTitle></Article></MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

test('parseArticles extracts fields, drops retracted and abstract-less records', () => {
  const articles = parseArticles(XML);
  assert.deepEqual(articles.map((a) => a.pmid), ['111', '222']);
  const [a, b] = articles;
  assert.equal(a.design, 'Meta-analysis');
  assert.equal(a.year, 2013);
  assert.equal(a.journal, 'Cochrane Database of Systematic Reviews');
  assert.match(a.conclusion, /routine supplementation is not justified/);
  assert.equal(a.tone, 'no_benefit');
  assert.equal(a.url, 'https://pubmed.ncbi.nlm.nih.gov/111/');
  assert.equal(b.title, 'A small trial & its results');
  assert.equal(b.design, 'Randomized trial');
  assert.equal(b.year, 2022);
  assert.match(b.conclusion, /improved significantly/);
});

test('rankArticles prefers reviews, then relevance and title matches', () => {
  const mk = (pmid, design, year, title) => ({ pmid, design, year, title });
  const ranked = rankArticles([
    mk('1', 'Study', 2024, 'Something'),
    mk('2', 'Randomized trial', 2020, 'Zinc and colds'),
    mk('3', 'Meta-analysis', 2015, 'Vitamin C and the common cold')
  ], ['1', '2', '3'], ['vitamin c', 'common cold']);
  assert.deepEqual(ranked.map((a) => a.pmid), ['3', '2', '1']);
});

test('conclusionTone reads wording direction', () => {
  assert.equal(conclusionTone('There was no significant effect on incidence.'), 'no_benefit');
  assert.equal(conclusionTone('Treatment significantly reduced symptoms.'), 'benefit');
  assert.equal(conclusionTone('Treatment significantly reduced duration but there was no evidence for prevention.'), 'mixed');
  assert.equal(conclusionTone('Further research is needed.'), 'unknown');
  assert.equal(conclusionTone('Zinc was not effective in children.'), 'no_benefit');
});

const MEDLINE = `<nlmSearchResult><list>
<document rank="0" url="https://medlineplus.gov/commoncold.html">
<content name="title">&lt;span class="qt0"&gt;Common&lt;/span&gt; &lt;span class="qt1"&gt;Cold&lt;/span&gt;</content>
<content name="organizationName">National Library of Medicine</content>
<content name="FullSummary">What is the cold?&lt;p&gt;A mild infection of the nose and throat.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Sneezing&lt;/li&gt;&lt;li&gt;Cough&lt;/li&gt;&lt;/ul&gt;</content>
</document>
<document rank="1" url="https://evil.example.com/page"><content name="title">Nope</content><content name="FullSummary">x</content></document>
<document rank="2" url="https://medlineplus.gov/empty.html"><content name="title">No summary</content></document>
</list></nlmSearchResult>`;

test('parseTopics decodes escaped HTML and ignores non-MedlinePlus or empty entries', () => {
  const topics = parseTopics(MEDLINE);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].title, 'Common Cold');
  assert.equal(topics[0].url, 'https://medlineplus.gov/commoncold.html');
  assert.equal(topics[0].summary, 'What is the cold? A mild infection of the nose and throat. Sneezing Cough');
  assert.equal(topics[0].id, 'mp1');
});
