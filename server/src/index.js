#!/usr/bin/env node
// Squarespace MCP server: builds Squarespace 7.1 sites through the editor's own
// (unofficial) API, using the person's Chrome login via the bridge extension.

import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Bridge } from "./bridge.js";
import { Squarespace, siteHost, DATA_DIR } from "./sqs.js";
import { applySectionSpec, summarizeSections, deepMerge, BLOCK_TYPES, THEMES, blockInfo, buildGridContents, blockId, defaults } from "./blocks.js";
import { readDesign } from "./design.js";

const bridge = new Bridge();
const sqs = new Squarespace(bridge);
const server = new McpServer({ name: "squarespace", version: "0.1.0" }, {
  instructions: [
    "Builds and edits Squarespace 7.1 websites through the editor's own API, using the user's Chrome login (via the Squarespace MCP Bridge extension).",
    "Typical flow for turning a Claude Design export into a site: read_design → get_site_styles → set_palette / set_theme_colors / set_fonts / set_button_style → list_pages / create_page → upload_image for each photo → build_sections per page → check the live page.",
    "Layout: Fluid Engine grid, 24 columns on desktop and 8 on mobile, 1-based. A design's 12-column span N maps to 2N Squarespace columns (design columns 1–5 → x:1, w:10). Rows are 2vw tall on desktop, 6vw on mobile.",
    "Section themes are named white, light, dark, black (+ -bold variants), bright, bright-inverse. A design's darkest theme usually maps to 'black', its second dark to 'dark'.",
    "Buttons have three style slots: primary, secondary, tertiary, styled site-wide with set_button_style.",
    "Card grids of blog posts are summary blocks: props {design:'autogrid', collectionType:1, pageSize, imageAspectRatio:'0.75' for 3:4, primaryMetadata:'date', showReadMoreLink:true}. The number of columns follows columnWidth (px per card): raise it for fewer, wider columns. Blog posts need set_post_image for their card image.",
    "Blog post bodies are a simple top-to-bottom list of blocks (create_blog_post); pages use the grid (build_sections).",
    "Every write saves a snapshot first; restore_snapshot undoes a change. Prefer building on a test page before touching live pages, and tell the user what changed.",
  ].join("\n"),
});

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) }] });
const site = z.string().optional().describe("Site address, e.g. 'my-site' or 'my-site.squarespace.com'. Defaults to SQS_SITE.");
const pos = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() });
const blockSpec = z.object({
  type: z.enum([...Object.keys(BLOCK_TYPES), "raw"]),
  desktop: pos.describe("Position on the 24-column desktop grid"),
  mobile: pos.optional().describe("Position on the 8-column mobile grid. Omit to stack full-width in reading order."),
  html: z.string().optional().describe("text/code: HTML. Use <h1>-<h4>, <p> (add class=\"sqsrte-large\" or \"sqsrte-small\" for Paragraph 1/3), <a href>, <strong>, <em>."),
  text: z.string().optional().describe("button: label"),
  link: z.string().optional().describe("button/image: URL or /path"),
  style: z.enum(["primary", "secondary", "tertiary"]).optional().describe("button: style slot"),
  alignment: z.enum(["left", "center", "right"]).optional(),
  newWindow: z.boolean().optional(),
  imageId: z.string().optional().describe("image: id from upload_image"),
  alt: z.string().optional(),
  fill: z.boolean().optional().describe("image: fill the cell (crop). Default true."),
  collectionId: z.string().optional().describe("summary: blog/collection id to list"),
  definitionName: z.string().optional().describe("raw: website.components.* name"),
  props: z.record(z.any()).optional().describe("Extra fields merged into the block's value (see describe_block)."),
  verticalAlignment: z.enum(["top", "middle", "bottom"]).optional(),
  hideOnMobile: z.boolean().optional(),
  hideOnDesktop: z.boolean().optional(),
});
const sectionSpec = z.object({
  theme: z.enum(THEMES).optional(),
  height: z.enum(["small", "medium", "large", "custom"]).optional(),
  customHeight: z.number().optional(),
  verticalAlignment: z.enum(["top", "middle", "bottom"]).optional(),
  contentWidth: z.enum(["full", "wide", "medium", "narrow", "inset"]).optional(),
  background: z.object({ imageId: z.string().optional(), overlayOpacity: z.number().optional() }).optional(),
  desktopRows: z.number().int().optional(),
  mobileRows: z.number().int().optional(),
  blocks: z.array(blockSpec).optional(),
  styles: z.record(z.any()).optional().describe("Raw section style fields to merge"),
});

