# Browser Recon — an MCP bridge to the Chrome DevTools Protocol

Lets Claude inspect a live Chrome tab: run JS in the page, read and grep the
loaded scripts, look at network requests.

```
Claude  <--stdio (MCP)-->  server/  <--WebSocket :8787-->  extension/  --CDP-->  Chrome tab
```

A Chrome extension attaches to the tab you pick and ferries DevTools Protocol
commands. A local MCP server exposes that to Claude as tools, keeping responses
small — outlines and bounded slices instead of whole files.

Optionally it can **redact the site's identity**: with the toggle on, domains,
page titles and any keywords you list become opaque `tok_xxxxxx` tokens, so
Claude sees a generic web app. Off by default.

## Install

Needs Node 18+ and Chrome 114+.

**1. The server**

```bash
cd server
npm install
```

**2. Register it with Claude**

Claude Desktop — add to `claude_desktop_config.json`, then restart:

```json
{
  "mcpServers": {
    "browser-recon": { "command": "node", "args": ["/ABSOLUTE/PATH/server/index.js"] }
  }
}
```

Claude Code:

```bash
claude mcp add browser-recon -- node /ABSOLUTE/PATH/server/index.js
```

**3. The extension**

At `chrome://extensions`, enable Developer Mode, click **Load unpacked** and
select the `extension/` folder. The toolbar icon opens the sidebar.

## Usage

1. Open the sidebar and click **Attach** next to the tab you want.
2. **Reload the page.** CDP only reports scripts and requests that happen after
   attaching, so a page loaded earlier looks empty.
3. Ask Claude: *"search the sources for `getToken`"*, *"outline that script,
   then show me lines 40–80"*, *"what shape does the `/login` response have?"*

To hide the site's identity, tick **Redact identity** in the sidebar and list
any brand keywords (comma-separated) before Claude starts working. The toggle
lives only in the sidebar — there's no tool for it, so Claude can't turn off its
own blindfold. It's a convenience for keeping a site out of a model's context,
not a security boundary.

Available tools: `status`, `eval_js`, `list_scripts`, `get_script_outline`,
`read_script`, `search_sources`, `list_requests`, `inspect_response`.

Notes:

- Attaching shows Chrome's "being debugged" banner — that's `chrome.debugger`.
- After editing anything in `extension/`, hit reload on the extension card;
  otherwise Chrome keeps running the old code.
- Desktop and Claude Code can both be connected at once. The first server to
  start owns port 8787, the rest relay through it.
- `cd server && npm test` runs the whole chain against a stub extension, no
  browser needed.
- Point this only at sites you own or are authorized to inspect.
