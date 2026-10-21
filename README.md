# Infomedics (clickable prototype)

Infomedics helps people check whether health information, especially AI-generated answers, is trustworthy. This is a **prototype for demos**: every verdict is simulated.

## Run it

No install, no build, no server. Open `index.html` in any modern browser (double-click it, or run `open index.html` on macOS).

## What you can do

- **Check:** paste a claim, or click one of the three example chips, then press **Check claim** (or Ctrl/⌘ + Enter). A 1.5-second spinner simulates analysis.
- **Result card:** verdict badge (Supported, Mixed evidence, Unsupported, Needs a doctor; each with its own color *and* icon), plain-language explanation, red flags, trusted sources, a confidence meter, and a disclaimer.
- **History:** claims you checked are saved in `localStorage`. Click one to reopen its result, or **Clear history**.
- **Learn:** five tips for spotting health misinformation.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure; all four screens live here and are toggled by JS |
| `styles.css` | Styling (responsive, system fonts, focus states) |
| `data.js` | Mock data: verdict definitions, trusted sources, 9 pre-written claim results, heuristic word lists |
| `app.js` | UI logic, keyword matching, fallback heuristic, history |

## What is mocked

- **Verdicts.** `data.js` holds 9 pre-written results (including the 3 examples). `app.js` picks one by keyword matching: a claim matches when all terms in any keyword group appear in the input, and the most specific group wins.
- **Fallback heuristic** when nothing matches: flags absolute/miracle words (`always`, `never`, `cure`, `guaranteed`, `100%`, `miracle`), urgency/fear phrases, and missing sources. If the text mentions symptoms, medication, dosage, pregnancy, or emergencies it returns **Needs a doctor**; otherwise **Mixed evidence** with a generic explanation and Low confidence.
- **Delay.** The 1.5-second wait is a `setTimeout`, not real work.
- **Sources.** Links go to the real homepages of WHO, CDC, NIH, Mayo Clinic, and NHS, but the pairing of source to claim is illustrative.

The place to plug in a real service is marked with `REAL API HOOK` in `app.js` (`analyzeClaim`). Return the same result shape and the UI needs no other changes.

## Ideas for a real version

1. **LLM backend with retrieval.** Break a pasted answer into individual claims, retrieve passages from trusted sources (WHO, CDC, NIH, NHS, Cochrane, peer-reviewed journals), and have the model judge each claim only from what it retrieved.
2. **Citation checking.** Verify every cited source exists and actually supports the sentence it is attached to; show the supporting quote. Drop or flag anything that cannot be verified.
3. **Human clinician review.** Route high-risk topics (medication, dosage, pregnancy, children, emergencies) to a qualified reviewer, and use reviewed examples to evaluate and improve the system.
4. **Calibrated confidence.** Base Low/Medium/High on source quality, agreement between sources, and how recent the evidence is, and measure it against reviewed cases.
5. **Safety and trust.** Clear emergency guidance, multilingual support, reading-level checks, accessibility audits, and privacy-friendly storage of any user input.

## Disclaimer

Infomedics is a prototype and does not provide medical advice. Talk to a qualified clinician about health decisions.