// Tools that build blocks need Squarespace's block definitions, fetched from the site.
const NEEDS_DEFS = new Set(["build_sections", "update_section", "build_footer", "create_blog_post", "update_blog_post", "describe_block"]);

function reg(name, description, schema, fn) {
  server.registerTool(name, { description, inputSchema: schema }, async (args) => {
    try {
      if (NEEDS_DEFS.has(name)) await sqs.loadDefinitions(args.site);
      return text(await fn(args));
    }
    catch (e) { return { isError: true, content: [{ type: "text", text: String(e.message || e) }] }; }
  });
}

// ---------------------------------------------------------------- status / design
reg("status", "Check that Chrome is connected and you're logged in to the site.", { site }, async ({ site: s }) => {
  const connected = bridge.connected();
  const out = { bridge: connected ? "connected" : "not connected", mode: bridge.mode, extensionVersion: bridge.extensionVersion, dataDir: DATA_DIR };
  if (connected && (s || process.env.SQS_SITE)) {
    const host = siteHost(s);
    out.site = host;
    out.loggedIn = (await bridge.call("loggedIn", { host })).hasCrumb;
    if (out.loggedIn) { try { const c = await sqs.context(s); out.websiteTitle = c.title; out.homepageId = c.homepageId; } catch (e) { out.loggedIn = false; out.error = e.message; } }
  }
  return out;
});

reg("read_design", "Unpack a Claude Design export (.html) into a text outline with [IMAGE imgN WxH] markers in reading order, and save its images to disk for upload_image.",
  { path: z.string().describe("Path to the exported .html file") },
  async ({ path: p }) => {
    const r = readDesign(p);
    return { savedTo: r.dir, images: r.images.map(({ ref, file, size, mime }) => ({ ref, file, size, mime })), outline: r.outline };
  });

// ---------------------------------------------------------------- pages
reg("list_pages", "List the site's pages and collections with their ids, URLs and navigation placement.", { site }, async ({ site: s }) => {
  const [cols, layout] = await Promise.all([sqs.collections(s), sqs.siteLayout(s)]);
  const navOf = {};
  for (const n of layout.layout || []) for (const l of n.links || []) navOf[l.collectionId] = n.identifier;
  return cols.map((c) => ({ id: c.id, title: c.title, url: c.fullUrl || `/${c.urlId}`, type: c.typeName || c.type, navigation: navOf[c.id] || null }));
});

reg("get_page", "Read a page's sections and blocks as a compact summary (positions, text, images). Set full=true for the raw JSON.",
  { site, pageId: z.string(), full: z.boolean().optional() },
  async ({ site: s, pageId, full }) => {
    const p = await sqs.getPage(s, pageId);
    if (full) return p;
    return (p.regions || []).map((r) => ({ region: r.type, sections: summarizeSections(r.sections) }));
  });

async function primaryRegion(s, pageId) {
  const page = await sqs.getPage(s, pageId);
  const region = (page.regions || []).find((r) => r.type === "USER_PRIMARY") || page.regions?.[0];
  if (!region) throw new Error("This page has no editable region (it may be a blog or store index; edit its items instead).");
  return { page, region };
}

reg("build_sections", "Create Fluid Engine sections from specs and add them to a page. mode: append (default), prepend, replace (removes all existing sections), or insert at index.",
  { site, pageId: z.string(), sections: z.array(sectionSpec), mode: z.enum(["append", "prepend", "replace", "insert"]).optional(), index: z.number().int().optional() },
  async ({ site: s, pageId, sections, mode = "append", index }) => {
    const { page, region } = await primaryRegion(s, pageId);
    const built = [];
    for (const spec of sections) {
      const shell = await sqs.newBlankSection(s);
      built.push(applySectionSpec(shell, spec));
    }
    const existing = region.sections || [];
    region.sections = mode === "replace" ? built
      : mode === "prepend" ? [...built, ...existing]
      : mode === "insert" ? [...existing.slice(0, index ?? existing.length), ...built, ...existing.slice(index ?? existing.length)]
      : [...existing, ...built];
    const { after, snapshot } = await sqs.putPage(s, pageId, page);
    const reg2 = (after.regions || []).find((r) => r.id === region.id) || after.regions?.[0];
    return { ok: true, snapshot, sectionIds: built.map((b) => b.id), page: summarizeSections(reg2?.sections) };
  });

