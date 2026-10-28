// MedlinePlus Health Topics (US National Library of Medicine): plain-language summaries
// written for the public. Free web service, no key.

import { getText } from './http.js';
import { decodeEntities, stripTags, squash, truncate } from './text.js';

const ENDPOINT = 'https://wsearch.nlm.nih.gov/ws/query';

function cleanHtmlField(value) {
  // Fields arrive as entity-escaped HTML: decode once, add breaks, strip tags, decode again.
  const html = decodeEntities(value).replace(/<\/?(?:p|li|ul|ol|h\d|br)\b[^>]*>/gi, ' ');
  return squash(decodeEntities(stripTags(html)));
}

/** Parse the MedlinePlus search XML. Exported for tests. */
export function parseTopics(xml) {
  const topics = [];
  for (const doc of String(xml).matchAll(/<document\b([^>]*)>([\s\S]*?)<\/document>/g)) {
    const url = (/url="([^"]+)"/.exec(doc[1]) || [])[1];
    if (!url || !/^https:\/\/medlineplus\.gov\//.test(url)) continue;
    const fields = {};
    for (const c of doc[2].matchAll(/<content\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/content>/g)) {
      if (fields[c[1]] === undefined) fields[c[1]] = cleanHtmlField(c[2]);
    }
    const summary = fields.FullSummary || fields.snippet || '';
    if (!fields.title || !summary) continue;
    topics.push({
      id: 'mp' + (topics.length + 1),
      kind: 'medlineplus',
      title: fields.title,
      url: decodeEntities(url),
      organization: fields.organizationName || 'National Library of Medicine',
      summary: truncate(summary, 900)
    });
  }
  return topics;
}

export async function searchMedlinePlus(topicQuery, { limit = 2, signal } = {}) {
  if (!topicQuery) return [];
  const params = new URLSearchParams({ db: 'healthTopics', term: topicQuery, retmax: String(limit) });
  const xml = await getText(`${ENDPOINT}?${params}`, { signal });
  return parseTopics(xml).slice(0, limit);
}
