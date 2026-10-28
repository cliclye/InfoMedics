// Find the health claims in a block of text, turn them into search terms, and triage risk.

import { squash } from './text.js';
import { findRedFlags } from './redflags.js';

const HEALTH_RE = new RegExp(
  '\\b(?:' + [
    'cancer', 'tumou?r', 'chemo\\w*', 'radiation', 'diabet\\w*', 'insulin', 'blood (?:pressure|sugar|clot\\w*)', 'cholesterol',
    'heart', 'stroke', 'cardio\\w*', 'vitamins?', 'minerals?', 'supplements?', 'probiotics?', 'antioxidants?', 'omega',
    'protein', 'calor\\w+', 'diet\\w*', 'weight', 'obes\\w+', 'fat', 'metabol\\w+', 'immun\\w+', 'infect\\w+', 'virus\\w*',
    'viral', 'bacteri\\w+', 'antibiotics?', 'vaccin\\w+', 'flu', 'influenza', 'colds?', 'covid\\w*', 'allerg\\w+', 'asthma',
    'arthritis', 'inflammat\\w+', 'pain\\w*', 'headaches?', 'migraines?', 'fever', 'cough\\w*', 'symptoms?', 'diseases?',
    'disorders?', 'syndrome', 'depress\\w+', 'anxiety', 'sleep\\w*', 'insomnia', 'memory', 'dementia', 'alzheimer\\w*', 'autism',
    'adhd', 'pregnan\\w+', 'fertil\\w+', 'menopaus\\w+', 'hormon\\w+', 'thyroid', 'kidneys?', 'liver', 'lungs?', 'gut',
    'digest\\w+', 'detox\\w*', 'toxins?', 'cleanse', 'herbal', 'turmeric', 'ginger', 'garlic', 'vinegar', 'honey', 'tea',
    'coffee', 'alcohol', 'smok\\w+', 'vap\\w+', 'sugar', 'salt', 'sodium', 'gluten', 'dairy', 'medicines?', 'medicat\\w+',
    'drugs?', 'dos(?:e|es|age)', 'treat\\w*', 'therap\\w+', 'remed\\w+', 'doctors?', 'clinic\\w*', 'hospital', 'surgery',
    'bones?', 'osteopor\\w+', 'skin', 'acne', 'eczema', 'hair', 'teeth', 'dental', 'eyes?', 'vision', 'hearing', 'blood',
    'cure[sd]?', 'prevent\\w*', 'health\\w*', 'nutrition\\w*', 'exercise', 'fasting', 'organic', 'natural', 'oil'
  ].join('|') + ')\\b', 'gi');

const CLAIM_VERB_RE = /\b(?:cure[sd]?|treat(?:s|ed)?|prevent(?:s|ed)?|cause[sd]?|lower(?:s|ed)?|reduce[sd]?|boost(?:s|ed)?|improve[sd]?|heal(?:s|ed)?|detox\w*|kill(?:s|ed)?|fight(?:s)?|flush(?:es)?|burn(?:s)?|melt(?:s)?|reverse[sd]?|increase[sd]?|raise[sd]?|protect(?:s)?|stop(?:s)?|relieve[sd]?|eliminate[sd]?|clear(?:s)?|help(?:s)?|stunt(?:s|ed)?|damage[sd]?|destroy(?:s|ed)?|weaken(?:s|ed)?|strengthen(?:s|ed)?|shorten(?:s|ed)?|worsen(?:s|ed)?|trigger(?:s|ed)?|spread(?:s)?|make(?:s)?|work(?:s)?|linked to|leads? to|results? in|should|never|always|can|does|is|are)\b/i;

const STOP = new Set(('a an the and or but if then than so to of in on at by for with without from into onto over under about as is are was were be been being ' +
  'am do does did done have has had having can could should would will shall may might must it its this that these those there here you your yours ' +
  'we our they them their he she his her i me my not no nor very more most much many some any each every all both just also too really ' +
  'who whom whose which what when where why how while during after before because since until against between through ' +
  'drinking eating taking using doing getting having making taking cure cures cured cause causes caused prevent prevents prevented ' +
  'treat treats treated lower lowers lowered reduce reduces reduced boost boosts boosted improve improves improved heal heals healed ' +
  'kill kills killed fight fights flush flushes burn burns melt melts melted reverse reverses increase increases raise raises ' +
  'protect protects stop stops relieve relieves eliminate eliminates clear clears help helps lead leads result results ' +
  'never always best worst good bad safe unsafe actually really truly proven guaranteed miracle natural naturally ' +
  'say says said claim claims people everyone anyone one like get gets still even ever ' +
  'take takes give gives use uses used drink drinks eat eats need needs make makes made work works working try tries daily morning day week time times').split(/\s+/));

