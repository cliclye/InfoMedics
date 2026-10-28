/*
 * Shared by the background worker, the in-page panel, and the popup.
 *
 *  - streamCheck(): talks to the Infomedics server (/api/check, streamed NDJSON). Used by the background worker only,
 *    so API calls never run inside web pages (page CORS rules, and pages can't see the extension's traffic).
 *  - checkViaBackground(): what pages and the popup call; it asks the background worker to run the check and relays
 *    progress events back.
 */
(function (root) {
  'use strict';

  var DEFAULT_SERVER = 'http://localhost:3000';

  function normalizeServerUrl(raw) {
    try {
      var u = new URL(String(raw || '').trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.origin;
    } catch (e) {
      return null;
    }
  }

  async function getServerUrl() {
    try {
      var stored = await chrome.storage.local.get('serverUrl');
      return normalizeServerUrl(stored.serverUrl) || DEFAULT_SERVER;
    } catch (e) {
      return DEFAULT_SERVER;
    }
  }

  function unreachable(serverUrl) {
    return new Error('Could not reach the Infomedics server at ' + serverUrl + '. Start it with “npm start”, or change the address in the extension’s Settings.');
  }

  function parseEvent(line) {
    try { return JSON.parse(line); } catch (e) { throw new Error('The server sent an unreadable response. Make sure it is the Infomedics server.'); }
  }

  /**
   * POST the text to the server and call onEvent for each streamed event.
   * Throws an Error with a user-friendly message on connection or HTTP problems.
   */
  async function streamCheck(serverUrl, text, onEvent, signal) {
    var res;
    try {
      res = await fetch(serverUrl + '/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text }),
        signal: signal
      });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      throw unreachable(serverUrl);
    }
    if (!res.ok) {
      var message = 'The server returned an error (' + res.status + ').';
      if (res.status === 403) message = 'The server refused this request. If it runs on another machine, start it there with HOST=0.0.0.0; otherwise update the Infomedics server and try again.';
      try { var body = await res.json(); if (body && body.error && res.status !== 403) message = body.error; } catch (e) { /* keep default */ }
      throw new Error(message);
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        var line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onEvent(parseEvent(line));
      }
    }
    if (buffer.trim()) onEvent(parseEvent(buffer.trim()));
  }

  /**
   * Ask the background worker to check `text`.
   * @returns {{promise: Promise<{result: object, serverUrl: string}>, cancel: Function}}
   */
  function checkViaBackground(text, onEvent) {
    var port = chrome.runtime.connect({ name: 'check' });
    var finished = false;
    var promise = new Promise(function (resolve, reject) {
      port.onMessage.addListener(function (msg) {
        if (msg.type === 'result') { finished = true; resolve({ result: msg.result, serverUrl: msg.serverUrl }); port.disconnect(); }
        else if (msg.type === 'error') { finished = true; reject(new Error(msg.message)); port.disconnect(); }
        else if (onEvent) onEvent(msg);
      });
      port.onDisconnect.addListener(function () {
        if (!finished) reject(new Error('The check was interrupted. If you just reloaded the extension, refresh this page and try again.'));
      });
      port.postMessage({ type: 'check', text: text });
    });
    return {
      promise: promise,
      cancel: function () { finished = true; try { port.disconnect(); } catch (e) { /* already closed */ } }
    };
  }

  root.InfomedicsClient = {
    DEFAULT_SERVER: DEFAULT_SERVER,
    normalizeServerUrl: normalizeServerUrl,
    getServerUrl: getServerUrl,
    streamCheck: streamCheck,
    checkViaBackground: checkViaBackground
  };
})(globalThis);
