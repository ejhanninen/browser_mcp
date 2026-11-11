import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";

// A fake minified script the stub "extension" will serve.
const FAKE = `function add(a,b){return a+b}const mul=(a,b)=>a*b;class Foo{bar(){return this.secretToken||"x"}}window.__API="/api/v2/login";`;

// 1) Spawn the server via MCP stdio (this also opens its WS server on 8787).
const transport = new StdioClientTransport({ command: "node", args: ["index.js"] });
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

// 2) Connect a stub extension that answers the server's RPC calls.
const ext = await new Promise((resolve, reject) => {
  const tryConnect = () => {
    const w = new WebSocket("ws://127.0.0.1:8787");
    w.on("open", () => resolve(w));
    w.on("error", () => setTimeout(tryConnect, 200));
  };
  tryConnect();
});
ext.on("message", (buf) => {
  const { id, method } = JSON.parse(buf.toString());
  const respond = (result) => ext.send(JSON.stringify({ id, ok: true, result }));
  if (method === "listScripts") respond([{ scriptId: "7", url: "https://x.test/app.min.js", length: FAKE.length }]);
  else if (method === "getScriptSource") respond({ source: FAKE });
  else if (method === "listRequests") respond([{ requestId: "R1", method: "POST", url: "https://x.test/api/v2/login", type: "XHR", status: 200, headers: { "content-type": "application/json" } }]);
  else if (method === "getResponseBody") respond({ body: JSON.stringify({ ok: true, user: { id: 9, name: "ada" }, items: [1, 2, 3, 4, 5] }), meta: { method: "POST", url: "https://x.test/api/v2/login", status: 200, headers: { "content-type": "application/json" } } });
  else ext.send(JSON.stringify({ id, ok: false, error: "unhandled " + method }));
});

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content.map((c) => c.text).join("\n");
};

console.log("== list_scripts ==\n" + (await call("list_scripts")));
console.log("\n== get_script_outline ==\n" + (await call("get_script_outline", { scriptId: "7" })));
console.log("\n== read_script (lines 1-6) ==\n" + (await call("read_script", { scriptId: "7", startLine: 1, lineCount: 6 })));
console.log("\n== search_sources 'secretToken' ==\n" + (await call("search_sources", { query: "secretToken" })));
console.log("\n== inspect_response (shape) ==\n" + (await call("inspect_response", { requestId: "R1" })));
console.log("\n== inspect_response jsonPath $.user.name ==\n" + (await call("inspect_response", { requestId: "R1", jsonPath: "$.user.name" })));

await client.close();
ext.close();
process.exit(0);
