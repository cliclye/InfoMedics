/*
 * Infomedics mock data.
 *
 * Everything here is pre-written and SIMULATED. None of it is medical advice.
 * Loaded as a classic script (not an ES module) so index.html works from file://.
 */
window.INFOMEDICS = (function () {
  'use strict';

  // ---- Trusted sources: general homepages only, no made-up deep links ----
  var SOURCES = {
    who:   { name: 'World Health Organization (WHO)', url: 'https://www.who.int' },
    cdc:   { name: 'Centers for Disease Control and Prevention (CDC)', url: 'https://www.cdc.gov' },
    nih:   { name: 'National Institutes of Health (NIH)', url: 'https://www.nih.gov' },
    mayo:  { name: 'Mayo Clinic', url: 'https://www.mayoclinic.org' },
    nhs:   { name: 'NHS (UK National Health Service)', url: 'https://www.nhs.uk' }
  };

  // ---- Verdict states: label, color class, icon (never color alone) ----
  var VERDICTS = {
    supported: {
      label: 'Supported',
      blurb: 'The evidence generally backs this up.',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    },
    mixed: {
      label: 'Mixed evidence',
      blurb: 'Partly true, or it depends on the situation.',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2.5 22.5 21h-21z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 9.5v5M12 17.2v.3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>'
    },
    unsupported: {
      label: 'Unsupported',
      blurb: 'Good evidence does not back this up.',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8.2 8.2l7.6 7.6M15.8 8.2l-7.6 7.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>'
    },
    doctor: {
      label: 'Needs a doctor',
      blurb: 'This depends on the person. Ask a qualified professional.',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="currentColor"/><path d="M12 7v10M7 12h10" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>'
    }
  };

  // Display order and meaning for the confidence meter.
  var CONFIDENCE_LEVELS = { Low: 1, Medium: 2, High: 3 };

  // ---- Example claims shown as clickable chips ----
  var EXAMPLES = [
    'Vitamin C cures the common cold',
    'You should never take antibiotics with food',
    'Drinking apple cider vinegar melts belly fat'
  ];

  // ---- Pre-written results ----
  // `match` is a list of keyword groups. A claim matches when ALL terms in at
  // least one group appear in the (lower-cased) input. Bigger groups = more
  // specific, so they win ties.
  var CLAIMS = [
    {
      id: 'vitamin-c-cold',
      match: [['vitamin c', 'cold'], ['vitamin c', 'cure'], ['ascorbic', 'cold']],
      verdict: 'unsupported',
      explanation: 'Vitamin C does not cure the common cold. Large studies show that taking it does not stop most people from catching colds. For some people it may shorten a cold by a small amount, but that is not a cure. Colds are caused by viruses and usually get better on their own.',
      redFlags: [
        'Miracle cure language: the word “cures” promises more than the evidence shows.',
        'Absolute claim with no details about dose or who it works for.',
        'No source or study is named.'
      ],
      sources: ['nih', 'mayo', 'nhs'],
      confidence: { level: 'High', note: 'Many large reviews of trials reach the same conclusion.' }
    },
    {
      id: 'antibiotics-food',
      match: [['antibiotic', 'food'], ['antibiotic', 'empty stomach'], ['antibiotic', 'meal'], ['antibiotic', 'with milk']],
      verdict: 'mixed',
      explanation: 'Whether to take antibiotics with food depends on which antibiotic you have. Some work best on an empty stomach. Others are fine with food, and food can help if the medicine upsets your stomach. A few should not be taken with foods like dairy. So “never” is too strong. Follow the label and ask your pharmacist.',
      redFlags: [
        'Absolute word: “never” treats every antibiotic the same way.',
        'Ignores that different medicines have different rules.',
        'No source is named.'
      ],
      sources: ['nhs', 'mayo', 'cdc'],
      confidence: { level: 'Medium', note: 'The right answer changes with the exact medicine.' }
    },
    {
      id: 'acv-belly-fat',
      match: [['apple cider vinegar'], ['vinegar', 'belly'], ['vinegar', 'fat'], ['acv', 'fat']],
      verdict: 'unsupported',
      explanation: 'There is no good evidence that apple cider vinegar melts belly fat. One small study saw a tiny weight change after months, which is too little to matter much. Your body cannot pick one spot to lose fat from. Drinking a lot of vinegar can also hurt your teeth and throat.',
      redFlags: [
        'Miracle-style wording: “melts” suggests a fast, easy fix.',
        'Promises fat loss from one body area, which is not how bodies work.',
        'Offers a single quick fix instead of a full picture.'
      ],
      sources: ['mayo', 'nih', 'nhs'],
      confidence: { level: 'Medium', note: 'Only a few small studies exist, and none show a strong effect.' }
    },
    {
      id: 'handwashing',
      match: [['wash', 'hand'], ['handwashing'], ['hand washing'], ['hand hygiene']],
      verdict: 'supported',
      explanation: 'Washing your hands with soap and water helps stop germs from spreading. It lowers the risk of stomach bugs and some breathing illnesses. Scrub for about 20 seconds, including between your fingers. If there is no soap and water, a hand sanitizer with at least 60% alcohol is the next best choice.',
      redFlags: [],
      sources: ['cdc', 'who', 'nhs'],
      confidence: { level: 'High', note: 'Health agencies around the world agree, backed by many studies.' }
    },
    {
      id: 'vaccines-autism',
      match: [['vaccin', 'autism']],
      verdict: 'unsupported',
      explanation: 'Many large studies, including some that followed millions of children, found no link between vaccines and autism. The idea began with a small study that was later found to be flawed and was withdrawn. Vaccines protect against serious diseases. If you have worries about vaccines, talk with a clinician you trust.',
      redFlags: [
        'Fear-based framing about a serious harm to children.',
        'Goes against very large studies from many countries.',
        'No source is named.'
      ],
      sources: ['who', 'cdc', 'nih'],
      confidence: { level: 'High', note: 'The question has been studied many times with the same answer.' }
    },
    {
      id: 'eight-glasses-water',
      match: [['8 glasses'], ['eight glasses'], ['glasses of water'], ['water', 'a day']],
      verdict: 'mixed',
      explanation: 'The “8 glasses a day” rule is a handy guide, not a strict rule. How much water you need depends on your size, activity, health, and the weather. You also get water from food and other drinks. For most healthy people, drinking when you feel thirsty works well.',
      redFlags: [
        'Treats one number as right for everyone.',
        'No source is named.'
      ],
      sources: ['mayo', 'nhs', 'cdc'],
      confidence: { level: 'Medium', note: 'Needs vary from person to person, so no single number fits all.' }
    },
    {
      id: 'stop-bp-medication',
      match: [['blood pressure', 'stop'], ['stop', 'medic'], ['stop taking', 'pill'], ['blood pressure', 'feel fine']],
      verdict: 'doctor',
      explanation: 'Do not stop a prescribed medicine on your own. High blood pressure often has no symptoms, so feeling fine can mean the medicine is working. Stopping suddenly can make blood pressure rise again, which can raise the risk of a stroke or heart attack. Talk to your doctor or pharmacist before you change any medicine.',
      redFlags: [
        'Advice about changing a prescription medicine.',
        'Judges the treatment by how you feel, not by test results.'
      ],
      sources: ['nhs', 'mayo', 'nih'],
      confidence: { level: 'High', note: 'Health groups agree: do not stop prescribed medicine without advice.' }
    },
    {
      id: 'pregnancy-medicine',
      match: [['pregnan', 'ibuprofen'], ['pregnan', 'medic'], ['pregnan', 'herbal'], ['pregnan', 'safe to take'], ['pregnan', 'supplement']],
      verdict: 'doctor',
      explanation: 'Some medicines and supplements are safe in pregnancy and some are not. It can depend on the medicine, the dose, and how far along the pregnancy is. For example, ibuprofen is usually advised against in later pregnancy. Because the risks are personal, ask your doctor, midwife, or pharmacist before taking anything.',
      redFlags: [
        'Involves pregnancy, where small mistakes can matter a lot.',
        'A general answer cannot cover your own health and stage of pregnancy.'
      ],
      sources: ['nhs', 'mayo', 'cdc'],
      confidence: { level: 'High', note: 'Medical groups agree: check with a professional first.' }
    },
    {
      id: 'exercise-heart',
      match: [['exercise', 'heart'], ['physical activity', 'heart'], ['walking', 'heart']],
      verdict: 'supported',
      explanation: 'Regular physical activity is linked to a healthier heart. It can lower blood pressure, help with weight, and reduce the risk of heart disease. Health groups suggest about 150 minutes of moderate activity each week for most adults. If you have a health condition, check with a clinician before starting a new plan.',
      redFlags: [],
      sources: ['who', 'cdc', 'mayo'],
      confidence: { level: 'High', note: 'Backed by decades of research and major health guidelines.' }
    }
  ];

  // ---- Fallback heuristic used when no claim above matches ----
  // Terms are matched as word starts (so "cure" also catches "cures"/"cured").
  var HEURISTIC = {
    absoluteWords: ['always', 'never', 'cure', 'guaranteed', 'miracle', '100%'],
    doctorWords: [
      'symptom', 'medication', 'medicine', 'medicat', 'dosage', 'dose', 'prescri',
      'pregnan', 'emergenc', 'overdose', 'chest pain', 'bleeding', 'fever',
      'can\'t breathe', 'trouble breathing', 'allergic reaction', 'mg'
    ],
    urgencyWords: ['urgent', 'immediately', 'right now', 'act now', 'before it\'s too late', 'doctors hate', 'they don\'t want you to know', 'secret'],
    sourceHints: ['according to', 'study', 'studies', 'research', 'journal', 'cdc', 'nih', 'http', 'source'],
    flagText: {
      absolute: 'Absolute or miracle wording: ',
      urgency: 'Urgency or fear tactics: ',
      noSource: 'No source or study is cited.'
    },
    results: {
      doctor: {
        verdict: 'doctor',
        explanation: 'This claim mentions symptoms, medicine, or another personal health situation. The right answer can depend on your age, health, and other medicines, so a general website cannot decide for you. Please talk to a doctor, nurse, or pharmacist. If it could be an emergency, contact your local emergency services.',
        sources: ['nhs', 'mayo', 'cdc'],
        confidence: { level: 'Low', note: 'We cannot judge the claim itself, but asking a professional is the safe step.' }
      },
      mixed: {
        verdict: 'mixed',
        explanation: 'We could not match this to a claim in our library, so we cannot say for sure if it is true. Health claims are often more complicated than one sentence. Check what trusted health organizations say, and look for whether the claim names a real study or source.',
        sources: ['who', 'nih', 'mayo'],
        confidence: { level: 'Low', note: 'This was a simple rule-based check, not a review of the evidence.' }
      }
    }
  };

  return {
    SOURCES: SOURCES,
    VERDICTS: VERDICTS,
    CONFIDENCE_LEVELS: CONFIDENCE_LEVELS,
    EXAMPLES: EXAMPLES,
    CLAIMS: CLAIMS,
    HEURISTIC: HEURISTIC
  };
})();
