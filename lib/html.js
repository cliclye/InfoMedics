// Turn a web page's HTML into readable text plus the metadata we need to judge it.
// Deliberately regex-based and dependency-free: good enough for article pages.

import { decodeEntities, stripTags, squash } from './text.js';

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttrs(tag) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(tag))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function collectMeta(html) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content !== undefined && meta[key] === undefined) meta[key] = squash(a.content);
  }
  return meta;
}

function collectJsonLd(html) {
  const found = {};
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = [data];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (!node || typeof node !== 'object') continue;
      if (node['@graph']) stack.push(node['@graph']);
      if (typeof node.datePublished === 'string' && !found.published) found.published = node.datePublished;
      if (typeof node.dateModified === 'string' && !found.modified) found.modified = node.dateModified;
      if (typeof node.headline === 'string' && !found.headline) found.headline = node.headline;
      if (node.author && !found.author) {
        const authors = Array.isArray(node.author) ? node.author : [node.author];
        const names = authors.map((a) => (typeof a === 'string' ? a : a && a.name)).filter(Boolean);
        if (names.length) found.author = names.slice(0, 3).join(', ');
      }
      if (node.publisher && !found.publisher) {
        const p = node.publisher;
        found.publisher = typeof p === 'string' ? p : p && p.name;
      }
    }
  }
  return found;
}

function toIsoDate(value) {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  const year = new Date(t).getUTCFullYear();
  if (year < 1990 || year > new Date().getUTCFullYear() + 1) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function removeBlocks(html, tags) {
  let out = html;
  for (const tag of tags) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  return out;
}

function htmlToText(html) {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n• ')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|section|blockquote|ul|ol|table|article|figure|figcaption)\s*>/gi, '\n');
  return decodeEntities(stripTags(withBreaks))
    .replace(/\[(?:\d{1,3}|[a-z]|citation needed|note \d+)\]/gi, '') // footnote markers like [7]
    .split('\n')
    .map((line) => squash(line))
    .filter(Boolean)
    .join('\n');
}

function innerOf(html, tag) {
  const open = html.search(new RegExp(`<${tag}\\b`, 'i'));
  if (open === -1) return null;
  const closeIdx = html.toLowerCase().lastIndexOf(`</${tag}>`);
  if (closeIdx === -1 || closeIdx < open) return null;
  return html.slice(open, closeIdx);
}

/**
 * @returns {{title, siteName, description, author, published, modified, text, links, hasReferences, wordCount}}
 */
export function extractPage(html, baseUrl) {
  const meta = collectMeta(html);
  const ld = collectJsonLd(html);

  const titleTag = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1];
  const title = squash(decodeEntities(meta['og:title'] || ld.headline || titleTag || '')) || null;

  const cleaned = removeBlocks(html.replace(/<!--[\s\S]*?-->/g, ' '),
    ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'head', 'nav', 'footer', 'aside', 'form', 'button']);

  const candidates = ['article', 'main', 'body']
    .map((tag) => innerOf(cleaned, tag))
    .filter(Boolean)
    .map((region) => ({ region, text: htmlToText(region) }));
  const best = candidates.find((c) => c.text.length >= 600) || candidates.sort((a, b) => b.text.length - a.text.length)[0]
    || { region: cleaned, text: htmlToText(cleaned) };

  const links = [];
  for (const tag of best.region.match(/<a\b[^>]*>/gi) || []) {
    const { href } = parseAttrs(tag);
    if (!href) continue;
    try {
      const abs = new URL(href, baseUrl);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') links.push(abs.toString());
    } catch { /* ignore bad hrefs */ }
  }

  let author = meta.author || ld.author || null;
  if (!author && meta['article:author'] && !/^https?:/i.test(meta['article:author'])) author = meta['article:author'];
  if (!author) {
    const rel = /<a\b[^>]*rel=["'][^"']*\bauthor\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(best.region);
    if (rel) author = squash(decodeEntities(stripTags(rel[1]))) || null;
  }
  if (author && author.length > 120) author = null;

  const timeTag = /<time\b[^>]*datetime=["']([^"']+)["']/i.exec(html);
  const published = toIsoDate(
    meta['article:published_time'] || meta['og:article:published_time'] || ld.published ||
    meta.datepublished || meta.pubdate || meta['publish-date'] || meta.date || (timeTag && timeTag[1])
  );
  const modified = toIsoDate(meta['article:modified_time'] || meta['og:updated_time'] || ld.modified || meta['last-modified']);

  const hasReferences = /<h[1-6][^>]*>\s*(?:references|sources|citations|bibliography|studies cited|works cited|further reading)\s*:?\s*<\/h[1-6]>/i.test(best.region)
    || /^(?:references|sources|citations|bibliography|works cited)\s*:?$/im.test(best.text);

  const text = best.text.slice(0, 60_000);
  return {
    title,
    siteName: meta['og:site_name'] || ld.publisher || null,
    description: meta['og:description'] || meta.description || null,
    author,
    published,
    modified,
    text,
    links,
    hasReferences,
    wordCount: text.split(/\s+/).filter(Boolean).length
  };
}
