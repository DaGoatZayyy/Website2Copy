import { NextRequest, NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import JSZip from "jszip";
import * as cheerio from "cheerio";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 12;
const TIMEOUT_MS = 8000;
const PREFIX = "[SiteArchiver][API]";

function log(level: "info" | "warn" | "error", code: string, message: string, details: Record<string, unknown> = {}) {
  const entry = { timestamp: new Date().toISOString(), code, message, ...details };
  if (level === "error") console.error(PREFIX, JSON.stringify(entry));
  else if (level === "warn") console.warn(PREFIX, JSON.stringify(entry));
  else console.info(PREFIX, JSON.stringify(entry));
}
function fail(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}
function isPrivateIPv4(ip: string) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 192 && p[1] === 0) || (p[0] === 198 && (p[1] === 18 || p[1] === 19));
}
function isPrivateIPv6(ip: string) {
  const s = ip.toLowerCase();
  return s === "::" || s === "::1" || s.startsWith("fc") || s.startsWith("fd") ||
    /^fe[89ab]/.test(s) || s.startsWith("::ffff:") || s.startsWith("2001:db8:");
}
async function validatePublicUrl(url: URL) {
  if (!["http:", "https:"].includes(url.protocol)) throw Object.assign(new Error("Only HTTP and HTTPS URLs are allowed."), { code: "URL-4001" });
  if (url.username || url.password) throw Object.assign(new Error("URLs containing credentials are not allowed."), { code: "URL-4002" });
  if (url.port && !["80", "443"].includes(url.port)) throw Object.assign(new Error("Only standard web ports 80 and 443 are allowed."), { code: "URL-4003" });
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw Object.assign(new Error("Private and local network hosts are not allowed."), { code: "SSRF-4001" });
  }
  const version = isIP(host);
  if (version === 4 && isPrivateIPv4(host)) throw Object.assign(new Error("Private network addresses are not allowed."), { code: "SSRF-4002" });
  if (version === 6 && isPrivateIPv6(host)) throw Object.assign(new Error("Private network addresses are not allowed."), { code: "SSRF-4003" });
  if (!version) {
    let addresses;
    try { addresses = await lookup(host, { all: true, verbatim: true }); }
    catch { throw Object.assign(new Error("The hostname could not be resolved."), { code: "DNS-4001" }); }
    if (!addresses.length || addresses.some(a => a.family === 4 ? isPrivateIPv4(a.address) : isPrivateIPv6(a.address))) {
      throw Object.assign(new Error("The hostname resolves to a private or unsupported network address."), { code: "SSRF-4004" });
    }
  }
}
async function safeFetch(input: string, accept = "*/*") {
  let current = new URL(input);
  for (let hop = 0; hop <= 4; hop++) {
    await validatePublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, { redirect: "manual", signal: controller.signal, headers: { "User-Agent": "SiteArchiver/1.0 (public asset archival)", Accept: accept } });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw Object.assign(new Error(timedOut ? "The website took too long to respond." : "The website could not be reached."), { code: timedOut ? "NET-4081" : "NET-5021" });
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw Object.assign(new Error("Website returned an invalid redirect."), { code: "HTTP-5022" });
      current = new URL(location, current);
      continue;
    }
    return { response, finalUrl: current };
  }
  throw Object.assign(new Error("The website redirected too many times."), { code: "HTTP-5023" });
}
function safeName(url: URL, type: string) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  else if (!pathname.split("/").pop()?.includes(".")) pathname += "/index.html";
  pathname = pathname.replace(/^\/+/, "").replace(/\.\./g, "_").replace(/[<>:"|?*\x00-\x1F]/g, "_");
  const host = url.hostname.replace(/[^a-z0-9.-]/gi, "_");
  let name = `${host}/${pathname}`;
  if (name.length > 180) name = name.slice(0, 180);
  if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
    const t = type.toLowerCase();
    const ext = t.includes("css") ? ".css" : t.includes("javascript") ? ".js" : t.includes("png") ? ".png" : t.includes("svg") ? ".svg" : t.includes("jpeg") ? ".jpg" : t.includes("webp") ? ".webp" : t.includes("woff") ? ".woff" : ".bin";
    name += ext;
  }
  return name;
}
function isHtml(type: string) { return type.toLowerCase().includes("text/html"); }
function isFetchableAsset(url: URL) {
  return /\.(?:css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|pdf|txt|xml|json)$/i.test(url.pathname);
}
function addUrl(set: Set<string>, raw: string | undefined, base: URL, origin: string) {
  if (!raw || raw.startsWith("#") || /^(?:data:|blob:|javascript:|mailto:|tel:)/i.test(raw)) return;
  try {
    const url = new URL(raw, base);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) return;
    url.hash = "";
    set.add(url.toString());
  } catch {}
}

