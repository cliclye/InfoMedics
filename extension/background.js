/*
 * Infomedics extension service worker.
 * - adds a "Check with Infomedics" right-click item for selected text
 * - runs checks against the Infomedics server (so pages never talk to it directly) and stores history
 */
importScripts('client.js');

var MENU_ID = 'infomedics-check';
var MAX_HISTORY = 15;
var MAX_CHARS = 8000;
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
        files: ['render.js', 'client.js', 'content.js']
      });
      await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e2) { /* restricted page: nothing we can show there */ }
  }
});

async function saveToHistory(result) {
  var stored = await chrome.storage.local.get('history');
  var history = (Array.isArray(stored.history) ? stored.history : []).filter(function (r) { return r && Array.isArray(r.claims); });
  history.unshift(result);
  await chrome.storage.local.set({ history: history.slice(0, MAX_HISTORY) });
}

function post(port, message) {
  try { port.postMessage(message); } catch (e) { /* the page or popup went away */ }
}

async function runCheck(port, rawText, abort) {
  var text = String(rawText || '').trim().slice(0, MAX_CHARS);
  if (!text) { post(port, { type: 'error', message: 'There is nothing to check.' }); return; }

  var result = null;
  var failure = null;
  try {
    var serverUrl = await InfomedicsClient.getServerUrl();
    await InfomedicsClient.streamCheck(serverUrl, text, function (event) {
      if (event.type === 'result') result = event.result;
      else if (event.type === 'error') failure = event.message;
      else post(port, event); // plan / step progress
    }, abort.signal);
    if (failure || !result) {
      post(port, { type: 'error', message: failure || 'No result came back. Please try again.' });
      return;
    }
    await saveToHistory(result);
    post(port, { type: 'result', result: result, serverUrl: serverUrl });
  } catch (e) {
    if (abort.signal.aborted) return;
    post(port, { type: 'error', message: (e && e.message) || 'Something went wrong while checking.' });
  }
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'check') return;
  var abort = new AbortController();
  port.onDisconnect.addListener(function () { abort.abort(); });
  port.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'check') runCheck(port, msg.text, abort);
  });
});

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
  if (msg && msg.type === 'get-css') {
    getCss()
      .then(function (css) { sendResponse({ ok: true, css: css }); })
      .catch(function () { sendResponse({ ok: false, css: '' }); });
    return true;
  }
  return false;
});
