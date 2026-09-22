/**
 * dsh-file-shuttle: model-facing file delivery for the DeepSeek Harness.
 *
 * The user often wants the agent to hand over artifacts ("send me that zip /
 * screenshot / report"). This plugin gives the model a `send_files` tool that
 * publishes files through ONE persistent background HTTP server (server.mjs)
 * on a fixed port, bound to every interface so the link works over the
 * Tailscale tailnet and the LAN. The server is started detached on first use
 * and reused afterwards - across tool calls, sessions, and `dsh` restarts.
 * Links carry a 128-bit random token and expire (default 60 min); the server
 * purges expired links on access and on a sweep timer.
 *
 *   send_files     - publish files (multiple files/dirs are zipped on the
 *                    fly with a built-in streaming zip writer) and return
 *                    tailscale/LAN/localhost links with expiry.
 *   shuttle_status - report server state, list active links, purge links.
 *
 * Security model: /publish, /links, /purge are loopback-only (only this
 * machine's harness creates links). The share links themselves are public to
 * whoever can reach the port - the token is the secret, links are short-lived,
 * and originals are copied into the outbox (the source files are never
 * exposed in place).
 *
 * Self-contained on purpose (profile-linked plugins cannot reliably resolve
 * sibling @deepseek-ai packages): tools are plain registry-ready definitions
 * with raw JSON Schemas, in the same shape as dsh-image-finder.
 */
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, createReadStream, createWriteStream } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Writable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const name = "file-shuttle";
const inject = ["tools"];

const DEFAULTS = {
  /** Fixed port for the persistent server (reuse, not per-request servers). */
  port: 8931,
  /** Store root; empty => ~/.dsh/file-shuttle. */
  storeRoot: "",
  /** Default link lifetime in minutes (send_files may override per call). */
  expiryMinutes: 60,
  /** Per-published-file cap forwarded to the server. */
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  /** tailscale CLI override; empty => platform default (win32 install path, else PATH). */
  tailscaleBin: "",
  /** Force a tailscale host (DNS name or IP); empty => detect via `tailscale status --json`. */
  tailscaleHost: "",
  /** Force the LAN host; empty => first non-internal IPv4 of this box. */
  lanHost: "",
  healthTimeoutMs: 1500,
  /** How long to wait for a freshly spawned server to answer /healthz. */
  startTimeoutMs: 10000,
  /** zip default: "auto" (zip when >1 path), "always", or "never". */
  zipDefault: "auto",
};

class ShuttleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ShuttleError";
    this.code = code;
  }
}

function resolveDshHome() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
}

function resolveStoreRoot(config) {
  const root = (typeof config.storeRoot === "string" && config.storeRoot.length > 0)
    ? config.storeRoot
    : join(resolveDshHome(), "file-shuttle");
  mkdirSync(join(root, "staging"), { recursive: true });
  return root;
}

/** Real path of server.mjs (import.meta.url is resolved through pnpm links). */
function serverPath() {
  return fileURLToPath(new URL("../server.mjs", import.meta.url));
}

/**
 * GET /healthz on the loopback port. Resolves true when a healthy server
 * answers, false otherwise (never throws on connectivity problems).
 */
async function serverHealth(port, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new ShuttleError("aborted", "ABORTED"));
    }, { once: true });
  });
}

/**
 * Ensure the persistent server is running: reuse it when /healthz answers,
 * otherwise spawn it DETACHED (it survives the harness process exiting and is
 * reused by every later call) and wait for /healthz.
 */
async function ensureServer(options, signal) {
  if (await serverHealth(options.port, options.healthTimeoutMs)) return "reused";
  const root = options.storeRoot;
  mkdirSync(root, { recursive: true });
  const logPath = join(root, "server.log");
  // spawn wants a raw fd here; a WriteStream has none until it opens.
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [serverPath()], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      SHUTTLE_PORT: String(options.port),
      SHUTTLE_ROOT: root,
      SHUTTLE_MAX_FILE_BYTES: String(options.maxFileBytes),
    },
  });
  child.unref();
  closeSync(logFd);
  const deadline = Date.now() + options.startTimeoutMs;
  for (;;) {
    if (signal?.aborted === true) throw new ShuttleError("aborted", "ABORTED");
    if (await serverHealth(options.port, options.healthTimeoutMs)) {
      return "started";
    }
    if (Date.now() >= deadline) {
      let tail = "";
      try {
        const all = readFileSync(logPath, "utf8").split(/\r?\n/u);
        tail = all.slice(-8).join(" | ");
      } catch {
        /* log unreadable */
      }
      throw new ShuttleError(
        `shuttle server did not answer on port ${options.port} within ${options.startTimeoutMs}ms` +
        (tail.length > 0 ? ` (server.log tail: ${tail})` : ""),
        "SERVER_START_FAILED",
      );
    }
    await sleep(250, signal);
  }
}

