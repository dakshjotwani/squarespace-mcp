// Turns a compact section/block spec into Squarespace Fluid Engine JSON.
//
// Grid: desktop is 24 columns, mobile is 8 columns. Positions are 1-based and the end
// cell is inclusive, exactly as Squarespace stores them ({start:{x,y}, end:{x,y}}).
// A spec gives positions as {x, y, w, h}: end = start + size - 1.

import { randomBytes } from "node:crypto";

// Block definitions (defaults and field notes) are fetched from the site at runtime
// via Squarespace.loadDefinitions, so they always match the editor's current release.
let BLOCKS = null;
export function setDefinitions(definitions) {
  BLOCKS = Object.fromEntries(definitions.map((x) => [x.definitionName, {
    initial: x.initialContextValues, agent: x.agentMetadata?.description, agentContext: x.dataSchema?.agentContext,
  }]));
}
const defs = () => { if (!BLOCKS) throw new Error("Block definitions not loaded yet"); return BLOCKS; };

export const blockId = () => randomBytes(10).toString("hex"); // 20 hex chars, like the editor

export const BLOCK_TYPES = {
  text: "website.components.html",
  button: "website.components.button",
  image: "website.components.imageFluid",
  line: "website.components.horizontalrule",
  spacer: "website.components.spacer",
  summary: "website.components.summary",
  newsletter: "website.components.newsletter",
  socialLinks: "website.components.socialLinks",
  code: "website.components.code",
  video: "website.components.video",
  map: "website.components.map",
  accordion: "website.components.accordion",
  quote: "website.components.quote",
  form: "website.components.form",
  embed: "website.components.embed",
  audio: "website.components.audio",
  product: "website.components.product",
  shape: "website.components.shape",
  scrolling: "website.components.scrolling",
};

export const THEMES = ["white", "white-bold", "light", "light-bold", "dark", "dark-bold", "black", "black-bold", "bright", "bright-inverse"];

const BUTTON_SIZES = { primary: "medium", secondary: "large", tertiary: "small" };
const SECTION_HEIGHT = { small: "section-height--small", medium: "section-height--medium", large: "section-height--large", custom: "section-height--custom" };
const VALIGN = { top: "vertical-alignment--top", middle: "vertical-alignment--middle", bottom: "vertical-alignment--bottom" };
const CONTENT_WIDTH = { full: "content-width--full", wide: "content-width--wide", medium: "content-width--medium", narrow: "content-width--narrow", inset: "content-width--inset" };

// Strip the editor's {translate:{stringValue}} wrappers from default values.
function untranslate(v) {
  if (Array.isArray(v)) return v.map(untranslate);
  if (v && typeof v === "object") {
    if (v.translate && typeof v.translate === "object" && "stringValue" in v.translate) return v.translate.stringValue;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, untranslate(x)]));
  }
  return v;
}

