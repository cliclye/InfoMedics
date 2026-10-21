/*
 * Infomedics extension service worker.
 * - adds a "Check with Infomedics" right-click item for selected text
 * - runs the (mock) analysis and stores history for the popup
 */
importScripts('data.js', 'analyze.js');

var MENU_ID = 'infomedics-check';
var MAX_HISTORY = 25;
var MAX_CHARS = 2000;
var cssCache = null;

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Check “%s” with Infomedics',
      contexts: ['selection']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async function (info, tab) {
  if (info.menuItemId !== MENU_ID || !tab || tab.id === undefined) return;
  var msg = { type: 'check-selection', text: info.selectionText || '' };
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // Content script is missing (tab opened before install, or a restricted page).
    // The click grants activeTab, so try injecting it now.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['data.js', 'render.js', 'content.js']
      });
      await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e2) { /* restricted page: nothing we can show there */ }
  }
});

async function analyzeAndStore(rawText) {
  var text = String(rawText || '').trim().slice(0, MAX_CHARS);
  if (!text) throw new Error('empty');

  var result = await InfomedicsAnalyze.analyzeClaim(text);
  var entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: text,
    ts: Date.now(),
    result: result
  };

  var stored = await chrome.storage.local.get('history');
  var history = Array.isArray(stored.history) ? stored.history : [];
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, MAX_HISTORY) });
  return entry;
}

// Style text for the in-page panel (it lives in a shadow root, so page CSS can't touch it).
async function getCss() {
  if (cssCache) return cssCache;
  var files = ['card.css', 'panel.css'];
  var parts = await Promise.all(files.map(function (f) {
    return fetch(chrome.runtime.getURL(f)).then(function (r) { return r.text(); });
  }));
  cssCache = parts.join('\n');
  return cssCache;
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return false;

  if (msg.type === 'analyze') {
    analyzeAndStore(msg.text)
      .then(function (entry) { sendResponse({ ok: true, entry: entry }); })
      .catch(function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); });
    return true; // async response
  }

  if (msg.type === 'get-css') {
    getCss()
      .then(function (css) { sendResponse({ ok: true, css: css }); })
      .catch(function () { sendResponse({ ok: false, css: '' }); });
    return true;
  }

  return false;
});
