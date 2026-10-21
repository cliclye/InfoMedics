/*
 * Infomedics in-page UI: when you select text, a small "Check" button appears.
 * Click it (or use the right-click menu) to see a result panel next to the selection.
 * All UI lives in a shadow root so the page's CSS can't break it, and ours can't leak out.
 */
(function () {
  'use strict';

  if (window.__infomedicsInjected) return;
  window.__infomedicsInjected = true;

  var R = window.InfomedicsRender;
  var MIN_CHARS = 12;
  var MAX_CHARS = 2000;

  var host = null;
  var shadow = null;
  var fab = null;
  var panel = null;
  var panelBody = null;
  var hostPromise = null;
  var lastText = '';
  var lastRect = null;
  var token = 0; // bumped on every new check/close so stale responses are ignored

  var LOGO_SVG = '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="9" fill="currentColor"/><path d="M16 8.5v15M8.5 16h15" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>';
  var FAB_SVG = '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="15" fill="#fff"/><path d="M16 9.5v13M9.5 16h13" stroke="#0b5f9a" stroke-width="4" stroke-linecap="round"/></svg>';

  function clamp(n, min, max) { return Math.max(min, Math.min(n, max)); }

  function plainRect(r) {
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  // ---------- Host / shadow DOM ----------
  function ensureHost() {
    if (hostPromise && host && host.isConnected) return hostPromise;

    host = document.createElement('div');
    host.id = 'infomedics-root';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });

    hostPromise = chrome.runtime.sendMessage({ type: 'get-css' }).then(function (resp) {
      var style = document.createElement('style');
      style.textContent = (resp && resp.css) || '';
      shadow.appendChild(style);

      fab = document.createElement('button');
      fab.type = 'button';
      fab.className = 'fab';
      fab.hidden = true;
      fab.innerHTML = FAB_SVG + '<span>Check with Infomedics</span>';
      // mousedown would collapse the selection before click fires
      fab.addEventListener('mousedown', function (e) { e.preventDefault(); });
      fab.addEventListener('click', function () { startCheck(lastText, lastRect); });
      shadow.appendChild(fab);

      panel = document.createElement('div');
      panel.className = 'panel';
      panel.hidden = true;
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Infomedics result');
      panel.innerHTML =
        '<div class="panel-head">' +
          '<span class="panel-logo">' + LOGO_SVG + '<span><span class="a">Info</span><span class="b">medics</span></span></span>' +
          '<span class="panel-proto">Prototype: simulated</span>' +
          '<button type="button" class="panel-close" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="panel-body" tabindex="-1" aria-live="polite"></div>';
      panelBody = panel.querySelector('.panel-body');
      panel.querySelector('.panel-close').addEventListener('click', closePanel);
      shadow.appendChild(panel);

      document.documentElement.appendChild(host);
    });
    return hostPromise;
  }

  // ---------- Floating button ----------
  function hideFab() { if (fab) fab.hidden = true; }

  function showFab(rect) {
    if (!fab) return;
    fab.hidden = false;
    var w = fab.offsetWidth;
    var h = fab.offsetHeight;
    var left = clamp(rect.right - w, 8, window.innerWidth - w - 8);
    var top = rect.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 8);
    fab.style.left = left + 'px';
    fab.style.top = top + 'px';
  }

  // ---------- Panel ----------
  function closePanel() {
    token++;
    if (panel) panel.hidden = true;
  }

  function placePanel(rect) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var w = Math.min(400, vw - 16);
    panel.style.width = w + 'px';
    panel.style.maxHeight = (vh - 16) + 'px';
    var h = panel.offsetHeight;
    var left;
    var top;
    if (rect) {
      left = clamp(rect.left, 8, vw - w - 8);
      top = rect.bottom + 10;
      if (top + h > vh - 8) {
        var above = rect.top - 10 - h;
        top = above >= 8 ? above : Math.max(8, vh - h - 8);
      }
    } else {
      left = vw - w - 16;
      top = 16;
    }
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  async function startCheck(text, rect) {
    text = String(text || '').trim();
    if (!text) return;
    var my = ++token;

    try { await ensureHost(); } catch (e) { return; }
    hideFab();
    panelBody.innerHTML = '<div class="panel-loading" role="status"><span class="panel-spinner" aria-hidden="true"></span><span>Checking trusted sources…</span></div>';
    panel.hidden = false;
    placePanel(rect);

    var resp = null;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'analyze', text: text });
    } catch (e) { /* extension was reloaded or updated */ }
    if (my !== token) return;

    if (!resp || !resp.ok) {
      panelBody.innerHTML = '<p class="panel-error">Could not check this right now. If you just reloaded the extension, refresh this page and try again.</p>';
      placePanel(rect);
      return;
    }
    panelBody.innerHTML = R.renderCard(resp.entry, { maxQuote: 140 });
    panelBody.scrollTop = 0;
    placePanel(rect);
    panelBody.focus({ preventScroll: true });
  }

  // ---------- Selection handling ----------
  function inHost(e) {
    return host && e.composedPath && e.composedPath().indexOf(host) !== -1;
  }

  function readSelection() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    var text = sel.toString().trim();
    if (text.length < MIN_CHARS || text.length > MAX_CHARS) return null;
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text: text, rect: plainRect(rect) };
  }

  function onSelectionChange(e) {
    if (inHost(e)) return;
    // wait a tick so the browser has finalized the selection
    setTimeout(async function () {
      var s = readSelection();
      if (!s) { hideFab(); return; }
      lastText = s.text;
      lastRect = s.rect;
      try { await ensureHost(); } catch (err) { return; }
      showFab(s.rect);
    }, 10);
  }

  document.addEventListener('mouseup', onSelectionChange, true);
  document.addEventListener('keyup', function (e) {
    if (e.key === 'Escape') { hideFab(); closePanel(); return; }
    if (e.shiftKey || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) onSelectionChange(e);
  }, true);

  document.addEventListener('mousedown', function (e) {
    if (inHost(e)) return;
    hideFab();
    closePanel();
  }, true);

  window.addEventListener('scroll', hideFab, true);
  window.addEventListener('resize', function () { hideFab(); });

  // ---------- Right-click menu / background messages ----------
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'check-selection') return;
    var s = readSelection();
    var text = (msg.text || (s && s.text) || '').trim();
    startCheck(text, s ? s.rect : lastRect);
  });
})();
