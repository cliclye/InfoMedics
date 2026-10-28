// Turn a web page's HTML into readable text plus the metadata we need to judge it.
// Deliberately regex-based and dependency-free: good enough for article pages.

import { decodeEntities, stripTags, squash } from './text.js';

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttrs(tag) {
  const attrs = {};
  if (tag.length > 4000) return attrs; // a giant "tag" is junk, and attribute matching on it is slow
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

function collectJsonLd(html, lower) {
  const found = {};
  for (const r of blockRanges(lower, 'script')) {
    if (r.innerEnd === null || !/type\s*=\s*["']?application\/ld\+json/i.test(html.slice(r.start, r.openEnd))) continue;
    let data;
    try { data = JSON.parse(html.slice(r.openEnd, r.innerEnd).trim()); } catch { continue; }
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

// ---- Linear-time scanning. Pages are untrusted, and a few hundred KB of unclosed tags would make
// lazy regexes like <nav>[\s\S]*?</nav> run for minutes, so tags are located with indexOf instead.

// Same length as the input, so indexes found in it also work on the original.
function lowerAscii(s) {
  const l = s.toLowerCase();
  return l.length === s.length ? l : s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

function stripComments(html) {
  let out = '';
  let pos = 0;
  for (;;) {
    const start = html.indexOf('<!--', pos);
    if (start === -1) return out + html.slice(pos);
    out += html.slice(pos, start) + ' ';
    const end = html.indexOf('-->', start + 4);
    if (end === -1) return out;
    pos = end + 3;
  }
}

// A '<' that never reaches a '>' before the next '<' is text, not a tag.
const escapeStrayLt = (html) => html.replace(/<(?![^<>]*>)/g, '&lt;');

/**
 * Every <tag ...>...</tag> block in `lower` (a lowercased copy of the page). An open tag with no closing
 * tag yields just the open tag (innerEnd === null). Expects stray '<' to be escaped already.
 */
function blockRanges(lower, tag) {
  const ranges = [];
  const open = '<' + tag;
  const close = '</' + tag;
  let pos = 0;
  let closable = true; // once one search fails, later ones would too
  for (;;) {
    let start = lower.indexOf(open, pos);
    while (start !== -1 && /[a-z0-9:-]/.test(lower[start + open.length] || '')) start = lower.indexOf(open, start + open.length);
    if (start === -1) return ranges;
    const openEnd = lower.indexOf('>', start + open.length) + 1;
    if (openEnd === 0) return ranges;
    let end = openEnd;
    let innerEnd = null;
    if (closable) {
      const c = lower.indexOf(close, openEnd);
      if (c === -1) closable = false;
      else {
        const gt = lower.indexOf('>', c + close.length);
        end = gt === -1 ? lower.length : gt + 1;
        innerEnd = c;
      }
    }
    ranges.push({ start, openEnd, innerEnd, end });
    pos = end;
  }
}

function removeBlocks(html, tags) {
  let out = html;
  for (const tag of tags) {
    const ranges = blockRanges(lowerAscii(out), tag);
    if (!ranges.length) continue;
    let result = '';
    let pos = 0;
    for (const r of ranges) { result += out.slice(pos, r.start) + ' '; pos = r.end; }
    out = result + out.slice(pos);
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
  const lower = lowerAscii(html);
  const [first] = blockRanges(lower, tag);
  if (!first) return null;
  const closeIdx = lower.lastIndexOf(`</${tag}>`);
  if (closeIdx === -1 || closeIdx < first.start) return null;
  return html.slice(first.start, closeIdx);
}

const STRIP_FULL = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'head', 'nav', 'footer', 'aside', 'form', 'button'];
// Some sites (old ASP.NET pages) wrap the whole page in one <form>; this keeps the content.
const STRIP_LIGHT = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'head', 'button'];

function pickRegion(cleaned) {
  const candidates = ['article', 'main', 'body']
    .map((tag) => innerOf(cleaned, tag))
    .filter(Boolean)
    .map((region) => ({ region, text: htmlToText(region) }));
  return candidates.find((c) => c.text.length >= 600) || candidates.sort((a, b) => b.text.length - a.text.length)[0]
    || { region: cleaned, text: htmlToText(cleaned) };
}

/**
 * @returns {{title, siteName, description, author, published, modified, text, links, hasReferences, wordCount}}
 */
export function extractPage(rawHtml, baseUrl) {
  const html = escapeStrayLt(stripComments(String(rawHtml)));
  const lower = lowerAscii(html);
  const meta = collectMeta(html);
  const ld = collectJsonLd(html, lower);

  const [titleBlock] = blockRanges(lower, 'title');
  const titleTag = titleBlock && titleBlock.innerEnd !== null ? html.slice(titleBlock.openEnd, titleBlock.innerEnd) : '';
  const title = squash(decodeEntities(meta['og:title'] || ld.headline || titleTag || '')) || null;

  let best = pickRegion(removeBlocks(html, STRIP_FULL));
  if (best.text.split(/\s+/).length < 120) {
    const alt = pickRegion(removeBlocks(html, STRIP_LIGHT));
    if (alt.text.length > best.text.length * 1.5) best = alt;
  }

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
    const regionLower = lowerAscii(best.region);
    for (const r of blockRanges(regionLower, 'a')) {
      if (r.innerEnd === null || !/\brel\s*=\s*["'][^"']*\bauthor\b/i.test(best.region.slice(r.start, r.openEnd))) continue;
      author = squash(decodeEntities(stripTags(best.region.slice(r.openEnd, r.innerEnd)))) || null;
      if (author) break;
    }
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
