// NHS website (nhs.uk): search its public site search, then read the top matching pages.
// A real web search and scrape of a credible health service, not a guess from the model's memory.

import { getText, fetchPage } from './http.js';
import { extractPage } from './html.js';
import { decodeEntities, stripTags, squash, truncate, titleMatchesTerms } from './text.js';

const SEARCH = 'https://www.nhs.uk/search/results';
const ORIGIN = 'https://www.nhs.uk';
const SKIP_PATHS = /^\/(?:nhs-services|service-search|social-care|using-the-nhs|about-us|our-policies|nhs-sites)\b/;

/** Parse the NHS search results page. Exported for tests. */
export function parseNhsResults(html) {
  const results = [];
  const re = /<a\b[^>]*class="[^"]*app-search-results-item[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*(?:<p\b[^>]*>([\s\S]*?)<\/p>)?/g;
  for (const m of String(html).matchAll(re)) {
    const href = decodeEntities(m[1]);
    let path;
    try {
      const u = new URL(href, ORIGIN);
      path = u.pathname === '/search/click' ? u.searchParams.get('url') : u.pathname;
    } catch { continue; }
    if (!path || !path.startsWith('/') || path.startsWith('//') || SKIP_PATHS.test(path)) continue;
    const title = squash(decodeEntities(stripTags(m[2])));
    if (!title) continue;
    results.push({ title, path, snippet: squash(decodeEntities(stripTags(m[3] || ''))) });
  }
  return results;
}

// NHS search is fuzzy ("vitamin c cold" also returns cold sores): keep only titles that match the search terms.
export const nhsTitleRelevant = titleMatchesTerms;

/**
 * @returns {Promise<{id: string, kind: 'nhs', title: string, url: string, organization: string, summary: string, reviewed: string|null}[]>}
 */
export async function searchNhs(query, { terms = [], limit = 2, signal, read = fetchPage, getHtml = getText } = {}) {
  if (!query) return [];
  const html = await getHtml(`${SEARCH}?${new URLSearchParams({ q: query })}`, { signal, timeoutMs: 8000, retries: 0 });
  const picks = parseNhsResults(html).filter((r) => nhsTitleRelevant(r.title, terms)).slice(0, limit);

  const pages = await Promise.allSettled(picks.map((r) => read(ORIGIN + r.path, { signal, timeoutMs: 8000, maxBytes: 600_000 })));
  const out = [];
  pages.forEach((p, i) => {
    const r = picks[i];
    let summary = r.snippet;
    let reviewed = null;
    if (p.status === 'fulfilled') {
      const page = extractPage(p.value.html, p.value.finalUrl);
      if (page.wordCount >= 40) summary = truncate(page.text.replace(/\n+/g, ' '), 900);
      reviewed = page.modified || page.published || null;
    }
    if (!summary) return;
    out.push({ id: 'nhs' + (out.length + 1), kind: 'nhs', title: r.title, url: ORIGIN + r.path, organization: 'NHS (UK National Health Service)', summary, reviewed });
  });
  return out;
}
