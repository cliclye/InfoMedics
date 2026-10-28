// Small text helpers shared by the scrapers and parsers.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', middot: '·', bull: '•',
  laquo: '«', raquo: '»', eacute: 'é', egrave: 'è', agrave: 'à', uuml: 'ü', ouml: 'ö', auml: 'ä',
  micro: 'µ', ge: '≥', le: '≤', beta: 'β', alpha: 'α', gamma: 'γ', delta: 'δ'
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

export function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '');
}

// Collapse runs of whitespace (including newlines) into single spaces.
export function squash(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

export function truncate(s, max) {
  s = String(s);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
