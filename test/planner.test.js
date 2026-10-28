import test from 'node:test';
import assert from 'node:assert/strict';
import { planSearches, normalizePlan, cleanTerm, createPlanCache } from '../lib/planner.js';
import { searchFromPlan } from '../lib/claims.js';
import { mentions, onTopic } from '../lib/pubmed.js';

const fakeClient = (reply, calls = []) => ({
  messages: {
    create: async (params) => {
      calls.push(params);
      if (reply instanceof Error) throw reply;
      return { content: [{ type: 'text', text: JSON.stringify(reply) }], usage: { input_tokens: 300, output_tokens: 70 } };
    }
  }
});

test('cleanTerm strips PubMed syntax so a term cannot change the query', () => {
  assert.equal(cleanTerm('Knuckle "cracking"[tiab] OR hacked'), 'knuckle cracking tiab hacked');
  assert.equal(cleanTerm('omega-3'), 'omega-3');
  assert.equal(cleanTerm('x'), '');
  assert.equal(cleanTerm('a'.repeat(80)), '');
});

test('normalizePlan keeps at most 3 groups of 4 terms and 2 topics, and rejects empty plans', () => {
  const p = normalizePlan({ concepts: [['a1', 'a2', 'a3', 'a4', 'a5'], [], ['b1'], ['c1'], ['d1']], topics: [] });
  assert.deepEqual(p.concepts, [['a1', 'a2', 'a3', 'a4'], ['b1'], ['c1']]);
  assert.deepEqual(p.topics, ['a1']);
  assert.equal(normalizePlan({ concepts: [], topics: ['x'] }), null);
  assert.equal(normalizePlan(null), null);
});

test('planSearches asks once for all claims, without thinking, and caches good plans', async () => {
  const calls = [];
  const client = fakeClient({ plans: [
    { concepts: [['knuckle cracking'], ['osteoarthritis']], topics: ['arthritis'] },
    { concepts: [], topics: [] }
  ] }, calls);
  const cache = createPlanCache();
  const out = await planSearches(['Cracking knuckles causes arthritis', 'hello there'], { client, cache });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].thinking, { type: 'disabled' });
  assert.match(calls[0].messages[0].content, /1\. Cracking knuckles.*\n2\. hello there/);
  assert.deepEqual(out.plans[0].concepts, [['knuckle cracking'], ['osteoarthritis']]);
  assert.equal(out.plans[1], null);
  assert.equal(out.usage.outputTokens, 70);

  // The good plan is reused; only the failed one is asked for again.
  const again = await planSearches(['cracking knuckles causes arthritis', 'hello there'], { client, cache });
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content, /^1\. hello there$/);
  assert.deepEqual(again.plans[0].topics, ['arthritis']);
});

test('a failed planner call falls back to no plan instead of failing the check', async () => {
  const out = await planSearches(['Vitamin C cures colds'], { client: fakeClient(new Error('boom')), cache: createPlanCache() });
  assert.deepEqual(out, { plans: [null], usage: null });
});

test('searchFromPlan builds an OR-within, AND-between PubMed query', () => {
  const s = searchFromPlan({ concepts: [['knuckle cracking', 'joint cracking'], ['osteoarthritis']], topics: ['arthritis', 'joint pain'] });
  assert.equal(s.pubmedQuery, '("knuckle cracking" OR "joint cracking") AND osteoarthritis');
  assert.equal(s.pubmedBroad, '("knuckle cracking" OR "joint cracking")');
  assert.equal(s.topicQuery, 'arthritis');
  assert.ok(s.terms.includes('joint pain') && s.terms.includes('osteoarthritis'));
});

test('mentions matches word forms; onTopic needs both the exposure and the outcome', () => {
  assert.ok(mentions('Habitual cracking of the knuckles', 'knuckle cracking'));
  assert.ok(mentions('Effects of microwave heating on vitamins', 'microwaving'));
  assert.ok(!mentions('Television viewing and vision', 'vision loss'));
  assert.ok(!mentions('Cracked teeth outcomes', 'knuckle cracking'));
  const concepts = [['knuckle cracking'], ['osteoarthritis', 'arthritis']];
  assert.ok(onTopic({ title: 'Knuckle cracking and hand osteoarthritis', abstract: '' }, concepts));
  assert.ok(!onTopic({ title: 'Knuckle cracking sounds', abstract: 'Ultrasound of the joint.' }, concepts));
  assert.ok(onTopic({ title: 'Anything', abstract: '' }, undefined));
});
