const el = document.getElementById("status");
const ws = new WebSocket("ws://127.0.0.1:8787");
// Declare ourselves a probe: the server treats an undeclared socket as the
// extension, and this one must not shadow the real background connection.
ws.onopen = () => {
  ws.send(JSON.stringify({ hello: "probe" }));
  el.textContent = "MCP server: connected";
  el.className = "on";
  ws.close();
};
ws.onerror = () => { el.textContent = "MCP server: not reachable"; el.className = "off"; };
