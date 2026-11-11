// Squarespace MCP Bridge — service worker.
// Connects to the local MCP server over WebSocket and performs HTTP requests to
// *.squarespace.com on its behalf, using the browser's existing Squarespace login.
// Only https://*.squarespace.com URLs are ever fetched; anything else is refused.

const PORT = 47321;
const URL_WS = `ws://127.0.0.1:${PORT}/bridge`;
let ws = null;
let lastStatus = { connected: false, since: null, lastRequest: null, lastError: null };

function setStatus(patch) {
  lastStatus = { ...lastStatus, ...patch };
  chrome.storage.session?.set({ status: lastStatus }).catch(() => {});
  chrome.action.setBadgeText({ text: lastStatus.connected ? "on" : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#3f5fd0" }).catch(() => {});
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(URL_WS);
  } catch (e) {
    setStatus({ connected: false, lastError: String(e) });
    return;
  }
  ws.onopen = () => {
    setStatus({ connected: true, since: Date.now(), lastError: null });
    ws.send(JSON.stringify({ type: "hello", version: chrome.runtime.getManifest().version }));
  };
  ws.onclose = () => { setStatus({ connected: false }); ws = null; };
  ws.onerror = () => {};
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "ping") { ws?.send(JSON.stringify({ type: "pong" })); return; }
    if (msg.type !== "request" || !msg.id) return;
    let reply;
    try {
      reply = { id: msg.id, ok: true, result: await handle(msg.op, msg.args || {}) };
    } catch (e) {
      reply = { id: msg.id, ok: false, error: String(e && e.message ? e.message : e) };
      setStatus({ lastError: reply.error });
    }
    try { ws?.send(JSON.stringify(reply)); } catch {}
  };
}

function assertAllowed(url) {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("Only https URLs are allowed");
  if (!(u.hostname === "squarespace.com" || u.hostname.endsWith(".squarespace.com")))
    throw new Error(`Refusing to contact ${u.hostname}: only *.squarespace.com is allowed`);
  return u;
}

async function crumbFor(host) {
  const c = await chrome.cookies.get({ url: `https://${host}/`, name: "crumb" });
  return c ? c.value : null;
}

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || "application/octet-stream" });
}

async function handle(op, args) {
  if (op === "status") {
    return { version: chrome.runtime.getManifest().version };
  }
  if (op === "loggedIn") {
    // Is there a Squarespace session for this site host?
    const host = assertAllowed(`https://${args.host}/`).hostname;
    const crumb = await crumbFor(host);
    return { host, hasCrumb: !!crumb };
  }
  if (op === "http") {
    const u = assertAllowed(args.url);
    const headers = { ...(args.headers || {}) };
    // The site's CSRF token is its crumb cookie. Attach it for requests to the site itself.
    if (args.csrf !== false && u.hostname !== "media-api.squarespace.com") {
      const crumb = await crumbFor(u.hostname);
      if (crumb) headers["X-CSRF-Token"] = crumb;
    }
    let body;
    switch (args.bodyType) {
      case "json": body = JSON.stringify(args.body); headers["Content-Type"] = headers["Content-Type"] || "application/json"; break;
      case "form": body = new URLSearchParams(args.body).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"; break;
      case "text": body = String(args.body ?? ""); headers["Content-Type"] = headers["Content-Type"] || "text/plain"; break;
      case "multipart": {
        const fd = new FormData();
        for (const [k, v] of Object.entries(args.body?.fields || {})) fd.append(k, v);
        for (const f of args.body?.files || []) fd.append(f.field, b64ToBlob(f.base64, f.type), f.name);
        body = fd;
        break;
      }
      default: body = undefined;
    }
    setStatus({ lastRequest: `${args.method || "GET"} ${u.hostname}${u.pathname}` });
    const res = await fetch(u.toString(), {
      method: args.method || "GET",
      headers,
      body,
      credentials: "include",
      redirect: "follow",
    });
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get("content-type"), text };
  }
  throw new Error(`Unknown op ${op}`);
}

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m === "status") { connect(); send(lastStatus); }
  return false;
});
connect();
