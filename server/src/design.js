// Reads a Claude Design export (the self-unpacking "Bundled Page" .html) or a plain
// HTML file, extracts its images, and returns a text outline with image markers in
// reading order so the model can map the design onto Squarespace sections and blocks.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DATA_DIR } from "./sqs.js";

const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg", "font/woff2": ".woff2", "text/javascript": ".js", "text/css": ".css" };

function scriptBlock(html, type) {
  const m = html.match(new RegExp(`<script type="__bundler/${type}">([\\s\\S]*?)</script>`));
  return m ? m[1].trim() : null;
}

function imageSize(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch {}
  return null;
}

const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");

export function readDesign(file, { outDir } = {}) {
  const src = fs.readFileSync(file, "utf8");
  const name = path.basename(file).replace(/\.html?$/i, "").replace(/[^\w.-]+/g, "-");
  const dir = outDir || path.join(DATA_DIR, "designs", name);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });

  let html = src;
  const images = {};
  const manifestText = scriptBlock(src, "manifest");
  if (manifestText) {
    const manifest = JSON.parse(manifestText);
    html = JSON.parse(scriptBlock(src, "template"));
    for (const [uuid, e] of Object.entries(manifest)) {
      let buf = Buffer.from(e.data, "base64");
      if (e.compressed) buf = zlib.gunzipSync(buf);
      if (!/^image\//.test(e.mime)) continue;
      const rel = `assets/${uuid}${EXT[e.mime] || ""}`;
      fs.writeFileSync(path.join(dir, rel), buf);
      images[uuid] = { file: path.join(dir, rel), mime: e.mime, bytes: buf.length, size: imageSize(buf) };
    }
  }

  // Walk the HTML: drop scripts/styles/fonts, mark images, keep text in order.
  let body = html.replace(/<(script|style|head|helmet|svg)\b[\s\S]*?<\/\1>/gi, " ");
  let n = 0;
  const used = [];
  const mark = (ref, alt) => {
    const uuid = (ref.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0];
    const img = uuid && images[uuid];
    if (!img) return " ";
    if (!img.ref) { img.ref = `img${++n}`; used.push({ ref: img.ref, ...img, alt: alt || "" }); }
    const k = img.ref;
    const sz = img.size ? ` ${img.size.w}x${img.size.h}` : "";
    return `\n[IMAGE ${k}${sz}${alt ? ` alt="${alt}"` : ""}]\n`;
  };
  body = body.replace(/<img\b[^>]*>/gi, (tag) => mark((tag.match(/src="([^"]+)"/) || [])[1] || "", (tag.match(/alt="([^"]*)"/) || [])[1]));
  body = body.replace(/url\((?:&quot;|["'])?([^)"'&]+)(?:&quot;|["'])?\)/gi, (_m, ref) => mark(ref, "background"));
  body = body.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/section|\/header|\/footer|\/tr)\b[^>]*>/gi, "\n");
  body = body.replace(/<h([1-6])\b[^>]*>/gi, (_m, l) => `\n${"#".repeat(Number(l))} `);
  body = body.replace(/<li\b[^>]*>/gi, "\n• ");
  body = decode(body.replace(/<[^>]+>/g, " "));
  const outline = body.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");

  // Images present in the bundle but not referenced in markup (e.g. set from JS).
  const unplaced = Object.values(images).filter((i) => !used.some((u) => u.file === i.file));

  fs.writeFileSync(path.join(dir, "outline.txt"), outline);
  return { dir, outline, images: used, unplacedImages: unplaced };
}
