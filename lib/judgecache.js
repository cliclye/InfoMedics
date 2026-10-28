// A small in-memory cache of finished judgements. The same viral claim, checked again against the same
// sources, costs nothing the second time. Entries expire after a day so a changed evidence base is picked up.

import { createHash } from 'node:crypto';

export function createJudgeCache({ max = 300, ttlMs = 24 * 3600 * 1000 } = {}) {
  const map = new Map(); // insertion order doubles as recency order
  return {
    key({ model, effort, claim, evidence, triage, redFlags }) {
      const parts = [model, effort, String(claim).toLowerCase().replace(/\s+/g, ' ').trim(),
        evidence.map((e) => e.id).sort().join(','), triage && triage.personal ? 'p' : '-', (redFlags || []).map((f) => f.type).sort().join(',')];
      return createHash('sha256').update(parts.join('\u0001')).digest('hex');
    },
    get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (Date.now() - hit.at > ttlMs) { map.delete(key); return null; }
      map.delete(key); map.set(key, hit); // refresh recency
      return hit.value;
    },
    set(key, value) {
      map.set(key, { at: Date.now(), value });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() { return map.size; }
  };
}

export const sharedJudgeCache = createJudgeCache();
