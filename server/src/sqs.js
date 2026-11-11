// Thin client for the Squarespace 7.1 editor API, executed through the Chrome bridge.
// Every write that replaces a document first saves the current version as a snapshot.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setDefinitions } from "./blocks.js";

export const DATA_DIR = process.env.SQS_MCP_HOME || path.join(os.homedir(), ".squarespace-mcp");
const SNAP_DIR = path.join(DATA_DIR, "snapshots");
const MEDIA_API = "https://media-api.squarespace.com";

export function siteHost(site) {
  const s = String(site || process.env.SQS_SITE || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!s) throw new Error("No site given. Pass `site` (e.g. \"my-site\" or \"my-site.squarespace.com\") or set SQS_SITE.");
  return s.includes(".") ? s : `${s}.squarespace.com`;
}

export class Squarespace {
  constructor(bridge) { this.bridge = bridge; this.ctxCache = new Map(); }

  async http(site, method, apiPath, { body, bodyType, headers, csrf, raw } = {}) {
    const host = siteHost(site);
    const url = apiPath.startsWith("https://") ? apiPath : `https://${host}${apiPath}`;
    const r = await this.bridge.call("http", { url, method, body, bodyType: bodyType || (body !== undefined ? "json" : undefined), headers, csrf });
    if (raw) return r;
    if (r.status === 401 || r.status === 403 || (r.status === 200 && /text\/html/.test(r.contentType || "") && /login|sign in/i.test(r.text.slice(0, 3000)))) {
      throw new Error(`Squarespace refused the request (${r.status}). Make sure you're logged in to ${host} in Chrome and that this account can edit the site.`);
    }
    if (r.status >= 400) throw new Error(`${method} ${apiPath} failed: HTTP ${r.status} ${r.text.slice(0, 500)}`);
    if (!r.text) return null;
    try { return JSON.parse(r.text); } catch { return r.text; }
  }
  get(site, p, o) { return this.http(site, "GET", p, o); }
  put(site, p, body, o) { return this.http(site, "PUT", p, { body, ...o }); }
  post(site, p, body, o) { return this.http(site, "POST", p, { body, ...o }); }

