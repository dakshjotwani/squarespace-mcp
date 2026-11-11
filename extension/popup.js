function render(s) {
  const on = s && s.connected;
  document.getElementById("dot").className = "dot " + (on ? "on" : "off");
  document.getElementById("state").textContent = on ? "Connected to Claude" : "Not connected";
  document.getElementById("detail").textContent = on
    ? (s.lastRequest ? "Last request: " + s.lastRequest : "Waiting for requests.")
    : "Open Claude (with the Squarespace MCP installed). This turns on by itself once Claude is running.";
}
chrome.runtime.sendMessage("status", render);
setTimeout(() => chrome.runtime.sendMessage("status", render), 1200);
