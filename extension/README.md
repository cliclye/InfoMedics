# Infomedics browser extension

Select a health claim on any web page and check it with your Infomedics server: it searches PubMed and MedlinePlus and shows the result right next to the text. Works in **Chrome** and **Edge** (Manifest V3).

The extension is a thin client. All the work (scraping, search, red flags, AI verdicts) happens on the Infomedics server in the parent folder, so **the server must be running**.

## Set up

1. Start the server from the project root:
   ```bash
   npm install
   npm start
   ```
   Add `ANTHROPIC_API_KEY` to `.env` if you want AI verdicts (see the root README). Without it, results show the evidence and are marked **Not rated**.
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge) and turn on **Developer mode**.
3. Click **Load unpacked** and choose this `extension/` folder.
4. Pin the Infomedics icon if you like. The popup's status line shows whether it can reach the server.

The extension has a fixed ID (its manifest pins a public key), and the server accepts requests from that ID by default. Other websites and other extensions are refused.

## Use it

- **Select text** (12 to 8000 characters) on any page. A **Check with Infomedics** button appears under the selection. Click it for a result panel with live progress.
- **Right-click** a selection and choose **Check “…” with Infomedics**. This also works on tabs that were open before you installed the extension.
- **Toolbar icon** opens a popup to paste a claim, an AI answer, or a link, see history, and change settings. If text is selected on the page, the popup pre-fills it.
- Press **Esc**, click outside, or use **×** to close the panel. Closing it cancels the check.

A selected link, or a long AI answer, works too: links are read and assessed, and up to three claims are checked.

## Settings

The popup's **Settings** tab sets the server address (default `http://localhost:3000`). Saving a different address asks Chrome for permission to reach it. If the server is on another machine, set `HOST` on it, and remember the API has no login, so only expose it on networks you trust.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest; permissions `contextMenus`, `activeTab`, `scripting`, `storage`; pinned key |
| `background.js` | Service worker: right-click menu, runs checks against the server, saves history |
| `client.js` | Talks to the server (streamed `/api/check`); helper for pages to ask the worker |
| `content.js` | Selection button and result panel, inside a shadow root so page styles can't interfere |
| `render.js`, `card.css`, `panel.css` | Renders the server's result and styles it |
| `popup.html/.css/.js` | Toolbar popup |

Requests go through the background worker rather than from the page, so they are not subject to a site's CORS rules or content security policy, and pages cannot see the traffic.

## Notes

- The content script runs on every `http(s)` page to show the selection button. For a smaller footprint, remove `content_scripts` from the manifest and use the right-click menu and toolbar popup, which only need `activeTab`.
- Selected text is sent to your Infomedics server, and from there to PubMed, MedlinePlus, and (in AI mode) Anthropic. Nothing goes anywhere else.
- Before publishing to the Chrome Web Store or Edge Add-ons you would need a store listing and privacy policy, and a hosted server instead of `localhost`.
- Tests: `npm test` in the project root covers the background flow, client, and rendering using the real server.

## Disclaimer

Infomedics is a prototype and does not provide medical advice. Talk to a qualified clinician about health decisions.
