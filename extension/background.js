/* Browser Recon — background service worker.
 *
 * The extension is the trust boundary:
 *   - Sidebar (user-side) shows real tabs / accepts the keyword list.
 *   - This worker holds the Redactor table and is the *only* place that ever
 *     sees real titles, URLs, source bytes, or keyword strings.
 *   - The MCP server (and through it, the AI) only ever receives tokenized
 *     data. AI-controlled strings hitting the page (eval) get reversed here
 *     just before CDP, so identifiers resolve correctly.
 *
 * The MCP server no longer offers list_tabs / attach — those are
 * user-initiated from the sidebar. The server learns of attach state via
 * unsolicited events on the same WebSocket.
 */

import { Redactor } from "./redactor.js";

const WS_URL = "ws://127.0.0.1:8787";
const redactor = new Redactor();

let ws = null;
let attachedTab = null;
let attachedTabUrl = null;
let keywords = [];
// Redaction is OFF by default: the server behaves like a plain CDP bridge,
// passing real URLs, titles, sources and headers through. Turning it on is an
// explicit, sidebar-only act — there is no RPC method for it, so the AI cannot
// lift its own blindfold.
let redacting = false;
const mode = () => (redacting ? "redact" : "raw");
const scripts = new Map(); // scriptId -> {scriptId, url, length}
const requests = new Map(); // requestId -> {requestId, method, url, type, status, headers, mimeType, size}

// Restore persisted keywords + toggle on worker boot.
chrome.storage.local.get(["keywords", "redact"]).then(({ keywords: k, redact }) => {
  if (Array.isArray(k)) {
    keywords = k;
    redactor.setKeywords(keywords);
  }
  redacting = redact === true;
});

// ---- Redaction gate ------------------------------------------------------
// Every outbound path goes through these instead of calling the redactor
// directly, so the toggle is one branch in one place rather than a flag
// threaded through a dozen call sites.
const red = (text) => (redacting ? redactor.redact(text || "") : text);
const redVal = (v) => (redacting ? redactor.redactValue(v) : v);
const heads = (h) => {
  if (!h) return h;
  return redacting ? redactor.sanitizeHeaders(h) : h;
};
// Inbound is unconditional: tokens the AI learned before a switch to raw must
// still resolve, and unredact is a no-op on text that contains no tokens.
const unred = (text) => redactor.unredact(text || "");

// Make clicking the action icon open the side panel (Chrome 114+).
chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  .catch(() => {});

// ---- WebSocket (with reconnect) ------------------------------------------
function connect() {
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    return scheduleReconnect();
  }
  ws.onopen = () => {
    console.log("[recon] connected to MCP server");
    // Re-announce attach state on reconnect.
    if (attachedTab != null) notifyServer({ event: "attached" });
  };
  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    try {
      const result = await dispatch(msg.method, msg.params || {});
      reply({ id: msg.id, ok: true, result });
    } catch (e) {
      reply({ id: msg.id, ok: false, error: e?.message || String(e) });
    }
  };
}
function reply(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function notifyServer(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

// Keep the service worker alive while we have a job to do.
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState > 1) connect();
});
connect();

// ---- CDP helper ----------------------------------------------------------
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (attachedTab == null) return reject(new Error("not attached to any tab"));
    chrome.debugger.sendCommand({ tabId: attachedTab }, method, params, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTab) return;
  if (method === "Debugger.scriptParsed") {
    if (params.url) redactor.addOrigin(params.url);
    scripts.set(params.scriptId, {
      scriptId: params.scriptId,
      url: params.url || "",
      length: params.length,
    });
  } else if (method === "Network.requestWillBeSent") {
    if (params.request?.url) redactor.addOrigin(params.request.url);
    requests.set(params.requestId, {
      requestId: params.requestId,
      method: params.request.method,
      url: params.request.url,
      type: params.type || "",
    });
  } else if (method === "Network.responseReceived") {
    const r = requests.get(params.requestId) || { requestId: params.requestId };
    r.status = params.response.status;
    r.headers = params.response.headers || {};
    r.type = params.type || r.type;
    r.mimeType = params.response.mimeType;
    requests.set(params.requestId, r);
  } else if (method === "Network.loadingFinished") {
    const r = requests.get(params.requestId);
    if (r) r.size = Math.round(params.encodedDataLength);
  } else if (
    method === "Runtime.executionContextsCleared" ||
    (method === "Page.frameNavigated" && !params.frame.parentId)
  ) {
    if (method === "Page.frameNavigated" && params.frame?.url) {
      redactor.addOrigin(params.frame.url);
    }
    onNavigated();
  }
});

function onNavigated() {
  scripts.clear();
  requests.clear();
  notifyServer({ event: "navigated" });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTab) {
    attachedTab = null;
    attachedTabUrl = null;
    notifyServer({ event: "detached" });
    broadcastSidebar({ kind: "stateChanged" });
  }
});

