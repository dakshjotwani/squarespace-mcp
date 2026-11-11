// Bridge between this MCP server and the Chrome extension.
//
// The first server process listens on 127.0.0.1:47321. The extension connects to
// /bridge. Any further server processes (e.g. a second Claude window) find the port
// taken and connect to /peer instead; the primary relays their requests to the
// extension. If the primary exits, a peer takes over the port.

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

export const PORT = 47321;
export const EXTENSION_ID = "hbcngfeechicaonnjadpejegdcjfaojo";
const ALLOWED_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const TIMEOUT_MS = 120_000;

const log = (...a) => console.error("[bridge]", ...a);

export class Bridge {
  constructor() {
    this.mode = "starting"; // "primary" | "peer"
    this.extension = null; // ws to extension (primary only)
    this.extensionVersion = null;
    this.upstream = null; // ws to primary (peer only)
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.relays = new Map(); // id -> peer ws (primary only)
    this.start();
  }

  start() {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
    wss.on("listening", () => { this.mode = "primary"; this.wss = wss; log("listening on", PORT); });
    wss.on("error", (e) => {
      if (e.code === "EADDRINUSE") { this.becomePeer(); }
      else log("server error", e.message);
    });
    wss.on("connection", (ws, req) => this.onConnection(ws, req));
    setInterval(() => {
      if (this.extension?.readyState === WebSocket.OPEN) this.extension.send(JSON.stringify({ type: "ping" }));
    }, 20_000).unref();
  }

  becomePeer() {
    this.mode = "peer";
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/peer`);
    ws.on("open", () => { this.upstream = ws; log("connected to primary as peer"); });
    ws.on("message", (d) => this.onReply(JSON.parse(d.toString())));
    ws.on("close", () => {
      this.upstream = null;
      // Primary went away: try to take over the port shortly.
      setTimeout(() => this.start(), 500 + Math.random() * 1000);
    });
    ws.on("error", () => {});
  }

  onConnection(ws, req) {
    const path = req.url || "";
    if (path.startsWith("/bridge")) {
      if (req.headers.origin !== ALLOWED_ORIGIN) { ws.close(1008, "origin not allowed"); return; }
      this.extension?.close();
      this.extension = ws;
      log("extension connected");
      ws.on("message", (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === "hello") { this.extensionVersion = msg.version; return; }
        if (msg.type === "pong") return;
        const peer = this.relays.get(msg.id);
        if (peer) { this.relays.delete(msg.id); if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(msg)); return; }
        this.onReply(msg);
      });
      ws.on("close", () => { if (this.extension === ws) { this.extension = null; log("extension disconnected"); } });
      return;
    }
    if (path.startsWith("/peer")) {
      // Only other local server processes; browsers always send an Origin header.
      if (req.headers.origin) { ws.close(1008, "origin not allowed"); return; }
      ws.on("message", (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type !== "request") return;
        if (!this.extension || this.extension.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: msg.id, ok: false, error: EXT_MISSING }));
          return;
        }
        this.relays.set(msg.id, ws);
        this.extension.send(JSON.stringify(msg));
      });
      return;
    }
    ws.close(1008, "unknown path");
  }

  onReply(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
  }

  connected() {
    if (this.mode === "primary") return this.extension?.readyState === WebSocket.OPEN;
    return this.upstream?.readyState === WebSocket.OPEN; // primary decides about the extension
  }

  async call(op, args) {
    const target = this.mode === "primary" ? this.extension : this.upstream;
    if (!target || target.readyState !== WebSocket.OPEN) {
      // Give the extension a moment to (re)connect — its keepalive runs every 30 s.
      for (let i = 0; i < 20 && !this.connected(); i++) await new Promise((r) => setTimeout(r, 500));
    }
    const t = this.mode === "primary" ? this.extension : this.upstream;
    if (!t || t.readyState !== WebSocket.OPEN) throw new Error(EXT_MISSING);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out waiting for Chrome (${op})`)); }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      t.send(JSON.stringify({ type: "request", id, op, args }));
    });
  }
}

export const EXT_MISSING =
  "The Squarespace MCP Bridge Chrome extension is not connected. Make sure Chrome is open, the extension is installed and enabled, and you are logged in to Squarespace in Chrome. Clicking the extension's icon wakes it up.";