reg("update_section", "Change an existing section: theme, height, alignment, background, and (if blocks is given) replace all of its blocks.",
  { site, pageId: z.string(), sectionId: z.string(), spec: sectionSpec },
  async ({ site: s, pageId, sectionId, spec }) => {
    const { page, region } = await primaryRegion(s, pageId);
    const i = region.sections.findIndex((x) => x.id === sectionId);
    if (i < 0) throw new Error(`Section ${sectionId} not found on page ${pageId}`);
    region.sections[i] = applySectionSpec(region.sections[i], spec);
    const { snapshot } = await sqs.putPage(s, pageId, page);
    return { ok: true, snapshot, section: summarizeSections([region.sections[i]])[0] };
  });

reg("update_block", "Edit one block in place: text html, button text/link/style, image, position, or raw props.",
  { site, pageId: z.string(), blockId: z.string(),
    html: z.string().optional(), text: z.string().optional(), link: z.string().optional(), style: z.enum(["primary", "secondary", "tertiary"]).optional(),
    imageId: z.string().optional(), desktop: pos.optional(), mobile: pos.optional(), props: z.record(z.any()).optional() },
  async ({ site: s, pageId, blockId: bid, ...ch }) => {
    const { page } = await primaryRegion(s, pageId);
    let hit;
    for (const r of page.regions) for (const sec of r.sections || []) for (const g of sec.fluidEngineContext?.gridContents || []) if (g.content?.value?.id === bid) hit = g;
    if (!hit) throw new Error(`Block ${bid} not found`);
    const v = hit.content.value.value;
    if (ch.html != null) { v.html = ch.html; v.source = ch.html; }
    if (ch.text != null) v.buttonText = ch.text;
    if (ch.link != null) { if ("buttonLink" in v || hit.content.value.definitionName === BLOCK_TYPES.button) v.buttonLink = ch.link; else { v.linkTo = ch.link; v.imageLink = "url"; } }
    if (ch.style) v.buttonSize = { primary: "medium", secondary: "large", tertiary: "small" }[ch.style];
    if (ch.imageId) v.imageId = ch.imageId;
    if (ch.props) hit.content.value.value = deepMerge(v, ch.props);
    const setPos = (bp, p) => { hit.layout[bp] = { ...hit.layout[bp], start: { x: p.x, y: p.y }, end: { x: p.x + p.w - 1, y: p.y + p.h - 1 } }; };
    if (ch.desktop) setPos("desktop", ch.desktop);
    if (ch.mobile) setPos("mobile", ch.mobile);
    const { snapshot } = await sqs.putPage(s, pageId, page);
    return { ok: true, snapshot };
  });

reg("delete_sections", "Remove sections from a page by id.", { site, pageId: z.string(), sectionIds: z.array(z.string()) },
  async ({ site: s, pageId, sectionIds }) => {
    const { page, region } = await primaryRegion(s, pageId);
    const before = region.sections.length;
    region.sections = region.sections.filter((x) => !sectionIds.includes(x.id));
    const { snapshot } = await sqs.putPage(s, pageId, page);
    return { ok: true, removed: before - region.sections.length, snapshot };
  });

