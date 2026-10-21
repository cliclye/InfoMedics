# Infomedics browser extension (prototype)

Select a health claim on any web page and Infomedics shows a verdict card right next to it. Works in **Chrome** and **Edge** (Manifest V3). Results are **simulated**, exactly like the website prototype.

## Install (unpacked)

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `extension/` folder.
4. Optional: pin the Infomedics icon from the puzzle-piece menu.

If you change any file, click the reload icon on the extension card and refresh the page you are testing.

## How to use it

- **Select text** (12 to 2000 characters) on any page. A small **Check with Infomedics** button appears under the selection. Click it to open the result panel.
- **Right-click** the selection and choose **Check “…” with Infomedics**. This also works on a page that was already open when you installed the extension.
- **Toolbar icon** opens a popup where you can paste text, try examples, and see your history. If text is selected on the page, the popup pre-fills it.
- Press **Esc**, click outside, or use the **×** button to close the panel.

The panel shows the same result card as the website: verdict badge (color and icon), plain-language explanation, red flags, trusted sources, confidence, and the disclaimer. History is shared between the panel and the popup (`chrome.storage.local`, last 25).

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest; permissions: `contextMenus`, `activeTab`, `scripting`, `storage` |
| `background.js` | Service worker: right-click menu, runs the analysis, stores history |
| `analyze.js` | Mock analysis (keyword match + fallback heuristic). **The real-API hook lives here** |
| `data.js` | Mock claim library, sources, verdict definitions (**copy of `../data.js`**) |
| `content.js` | Selection button and result panel, drawn inside a shadow root so page styles can't interfere |
| `render.js`, `card.css`, `panel.css` | Result card markup and styles |
| `popup.html/.css/.js` | Toolbar popup |

`data.js` is duplicated from the website because an extension can only load files inside its own folder. If you edit the website's `data.js`, copy it over:

```bash
cp ../data.js data.js
```

## Notes on a real version

- Do the API call in `background.js`/`analyze.js` (see `REAL API HOOK`), not in the content script. Content scripts run under each page's CORS rules and anything in them is visible to the page, so API keys must live on your server, not in the extension.
- The content script runs on every `http(s)` page to show the selection button. For a less broad footprint, drop `content_scripts` and rely on the right-click menu and toolbar popup, which only need `activeTab`.
- Before publishing to the Chrome Web Store or Edge Add-ons you will need a privacy policy and store listing; the prototype sends no data anywhere.

## Disclaimer

Infomedics is a prototype and does not provide medical advice. Talk to a qualified clinician about health decisions.