  snapshot(site, kind, key, doc) {
    const dir = path.join(SNAP_DIR, siteHost(site));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}__${kind}__${key || "doc"}.json`);
    fs.writeFileSync(file, JSON.stringify({ site: siteHost(site), kind, key, savedAt: new Date().toISOString(), doc }, null, 1));
    return file;
  }

  listSnapshots(site) {
    const dir = path.join(SNAP_DIR, siteHost(site));
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse().map((f) => {
      const [ts, kind, key] = f.replace(/\.json$/, "").split("__");
      return { file: path.join(dir, f), time: ts, kind, key };
    });
  }

  // ---- website context -------------------------------------------------
  async context(site) {
    const host = siteHost(site);
    if (this.ctxCache.has(host)) return this.ctxCache.get(host);
    const c = await this.get(site, "/api/context/website");
    const website = c.website || c;
    const ctx = {
      websiteId: website.id || c.websiteId,
      templateId: c.templateId || (JSON.stringify(c).match(/"templateId"\s*:\s*"([0-9a-f]{24})"/) || [])[1],
      homepageId: c.homepageCollectionId,
      title: website.siteTitle || website.title,
    };
    if (!ctx.websiteId) {
      const cols = await this.get(site, "/api/commondata/GetCollections");
      ctx.websiteId = Object.values(cols.collections || {})[0]?.websiteId;
    }
    try { ctx.accountId = (await this.get(site, "/api/context/account")).authenticatedAccount?.id; } catch {}
    this.ctxCache.set(host, ctx);
    return ctx;
  }

  // Squarespace's own block definitions (defaults, field notes), loaded once per run.
  async loadDefinitions(site) {
    if (this.defsLoaded) return;
    const d = await this.get(site, "/api/1/website-component-definitions");
    setDefinitions(d.definitions || []);
    this.defsLoaded = true;
  }

  // ---- pages -------------------------------------------------------------
  async collections(site) {
    const r = await this.get(site, "/api/commondata/GetCollections");
    return Object.values(r.collections || r);
  }
  siteLayout(site) { return this.get(site, "/api/commondata/GetSiteLayout"); }
  getPage(site, pageId) { return this.get(site, `/api/pages/by-collection-id/${pageId}`); }
  async putPage(site, pageId, doc) {
    const before = await this.getPage(site, pageId);
    const snap = this.snapshot(site, "page", pageId, before);
    const after = await this.put(site, `/api/pages/by-collection-id/${pageId}`, doc);
    return { after, snapshot: snap };
  }

  async newBlankSection(site) {
    const blank = await this.get(site, "/api/catalog-preview/blankFluidEngineSection");
    const id = blank.sectionId;
    if (!id) throw new Error("Squarespace did not return a section id");
    return this.post(site, `/api/content/add/fluidEngineSection?sectionId=${id}`, null);
  }

  // ---- header / footer ---------------------------------------------------
  getHeaderFooter(site) { return this.get(site, "/api/site-header-footer"); }
  async putHeaderFooter(site, doc) {
    const snap = this.snapshot(site, "header-footer", "site", await this.getHeaderFooter(site));
    return { after: await this.put(site, "/api/site-header-footer", doc), snapshot: snap };
  }

  // ---- styles ------------------------------------------------------------
  styleDoc(site, kind) { return this.get(site, STYLE_PATHS[kind]); }
  async putStyleDoc(site, kind, doc) {
    const snap = this.snapshot(site, kind, "site", await this.styleDoc(site, kind));
    return { after: await this.put(site, STYLE_PATHS[kind], doc), snapshot: snap };
  }
  async getCustomCss(site) {
    const r = await this.http(site, "GET", "/api/template/GetTemplateCustomCss", { raw: true });
    try { const j = JSON.parse(r.text); return typeof j === "string" ? j : (j.css ?? j.customCss ?? r.text); } catch { return r.text; }
  }
  async setCustomCss(site, css) {
    const snap = this.snapshot(site, "custom-css", "site", await this.getCustomCss(site));
    await this.post(site, "/api/template/SetTemplateCustomCss", { css }, { bodyType: "form" });
    return { snapshot: snap };
  }

  // ---- navigation & page creation -----------------------------------------
  async saveCollectionSettings(site, collectionData) {
    return this.post(site, "/api/commondata/SaveCollectionSettings", { collectionData, memberAreaData: { memberAreaIds: [] } });
  }
  async addToNavigation(site, collection, navId = "mainNav") {
    const ctx = await this.context(site);
    const layout = await this.siteLayout(site);
    const nav = (layout.layout || []).find((n) => n.identifier === navId);
    if (!nav) throw new Error(`Navigation "${navId}" not found. Available: ${(layout.layout || []).map((n) => n.identifier).join(", ")}`);
    const items = (nav.links || []).filter((l) => l.collectionId !== collection.id);
    items.push({
      collectionId: collection.id, collectionType: collection.type, enabled: true, isFolder: false, items: [],
      linkId: collection.id, linkType: "collection", passwordProtected: false, title: collection.navigationTitle || collection.title,
      typeName: collection.typeName, urlId: collection.urlId, isDraft: false, pagePermissionType: 1,
    });
    this.snapshot(site, "navigation", navId, layout);
    return this.post(site, "/api/widget/UpdateNavigation", { fieldName: navId, templateId: ctx.templateId, navigation: { items } });
  }
  async setNavigation(site, navId, items) {
    const ctx = await this.context(site);
    this.snapshot(site, "navigation", navId, await this.siteLayout(site));
    return this.post(site, "/api/widget/UpdateNavigation", { fieldName: navId, templateId: ctx.templateId, navigation: { items } });
  }

  // ---- blog ----------------------------------------------------------------
  listItems(site, collectionId, limit = 50) {
    return this.get(site, `/api/content-collections/${collectionId}/content-items?limit=${limit}`);
  }

  // ---- images --------------------------------------------------------------
  async uploadImage(site, opts) {
    const assetId = await this.uploadAsset(site, opts);
    const ctx = await this.context(site);
    const ref = await this.post(site, "/api/uploads/images/asset-reference", { assetId, libraryId: ctx.websiteId, recordType: "2" }, { bodyType: "form" });
    const media = ref.media?.[0] || ref;
    return { imageId: media.id, assetId, assetUrl: media.assetUrl, size: media.originalSize || media.systemDataVariants, filename: media.filename };
  }

  async uploadAsset(site, { base64, filename, mimeType }) {
    const ctx = await this.context(site);
    const libraryId = ctx.websiteId;
    const { token } = await this.get(site, "/api/media/auth/v1/library/authorization");
    await this.http(site, "POST", `${MEDIA_API}/user/authorize`, { body: token, bodyType: "text", csrf: false });
    const up = await this.http(site, "POST", `${MEDIA_API}/uploads/image`, {
      bodyType: "multipart", csrf: false,
      headers: { "X-Library-Id": libraryId, "X-sqsp-source": "web upload" },
      body: { files: [{ field: "image", name: filename, type: mimeType, base64 }] },
    });
    const jobId = up.jobId;
    let wait = up.checkStatusAfterMs || 1000;
    let job;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, wait));
      wait = 1500;
      const st = await this.http(site, "GET", `${MEDIA_API}/jobs/image/status?job-list=${encodeURIComponent(jobId)}`, { csrf: false, headers: { "X-Library-Id": libraryId } });
      const list = Array.isArray(st) ? st : st?.jobs || st?.data || [st];
      job = list.find((j) => j && (j.jobId === jobId || j.id === jobId)) || list[0];
      const status = String(job?.status || job?.state || "").toUpperCase();
      if (/FAIL|ERROR/.test(status)) throw new Error(`Image processing failed: ${JSON.stringify(job).slice(0, 300)}`);
      if (job?.assetId || /COMPLETE|SUCCESS|DONE|FINISHED/.test(status)) break;
    }
    const assetId = job?.assetId || job?.asset?.id || job?.result?.assetId;
    if (!assetId) throw new Error(`Upload finished without an asset id: ${JSON.stringify(job).slice(0, 400)}`);
    return assetId;
  }
}

export const STYLE_PATHS = {
  styles: "/api/website-styles",
  colors: "/api/website-colors",
  fonts: "/api/website-fonts",
};
