# Infomedics

Check whether a health claim, an AI chatbot's answer, or a web article holds up against the medical research.

Paste text or a link. Infomedics finds the health claims, searches **PubMed** (systematic reviews, meta-analyses, randomized trials) and **MedlinePlus** (plain-language topic pages), and shows what it found. With an AI model connected, it also weighs the claim against that evidence and gives a verdict with an explanation.

> Infomedics is a prototype and does not provide medical advice. Talk to a qualified clinician about health decisions.

## Run it

Requires Node 20.12 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000.

### Two modes

| Mode | When | What you get |
| --- | --- | --- |
| **AI verdicts** | `ANTHROPIC_API_KEY` is set | A verdict (Supported, Mixed evidence, Unsupported, Needs a doctor, Not enough evidence), a plain-language explanation, a confidence level, and a stance for each source |
| **Evidence only** | no key | Real PubMed and MedlinePlus results, red flags, page checks, and a keyword hint about each paper's conclusion. Claims are marked **Not rated**; Infomedics does not guess |

To enable verdicts, copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. The default model is `claude-opus-5-5`; set `INFOMEDICS_MODEL` to change it. The top-right chip in the app shows which mode is active.

Other optional settings: `NCBI_API_KEY` and `NCBI_EMAIL` (higher PubMed rate limit), `PORT`, `HOST` (default `127.0.0.1`, local only), `INFOMEDICS_ALLOWED_ORIGINS` (extra origins allowed to call the API, comma-separated).

## What a check does

1. **Read.** Pasted text is used as written. For a link, the server downloads the page and extracts the article text, author, dates, and outbound links.
2. **Find claims.** Sentences that make health claims are picked out (up to three).
3. **Assess the page** (links only): reputation of the domain, named author, date, whether it cites research, and signs of selling or sponsorship.
4. **Search.** Search terms are built from the claim and sent to PubMed (ranked by study type, relevance, recency; retracted papers dropped) and MedlinePlus (off-topic results filtered out).
5. **Spot red flags in the wording.** Rule-based: miracle language, absolute words, fear tactics, conspiracy framing, vague authority, anecdotes, no source named.
6. **Triage.** Emergencies and personal medical decisions (medicines, pregnancy, children, stopping treatment) are always sent to **Needs a doctor**, whatever the AI says.
7. **Weigh** (AI mode). Claude gets the claim and the retrieved evidence and returns structured JSON. It may only cite the evidence it was given, and the server validates everything before it reaches the page.

Progress streams to the UI as it happens.

## Safety and privacy

- **Link fetching is hardened against SSRF.** Only http/https on ports 80/443; every resolved address is checked at connection time, so localhost, private ranges, cloud metadata addresses, and DNS tricks are refused, including through redirects. Size, time, and redirect limits apply.
- The server binds to `127.0.0.1` by default, rejects cross-origin POSTs, rate-limits checks per IP, and serves a strict Content-Security-Policy. While it listens only on loopback it also refuses any request whose `Host` header is not `localhost`, `127.x.x.x` or `[::1]`, which stops DNS-rebinding attacks from other websites. (Set `HOST=0.0.0.0` to expose it on a network; that turns this check off, and the API has no login.)
- Pages you link to are untrusted input: HTML is scanned in linear time, so a hostile page cannot stall the server.
- Page text and abstracts are treated as untrusted data in the AI prompt, and model output is schema-validated.
- Your API key stays on the server and is never sent to the browser.
- History is stored only in your browser's local storage.
- If AI mode is on, the claim and retrieved evidence are sent to Anthropic. Search terms always go to PubMed and MedlinePlus.

## Limits

- It reads abstracts, not full papers, and PubMed is not all of medicine.
- The AI can be wrong. Use the source links.
- Sites that block bots, need JavaScript, or serve PDFs can't be read; paste the text instead.
- English only. Up to three claims per submission.
- The server calls Claude with the server-side refusal fallback enabled and retries without it if the API rejects that parameter. That path was tested against a fake API, not against the live service, since no key was available during development.

## Tests

```bash
npm test            # offline: unit, pipeline, HTTP-safety, server, and fake-Anthropic tests
npm run test:live   # hits the real PubMed, MedlinePlus, and nhs.uk
```

## Project layout

```
server.js            HTTP server: static files, /api/status, streamed /api/check
lib/pipeline.js      read -> claims -> evidence -> judge -> result
lib/http.js          SSRF-safe page fetch, API fetch
lib/html.js          HTML to text and metadata
lib/page.js          page trust signals
lib/claims.js        claim extraction, search terms, triage
lib/redflags.js      wording red flags
lib/pubmed.js        PubMed search, parsing, ranking
lib/medline.js       MedlinePlus search
lib/judge.js         Claude verdicts with schema validation
public/              the web app (index.html, styles.css, app.js)
extension/           Chrome/Edge extension that uses the server (see below)
test/                node:test suites
```

## Browser extension

`extension/` is a Chrome/Edge extension that checks text you select on any page using this server (progress, evidence, and verdicts all come from `/api/check`). Run the server, load the folder as an unpacked extension, and select some text. See [extension/README.md](extension/README.md).

The server accepts requests from the extension's fixed ID (`INFOMEDICS_ALLOWED_ORIGINS` adds more origins) and refuses other websites.

## Ideas for next steps

- Full-text retrieval and citation verification for the papers behind a verdict.
- More sources: Cochrane, WHO and CDC pages, clinical guidelines.
- Human clinician review for high-risk topics, and a reviewed set to measure verdict accuracy.
- Multilingual support.
