#!/usr/bin/env node
/**
 * dsh-file-shuttle server: one persistent background process that serves
 * expiring file-share links for the DeepSeek Harness.
 *
 * The harness plugin (lib/index.js) starts this ONCE (detached) on first use
 * and reuses it afterwards - across tool calls and across `dsh` restarts. It
 * binds every interface so the links are reachable over the Tailscale tailnet
 * and the LAN; the 128-bit link token is the only secret. Publish/list/purge
 * endpoints are loopback-only - only this machine's harness can create links.
 *
 * Layout (SHUTTLE_ROOT, default ~/.dsh/file-shuttle):
 *   outbox/<token>/<file>   - published copies (originals are never exposed)
 *   staging/                - where the plugin drops freshly built zips
 *   manifest.json           - token -> { note, createdAt, expiresAt, files[] }
 *
 * Env:
 *   SHUTTLE_PORT           default 8931
 *   SHUTTLE_ROOT           default ~/.dsh/file-shuttle
 *   SHUTTLE_MAX_FILE_BYTES default 2147483648 (2 GiB per published file)
 *   SHUTTLE_SWEEP_MS       default 600000 (expired-link sweep interval)
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";

const PORT = Number(process.env.SHUTTLE_PORT ?? 8931);
const ROOT = (process.env.SHUTTLE_ROOT ?? "").trim().length > 0
  ? process.env.SHUTTLE_ROOT
  : join(homedir(), ".dsh", "file-shuttle");
const OUTBOX = join(ROOT, "outbox");
const STAGING = join(ROOT, "staging");
const MANIFEST_PATH = join(ROOT, "manifest.json");
const MAX_FILE_BYTES = Number(process.env.SHUTTLE_MAX_FILE_BYTES ?? 2147483648);
const SWEEP_MS = Number(process.env.SHUTTLE_SWEEP_MS ?? 600000);
const BODY_LIMIT = 1024 * 1024;
const STARTED_AT = Date.now();

const MIME = {
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xml": "application/xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".py": "text/x-python; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".sh": "text/x-shellscript; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
};

/** Serialize manifest read-modify-write cycles (single process, async hops). */
let manifestLock = Promise.resolve();
function withManifestLock(fn) {
  const run = manifestLock.then(fn, fn);
  manifestLock = run.catch(() => {});
  return run;
}

function loadManifest() {
  try {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    if (raw !== null && typeof raw === "object" && raw.tokens !== null && typeof raw.tokens === "object") {
      return raw;
    }
  } catch {
    /* absent or corrupt: start empty (corrupt manifests are not worth keeping) */
  }
  return { tokens: {} };
}