export function deepMerge(a, b) {
  if (b === undefined) return a;
  if (Array.isArray(b) || b === null || typeof b !== "object") return b;
  const out = { ...(a && typeof a === "object" && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
  return out;
}

export function defaults(definitionName) {
  const d = defs()[definitionName];
  if (!d) throw new Error(`Unknown block definition ${definitionName}`);
  return untranslate(structuredClone(d.initial || {}));
}

export function blockInfo(definitionName) { return defs()[definitionName]; }

function blockValue(spec) {
  const type = spec.type;
  const def = type === "raw" ? spec.definitionName : BLOCK_TYPES[type];
  if (!def) throw new Error(`Unknown block type "${type}". Use one of: ${Object.keys(BLOCK_TYPES).join(", ")}, raw`);
  let v = defaults(def);
  switch (type) {
    case "text": {
      const html = spec.html ?? "";
      v = { ...v, engine: "wysiwyg", html, source: html, textAttributes: [] };
      break;
    }
    case "button": {
      v = { ...v, buttonText: spec.text ?? "Button", buttonLink: spec.link ?? null, newWindow: !!spec.newWindow,
        buttonSize: BUTTON_SIZES[spec.style || "primary"] || spec.style, buttonAlignment: spec.alignment || "left" };
      break;
    }
    case "image": {
      if (!spec.imageId) throw new Error("image blocks need an imageId (use upload_image first)");
      v = { ...v, imageId: spec.imageId, altText: spec.alt || "", stretch: spec.fill !== false,
        imageMask: spec.mask || "none", imagePosition: spec.position || "center",
        linkTo: spec.link || "", imageLink: spec.link ? "url" : "none", newwindow: !!spec.newWindow,
        layout: "caption-below", designLayout: "fluid", lightbox: false,
        containerStyles: { ...(v.containerStyles || {}), backgroundEnabled: false, stretchedToFill: spec.fill !== false } };
      if (spec.aspectRatio) v.aspectRatio = spec.aspectRatio;
      break;
    }
    case "code": {
      v = { ...v, html: spec.html ?? "", wysiwyg: { ...(v.wysiwyg || {}), source: spec.html ?? "" } };
      break;
    }
    case "summary": {
      if (spec.collectionId) v.collectionId = spec.collectionId;
      break;
    }
    default: break;
  }
  if (spec.props) v = deepMerge(v, spec.props);
  return { def, value: v };
}

function cell(pos, cols, label) {
  const { x, y, w, h } = pos;
  if (![x, y, w, h].every((n) => Number.isInteger(n) && n > 0)) throw new Error(`${label}: x, y, w, h must be positive integers`);
  if (x + w - 1 > cols) throw new Error(`${label}: block runs past column ${cols} (x=${x}, w=${w})`);
  return { start: { x, y }, end: { x: x + w - 1, y: y + h - 1 } };
}

// Default mobile layout: stack blocks full-width in reading order, keeping each
// block's aspect (desktop rows are 2vw tall, mobile rows 6vw; mobile is 8 cols wide).
function autoMobile(blocks) {
  const order = blocks.map((b, i) => ({ b, i })).sort((p, q) => (p.b.desktop.y - q.b.desktop.y) || (p.b.desktop.x - q.b.desktop.x));
  let y = 1;
  const out = new Array(blocks.length);
  for (const { b, i } of order) {
    if (b.mobile) { out[i] = b.mobile; y = Math.max(y, b.mobile.y + b.mobile.h); continue; }
    const d = b.desktop;
    let h = Math.max(1, Math.round((d.h * 2 * 24) / d.w / 6));
    if (b.type === "text") h = Math.max(1, Math.round(d.h * 0.9)); // text reflows taller on narrow screens
    if (b.type === "line") h = 1;
    if (b.type === "button") h = Math.max(1, Math.min(2, d.h));
    out[i] = { x: 1, y, w: 8, h };
    y += h;
  }
  return out;
}

export function buildGridContents(blocks) {
  const mobiles = autoMobile(blocks);
  return blocks.map((b, i) => {
    const { def, value } = blockValue(b);
    const label = `block ${i + 1} (${b.type})`;
    return {
      layout: {
        desktop: { ...cell(b.desktop, 24, label + " desktop"), verticalAlignment: b.verticalAlignment || "top", visible: b.hideOnDesktop !== true, isLocked: false, zIndex: b.zIndex ?? i },
        mobile: { ...cell(mobiles[i], 8, label + " mobile"), verticalAlignment: b.verticalAlignment || "top", visible: b.hideOnMobile !== true, isLocked: false, zIndex: b.zIndex ?? i },
      },
      content: { value: { id: b.id || blockId(), type: 1337, definitionName: def, value } },
    };
  });
}

// Apply a section spec onto a section shell (from newBlankSection or an existing section).
export function applySectionSpec(shell, spec) {
  const s = structuredClone(shell);
  const st = { ...(s.styles || {}) };
  if (spec.theme) {
    if (!THEMES.includes(spec.theme)) throw new Error(`theme must be one of ${THEMES.join(", ")}`);
    st.sectionTheme = spec.theme;
  }
  if (spec.height) st.sectionHeight = SECTION_HEIGHT[spec.height] || spec.height;
  if (spec.customHeight != null) { st.sectionHeight = SECTION_HEIGHT.custom; st.customSectionHeight = spec.customHeight; }
  if (spec.verticalAlignment) st.verticalAlignment = VALIGN[spec.verticalAlignment] || spec.verticalAlignment;
  if (spec.contentWidth) st.contentWidth = CONTENT_WIDTH[spec.contentWidth] || spec.contentWidth;
  if (spec.background) {
    const bg = spec.background;
    if (bg.imageId) { st.backgroundMode = "image"; s.backgroundImageId = bg.imageId; }
    if (bg.overlayOpacity != null) st.imageOverlayOpacity = bg.overlayOpacity;
  }
  if (spec.styles) Object.assign(st, spec.styles);
  s.styles = st;
  if (spec.blocks) {
    const gc = buildGridContents(spec.blocks);
    const fe = s.fluidEngineContext || { gridSettings: {} };
    const maxD = Math.max(1, ...gc.map((g) => g.layout.desktop.end.y));
    const maxM = Math.max(1, ...gc.map((g) => g.layout.mobile.end.y));
    const bp = structuredClone(fe.gridSettings?.breakpointSettings || {});
    // Squarespace requires every block to end at or before row (rows - 1).
    bp.desktop = { columns: 24, rowSize: { unit: "vw", value: 2 }, ...(bp.desktop || {}), rows: Math.max(spec.desktopRows || 0, maxD + 1) };
    bp.mobile = { columns: 8, rowSize: { unit: "vw", value: 6 }, ...(bp.mobile || {}), rows: Math.max(spec.mobileRows || 0, maxM + 1) };
    s.fluidEngineContext = { ...fe, gridSettings: { rowGap: { unit: "px", value: 11 }, columnGap: { unit: "px", value: 11 }, rowStretch: false, ...(fe.gridSettings || {}), breakpointSettings: bp }, gridContents: gc };
  }
  if (spec.raw) Object.assign(s, deepMerge(s, spec.raw));
  return s;
}

// Compact, readable description of a page document.
export function summarizeSections(sections) {
  return (sections || []).map((s, i) => {
    const fe = s.fluidEngineContext;
    const blocks = (fe?.gridContents || []).map((g) => {
      const v = g.content?.value || {};
      const d = g.layout?.desktop, m = g.layout?.mobile;
      const val = v.value || {};
      const text = (val.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return {
        id: v.id,
        type: Object.entries(BLOCK_TYPES).find(([, n]) => n === v.definitionName)?.[0] || v.definitionName,
        desktop: d && { x: d.start.x, y: d.start.y, w: d.end.x - d.start.x + 1, h: d.end.y - d.start.y + 1 },
        mobile: m && { x: m.start.x, y: m.start.y, w: m.end.x - m.start.x + 1, h: m.end.y - m.start.y + 1 },
        ...(text ? { text: text.slice(0, 160) } : {}),
        ...(val.buttonText ? { button: { text: val.buttonText, link: val.buttonLink, size: val.buttonSize } } : {}),
        ...(val.imageId ? { imageId: val.imageId } : {}),
        ...(val.collectionId ? { collectionId: val.collectionId } : {}),
      };
    });
    return {
      index: i, id: s.id, kind: s.sectionName, theme: s.styles?.sectionTheme, height: s.styles?.sectionHeight?.replace("section-height--", ""),
      desktopRows: fe?.gridSettings?.breakpointSettings?.desktop?.rows, mobileRows: fe?.gridSettings?.breakpointSettings?.mobile?.rows,
      blocks,
    };
  });
}