// ---- Server RPC methods (responses are redacted on the way out) ----------
async function dispatch(method, p) {
  switch (method) {
    case "status":
      return {
        attached: attachedTab != null,
        mode: mode(),
        redactorEntries: redactor.stats().entries,
      };
    case "listScripts": {
      return Array.from(scripts.values()).map((s) => ({
        ...s,
        url: red(s.url),
      }));
    }
    case "getScriptSource": {
      const res = await cdp("Debugger.getScriptSource", { scriptId: p.scriptId });
      return { source: red(res.scriptSource) };
    }
    case "eval": {
      // AI input — reverse-substitute identifiers/strings into their real
      // names before the page sees them, so document.querySelector(".tok_x")
      // actually finds the real class.
      const expression = unred(p.expression);
      const res = await cdp("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: !!p.awaitPromise,
        userGesture: true,
      });
      if (res.exceptionDetails) {
        const ex = res.exceptionDetails;
        return {
          exception: red(ex.exception?.description || ex.text || "error"),
        };
      }
      return { value: redVal(res.result?.value) };
    }
    case "listRequests": {
      return Array.from(requests.values()).map((r) => ({
        ...r,
        url: red(r.url),
        headers: r.headers ? heads(r.headers) : undefined,
      }));
    }
    case "getResponseBody": {
      const meta = requests.get(p.requestId) || {};
      let body = "";
      try {
        const res = await cdp("Network.getResponseBody", { requestId: p.requestId });
        body = res.base64Encoded ? atob(res.body) : res.body;
      } catch (e) {
        body = `[no body available: ${e.message}]`;
      }
      return {
        body: red(body),
        meta: {
          method: meta.method,
          url: red(meta.url),
          status: meta.status,
          mimeType: meta.mimeType,
          headers: meta.headers ? heads(meta.headers) : {},
        },
      };
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

// ---- Sidebar control plane ----------------------------------------------
function broadcastSidebar(msg) {
  // best-effort — sidebar may not be open
  chrome.runtime.sendMessage({ kind: msg.kind || "event", ...msg }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "getStatus":
          sendResponse({
            wsConnected: !!ws && ws.readyState === 1,
            attached: attachedTab != null,
            attachedTabId: attachedTab,
            keywords,
            redacting,
            mode: mode(),
            stats: redactor.stats(),
          });
          return;
        case "setRedact": {
          const next = msg.on === true;
          if (next !== redacting) {
            redacting = next;
            await chrome.storage.local.set({ redact: redacting });
            // Re-seed the table so turning redaction on mid-session covers the
            // tab we're already attached to.
            if (redacting) {
              redactor.reset();
              for (const k of keywords) redactor.addKeyword(k);
              if (attachedTabUrl) redactor.addOrigin(attachedTabUrl);
            }
            // The server caches beautified sources captured under the old
            // setting — make it drop them.
            notifyServer({ event: "modeChanged", mode: mode() });
          }
          sendResponse({ ok: true, redacting });
          return;
        }
        case "listTabs": {
          const tabs = await chrome.tabs.query({});
          sendResponse(
            tabs.map((t) => ({
              id: t.id,
              title: t.title,
              url: t.url,
              favIconUrl: t.favIconUrl,
            }))
          );
          return;
        }
        case "setKeywords": {
          keywords = (msg.keywords || []).filter(Boolean);
          await chrome.storage.local.set({ keywords });
          // Rebuild the table. If attached, re-seed with the tab's origin too.
          // Note: tokens in the AI's prior context become stale — config
          // changes are meant to happen *before* the AI starts working.
          redactor.reset();
          for (const k of keywords) redactor.addKeyword(k);
          if (attachedTabUrl) redactor.addOrigin(attachedTabUrl);
          sendResponse({ ok: true });
          return;
        }
        case "attach": {
          await new Promise((resolve, reject) => {
            chrome.debugger.attach({ tabId: msg.tabId }, "1.3", () => {
              const err = chrome.runtime.lastError;
              if (err) {
                let hint = err.message;
                if (
                  /another debugger|debugger is already attached|chrome-extension:\/\/ URL of different extension/i.test(
                    err.message
                  )
                ) {
                  hint =
                    err.message +
                    " — close DevTools on this tab and/or disable other extensions (esp. content blockers, password managers, other devtools/scraping extensions) on this site, then retry.";
                }
                reject(new Error(hint));
              } else resolve();
            });
          });
          attachedTab = msg.tabId;
          try {
            const tab = await chrome.tabs.get(msg.tabId);
            attachedTabUrl = tab.url || null;
          } catch {
            attachedTabUrl = null;
          }
          // Fresh table per attach session — keywords reseed, origin seeds itself.
          redactor.reset();
          for (const k of keywords) redactor.addKeyword(k);
          if (attachedTabUrl) redactor.addOrigin(attachedTabUrl);
          scripts.clear();
          requests.clear();
          await cdp("Runtime.enable");
          await cdp("Debugger.enable");
          await cdp("Network.enable");
          await cdp("Page.enable");
          notifyServer({ event: "attached" });
          broadcastSidebar({ kind: "stateChanged" });
          sendResponse({ ok: true });
          return;
        }
        case "detach": {
          if (attachedTab != null) {
            try {
              await chrome.debugger.detach({ tabId: attachedTab });
            } catch {}
          }
          attachedTab = null;
          attachedTabUrl = null;
          scripts.clear();
          requests.clear();
          notifyServer({ event: "detached" });
          broadcastSidebar({ kind: "stateChanged" });
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ error: "unknown command" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // async sendResponse
});