/**
 * Tailscale host detection: config override, else `tailscale status --json`
 * (Self.DNSName + first 100.x IP), cached in memory for 10 min and persisted
 * to <root>/tailscale.json as a last-resort fallback when the CLI is gone.
 */
let tailscaleMemory = { at: 0, host: undefined };

function tailscaleBin(options) {
  if (options.tailscaleBin.length > 0) return options.tailscaleBin;
  if (process.platform === "win32") return "C:\\Program Files\\Tailscale\\tailscale.exe";
  return "tailscale";
}

function detectTailscale(options) {
  if (options.tailscaleHost.length > 0) return options.tailscaleHost;
  const statePath = join(options.storeRoot, "tailscale.json");
  if (tailscaleMemory.at > 0 && Date.now() - tailscaleMemory.at < 10 * 60 * 1000 && tailscaleMemory.host !== undefined) {
    return tailscaleMemory.host;
  }
  try {
    const result = spawnSync(tailscaleBin(options), ["status", "--json"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0 && typeof result.stdout === "string" && result.stdout.length > 0) {
      const data = JSON.parse(result.stdout);
      const dnsName = typeof data?.Self?.DNSName === "string" ? data.Self.DNSName.replace(/\.$/u, "") : "";
      const ips = Array.isArray(data?.Self?.TailscaleIPs) ? data.Self.TailscaleIPs : [];
      const ip = ips.find((v) => typeof v === "string" && /^100\./u.test(v)) ?? undefined;
      const host = dnsName.length > 0 ? dnsName : ip;
      if (host !== undefined) {
        tailscaleMemory = { at: Date.now(), host };
        try {
          writeFileSync(statePath, `${JSON.stringify({ at: Date.now(), host }, null, 2)}\n`);
        } catch {
          /* best effort */
        }
        return host;
      }
    }
  } catch {
    /* fall through to the persisted value */
  }
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (typeof state?.host === "string" && state.host.length > 0) return state.host;
  } catch {
    /* no cache */
  }
  return undefined;
}

/** First non-internal IPv4 of this machine (LAN address), or config override. */
function detectLan(options) {
  if (options.lanHost.length > 0) return options.lanHost;
  const interfaces = networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return undefined;
}

function buildLinks(port, token, options) {
  const tailscaleHost = detectTailscale(options);
  const lanHost = detectLan(options);
  const links = {};
  if (tailscaleHost !== undefined) links.tailscale = `http://${tailscaleHost}:${port}/f/${token}`;
  if (lanHost !== undefined) links.lan = `http://${lanHost}:${port}/f/${token}`;
  links.localhost = `http://127.0.0.1:${port}/f/${token}`;
  const primary = links.tailscale ?? links.lan ?? links.localhost;
  return { links, primary };
}

// ---------------------------------------------------------------------------
// Streaming ZIP writer (store layout, DEFLATE via zlib, data descriptors so
// file sizes are never buffered in memory - entries of any size stream).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO 3309 / zlib) as a pass-through Transform. */
class Crc32 extends Transform {
  constructor() {
    super();
    this.crc = 0xffffffff;
  }
  _transform(chunk, _encoding, callback) {
    const table = CRC_TABLE;
    for (let i = 0; i < chunk.length; i += 1) {
      // eslint-disable-next-line no-bitwise
      this.crc = table[(this.crc ^ chunk[i]) & 0xff] ^ (this.crc >>> 8);
    }
    this.push(chunk);
    callback();
  }
  _flush(callback) {
    this.crcValue = (this.crc ^ 0xffffffff) >>> 0;
    callback();
  }
}