// Multi-word terms we want to keep together when searching.
const PHRASES = [
  'apple cider vinegar', 'vitamin c', 'vitamin d', 'vitamin b12', 'vitamin e', 'vitamin a', 'vitamin k', 'blood pressure', 'blood sugar',
  'common cold', 'heart disease', 'heart attack', 'type 2 diabetes', 'type 1 diabetes', 'weight loss', 'belly fat', 'green tea',
  'omega-3', 'fish oil', 'intermittent fasting', 'lemon water', 'coconut oil', 'olive oil', 'mental health', 'back pain', 'sore throat',
  'kidney stones', 'gut health', 'immune system', 'side effects', 'folic acid', 'baking soda', 'hydrogen peroxide', 'colloidal silver',
  'essential oils', 'cold water', 'ice bath', 'red meat', 'processed meat', 'artificial sweeteners', 'high blood pressure',
  'high cholesterol', 'chronic pain', 'multiple sclerosis', 'ibuprofen', 'sun exposure', 'screen time', 'bone density'
];

const ADVICE_RE = /\b(?:check|consult|talk|speak|ask|see)\s+(?:with\s+|to\s+)?(?:your|a|an)\s+(?:own\s+)?(?:doctor|gp|pharmacist|health ?care (?:provider|professional)|physician|clinician|nurse|midwife|dentist)\b|\bnot (?:a substitute for|intended as) (?:professional )?medical advice\b/i;

const ABBREVIATIONS = /\b(?:Dr|Mr|Mrs|Ms|Prof|vs|etc|e\.g|i\.e|approx|St|No|Fig|al)\.$/;