reg("create_page", "Create a page. kind 'blank' makes an empty layout page; 'blog' makes a blog (Squarespace adds sample posts you can delete). navigation: 'mainNav' (shown in the header) or '_hidden' (not linked).",
  { site, title: z.string(), kind: z.enum(["blank", "blog"]).optional(), navigation: z.enum(["mainNav", "_hidden"]).optional() },
  async ({ site: s, title, kind = "blank", navigation = "mainNav" }) => {
    const ctx = await sqs.context(s);
    let col;
    if (kind === "blank") {
      col = await sqs.saveCollectionSettings(s, {
        description: { html: "", raw: false }, enabled: true, deleted: false, folder: false, regionName: "default", dirty: false, body: null,
        collectionType: 10, supported: true, typeName: "page", title, newTitle: title, icon: "page", navigationTitle: title, type: 10, websiteId: ctx.websiteId,
      });
    } else {
      col = await sqs.post(s, "/api/content/copy/collection/from-catalog-entity?catalogId=69a0b6158945ad1b261cd0f1&catalogEntityId=6a29cff5899a264cea1e39a9", {});
      const urlId = (await sqs.post(s, `/api/content-collections/${col.id}/generate-url`, { title, urlId: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") })).urlId;
      col = await sqs.saveCollectionSettings(s, { ...col, title, navigationTitle: title, urlId: urlId || col.urlId });
    }
    await sqs.addToNavigation(s, { ...col, typeName: col.typeName || (kind === "blog" ? "blog" : "page") }, navigation);
    return { ok: true, id: col.id, title: col.title, url: col.fullUrl || `/${col.urlId}`, kind, navigation };
  });

reg("set_navigation_order", "Reorder a navigation list (mainNav or _hidden) by page ids. Pages not listed keep their relative order at the end.",
  { site, navigation: z.enum(["mainNav", "_hidden"]), pageIds: z.array(z.string()) },
  async ({ site: s, navigation, pageIds }) => {
    const layout = await sqs.siteLayout(s);
    const nav = (layout.layout || []).find((n) => n.identifier === navigation);
    const links = nav?.links || [];
    const ordered = [...pageIds.map((id) => links.find((l) => l.collectionId === id)).filter(Boolean), ...links.filter((l) => !pageIds.includes(l.collectionId))];
    const items = ordered.map((l) => ({ ...l, linkId: l.collectionId, linkType: "collection", items: l.items || [] }));
    await sqs.setNavigation(s, navigation, items);
    return { ok: true, order: ordered.map((l) => l.title) };
  });

// ---------------------------------------------------------------- images
reg("upload_image", "Upload an image file (or https URL) to the site's media library. Returns the imageId to use in image blocks and section backgrounds.",
  { site, path: z.string().optional(), url: z.string().optional(), filename: z.string().optional() },
  async ({ site: s, path: p, url, filename }) => {
    const { buf, name, mime } = await loadImage(p, url, filename);
    return sqs.uploadImage(s, { base64: buf.toString("base64"), filename: name, mimeType: mime });
  });

async function loadImage(p, url, filename) {
  let buf, name = filename, mime;
  if (p) { buf = fs.readFileSync(p); name ||= path.basename(p); }
  else if (url) { const r = await fetch(url); if (!r.ok) throw new Error(`Download failed: ${r.status}`); buf = Buffer.from(await r.arrayBuffer()); mime = r.headers.get("content-type")?.split(";")[0]; name ||= path.basename(new URL(url).pathname) || "image.jpg"; }
  else throw new Error("Give path or url");
  const ext = path.extname(name).toLowerCase();
  mime ||= { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" }[ext] || "image/jpeg";
  if (buf.length > 20 * 1024 * 1024) throw new Error("Image is over 20 MB");
  return { buf, name, mime };
}

// ---------------------------------------------------------------- site styles
const hexToHsl = (hex) => {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) throw new Error(`Bad hex color ${hex}`);
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, sat = 0;
  if (max !== min) {
    const d = max - min; sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return { hue: r2(h), saturation: r2(sat * 100), lightness: r2(l * 100) };
};
const hslToHex = ({ hue, saturation, lightness }) => {
  const s = saturation / 100, l = lightness / 100, k = (n) => (n + hue / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, "0");
  return `#${f(0)}${f(8)}${f(4)}`;
};

const CORE_VARS = ["siteBackgroundColor", "headingExtraLargeColor", "headingLargeColor", "headingMediumColor", "headingSmallColor", "paragraphLargeColor", "paragraphMediumColor", "paragraphSmallColor", "paragraphLinkColor", "headingLinkColor", "navigationLinkColor", "siteTitleColor", "primaryButtonBackgroundColor", "primaryButtonTextColor", "secondaryButtonBackgroundColor", "secondaryButtonTextColor", "tertiaryButtonBackgroundColor", "tertiaryButtonTextColor", "section-divider-stroke-color"];

reg("get_site_styles", "Read site-wide styles: color palette (hex), color themes (core variables), fonts and type sizes, and button styles.", { site, theme: z.string().optional().describe("Return all variables for this one theme") },
  async ({ site: s, theme }) => {
    const [colors, fonts, styles] = await Promise.all([sqs.styleDoc(s, "colors"), sqs.styleDoc(s, "fonts"), sqs.styleDoc(s, "styles")]);
    const palette = Object.fromEntries(colors.palette.map((p) => [p.id, hslToHex(p.value.values)]));
    const themes = Object.fromEntries(colors.colorThemes.filter((t) => !theme || t.themeName === theme).map((t) => [t.themeName,
      Object.fromEntries(t.mappings.filter((m) => theme || CORE_VARS.includes(m.variableName) || /button/i.test(m.variableName) && /primary|secondary|tertiary/.test(m.variableName) && !/hover|border/i.test(m.variableName))
        .map((m) => [m.variableName, m.paletteColorMapping ? `${m.paletteColorMapping.colorName}${m.paletteColorMapping.alphaModifier !== 1 ? "@" + m.paletteColorMapping.alphaModifier : ""}` : m])),
    ]));
    const buttons = styles.packs.filter((p) => p.type === "buttons").map((p) => ({ packId: p.packId, slots: Object.fromEntries(p.subtypes.map((st) => [st.id, Object.fromEntries(st.options.map((o) => [o.id, o.value]))])) }));
    return {
      palette, defaultTheme: colors.defaultTheme, themes,
      fonts: { pack: fonts.name, baseFontSize: fonts.baseFontSize, masterFonts: Object.fromEntries(fonts.masterFonts.map((f) => [f.name, f.fontValue])), sizes: Object.fromEntries(fonts.masterSizes.map((m) => [m.name, m.value])) },
      buttons, otherStylePacks: styles.packs.filter((p) => p.type !== "buttons").map((p) => p.packId),
    };
  });

reg("set_palette", "Set palette colors by name (white, black, accent, lightAccent, darkAccent, safeLightAccent, safeDarkAccent, safeInverseAccent, safeInverseLightAccent, safeInverseDarkAccent) to hex values. Themes reference these names.",
  { site, colors: z.record(z.string()).describe("e.g. {\"black\":\"#141416\",\"accent\":\"#5575E1\"}") },
  async ({ site: s, colors }) => {
    const doc = await sqs.styleDoc(s, "colors");
    for (const [name, hex] of Object.entries(colors)) {
      const p = doc.palette.find((x) => x.id === name);
      if (!p) throw new Error(`Unknown palette color "${name}". Have: ${doc.palette.map((x) => x.id).join(", ")}`);
      p.value = { userFormat: "hex", values: hexToHsl(hex) };
    }
    const { snapshot } = await sqs.putStyleDoc(s, "colors", doc);
    return { ok: true, snapshot };
  });

reg("set_theme_colors", "Point color-theme variables at palette colors, e.g. make the 'black' theme's siteBackgroundColor use palette 'black' and paragraphLinkColor use 'accent'. Use get_site_styles(theme=...) to see every variable.",
  { site, theme: z.enum(THEMES), mappings: z.record(z.union([z.string(), z.object({ colorName: z.string(), alphaModifier: z.number().optional() })])) },
  async ({ site: s, theme, mappings }) => {
    const doc = await sqs.styleDoc(s, "colors");
    const t = doc.colorThemes.find((x) => x.themeName === theme);
    const unknown = [];
    for (const [variable, val] of Object.entries(mappings)) {
      const m = t.mappings.find((x) => x.variableName === variable);
      if (!m) { unknown.push(variable); continue; }
      const v = typeof val === "string" ? { colorName: val, alphaModifier: 1 } : { alphaModifier: 1, ...val };
      m.paletteColorMapping = v;
    }
    if (unknown.length) throw new Error(`Unknown variables for theme ${theme}: ${unknown.join(", ")}`);
    const { snapshot } = await sqs.putStyleDoc(s, "colors", doc);
    return { ok: true, snapshot };
  });

reg("set_fonts", "Set master fonts (heading-font, body-font, meta-font) and type sizes: heading-1-size … heading-4-size, large-text-size (Paragraph 1), normal-text-size (Paragraph 2), small-text-size (Paragraph 3), normal-meta-size. Sizes may be given in px or rem (stored as rem). Font families must exist in Squarespace's font library (Google fonts like Inter are available).",
  { site,
    fonts: z.record(z.object({ fontFamily: z.string().optional(), fontWeight: z.number().optional(), fontStyle: z.string().optional(), textTransform: z.enum(["none", "uppercase", "lowercase", "capitalize"]).optional(), letterSpacingEm: z.number().optional(), lineHeightEm: z.number().optional() })).optional(),
    sizes: z.record(z.object({ value: z.number(), unit: z.enum(["px", "rem", "em"]) })).optional() },
  async ({ site: s, fonts = {}, sizes = {} }) => {
    const doc = await sqs.styleDoc(s, "fonts");
    for (const [name, f] of Object.entries(fonts)) {
      const mf = doc.masterFonts.find((x) => x.name === name);
      if (!mf) throw new Error(`Unknown master font ${name}. Have: ${doc.masterFonts.map((x) => x.name).join(", ")}`);
      const fv = mf.fontValue;
      if (f.fontFamily) fv.fontFamily = f.fontFamily;
      if (f.fontWeight) fv.fontWeight = f.fontWeight;
      if (f.fontStyle) fv.fontStyle = f.fontStyle;
      if (f.textTransform) fv.textTransform = f.textTransform;
      if (f.letterSpacingEm != null) fv.letterSpacing = { value: f.letterSpacingEm, unit: "em" };
      if (f.lineHeightEm != null) fv.lineHeight = { value: f.lineHeightEm, unit: "em" };
    }
    for (const [name, v] of Object.entries(sizes)) {
      const ms = doc.masterSizes.find((x) => x.name === name);
      if (!ms) throw new Error(`Unknown size ${name}. Have: ${doc.masterSizes.map((x) => x.name).join(", ")}`);
      // Squarespace only accepts rem here; convert px using the site's base font size.
      const base = doc.baseFontSize || 16;
      const rem = v.unit === "px" ? v.value / base : v.value;
      ms.value = { value: Math.round(rem * 1000) / 1000, unit: "rem" };
    }
    const { snapshot } = await sqs.putStyleDoc(s, "fonts", doc);
    return { ok: true, snapshot };
  });

reg("set_button_style", "Set options for a button slot (primary-button, secondary-button, tertiary-button). Option ids come from get_site_styles, e.g. style: Solid/Outline/Text, shape, border-top-left-radius {value,unit}, padding-left, stroke.",
  { site, slot: z.enum(["primary-button", "secondary-button", "tertiary-button"]), options: z.record(z.any()) },
  async ({ site: s, slot, options }) => {
    const doc = await sqs.styleDoc(s, "styles");
    let touched = 0;
    for (const p of doc.packs.filter((x) => x.type === "buttons")) {
      const st = p.subtypes.find((x) => x.id === slot);
      if (!st) continue;
      for (const [id, value] of Object.entries(options)) {
        const o = st.options.find((x) => x.id === id);
        if (o) o.value = value; else st.options.push({ type: typeof value === "object" ? "unit" : "enum", id, value });
        touched++;
      }
    }
    if (!touched) throw new Error("No button pack found to update");
    const { snapshot } = await sqs.putStyleDoc(s, "styles", doc);
    return { ok: true, snapshot };
  });

reg("get_custom_css", "Read the site's custom CSS.", { site }, async ({ site: s }) => sqs.getCustomCss(s));
reg("set_custom_css", "Replace (or append to) the site's custom CSS. Use sparingly: only for details native settings can't express.",
  { site, css: z.string(), mode: z.enum(["replace", "append"]).optional() },
  async ({ site: s, css, mode = "replace" }) => {
    const next = mode === "append" ? `${await sqs.getCustomCss(s)}\n${css}` : css;
    return { ok: true, ...(await sqs.setCustomCss(s, next)) };
  });

// ---------------------------------------------------------------- header / footer
reg("get_header_footer", "Read the global header settings and footer sections.", { site }, async ({ site: s }) => {
  const hf = await sqs.getHeaderFooter(s);
  const h = hf.header || {};
  return { header: { layout: h.layout, headerStyle: h.headerStyle, showButton: h.showButton, button: h.action, buttonVariant: h.buttonVariant, showCart: h.showCart, showSocial: h.showSocial, mobileLayout: h.mobileOptions?.layout }, footerSections: summarizeSections(hf.footer?.sections) };
});

reg("update_header", "Change header settings, e.g. {layout:'navRight', showButton:true, action:{href:'/tickets', buttonText:'Get Tickets', newWindow:false}, buttonVariant:'primary', headerStyle:'solid', showCart:false}.",
  { site, patch: z.record(z.any()) },
  async ({ site: s, patch }) => {
    const hf = await sqs.getHeaderFooter(s);
    hf.header = deepMerge(hf.header, patch);
    const { snapshot } = await sqs.putHeaderFooter(s, hf);
    return { ok: true, snapshot };
  });

reg("build_footer", "Replace the global footer with sections built from specs (same spec format as build_sections).",
  { site, sections: z.array(sectionSpec) },
  async ({ site: s, sections }) => {
    const hf = await sqs.getHeaderFooter(s);
    const built = [];
    for (const spec of sections) built.push(applySectionSpec(await sqs.newBlankSection(s), spec));
    hf.footer = { ...(hf.footer || {}), sections: built };
    const { snapshot } = await sqs.putHeaderFooter(s, hf);
    return { ok: true, snapshot, sectionIds: built.map((b) => b.id) };
  });

// ---------------------------------------------------------------- blog
reg("list_posts", "List posts in a blog collection.", { site, collectionId: z.string() }, async ({ site: s, collectionId }) => {
  const r = await sqs.listItems(s, collectionId);
  return (r.results || []).map((p) => ({ id: p.id, title: p.title, url: p.fullUrl, published: p.workflowState === 1, publishOn: new Date(p.publishOn).toISOString(), hasImage: !!p.assetUrl }));
});

// Post bodies use the older Layout Engine (12-column rows). Images there must be
// imageLayout blocks; imageFluid is stored but not rendered.
function postBody(blocks) {
  return {
    raw: false,
    layout: { columns: 12, rows: blocks.map((b) => {
      let def, value;
      if (b.type === "image") {
        if (!b.imageId) throw new Error("image blocks need an imageId (use upload_image first)");
        def = "website.components.imageLayout";
        value = deepMerge({ ...defaults(def), imageId: b.imageId, altText: b.alt || "" }, b.props);
      } else {
        const g = buildGridContents([{ ...b, desktop: { x: 1, y: 1, w: 24, h: 1 } }])[0];
        def = g.content.value.definitionName; value = g.content.value.value;
      }
      return { columns: [{ span: 12, blocks: [{ type: 1337, id: blockId(), definitionName: def, value }] }] };
    }) },
  };
}

reg("set_post_image", "Set a blog post's featured image (shown on Summary block cards and the blog list) from a local file or https URL.",
  { site, collectionId: z.string(), postId: z.string(), path: z.string().optional(), url: z.string().optional() },
  async ({ site: s, collectionId, postId, path: p, url }) => {
    const { buf, name, mime } = await loadImage(p, url);
    const r = await sqs.http(s, "POST", "/api/commondata/SaveMedia", {
      bodyType: "multipart",
      body: {
        fields: { process: "true", contentType: mime, isWordpressXmlFile: "false", recordType: "2", collectionId, replaceItemId: postId,
          imageDestination: "content-item-main-image", fileName: name, fileSize: String(buf.length) },
        files: [{ field: "Filedata", name, type: mime, base64: buf.toString("base64") }],
      },
    });
    return { ok: true, media: (r.media || []).map((m) => ({ id: m.id, assetUrl: m.assetUrl })) };
  });
const postBlock = z.object({ type: z.enum(["text", "image", "button", "line", "code", "video", "audio", "embed"]), html: z.string().optional(), text: z.string().optional(), link: z.string().optional(), style: z.enum(["primary", "secondary", "tertiary"]).optional(), newWindow: z.boolean().optional(), imageId: z.string().optional(), alt: z.string().optional(), props: z.record(z.any()).optional() });

reg("create_blog_post", "Create a blog post. body is a list of blocks top to bottom (text, image, button, line…). Drafts unless publish=true.",
  { site, collectionId: z.string(), title: z.string(), body: z.array(postBlock), excerptHtml: z.string().optional(), publish: z.boolean().optional(), publishOn: z.string().optional().describe("ISO date, e.g. the show date") },
  async ({ site: s, collectionId, title, body, excerptHtml, publish, publishOn }) => {
    const ctx = await sqs.context(s);
    const when = publishOn ? Date.parse(publishOn) : Date.now();
    const created = await sqs.post(s, `/api/content/blogs/${collectionId}/text-posts`, {
      addedOn: when, publishOn: when, websiteId: ctx.websiteId, authorId: ctx.accountId, workflowState: 4, title: null, recordType: 1, collectionId, commentState: 2,
      body: { raw: false, layout: { columns: 12, rows: [] } }, excerpt: { html: "", raw: false }, tags: [], categories: [], starred: false, passthrough: false,
    });
    const urlId = (await sqs.post(s, `/api/content-collections/${collectionId}/generate-url`, { title, urlId: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") }).catch(() => ({})))?.urlId;
    const post = { ...created, title, urlId: urlId || created.urlId, body: postBody(body), excerpt: { html: excerptHtml || "", raw: false }, publishOn: when, workflowState: publish ? 1 : 4 };
    const saved = await sqs.put(s, `/api/content/blogs/${collectionId}/text-posts/${created.id}`, post);
    return { ok: true, id: saved.id, url: saved.fullUrl, published: saved.workflowState === 1 };
  });

reg("update_blog_post", "Update a blog post's title, body, excerpt, date or published state.",
  { site, collectionId: z.string(), postId: z.string(), title: z.string().optional(), body: z.array(postBlock).optional(), excerptHtml: z.string().optional(), publish: z.boolean().optional(), publishOn: z.string().optional() },
  async ({ site: s, collectionId, postId, title, body, excerptHtml, publish, publishOn }) => {
    const items = await sqs.listItems(s, collectionId, 200);
    const cur = (items.results || []).find((p) => p.id === postId);
    if (!cur) throw new Error(`Post ${postId} not found`);
    sqs.snapshot(s, "post", postId, cur);
    const post = { ...cur };
    if (title) post.title = title;
    if (body) post.body = postBody(body);
    if (excerptHtml != null) post.excerpt = { html: excerptHtml, raw: false };
    if (publishOn) post.publishOn = Date.parse(publishOn);
    if (publish != null) post.workflowState = publish ? 1 : 4;
    const saved = await sqs.put(s, `/api/content/blogs/${collectionId}/text-posts/${postId}`, post);
    return { ok: true, url: saved.fullUrl, published: saved.workflowState === 1 };
  });

// ---------------------------------------------------------------- safety & escape hatches
reg("list_snapshots", "List saved snapshots (taken automatically before every write), newest first.", { site }, async ({ site: s }) => sqs.listSnapshots(s).slice(0, 50));

reg("restore_snapshot", "Undo a change by writing a snapshot back (pages, header/footer, colors, fonts, styles, custom CSS).",
  { file: z.string() },
  async ({ file }) => {
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    const s = snap.site;
    if (snap.kind === "page") { const r = await sqs.putPage(s, snap.key, snap.doc); return { ok: true, restoredPage: snap.key, snapshotOfReplaced: r.snapshot }; }
    if (snap.kind === "header-footer") { await sqs.putHeaderFooter(s, snap.doc); return { ok: true }; }
    if (["colors", "fonts", "styles"].includes(snap.kind)) { await sqs.putStyleDoc(s, snap.kind, snap.doc); return { ok: true }; }
    if (snap.kind === "custom-css") { await sqs.setCustomCss(s, snap.doc); return { ok: true }; }
    throw new Error(`Restoring ${snap.kind} snapshots isn't supported; the file has the old data if you need it.`);
  });

reg("describe_block", "Show a block type's default values and Squarespace's own field notes, for use in `props`.",
  { site, type: z.string().describe("e.g. button, summary, newsletter, or website.components.*") },
  async ({ type }) => {
    const def = BLOCK_TYPES[type] || type;
    const info = blockInfo(def);
    if (!info) throw new Error(`Unknown block ${type}`);
    return { definitionName: def, description: info.agent, fields: info.agentContext, defaults: defaults(def) };
  });

reg("api_request", "Escape hatch: call any Squarespace editor endpoint on the site (path must start with /api/). Use only when no other tool fits; writes here are not snapshotted.",
  { site, method: z.enum(["GET", "POST", "PUT", "DELETE"]), path: z.string(), body: z.any().optional(), bodyType: z.enum(["json", "form", "text"]).optional() },
  async ({ site: s, method, path: p, body, bodyType }) => {
    if (!p.startsWith("/api/")) throw new Error("path must start with /api/");
    return sqs.http(s, method, p, { body, bodyType: body === undefined ? undefined : bodyType || "json" });
  });

await server.connect(new StdioServerTransport());
console.error("[squarespace-mcp] ready; data in", DATA_DIR);
