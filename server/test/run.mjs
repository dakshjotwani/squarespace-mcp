// Usage: node test/run.mjs calls.json   (calls.json = [{"tool":"status","args":{...}}, ...])
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const calls = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const client = new Client({ name: "e2e", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/index.js", import.meta.url))], env: { ...process.env }, stderr: "inherit" }));
for (let i = 0; i < 40; i++) {
  const r = await client.callTool({ name: "status", arguments: {} });
  if (JSON.parse(r.content[0].text).bridge === "connected") break;
  if (i === 0) console.error("waiting for the Chrome extension to connect…");
  await new Promise((r) => setTimeout(r, 1500));
}
const out = {};
for (const [i, c] of calls.entries()) {
  // allow "$prev.<key>" references to earlier results by index: {"$ref":"2.imageId"}
  const args = JSON.parse(JSON.stringify(c.args || {}), (_k, v) => (v && v.$ref ? v.$ref.split(".").slice(1).reduce((o, k) => o?.[k], out[v.$ref.split(".")[0]]) : v));
  const t0 = Date.now();
  const r = await client.callTool({ name: c.tool, arguments: args });
  const txt = r.content[0].text;
  try { out[i] = JSON.parse(txt); } catch { out[i] = txt; }
  console.log(`\n### ${i} ${c.tool} ${r.isError ? "ERROR" : "ok"} (${Date.now() - t0} ms)\n${txt.length > (c.max || 2500) ? txt.slice(0, c.max || 2500) + " …[" + txt.length + "]" : txt}`);
  if (r.isError && c.stopOnError !== false) break;
}
await client.close();