export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  let targetHost = "unknown";
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.url !== "string" || body.url.length > 2048) {
      log("warn", "REQ-4000", "Rejected malformed request body", { requestId });
      return fail(400, "REQ-4000", "Enter a valid website URL.");
    }
    let start: URL;
    try { start = new URL(body.url.includes("://") ? body.url : `https://${body.url}`); }
    catch {
      log("warn", "URL-4000", "URL parsing failed", { requestId });
      return fail(400, "URL-4000", "That URL is not valid.");
    }
    targetHost = start.host;
    await validatePublicUrl(start);
    log("info", "ARCHIVE-1000", "Archive job started", { requestId, host: targetHost, protocol: start.protocol });

    const origin = start.origin;
    const queue = [start.toString()];
    const seen = new Set<string>();
    const zip = new JSZip();
    const manifest: { name: string; size: number }[] = [];
    let totalBytes = 0;
    let skipped = 0;
    const skippedByReason: Record<string, number> = {};
    const recentResponses: Array<{ path: string; status?: number; contentType?: string; reason: string }> = [];
    const recordSkip = (reason: string, path: string, extra: { status?: number; contentType?: string } = {}) => {
      skipped++;
      skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
      if (recentResponses.length < 12) recentResponses.push({ path, reason, ...extra });
    };

    while (queue.length && seen.size < MAX_PAGES && manifest.length < MAX_FILES && totalBytes < MAX_TOTAL_BYTES) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      let result: Awaited<ReturnType<typeof safeFetch>>;
      try { result = await safeFetch(current); }
      catch (error) {
        recordSkip((error as {code?: string})?.code || "FETCH-UNKNOWN", (() => { try { return new URL(current).pathname; } catch { return "/"; } })());
        log("warn", "FETCH-2001", "Skipped resource after fetch failure", { requestId, host: targetHost, resourceHost: (() => { try { return new URL(current).host; } catch { return "invalid"; } })(), code: (error as {code?: string})?.code || "FETCH-UNKNOWN", message: error instanceof Error ? error.message : "Unknown error" });
        continue;
      }
      const { response, finalUrl } = result;
      if (!response.ok) {
        recordSkip(`HTTP-${response.status}`, finalUrl.pathname, { status: response.status, contentType: response.headers.get("content-type") || undefined });
        log("warn", "HTTP-2001", "Resource returned a non-success HTTP status", { requestId, host: targetHost, status: response.status, resourcePath: finalUrl.pathname });
        continue;
      }
      const type = response.headers.get("content-type") || "application/octet-stream";
      if (!isHtml(type) && !isFetchableAsset(finalUrl)) {
        recordSkip("UNSUPPORTED_CONTENT_TYPE", finalUrl.pathname, { status: response.status, contentType: type });
        log("warn", "TYPE-2002", "Skipped response because its content type and URL extension are not supported", { requestId, resourcePath: finalUrl.pathname, contentType: type, status: response.status });
        continue;
      }
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > MAX_FILE_BYTES) {
        recordSkip("DECLARED_FILE_TOO_LARGE", finalUrl.pathname, { status: response.status, contentType: type });
        log("warn", "SIZE-4131", "Skipped resource over per-file size limit", { requestId, resourcePath: finalUrl.pathname, declaredBytes: declared });
        continue;
      }
      const buf = Buffer.from(await response.arrayBuffer());
      if (!buf.length || buf.length > MAX_FILE_BYTES || totalBytes + buf.length > MAX_TOTAL_BYTES) {
        recordSkip(!buf.length ? "EMPTY_RESPONSE" : "SIZE_LIMIT", finalUrl.pathname, { status: response.status, contentType: type });
        log("warn", "SIZE-4132", "Skipped empty or oversized response", { requestId, resourcePath: finalUrl.pathname, bytes: buf.length, totalBytes, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES });
        continue;
      }
      let name = safeName(finalUrl, type);
      if (zip.file(name)) name = name.replace(/(\.[^./]+)?$/, `-${manifest.length}$1`);

      if (isHtml(type)) {
        const $ = cheerio.load(buf.toString("utf8"));
        const discovered = new Set<string>();
        $("a[href]").each((_, el) => {
          const raw = $(el).attr("href");
          if (!raw) return;
          try {
            const u = new URL(raw, finalUrl);
            if (u.origin === origin && !/\.(?:pdf|zip|png|jpe?g|gif|webp|svg|ico|woff2?|mp4|webm)$/i.test(u.pathname)) addUrl(discovered, raw, finalUrl, origin);
          } catch {}
        });
        $("script[src],link[href],img[src],source[src],video[src],audio[src],iframe[src],object[data],embed[src]").each((_, el) => {
          const attr = el.tagName === "object" ? "data" : (el.tagName === "link" || el.tagName === "a") ? "href" : "src";
          addUrl(discovered, $(el).attr(attr), finalUrl, origin);
        });
        for (const match of (buf.toString("utf8").match(/url\(([^)]+)\)/g) || [])) {
          addUrl(discovered, match.slice(4, -1).trim().replace(/^['"]|['"]$/g, ""), finalUrl, origin);
        }
        for (const u of discovered) {
          if (seen.has(u) || queue.includes(u)) continue;
          if (queue.length + seen.size >= MAX_PAGES * 3) break;
          queue.push(u);
        }
      } else if (type.toLowerCase().includes("text/css") || finalUrl.pathname.toLowerCase().endsWith(".css")) {
        for (const m of buf.toString("utf8").matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
          const raw = m[2];
          if (!raw || raw.startsWith("data:")) continue;
          try {
            const asset = new URL(raw, finalUrl);
            if (asset.origin === origin && !seen.has(asset.toString()) && !queue.includes(asset.toString())) queue.push(asset.toString());
          } catch {}
        }
      }
      if (finalUrl.pathname === "/" || finalUrl.pathname.endsWith("/")) name = `${finalUrl.hostname}/index.html`;
      zip.file(name, buf);
      manifest.push({ name, size: buf.length });
      totalBytes += buf.length;
      log("info", "FILE-2000", "Archived resource", { requestId, name, bytes: buf.length, fileCount: manifest.length, totalBytes });
    }

    if (!manifest.length) {
      const diagnostics = { requestId, host: targetHost, skipped, skippedByReason, recentResponses, elapsedMs: Date.now() - started };
      log("error", "ARCHIVE-4220", "No eligible public files could be archived", diagnostics);
      return NextResponse.json({ code: "ARCHIVE-4220", error: "No public HTML or assets could be fetched. Review diagnostics to see why responses were skipped.", diagnostics }, { status: 422, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
    }
    zip.file("ARCHIVE-INFO.txt", [
      "Site Archiver export",
      `Starting URL: ${start.toString()}`,
      `Files saved: ${manifest.length}`,
      `Total bytes: ${totalBytes}`,
      `Resources skipped: ${skipped}`,
      "",
      "This archive contains only publicly reachable files discovered from the starting page.",
      "It does not include server-side source code, databases, private files, or authenticated content.",
      "Some links or dynamic features may not work offline."
    ].join("\n"));
    const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 5 } });
    const safeHost = start.hostname.replace(/[^a-z0-9.-]/gi, "_");
    const encodedManifest = encodeURIComponent(JSON.stringify(manifest.slice(0, 25)));
    log("info", "ARCHIVE-2000", "Archive generated successfully", { requestId, host: targetHost, fileCount: manifest.length, skipped, sourceBytes: totalBytes, zipBytes: archive.length, elapsedMs: Date.now() - started });
    return new NextResponse(new Uint8Array(archive), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeHost}-archive.zip"`,
        "Cache-Control": "no-store",
        "X-Archive-Manifest": encodedManifest,
        "X-Archive-File-Count": String(manifest.length),
        "X-Request-Id": requestId
      }
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error && typeof (error as {code?: unknown}).code === "string" ? (error as {code: string}).code : "ARCHIVE-5000";
    const message = error instanceof Error ? error.message : "Unexpected archive error.";
    log("error", code, "Archive request failed unexpectedly", { requestId, host: targetHost, message, elapsedMs: Date.now() - started, stack: error instanceof Error ? error.stack : undefined });
    const status = code.startsWith("SSRF-") ? 400 : code.startsWith("URL-") ? 400 : code.startsWith("DNS-") ? 400 : 500;
    return fail(status, code, message);
  }
}