/** Writable that forwards to a target stream and counts bytes (never ends it). */
class CountingStream extends Writable {
  constructor(target) {
    super();
    this.target = target;
    this.bytes = 0;
  }
  // Counted on write(), not _write(): zip offsets are read right after a
  // write() call, before a buffered _write() would have run.
  write(chunk, encoding, callback) {
    this.bytes += chunk.length;
    return super.write(chunk, encoding, callback);
  }
  _write(chunk, _encoding, callback) {
    this.target.write(chunk, callback);
  }
  _final(callback) {
    callback();
  }
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const year = Math.max(1980, date.getFullYear());
  const value = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: value & 0xffff };
}

function zipLocalHeader(arcName, time, date) {
  const buffer = Buffer.alloc(30);
  buffer.writeUInt32LE(0x04034b50, 0);
  buffer.writeUInt16LE(20, 4); // version needed
  buffer.writeUInt16LE(0x0008, 6); // flags: data descriptor follows
  buffer.writeUInt16LE(8, 8); // method: deflate
  buffer.writeUInt16LE(time, 10);
  buffer.writeUInt16LE(date, 12);
  buffer.writeUInt32LE(0, 14); // crc (in descriptor)
  buffer.writeUInt32LE(0, 18); // compressed size (in descriptor)
  buffer.writeUInt32LE(0, 22); // uncompressed size (in descriptor)
  const nameBuf = Buffer.from(arcName, "utf8");
  buffer.writeUInt16LE(nameBuf.length, 26);
  buffer.writeUInt16LE(0, 28);
  return [buffer, nameBuf];
}

function zipDataDescriptor(crc, compressedSize, uncompressedSize) {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(0x08074b50, 0);
  buffer.writeUInt32LE(crc >>> 0, 4);
  buffer.writeUInt32LE(compressedSize >>> 0, 8);
  buffer.writeUInt32LE(uncompressedSize >>> 0, 12);
  return buffer;
}

function zipCentralEntry(arcName, time, date, crc, compressedSize, uncompressedSize, offset) {
  const buffer = Buffer.alloc(46);
  buffer.writeUInt32LE(0x02014b50, 0);
  buffer.writeUInt16LE(20, 4); // version made by
  buffer.writeUInt16LE(20, 6); // version needed
  buffer.writeUInt16LE(0x0008, 8); // flags
  buffer.writeUInt16LE(8, 10); // method
  buffer.writeUInt16LE(time, 12);
  buffer.writeUInt16LE(date, 14);
  buffer.writeUInt32LE(crc >>> 0, 16);
  buffer.writeUInt32LE(compressedSize >>> 0, 20);
  buffer.writeUInt32LE(uncompressedSize >>> 0, 24);
  const nameBuf = Buffer.from(arcName, "utf8");
  buffer.writeUInt16LE(nameBuf.length, 28);
  buffer.writeUInt16LE(0, 30); // extra
  buffer.writeUInt16LE(0, 32); // comment
  buffer.writeUInt16LE(0, 34); // disk
  buffer.writeUInt16LE(0, 36); // internal attrs
  buffer.writeUInt32LE(0, 38); // external attrs
  buffer.writeUInt32LE(offset >>> 0, 42);
  return [buffer, nameBuf];
}

