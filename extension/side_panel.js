const $status = document.getElementById("status");
const $tabs = document.getElementById("tabs");
const $keywords = document.getElementById("keywords");
const $redact = document.getElementById("redact");

let transientError = null; // shown in status until the next successful action

function send(type, extra = {}) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage({ type, ...extra }, (r) => resolve(r))
  );
}

let lastKeywordsValue = "";

async function refresh() {
  const status = await send("getStatus");
  if (!status) {
    $status.textContent = "extension worker not responding";
    $status.className = "status off";
    return;
  }

  // Only overwrite the textarea if the user isn't actively editing it.
  const incoming = (status.keywords || []).join(", ");
  if (document.activeElement !== $keywords && incoming !== lastKeywordsValue) {
    $keywords.value = incoming;
    lastKeywordsValue = incoming;
  }

  // `redacting` is absent if the worker is still running an older build —
  // say so rather than silently showing the wrong state.
  if (status.redacting === undefined) {
    $status.textContent = "stale extension build — reload it at chrome://extensions";
    $status.className = "status off";
    return;
  }
  const redacting = status.redacting === true;
  document.body.classList.toggle("redacting", redacting);
  if (document.activeElement !== $redact) $redact.checked = redacting;
  $keywords.disabled = !redacting;

  if (transientError) {
    $status.textContent = transientError;
    $status.className = "status off";
  } else if (status.wsConnected && status.attached) {
    $status.textContent = redacting
      ? `attached · tab #${status.attachedTabId} · redacting · ${status.stats.entries} tokens in table`
      : `attached · tab #${status.attachedTabId} · raw (no redaction)`;
    $status.className = "status on";
  } else if (status.wsConnected) {
    $status.textContent = "MCP server connected · pick a tab below to attach";
    $status.className = "status warn";
  } else {
    $status.textContent = "MCP server unreachable — run `node server/index.js`";
    $status.className = "status off";
  }

  const tabs = (await send("listTabs")) || [];
  $tabs.innerHTML = "";
  for (const t of tabs) {
    // CDP can only attach to http(s) pages — filter everything else (chrome://,
    // chrome-extension://, devtools://, about:, file://, view-source:, blank).
    if (!/^https?:\/\//i.test(t.url || "")) continue;
    const div = document.createElement("div");
    const isAttached = status.attached && status.attachedTabId === t.id;
    div.className = "tab" + (isAttached ? " attached" : "");
    const img = document.createElement("img");
    if (t.favIconUrl) img.src = t.favIconUrl;
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = t.title || t.url || `tab ${t.id}`;
    title.title = t.url || "";
    const btn = document.createElement("button");
    btn.textContent = isAttached ? "Detach" : "Attach";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      transientError = null;
      if (isAttached) {
        const r = await send("detach");
        if (r && r.ok === false)
          transientError = "detach failed: " + (r.error || "unknown");
      } else {
        const r = await send("attach", { tabId: t.id });
        if (r && r.ok === false)
          transientError = "attach failed: " + (r.error || "unknown");
      }
      refresh();
    });
    div.append(img, title, btn);
    $tabs.appendChild(div);
  }
}

let saveTimer;
$keywords.addEventListener("input", () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const list = $keywords.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    lastKeywordsValue = list.join(", ");
    await send("setKeywords", { keywords: list });
    refresh();
  }, 500);
});

$redact.addEventListener("change", async () => {
  transientError = null;
  const r = await send("setRedact", { on: $redact.checked });
  if (!r || r.ok !== true) {
    transientError = "could not change redaction — reload the extension";
    $redact.checked = !$redact.checked;
  }
  refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === "stateChanged") refresh();
});

refresh();
setInterval(refresh, 3000);
