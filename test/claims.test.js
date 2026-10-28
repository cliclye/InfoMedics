import test from 'node:test';
import assert from 'node:assert/strict';
import { extractClaims, buildSearch, triage, splitSentences } from '../lib/claims.js';
import { findRedFlags } from '../lib/redflags.js';

test('short input is treated as one claim as written', () => {
  const claims = extractClaims('Vitamin C cures the common cold');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].text, 'Vitamin C cures the common cold');
});

test('long text yields the health claims, not filler', () => {
  const text = `Welcome to our wellness blog! We love sharing tips. Click here to subscribe to our newsletter today.
    Drinking apple cider vinegar every morning melts belly fat and cures diabetes. Our team met in 2015 in a small office in Denver.
    Garlic boosts your immune system and prevents colds in everyone who eats it. Thanks for reading and see you next week friends.`;
  const claims = extractClaims(text);
  const texts = claims.map((c) => c.text);
  assert.ok(texts.some((t) => /apple cider vinegar/.test(t)));
  assert.ok(texts.some((t) => /Garlic boosts/.test(t)));
  assert.ok(!texts.some((t) => /subscribe|Denver|Thanks for reading/.test(t)));
  assert.ok(claims.length <= 3);
});

test('page extraction skips list fragments starting in lowercase and returns nothing when no claims', () => {
  assert.deepEqual(extractClaims('Our office is open Monday to Friday. Parking is available behind the building. Please call ahead for appointments.', { forceExtract: true }), []);
});

test('sentence splitting keeps abbreviations together', () => {
  const s = splitSentences('Dr. Smith said it works. Another study disagreed. Is it safe?');
  assert.equal(s.length, 3);
  assert.match(s[0], /^Dr\. Smith/);
});

test('buildSearch keeps known phrases together and drops filler', () => {
  assert.deepEqual(buildSearch('Vitamin C cures the common cold').terms, ['vitamin c', 'common cold']);
  assert.deepEqual(buildSearch('Drinking apple cider vinegar melts belly fat').terms, ['apple cider vinegar', 'belly fat']);
  const abx = buildSearch('You should never take antibiotics with food');
  assert.deepEqual(abx.terms, ['antibiotics', 'food']);
  assert.equal(abx.pubmedQuery, 'antibiotics AND food');
});

test('buildSearch quotes multi-word terms for PubMed', () => {
  assert.equal(buildSearch('Vitamin C cures the common cold').pubmedQuery, '"vitamin c" AND "common cold"');
});

test('triage flags emergencies and personal medical decisions', () => {
  assert.equal(triage('I have chest pain and my left arm is numb').emergency, true);
  assert.equal(triage('Is it safe to take ibuprofen while pregnant?').personal, true);
  assert.equal(triage('You should stop taking your blood pressure medication if you feel fine').personal, true);
  assert.equal(triage('Should I give honey to my baby?').personal, true);
  assert.equal(triage('Vitamin C cures the common cold').personal, false);
  assert.equal(triage('Drinking apple cider vinegar melts belly fat').personal, false);
  assert.equal(triage('You should never take antibiotics with food').personal, false);
});

test('red flags: miracle, absolute, urgency, conspiracy, vague authority', () => {
  const types = (t) => findRedFlags(t).map((f) => f.type);
  assert.ok(types('This miracle herb cures everything, guaranteed!').includes('miracle'));
  assert.ok(types('This miracle herb cures everything, guaranteed!').includes('absolute'));
  assert.ok(types('Act now before it is too late! Doctors hate this trick.').includes('urgency'));
  assert.ok(types('Big pharma is hiding the cure.').includes('conspiracy'));
  assert.ok(types('Studies show that it works.').includes('vague_authority'));
  assert.ok(types('It worked for my aunt.').includes('anecdote'));
});

test('red flags: no_source only when asked and nothing is cited', () => {
  assert.ok(findRedFlags('Cinnamon lowers blood sugar').some((f) => f.type === 'no_source'));
  assert.ok(!findRedFlags('Cinnamon lowers blood sugar', { checkSource: false }).some((f) => f.type === 'no_source'));
  assert.ok(!findRedFlags('A 2019 meta-analysis found cinnamon lowers blood sugar').some((f) => f.type === 'no_source'));
});

test('red flags: calm, careful wording gets none of the wording flags', () => {
  const flags = findRedFlags('A review of trials found that regular exercise may modestly lower blood pressure.', { checkSource: false });
  assert.deepEqual(flags, []);
});

test('general claims that mention an emergency are not emergencies; someone in trouble is', () => {
  assert.equal(triage('Aspirin prevents heart attack').emergency, false);
  assert.equal(triage('Vitamin E reduces the risk of stroke symptoms').emergency, false);
  assert.equal(triage('Garlic can treat seizures').emergency, false);
  assert.equal(triage('I think I am having a heart attack').emergency, true);
  assert.equal(triage('My dad is choking right now').emergency, true);
  assert.equal(triage('I can\'t breathe').emergency, true);
});

test('advice to see a clinician is not picked as a claim', () => {
  const text = 'Great question! Turmeric can replace ibuprofen for joint pain. Green tea boosts metabolism and helps burn belly fat. Taking vitamin D every day prevents depression in adults. Always check with your doctor before starting supplements.';
  const claims = extractClaims(text).map((c) => c.text);
  assert.equal(claims.length, 3);
  assert.ok(claims.some((c) => /vitamin D/.test(c)));
  assert.ok(!claims.some((c) => /check with your doctor/.test(c)));
});

test('two sentences that each make a full claim are checked separately', () => {
  assert.deepEqual(extractClaims('Coffee stunts your growth. Garlic lowers cholesterol and protects your heart.').map((c) => c.text),
    ['Coffee stunts your growth.', 'Garlic lowers cholesterol and protects your heart.']);
  assert.equal(extractClaims('Garlic lowers cholesterol. It also protects your heart.').length, 1);
  assert.equal(extractClaims('Is it safe to take ibuprofen while pregnant? I have a bad headache.').length, 1);
  assert.equal(extractClaims('My aunt swears by this. Apple cider vinegar melts belly fat in a week.').length, 1);
  assert.equal(extractClaims('Vitamin C cures the common cold.').length, 1);
});