function zipEndRecord(count, centralSize, centralOffset) {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt32LE(0x06054b50, 0);
  buffer.writeUInt16LE(0, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt16LE(count, 8);
  buffer.writeUInt16LE(count, 10);
  buffer.writeUInt32LE(centralSize >>> 0, 12);
  buffer.writeUInt32LE(centralOffset >>> 0, 16);
  buffer.writeUInt16LE(0, 20);
  return buffer;
}

/**
 * Stream `entries` ({src, arcName}) as a ZIP into `out` (a writable that will
 * NOT be ended by this call). Uses data descriptors, so each file streams
 * through deflate without buffering. Returns { entries, uncompressed,
 * compressed, centralSize }.
 */
async function zipEntriesToStream(out, entries, signal) {
  const counter = out instanceof CountingStream ? out : new CountingStream(out);
  const centralParts = [];
  let uncompressedTotal = 0;
  let compressedTotal = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (signal?.aborted === true) throw new ShuttleError("aborted", "ABORTED");
    const entry = entries[i];
    const info = statSync(entry.src);
    const arcName = entry.arcName.replace(/\\/gu, "/");
    const { time, date } = dosDateTime(info.mtime);
    const offset = counter.bytes;
    const [header, nameBuf] = zipLocalHeader(arcName, time, date);
    counter.write(Buffer.concat([header, nameBuf]));
    const crc = new Crc32();
    const deflate = zlib.createDeflateRaw({ level: 6 });
    const reader = createReadStream(entry.src);
    let compressed = 0;
    // CRC is over the uncompressed bytes, so it sits before deflate. The sink
    // is a function rather than `counter` itself: pipeline ends a stream sink
    // even with { end: false }, and later entries still need to write to it.
    await pipeline(reader, crc, deflate, async (source) => {
      for await (const chunk of source) {
        compressed += chunk.length;
        if (!counter.write(chunk)) await once(counter, "drain");
      }
    });
    compressedTotal += compressed;
    uncompressedTotal += info.size;
    counter.write(zipDataDescriptor(crc.crcValue, compressed, info.size));
    centralParts.push(...zipCentralEntry(arcName, time, date, crc.crcValue, compressed, info.size, offset));
  }
  const centralOffset = counter.bytes;
  for (const part of centralParts) counter.write(part);
  const centralSize = counter.bytes - centralOffset;
  // Writes land in order, so once the last one's callback fires everything
  // has reached `out` and the caller may end it.
  await new Promise((resolve, reject) => {
    counter.write(zipEndRecord(entries.length, centralSize, centralOffset), (error) => (error ? reject(error) : resolve()));
  });
  return { entries: entries.length, uncompressed: uncompressedTotal, compressed: counter.bytes };
}

// ---------------------------------------------------------------------------
// Entry collection (files + optional directory walks) and publishing.
// ---------------------------------------------------------------------------

const MAX_ZIP_ENTRIES = 10000;

/** Depth-first walk collecting regular files (symlinks skipped) under rootPath. */
function walkDir(rootPath, prefix, out, limitBytes) {
  let total = 0;
  let count = 0;
  const stack = [rootPath];
  while (stack.length > 0) {
    const dir = stack.pop();
    let listing;
    try {
      listing = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of listing) {
      const full = join(dir, item.name);
      let info;
      try {
        info = lstatSync(full);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!info.isFile()) continue;
      count += 1;
      if (count > MAX_ZIP_ENTRIES) throw new ShuttleError(`directory contains more than ${MAX_ZIP_ENTRIES} files`, "TOO_MANY_FILES");
      total += info.size;
      if (total > limitBytes) throw new ShuttleError(`files are larger than the ${limitBytes}-byte limit in total`, "TOO_LARGE");
      const relative = full.slice(rootPath.length + 1).split(sep).join("/");
      out.push({ src: full, arcName: prefix ? `${prefix}/${relative}` : relative });
    }
  }
  return total;
}

function slugify(input, fallback = "files") {
  const base = String(input)
    .replace(/\.[a-z0-9]{1,5}$/iu, "")
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  return (base.length > 0 ? base : fallback).slice(0, 60);
}

function collectEntries(paths, zip, options, signal) {
  if (paths.length === 0) throw new ShuttleError("paths must contain at least one file", "INVALID_ARGS");
  if (paths.length > 32) throw new ShuttleError("at most 32 paths per send", "INVALID_ARGS");
  const entries = [];
  let uncompressed = 0;
  for (const raw of paths) {
    if (signal?.aborted === true) throw new ShuttleError("aborted", "ABORTED");
    const p = String(raw ?? "").trim();
    if (p.length === 0) continue;
    let info;
    try {
      info = lstatSync(p);
    } catch {
      throw new ShuttleError(`no such file or directory: ${p}`, "NOT_FOUND");
    }
    if (info.isSymbolicLink()) throw new ShuttleError(`refusing symlinks: ${p}`, "INVALID_ARGS");
    if (info.isDirectory()) {
      if (!zip) throw new ShuttleError(`directory requires zip: true: ${p}`, "INVALID_ARGS");
      const prefix = slugify(p.split(sep).filter(Boolean).pop(), "dir");
      uncompressed += walkDir(p, prefix, entries, options.maxFileBytes);
      continue;
    }
    if (!info.isFile()) throw new ShuttleError(`not a regular file: ${p}`, "INVALID_ARGS");
    if (info.size > options.maxFileBytes) throw new ShuttleError(`file exceeds the ${options.maxFileBytes}-byte limit: ${p}`, "TOO_LARGE");
    uncompressed += info.size;
    if (uncompressed > options.maxFileBytes) throw new ShuttleError(`files exceed the ${options.maxFileBytes}-byte limit in total`, "TOO_LARGE");
    entries.push({ src: p, arcName: p.split(sep).filter(Boolean).pop() });
  }
  if (entries.length === 0) throw new ShuttleError("no files to send", "INVALID_ARGS");
  return { entries, uncompressed };
}