export function splitSentences(text) {
  const parts = String(text).replace(/\r/g, '').split(/\n+/);
  const sentences = [];
  for (const part of parts) {
    const pieces = part.split(/(?<=[.!?])\s+(?=[A-Z"“‘'(\d•-])/);
    let buffer = '';
    for (const piece of pieces) {
      buffer = buffer ? buffer + ' ' + piece : piece;
      if (!ABBREVIATIONS.test(piece)) { sentences.push(buffer.trim()); buffer = ''; }
    }
    if (buffer) sentences.push(buffer.trim());
  }
  return sentences.map((s) => s.replace(/^•\s*/, '')).filter(Boolean);
}

function countHealthTerms(sentence) {
  const found = new Set((sentence.match(HEALTH_RE) || []).map((w) => w.toLowerCase()));
  return found.size;
}

// A sentence that makes a claim on its own: a health topic, a claim verb, and no pronoun pointing back at
// another sentence ("It works", "This is why").
function standsAlone(sentence) {
  if (/[?]$/.test(sentence) || sentence.split(/\s+/).length < 3) return false;
  if (/^(?:it|this|that|these|those|they|he|she|which|so|and|but)\b/i.test(sentence)) return false;
  return countHealthTerms(sentence) > 0 && CLAIM_VERB_RE.test(sentence);
}

function scoreSentence(sentence, { strict = false } = {}) {
  if (strict && /^[a-z]/.test(sentence)) return 0; // a fragment cut from a list or heading
  const words = sentence.split(/\s+/).length;
  if (words < 6 || sentence.length > 420) return 0;
  if (/[?]$/.test(sentence)) return 0;
  if (/^(?:click|subscribe|sign up|share|follow|read more|copyright|©|advertisement|related|photo|image)/i.test(sentence)) return 0;
  // "Check with your doctor first" is advice, not a claim anyone needs to verify.
  if (ADVICE_RE.test(sentence)) return 0;
  const health = countHealthTerms(sentence);
  if (!health) return 0;
  const verb = CLAIM_VERB_RE.test(sentence) ? 2 : 0;
  const flags = findRedFlags(sentence, { checkSource: false }).length;
  const hedged = /\b(?:may|might|could|some|often|sometimes|appears?|suggests?)\b/i.test(sentence) ? 0 : 1;
  return health * 2 + verb + flags * 3 + hedged;
}

/**
 * Pick the health claims worth checking.
 * Short inputs are treated as one claim as written; longer text yields up to `max` sentences.
 * @returns {{text: string, score: number}[]}
 */
export function extractClaims(text, { max = 3, forceExtract = false } = {}) {
  const clean = squash(text);
  if (!clean) return [];
  const sentences = splitSentences(text);

  if (!forceExtract && sentences.length <= 2) {
    // Two sentences that each make a full claim of their own ("Coffee stunts growth. Garlic lowers
    // cholesterol.") are checked separately; otherwise one is usually context for the other.
    if (sentences.length === 2 && sentences.every(standsAlone)) return sentences.map((t) => ({ text: t, score: scoreSentence(t) }));
    return [{ text: clean.slice(0, 600), score: scoreSentence(clean) }];
  }

  const scored = sentences
    .map((s, index) => ({ text: s, score: scoreSentence(s, { strict: forceExtract }), index }))
    .filter((s) => s.score >= 4);
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, max).sort((a, b) => a.index - b.index);
  if (top.length) return top.map(({ text: t, score }) => ({ text: t, score }));
  return forceExtract ? [] : [{ text: clean.slice(0, 400), score: 0 }];
}

/**
 * Build search terms from a claim. "Vitamin C cures the common cold" -> ["vitamin c", "common cold"].
 * @returns {{terms: string[], pubmedQuery: string, pubmedBroad: string, pubmedNarrow: string, topicQuery: string}}
 */
export function buildSearch(claim) {
  let rest = ' ' + String(claim).toLowerCase().replace(/[‘’]/g, "'") + ' ';
  const phrases = [];
  for (const phrase of PHRASES) {
    const re = new RegExp(`(?<![a-z0-9])${phrase.replace(/[-]/g, '[- ]')}(?![a-z0-9])`, 'i');
    const m = re.exec(rest);
    if (m) {
      phrases.push({ phrase, index: m.index });
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }
  }

  const tokens = [];
  const tokenRe = /[a-z][a-z0-9'-]{2,}/g;
  let m;
  while ((m = tokenRe.exec(rest))) {
    const word = m[0].replace(/'s$/, '');
    if (!STOP.has(word)) tokens.push({ phrase: word, index: m.index });
  }

  const merged = [...phrases, ...tokens].sort((a, b) => a.index - b.index).map((x) => x.phrase);
  const terms = [...new Set(merged)].slice(0, 5);

  const quote = (t) => (t.includes(' ') ? `"${t}"` : t);
  return {
    terms,
    pubmedQuery: terms.slice(0, 4).map(quote).join(' AND '),
    pubmedBroad: terms.slice(0, 2).map(quote).join(' AND '),
    pubmedNarrow: terms.slice(0, 1).map(quote).join(''),
    topicQuery: terms.slice(0, 3).join(' ')
  };
}

/**
 * The same search shape as buildSearch(), built from a planner's concept groups instead of the claim's
 * own words: [["knuckle cracking","joint cracking"],["osteoarthritis"]] ->
 * ("knuckle cracking" OR "joint cracking") AND osteoarthritis.
 */
export function searchFromPlan(plan) {
  const quote = (t) => (t.includes(' ') ? `"${t}"` : t);
  const group = (g) => (g.length > 1 ? `(${g.map(quote).join(' OR ')})` : quote(g[0]));
  const { concepts, topics } = plan;
  return {
    terms: [...new Set([...topics, ...concepts.flat()])],
    concepts,
    topics,
    pubmedQuery: concepts.map(group).join(' AND '),
    pubmedBroad: concepts.slice(0, concepts.length > 2 ? 2 : 1).map(group).join(' AND '),
    pubmedNarrow: group(concepts[0]),
    topicQuery: topics[0]
  };
}

// Always an emergency, however it is phrased.
const EMERGENCY_RE = /\b(?:chest pain|can'?t breathe|cannot breathe|trouble breathing|difficulty breathing|suicid\w+|kill myself|self-harm|severe bleeding|unconscious|not breathing|anaphyla\w+)\b/i;
// Also names an emergency, but "aspirin prevents heart attacks" is a general claim, not someone in trouble.
// These only count when the text says it is happening to someone right now.
const SITUATIONAL_RE = /\b(?:stroke symptoms?|overdos\w+|poison\w*|seizures?|choking|heart attacks?)\b/i;
const HAPPENING_NOW_RE = /\b(?:i|i'?m|im|my|me|we|our|someone|somebody|he'?s|she'?s|they'?re|is having|am having|are having|having a|right now|just (?:took|ate|drank|swallowed))\b/i;
const PERSONAL_RES = [
  /\bpregnan\w+|\bbreast-?feed\w*|\bnursing mother/i,
  /\bshould i\b|\bcan i (?:take|stop|use|give|drink|eat|mix)\b|\bam i (?:safe|allowed)\b|\bdo i need\b/i,
  /\b(?:stop|quit|skip) (?:taking|using|your|my|the)\b.*\b(?:medicat\w+|medicine|pills?|insulin|prescription|statins?|antidepressants?|inhaler|chemo\w*)/i,
  /\binstead of (?:your |my |the |any )?(?:medicat\w+|medicine|treatment|chemo\w*|insulin|prescription|surgery|vaccin\w+)/i,
  /\b(?:dosage|overdose|prescri\w+|insulin|chemotherapy|antidepressants?|opioids?|blood thinners?|anticoagulants?)\b/i,
  /\b(?:infant|baby|newborn|toddler|child|children|kids?)\b.*\b(?:medicat\w+|medicine|dose|dosage|supplement\w*|honey|aspirin)\b/i,
  /\b(?:interact\w*|mix(?:ing)?|combin\w+) (?:with )?(?:alcohol|medications?|drugs?)\b/i,
  /\bmy (?:symptoms?|doctor|medication|pills?|blood pressure|blood sugar|child|baby)\b/i
];

/**
 * Is this about an emergency, or a personal medical decision a website can't make?
 * @returns {{emergency: boolean, personal: boolean, reasons: string[]}}
 */
export function triage(text) {
  const t = String(text).replace(/[‘’]/g, "'");
  const reasons = [];
  const emergency = EMERGENCY_RE.test(t) || (SITUATIONAL_RE.test(t) && HAPPENING_NOW_RE.test(t));
  if (emergency) reasons.push('mentions a possible emergency');
  let personal = false;
  for (const re of PERSONAL_RES) {
    if (re.test(t)) { personal = true; break; }
  }
  if (personal) reasons.push('involves medication, pregnancy, children, or a personal medical decision');
  return { emergency, personal: personal || emergency, reasons };
}