function saveManifest(manifest) {
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

function isLoopback(req) {
  const remote = req.socket?.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Filesystem-safe name for a published entry: basename, no path tricks. */
function sanitizeName(raw, fallback) {
  let base = String(raw ?? "").split(/[\\/]/u).pop() ?? "";
  base = base.replace(/[\x00-\x1f]/gu, "").replace(/[/\\:*?"<>|]/gu, "-").trim();
  if (base.length === 0) base = fallback;
  return base.slice(0, 200);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

async function publish(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  if (files.length === 0) throw Object.assign(new Error("files[] is required"), { code: "BAD_REQUEST" });
  if (files.length > 64) throw Object.assign(new Error("at most 64 files per link"), { code: "BAD_REQUEST" });
  let expiryMinutes = Number(payload.expiryMinutes);
  if (!Number.isFinite(expiryMinutes) || expiryMinutes <= 0) expiryMinutes = 60;
  if (expiryMinutes > 20160) expiryMinutes = 20160; // 14 days
  const note = typeof payload.note === "string" ? payload.note.slice(0, 2000) : "";

  const staged = [];
  for (let i = 0; i < files.length; i += 1) {
    const entry = files[i];
    if (entry === null || typeof entry !== "object" || typeof entry.path !== "string" || entry.path.length === 0) {
      throw Object.assign(new Error(`files[${i}].path must be a non-empty string`), { code: "BAD_REQUEST" });
    }
    const info = await stat(entry.path).catch(() => {
      throw Object.assign(new Error(`files[${i}]: no such file: ${entry.path}`), { code: "BAD_REQUEST" });
    });
    if (!info.isFile()) {
      throw Object.assign(new Error(`files[${i}] is not a regular file: ${entry.path}`), { code: "BAD_REQUEST" });
    }
    if (info.size > MAX_FILE_BYTES) {
      throw Object.assign(new Error(`files[${i}] exceeds the ${MAX_FILE_BYTES}-byte limit`), { code: "BAD_REQUEST" });
    }
    staged.push({ src: entry.path, name: sanitizeName(entry.name ?? entry.path, `file-${i + 1}`) });
  }
  // De-duplicate display names (two "report.txt" in one link would collide).
  const used = new Map();
  for (const s of staged) {
    const n = used.get(s.name) ?? 0;
    used.set(s.name, n + 1);
    if (n > 0) {
      const dot = s.name.lastIndexOf(".");
      s.name = dot > 0 ? `${s.name.slice(0, dot)}-${n + 1}${s.name.slice(dot)}` : `${s.name}-${n + 1}`;
    }
  }

  const token = randomBytes(16).toString("hex");
  const dir = join(OUTBOX, token);
  await mkdir(dir, { recursive: true });
  const published = [];
  try {
    for (const s of staged) {
      await copyFile(s.src, join(dir, s.name));
      const info = await stat(join(dir, s.name));
      // An explicit name (e.g. a zip staged under a unique temp name) is what
      // the user should see; otherwise the source's own filename.
      published.push({ name: s.name, origName: files[staged.indexOf(s)].name ? s.name : sanitizeName(s.src.split(sep).pop(), s.name), size: info.size });
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw Object.assign(new Error(`publish failed: ${error instanceof Error ? error.message : String(error)}`), { code: "PUBLISH_FAILED" });
  }

  const record = {
    note,
    createdAt: Date.now(),
    expiresAt: Date.now() + Math.round(expiryMinutes * 60000),
    files: published,
  };
  await withManifestLock(async () => {
    const manifest = loadManifest();
    manifest.tokens[token] = record;
    saveManifest(manifest);
  });
  return {
    token,
    expiresAt: record.expiresAt,
    expiresInMin: Math.round((record.expiresAt - Date.now()) / 60000),
    files: published,
    totalBytes: published.reduce((sum, f) => sum + f.size, 0),
  };
}

function renderIndexPage(token, record) {
  const now = Date.now();
  const minutesLeft = Math.max(0, Math.ceil((record.expiresAt - now) / 60000));
  const rows = record.files
    .map((f) => {
      const href = `/f/${encodeURIComponent(token)}/${encodeURIComponent(f.name)}`;
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(f.origName)}</a> <span class="size">${escapeHtml(formatSize(f.size))}</span></li>`;
    })
    .join("\n");
  const noteHtml = record.note ? `<p class="note">${escapeHtml(record.note)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh file shuttle</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; background: #101216; color: #e8eaed; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  a { color: #8ab4f8; text-decoration: none; word-break: break-all; }
  a:hover { text-decoration: underline; }
  ul { list-style: none; padding: 0; }
  li { padding: .55rem 0; border-bottom: 1px solid #262a31; }
  .size { color: #9aa0a6; margin-left: .5rem; }
  .note { color: #9aa0a6; white-space: pre-wrap; }
  .meta { color: #9aa0a6; font-size: .85rem; margin-top: 2rem; }
</style>
</head>
<body>
<h1>dsh file shuttle</h1>
${noteHtml}
<ul>
${rows}
</ul>
<p class="meta">Link expires in about ${minutesLeft} min (UTC ${new Date(record.expiresAt).toUTCString()}).<br>Served by dsh-file-shuttle on this machine; the link token is the only secret.</p>
</body>
</html>
`;
}

function contentDisposition(filename) {
  const safe = filename.replace(/["\r\n]/gu, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/healthz") {
    const manifest = loadManifest();
    const now = Date.now();
    const active = Object.entries(manifest.tokens).filter(([, r]) => r.expiresAt > now).length;
    return sendJson(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), active, root: ROOT });
  }

  if (req.method === "POST" && path === "/publish") {
    if (!isLoopback(req)) return sendError(res, 403, "publish is loopback-only");
    try {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const result = await publish(payload);
      return sendJson(res, 200, result);
    } catch (error) {
      const status = error?.code === "BAD_REQUEST" ? 400 : 500;
      return sendError(res, status, error instanceof Error ? error.message : String(error));
    }
  }

  if (req.method === "GET" && path === "/links") {
    if (!isLoopback(req)) return sendError(res, 403, "loopback-only");
    const manifest = loadManifest();
    const now = Date.now();
    const links = Object.entries(manifest.tokens)
      .map(([token, r]) => ({
        token,
        note: r.note,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        minutesLeft: Math.max(0, Math.ceil((r.expiresAt - now) / 60000)),
        expired: r.expiresAt <= now,
        files: r.files.map((f) => f.name),
        totalBytes: r.files.reduce((sum, f) => sum + f.size, 0),
      }))
      .sort((a, b) => b.expiresAt - a.expiresAt);
    return sendJson(res, 200, { active: links.filter((l) => !l.expired).length, links });
  }

  if (req.method === "POST" && path === "/purge") {
    if (!isLoopback(req)) return sendError(res, 403, "loopback-only");
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      payload = {};
    }
    const target = typeof payload.token === "string" ? payload.token : null;
    const purged = [];
    await withManifestLock(async () => {
      const manifest = loadManifest();
      const keys = target !== null ? [target].filter((t) => manifest.tokens[t] !== undefined) : Object.keys(manifest.tokens);
      for (const key of keys) {
        delete manifest.tokens[key];
        purged.push(key);
      }
      saveManifest(manifest);
    });
    for (const key of purged) {
      await rm(join(OUTBOX, key), { recursive: true, force: true });
    }
    return sendJson(res, 200, { purged });
  }

  const match = /^\/f\/([^/]+)\/?([^/]+)?$/u.exec(path);
  if (match && req.method === "GET") {
    const token = decodeURIComponent(match[1]);
    const fileName = match[2] !== undefined ? decodeURIComponent(match[2]) : null;
    const manifest = loadManifest();
    const record = manifest.tokens[token];
    if (record === undefined) return sendError(res, 404, "no such link (expired links are purged)");
    if (record.expiresAt <= Date.now()) {
      await withManifestLock(async () => {
        const fresh = loadManifest();
        delete fresh.tokens[token];
        saveManifest(fresh);
      });
      await rm(join(OUTBOX, token), { recursive: true, force: true });
      return sendError(res, 410, "link expired");
    }
    if (fileName === null) {
      const body = renderIndexPage(token, record);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      return res.end(body);
    }
    const entry = record.files.find((f) => f.name === fileName);
    if (entry === undefined) return sendError(res, 404, "no such file in this link");
    const filePath = join(OUTBOX, token, fileName);
    let stream;
    try {
      stream = createReadStream(filePath);
    } catch {
      return sendError(res, 404, "file missing from disk");
    }
    res.writeHead(200, {
      "content-type": MIME[fileName.slice(fileName.lastIndexOf("."))] ?? "application/octet-stream",
      "content-length": entry.size,
      "content-disposition": contentDisposition(entry.name),
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    stream.pipe(res);
    stream.on("error", () => res.destroy());
    return undefined;
  }

  return sendError(res, 404, "not found");
}

/** Drop expired links on a timer so disk does not accumulate dead tokens. */
function sweep() {
  withManifestLock(async () => {
    const manifest = loadManifest();
    const now = Date.now();
    const expired = Object.keys(manifest.tokens).filter((t) => manifest.tokens[t].expiresAt <= now);
    if (expired.length === 0) return;
    for (const key of expired) delete manifest.tokens[key];
    saveManifest(manifest);
    for (const key of expired) {
      await rm(join(OUTBOX, key), { recursive: true, force: true });
      console.log(`[file-shuttle] swept expired link ${key}`);
    }
  }).catch((error) => console.error("[file-shuttle] sweep failed:", error));
}

async function main() {
  await mkdir(OUTBOX, { recursive: true });
  await mkdir(STAGING, { recursive: true });
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error("[file-shuttle] request failed:", error);
      if (!res.headersSent) sendError(res, 500, "internal error");
      else res.destroy();
    });
  });
  server.on("error", (error) => {
    console.error(`[file-shuttle] server error: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[file-shuttle] serving on 0.0.0.0:${PORT} (root=${ROOT}, maxFile=${MAX_FILE_BYTES}B, sweep=${SWEEP_MS}ms)`);
  });
  const sweepTimer = setInterval(sweep, SWEEP_MS);
  sweepTimer.unref?.();
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      console.log(`[file-shuttle] ${signal}: shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

main();