/** POST the staged file list to the loopback server. */
async function publishViaServer(options, payload, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(`http://127.0.0.1:${options.port}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
    if (!response.ok) throw new ShuttleError(`publish failed (HTTP ${response.status}): ${data.error ?? "unknown error"}`, "PUBLISH_FAILED");
    return data;
  } catch (error) {
    if (error instanceof ShuttleError) throw error;
    if (signal?.aborted === true) throw new ShuttleError("aborted", "ABORTED");
    throw new ShuttleError(`publish failed: ${error instanceof Error ? error.message : String(error)}`, "PUBLISH_FAILED");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Model-facing tools.
// ---------------------------------------------------------------------------

function renderSendFiles(value) {
  const lines = [`Sent ${value.files.length} file${value.files.length === 1 ? "" : "s"} (${value.totalBytes} bytes)`];
  lines.push(`Link (expires in ~${value.expiresInMin} min):`);
  lines.push(value.primary);
  for (const [net, url] of Object.entries(value.links)) {
    if (url === value.primary) continue;
    lines.push(`  ${net}: ${url}`);
  }
  if (value.note) lines.push(`note: ${value.note}`);
  lines.push("Give the primary (tailscale) link to the user; the others are fallbacks from other networks.");
  return lines.join("\n");
}

function sendFilesTool(options) {
  return {
    name: "send_files",
    description:
      "Send files to the user as expiring download links over Tailscale/LAN. " +
      "Pass file paths (directories allowed); with 2+ paths or a directory the files are zipped automatically. " +
      "The link is served by one persistent background shuttle server (reused across calls) and expires after a short time (default 60 min). " +
      "Use it whenever the user asks you to send/deliver/share a file, image, or zip. Returns the link to put in your reply.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Absolute paths of the files (or directories, which are included when zipped) to send.",
        },
        zip: {
          type: "boolean",
          description: "Force (un)zipping. Default: zip when more than one path is given.",
        },
        name: {
          type: "string",
          description: "Optional base name for the zip (extension added) or override display name for a single file.",
        },
        expiryMinutes: {
          type: "number",
          description: "Link lifetime in minutes (default from config, typically 60; max 20160).",
        },
        note: {
          type: "string",
          description: "Optional note shown on the download page.",
        },
      },
      required: ["paths"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          primary: { type: "string" },
          links: {
            type: "object",
            additionalProperties: false,
            properties: {
              tailscale: { type: "string" },
              lan: { type: "string" },
              localhost: { type: "string" },
            },
            required: ["localhost"],
          },
          files: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                origName: { type: "string" },
                size: { type: "integer" },
              },
              required: ["name", "origName", "size"],
            },
          },
          totalBytes: { type: "integer" },
          expiresInMin: { type: "integer" },
          note: { type: "string" },
        },
        required: ["primary", "links", "files", "totalBytes", "expiresInMin"],
      },
      render: (_args, value) => [{ type: "text", text: renderSendFiles(value) }],
    },
    timeoutMs: 10 * 60 * 1000,
    async execute(args, exec) {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      const zip = typeof args.zip === "boolean"
        ? args.zip
        : options.zipDefault === "always"
          ? true
          : options.zipDefault === "never"
            ? false
            : paths.length > 1;
      const { entries, uncompressed } = collectEntries(paths, zip, options, exec.signal);

      let staged = entries.map((e) => e.src);
      let displayName = (typeof args.name === "string" && args.name.trim().length > 0) ? args.name.trim() : undefined;
      let stagingZip = undefined;
      if (zip) {
        const stamp = new Date().toISOString().replace(/[-:]/gu, "").slice(0, 15);
        const base = displayName !== undefined ? slugify(displayName) : `dsh-send-${stamp}`;
        const zipName = `${base}.zip`;
        stagingZip = join(options.storeRoot, "staging", `${Date.now()}-${randomBytes(4).toString("hex")}-${zipName}`);
        const out = createWriteStream(stagingZip);
        try {
          await zipEntriesToStream(out, entries, exec.signal);
          await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
        } catch (error) {
          try {
            out.closeSync();
          } catch {
            /* already closed */
          }
          rmSync(stagingZip, { force: true });
          if (error instanceof ShuttleError) throw error;
          throw new ShuttleError(`zip write failed: ${error instanceof Error ? error.message : String(error)}`, "PUBLISH_FAILED");
        }
        const zipSize = statSync(stagingZip).size;
        if (zipSize > options.maxFileBytes) {
          rmSync(stagingZip, { force: true });
          throw new ShuttleError(`zip exceeds the ${options.maxFileBytes}-byte limit`, "TOO_LARGE");
        }
        displayName = zipName;
        staged = [stagingZip];
      }

      let payload;
      try {
        await ensureServer(options, exec.signal);
        payload = await publishViaServer(options, {
          files: staged.map((src, i) => (i === 0 && displayName !== undefined ? { path: src, name: displayName } : { path: src })),
          note: typeof args.note === "string" ? args.note : "",
          expiryMinutes: Number.isFinite(args.expiryMinutes) && args.expiryMinutes > 0 ? Math.min(args.expiryMinutes, 20160) : options.expiryMinutes,
        }, exec.signal);
      } finally {
        if (stagingZip !== undefined) {
          try {
            rmSync(stagingZip, { force: true });
          } catch {
            /* best effort */
          }
        }
      }

      const { links, primary } = buildLinks(options.port, payload.token, options);
      return {
        primary,
        links,
        files: payload.files,
        totalBytes: payload.totalBytes,
        expiresInMin: payload.expiresInMin,
        ...(typeof args.note === "string" && args.note.length > 0 ? { note: args.note } : {}),
      };
    },
  };
}

function renderShuttleStatus(value) {
  const lines = [];
  lines.push(value.serverUp ? `shuttle server UP (port ${value.port}, uptime ${value.uptimeSec}s, ${value.active} active link${value.active === 1 ? "" : "s"})` : `shuttle server DOWN (port ${value.port}) - it starts automatically on the next send_files`);
  if (value.purged !== undefined) lines.push(`purged: ${value.purged.length > 0 ? value.purged.join(", ") : "nothing"}`);
  for (const link of value.links ?? []) {
    const state = link.expired ? "EXPIRED" : `~${link.minutesLeft}min left`;
    lines.push(`- [${state}] ${link.files.join(", ")} (${link.totalBytes}B) token=${link.token.slice(0, 8)}…`);
  }
  if (Array.isArray(value.links) && value.links.length === 0) lines.push("- no active links");
  return lines.join("\n");
}

function shuttleStatusTool(options) {
  return {
    name: "shuttle_status",
    description:
      "Inspect the file-shuttle server: whether it is running, which links are currently live (with time left), and purge one or all links. " +
      "Use it when the user asks what is currently being served or wants a link revoked.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["list", "purge"],
          description: "'list' (default) shows active links; 'purge' removes them.",
        },
        token: {
          type: "string",
          description: "With action=purge: the token of ONE link to purge (prefix ok). Omit to purge all.",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          serverUp: { type: "boolean" },
          port: { type: "integer" },
          uptimeSec: { type: "integer" },
          active: { type: "integer" },
          links: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                token: { type: "string" },
                note: { type: "string" },
                minutesLeft: { type: "integer" },
                expired: { type: "boolean" },
                files: { type: "array", items: { type: "string" } },
                totalBytes: { type: "integer" },
              },
              required: ["token", "minutesLeft", "expired", "files", "totalBytes"],
            },
          },
          purged: { type: "array", items: { type: "string" } },
        },
        required: ["serverUp", "port", "active"],
      },
      render: (_args, value) => [{ type: "text", text: renderShuttleStatus(value) }],
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      const action = args.action === "purge" ? "purge" : "list";
      const up = await serverHealth(options.port, options.healthTimeoutMs);
      if (!up) {
        return { serverUp: false, port: options.port, uptimeSec: 0, active: 0, links: [], ...(action === "purge" ? { purged: [] } : {}) };
      }
      if (action === "purge") {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(`http://127.0.0.1:${options.port}/purge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(typeof args.token === "string" && args.token.length > 0 ? { token: args.token } : {}),
            signal: controller.signal,
          });
          const data = await response.json();
          if (!response.ok) throw new ShuttleError(`purge failed (HTTP ${response.status})`, "PUBLISH_FAILED");
          const health = await fetch(`http://127.0.0.1:${options.port}/healthz`, { signal: controller.signal }).then((r) => r.json()).catch(() => ({ active: 0, uptimeSec: 0 }));
          return { serverUp: true, port: options.port, uptimeSec: health.uptimeSec ?? 0, active: health.active ?? 0, links: [], purged: data.purged ?? [] };
        } finally {
          clearTimeout(timer);
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const [healthResponse, linksResponse] = await Promise.all([
          fetch(`http://127.0.0.1:${options.port}/healthz`, { signal: controller.signal }),
          fetch(`http://127.0.0.1:${options.port}/links`, { signal: controller.signal }),
        ]);
        const health = await healthResponse.json();
        const linksData = await linksResponse.json();
        return {
          serverUp: true,
          port: options.port,
          uptimeSec: health.uptimeSec ?? 0,
          active: health.active ?? 0,
          links: Array.isArray(linksData.links) ? linksData.links : [],
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin entry point.
// ---------------------------------------------------------------------------

function apply(ctx, config = {}) {
  const merged = { ...DEFAULTS, ...config };
  const options = {
    port: Number.isInteger(merged.port) && merged.port > 0 ? merged.port : DEFAULTS.port,
    storeRoot: resolveStoreRoot(merged),
    expiryMinutes: Number.isFinite(merged.expiryMinutes) && merged.expiryMinutes > 0 ? merged.expiryMinutes : DEFAULTS.expiryMinutes,
    maxFileBytes: Number.isFinite(merged.maxFileBytes) && merged.maxFileBytes > 0 ? merged.maxFileBytes : DEFAULTS.maxFileBytes,
    tailscaleBin: typeof merged.tailscaleBin === "string" ? merged.tailscaleBin : "",
    tailscaleHost: typeof merged.tailscaleHost === "string" ? merged.tailscaleHost : "",
    lanHost: typeof merged.lanHost === "string" ? merged.lanHost : "",
    healthTimeoutMs: Number.isFinite(merged.healthTimeoutMs) && merged.healthTimeoutMs > 0 ? merged.healthTimeoutMs : DEFAULTS.healthTimeoutMs,
    startTimeoutMs: Number.isFinite(merged.startTimeoutMs) && merged.startTimeoutMs > 0 ? merged.startTimeoutMs : DEFAULTS.startTimeoutMs,
    zipDefault: merged.zipDefault === "always" || merged.zipDefault === "never" ? merged.zipDefault : "auto",
  };
  ctx.tools.register(sendFilesTool(options));
  ctx.tools.register(shuttleStatusTool(options));
  ctx.logger?.info?.(`[file-shuttle] armed (port=${options.port}, store=${options.storeRoot}, expiry=${options.expiryMinutes}m, tailscale=${options.tailscaleHost || "auto"}, lan=${options.lanHost || "auto"})`);
}

export {
  apply,
  inject,
  name,
  ShuttleError,
  DEFAULTS,
  resolveStoreRoot,
  serverPath,
  serverHealth,
  ensureServer,
  detectTailscale,
  detectLan,
  buildLinks,
  zipEntriesToStream,
  dosDateTime,
  collectEntries,
  walkDir,
  slugify,
  renderSendFiles,
  sendFilesTool,
  shuttleStatusTool,
  Crc32,
  CRC_TABLE,
};
