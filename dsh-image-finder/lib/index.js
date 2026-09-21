/**
 * dsh-image-finder: model-facing image tools for the DeepSeek Harness.
 *
 * The sandboxed shell tools (pwsh/bash) cannot always reach the open web, so
 * "find me images" was impossible from an agent turn. This plugin registers two
 * model-facing tools on `ctx.tools` that run inside the harness process with
 * normal network access:
 *
 *   find_images - image search (Brave Image Search API primary, Bing HTML
 *                 scraping fallback when no key is configured or Brave fails),
 *                 plus og:image / product-image scraping of page URLs the
 *                 model already has. Downloads the top N images into the
 *                 session workspace so the agent can view them with read_image.
 *   fetch_image - download one direct image URL into the workspace.
 *
 * Backend choice: BRAVE_API_KEY (config literal -> process.env -> ~/.dsh/.env,
 * the same resolution order as dsh-web-search-ollama) enables the official
 * Brave Image Search API. Without a key, or when Brave errors, it falls back
 * to scraping Bing's /images/search result page, which needs no key. Bing is
 * tried over https first and retries over plain http, which also makes the
 * fallback usable from restricted networks that block outbound 443.
 *
 * Self-contained on purpose: a profile-linked plugin cannot reliably resolve
 * sibling @deepseek-ai packages, so it builds the registry-ready ToolDefinition
 * by hand (raw JSON Schemas - the same shape defineTool's output has) instead
 * of importing @deepseek-ai/dsh-tools.
 *
 * Images are downloaded as untrusted content: files are written under
 * <outDir>/images-<slug>/ and the agent views them with read_image, so image
 * bytes never cross into the session log directly.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const name = "image-finder";
const inject = ["tools"];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const DEFAULTS = {
  braveApiKeyEnv: "BRAVE_API_KEY",
  /** Directory image downloads land in; empty => <process cwd>/images. */
  outDir: "",
  /** Default cap for find_images when the model does not pass maxImages. */
  maxImages: 8,
  /** Per-HTTP-request timeout in milliseconds. */
  timeoutMs: 20000,
  /** Refuse downloads larger than this many bytes. */
  maxDownloadBytes: 10 * 1024 * 1024,
};

/** Typed error with a machine-routable code (matches the llmhub plugin convention). */
class ImageFinderError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ImageFinderError";
    this.code = code;
  }
}

/** Read one key from ~/.dsh/.env (or $DSH_HOME/.env). Best-effort, never throws. */
function readDshEnv(key) {
  const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
  let text;
  try {
    text = readFileSync(join(dshHome, ".env"), "utf8");
  } catch {
    return undefined;
  }
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/** Resolve a credential: literal config -> process.env -> ~/.dsh/.env. */
function resolveKey(literal, envName) {
  if (typeof literal === "string" && literal.length > 0) return literal;
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return readDshEnv(envName);
}

function isAbort(error) {
  return error instanceof ImageFinderError && error.code === "ABORTED";
}

/** fetch() with a hard timeout that also honors the caller's cancellation signal. */
async function fetchWithTimeout(url, init, signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ImageFinderError("request timed out", "TIMEOUT")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { redirect: "follow", ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted === true) throw new ImageFinderError("request aborted", "ABORTED", );
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof ImageFinderError && reason.code === "TIMEOUT") throw reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Brave Image Search API. GET /res/v1/images/search?q=&count=&safesearch=strict
 * with X-Subscription-Token; response is { results: [{ id, image, thumb, title, url, ... }] }
 * where `image` is the direct image URL and `url` the source page.
 */
async function braveImageSearch(apiKey, query, count, signal, options) {
  const url = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=${count}&safesearch=strict`;
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "x-subscription-token": apiKey,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
    },
    signal,
    options.timeoutMs,
  );
  if (!response.ok) {
    throw new ImageFinderError(`Brave image search HTTP ${response.status}`, "PROVIDER_ERROR");
  }
  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  const rows = [];
  for (const r of results) {
    if (typeof r?.image !== "string" || r.image.length === 0) continue;
    rows.push({
      url: r.image,
      engine: "brave",
      ...(typeof r?.url === "string" && r.url.length > 0 ? { sourceUrl: r.url } : {}),
      ...(typeof r?.title === "string" && r.title.length > 0 ? { title: r.title } : {}),
    });
  }
  return rows;
}

/** Single-pass HTML entity unescape for the small set Bing uses in result metadata. */
function unescapeHtml(text) {
  return text.replace(/&quot;|&#39;|&lt;|&gt;|&amp;/gu, (entity) => (
    { "&quot;": "\"", "&#39;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" }[entity]
  ));
}

/**
 * Parse Bing /images/search result pages. Each result carries an `m` attribute
 * holding (HTML-entity-escaped) JSON: { murl: direct image, purl: source page,
 * t: title, ... }. Other attributes share the name `m` (e.g. m="false"), so
 * only values that decode to a JSON object with a usable murl count.
 */
function parseBingImages(html) {
  const rows = [];
  const seen = new Set();
  for (const match of html.matchAll(/m="([^"]*)"/gu)) {
    const raw = match[1];
    if (raw.length === 0 || !raw.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(unescapeHtml(raw));
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== "object") continue;
    if (typeof obj.murl !== "string" || obj.murl.length === 0 || seen.has(obj.murl)) continue;
    seen.add(obj.murl);
    rows.push({
      url: obj.murl,
      engine: "bing",
      ...(typeof obj.purl === "string" && obj.purl.length > 0 ? { sourceUrl: obj.purl } : {}),
      ...(typeof obj.t === "string" && obj.t.length > 0 ? { title: obj.t } : {}),
    });
  }
  return rows;
}

/**
 * Bing image search, keyless. Tries https first and retries over plain http
 * (works from networks that block outbound 443; the page serves the same
 * result metadata on both).
 */
async function bingImageSearch(query, count, signal, options) {
  const qs = `q=${encodeURIComponent(query)}&first=1&count=35`;
  let lastError;
  for (const scheme of ["https:", "http:"]) {
    if (signal?.aborted === true) throw new ImageFinderError("request aborted", "ABORTED");
    try {
      const response = await fetchWithTimeout(
        `${scheme}//www.bing.com/images/search?${qs}`,
        { headers: { accept: "text/html", "user-agent": USER_AGENT } },
        signal,
        options.timeoutMs,
      );
      if (!response.ok) throw new ImageFinderError(`Bing HTTP ${response.status}`, "PROVIDER_ERROR");
      const html = await response.text();
      const rows = parseBingImages(html);
      if (rows.length > 0) return rows.slice(0, count);
      lastError = new ImageFinderError("Bing page contained no parseable image metadata", "PROVIDER_ERROR");
    } catch (error) {
      if (isAbort(error)) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new ImageFinderError("Bing image search failed", "PROVIDER_ERROR");
}

/**
 * Extract candidate image URLs from a page: og:image (and secure variant),
 * twitter:image, link[rel=image_src], JSON-LD image fields, and <img> src.
 * Relative references resolve against the final (post-redirect) page URL.
 */
function scrapePageImages(html, pageUrl) {
  const found = [];
  const add = (value) => {
    if (typeof value !== "string" || value.length === 0) return;
    let parsed;
    try {
      parsed = new URL(value, pageUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    const url = parsed.toString();
    if (/\.svg(\?|#|$)/iu.test(url)) return; // read_image cannot rasterize SVG
    found.push(url);
  };

  const metaRe = /<meta[^>]+>/gi;
  for (const tag of html.matchAll(metaRe)) {
    const el = tag[0];
    const prop = /(?:property|name)\s*=\s*["']?(og:image(?::secure_url)?|twitter:image)["']?/iu.exec(el);
    const content = /content\s*=\s*["']([^"']+)["']/iu.exec(el);
    if (prop && content) add(content[1]);
  }
  const linkRe = /<link[^>]+rel\s*=\s*["']?image_src["']?[^>]*>/gi;
  for (const tag of html.matchAll(linkRe)) {
    const href = /href\s*=\s*["']([^"']+)["']/iu.exec(tag[0]);
    if (href) add(href[1]);
  }
  const jsonLdRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const tag of html.matchAll(jsonLdRe)) {
    try {
      const walk = (node) => {
        if (node === null || typeof node !== "object") return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        for (const key of Object.keys(node)) {
          if (key === "image") {
            const value = node.image;
            if (typeof value === "string") add(value);
            else if (Array.isArray(value)) {
              for (const item of value) {
                if (typeof item === "string") add(item);
                else if (item !== null && typeof item === "object") walk(item);
              }
            } else if (value !== null && typeof value === "object") walk(value);
          }
        }
      };
      walk(JSON.parse(tag[1]));
    } catch {
      // malformed JSON-LD block: skip
    }
  }
  const imgRe = /<img[^>]+>/gi;
  for (const tag of html.matchAll(imgRe)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/iu.exec(tag[0]);
    if (src) add(src[1]);
  }

  const seen = new Set();
  return found.filter((url) => (seen.has(url) ? false : (seen.add(url), true)));
}

/** Magic-byte sniffing so a 200-with-HTML error page is never saved as a photo. */
const IMAGE_SIGNATURES = [
  { bytes: [0xff, 0xd8, 0xff], type: "image/jpeg", ext: ".jpg" },
  { bytes: [0x89, 0x50, 0x4e, 0x47], type: "image/png", ext: ".png" },
  { bytes: [0x47, 0x49, 0x46, 0x38], type: "image/gif", ext: ".gif" },
];

/**
 * Identify the image type: content-type header first, magic bytes as the
 * ground truth (a mismatched header loses), URL extension as a last resort.
 * Returns { type, ext } or undefined when the bytes are not a supported image.
 */
function detectImageType(bytes, contentType, url) {
  if (typeof contentType === "string") {
    const match = /^image\/(jpeg|png|gif|webp)/iu.exec(contentType.trim());
    if (match) {
      const map = { jpeg: ".jpg", png: ".png", gif: ".gif", webp: ".webp" };
      return { type: `image/${match[1].toLowerCase()}`, ext: map[match[1].toLowerCase()] };
    }
  }
  const head = Buffer.from(bytes.subarray(0, 16));
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.bytes.every((b, i) => head[i] === b)) return { type: sig.type, ext: sig.ext };
  }
  if (head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
    return { type: "image/webp", ext: ".webp" };
  }
  const extMatch = /\.(jpe?g|png|gif|webp)(\?|#|$)/iu.exec(url);
  if (extMatch) {
    const ext = extMatch[1].toLowerCase() === "jpeg" ? ".jpg" : `.${extMatch[1].toLowerCase()}`;
    return { type: `image/${ext.slice(1)}`, ext };
  }
  return undefined;
}

/** Download one image URL and verify it is a real supported image. */
async function fetchImageBytes(url, signal, options) {
  const response = await fetchWithTimeout(
    url,
    { headers: { accept: "image/*,*/*;q=0.8", "user-agent": USER_AGENT } },
    signal,
    options.timeoutMs,
  );
  if (!response.ok) throw new ImageFinderError(`HTTP ${response.status} for ${url}`, "DOWNLOAD_ERROR");
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > options.maxDownloadBytes) {
    throw new ImageFinderError(`image too large (${declared} bytes)`, "DOWNLOAD_ERROR");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > options.maxDownloadBytes) {
    throw new ImageFinderError(`image too large (${buffer.length} bytes)`, "DOWNLOAD_ERROR");
  }
  const detected = detectImageType(buffer, response.headers.get("content-type"), url);
  if (detected === undefined) {
    throw new ImageFinderError("response is not a supported image (jpeg/png/gif/webp)", "DOWNLOAD_ERROR");
  }
  return { bytes: buffer, contentType: detected.type, ext: detected.ext };
}

/** URL/path -> filesystem-safe slug. */
function slugify(input, fallback = "image") {
  const base = String(input)
    .replace(/\.([a-z]{2,5})(\?|#|$)/iu, "")
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  return (base.length > 0 ? base : fallback).slice(0, 60);
}

/** Write one image under <outDir>/<slug>/ with a collision-free file name. */
function writeImage(outDir, slug, image, url) {
  const dir = join(outDir, slug);
  mkdirSync(dir, { recursive: true });
  const base = slugify(url.split("/").pop() ?? slug) || slug;
  let candidate = join(dir, `${base}${image.ext}`);
  for (let i = 2; existsSync(candidate); i += 1) {
    candidate = join(dir, `${base}-${i}${image.ext}`);
  }
  writeFileSync(candidate, image.bytes);
  return candidate;
}

/** Model-facing text projection for find_images results. */
function renderFindImages(value) {
  const lines = [`Images for: ${value.query}`];
  value.results.forEach((row, i) => {
    const where = row.localPath !== undefined ? row.localPath : row.url;
    const source = row.sourceUrl !== undefined && row.sourceUrl !== row.url ? ` (from ${row.sourceUrl})` : "";
    lines.push(`${i + 1}. ${where}${source}`);
    if (row.error !== undefined) lines.push(`   ! download failed: ${row.error}`);
  });
  lines.push(`downloaded: ${value.downloaded}/${value.results.length} into ${value.outDir}`);
  if (Array.isArray(value.failures) && value.failures.length > 0) {
    lines.push(`warnings: ${value.failures.join("; ")}`);
  }
  lines.push("Open the files with read_image to view them.");
  return lines.join("\n");
}

function findImagesTool(options) {
  return {
    name: "find_images",
    description:
      "Find images on the web and download them into the session workspace so you can view them with read_image. " +
      "Searches by query (Brave Image API when a key is configured, Bing otherwise) and/or scrapes og:image and product images from page URLs you already have. " +
      "Use it whenever the user asks to 'find images', show pictures, or compare products visually.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "What to search for, e.g. '2024 Toyota RAV4 Prime roof rack'.",
        },
        urls: {
          type: "array",
          items: { type: "string" },
          description: "Optional page URLs to scrape for og:image and product images (e.g. product pages).",
        },
        maxImages: {
          type: "integer",
          description: "Maximum images to return. Defaults to the configured maximum (typically 8).",
        },
        download: {
          type: "boolean",
          description: "Download the images locally so read_image can open them. Defaults to true.",
        },
      },
      required: ["query"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          outDir: { type: "string" },
          results: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                url: { type: "string" },
                sourceUrl: { type: "string" },
                title: { type: "string" },
                engine: { type: "string" },
                localPath: { type: "string" },
                contentType: { type: "string" },
                error: { type: "string" },
              },
              required: ["url"],
            },
          },
          downloaded: { type: "integer" },
          failures: { type: "array", items: { type: "string" } },
        },
        required: ["query", "outDir", "results", "downloaded", "failures"],
      },
      render: (_args, value) => [{ type: "text", text: renderFindImages(value) }],
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const options2 = options;
      const query = String(args.query ?? "").trim();
      if (query.length === 0) throw new ImageFinderError("query must be a non-empty string", "INVALID_ARGS");
      const maxImages = Number.isInteger(args.maxImages) && args.maxImages > 0 ? Math.min(args.maxImages, 32) : options2.maxImages;
      const download = args.download !== false;
      const failures = [];
      const candidates = [];
      const seen = new Set();
      const push = (row) => {
        if (row.url.length === 0 || seen.has(row.url) || candidates.length >= maxImages * 3) return;
        seen.add(row.url);
        candidates.push(row);
      };

      // 1) Scrape any page URLs the model already has.
      const pageUrls = Array.isArray(args.urls) ? args.urls.filter((u) => typeof u === "string") : [];
      for (const pageUrl of pageUrls.slice(0, 10)) {
        if (exec.signal?.aborted === true) throw new ImageFinderError("aborted", "ABORTED");
        try {
          const response = await fetchWithTimeout(
            pageUrl,
            { headers: { accept: "text/html", "user-agent": USER_AGENT } },
            exec.signal,
            options2.timeoutMs,
          );
          if (!response.ok) {
            failures.push(`page ${pageUrl}: HTTP ${response.status}`);
            continue;
          }
          const html = await response.text();
          const finalUrl = (response.url && response.url.length > 0) ? response.url : pageUrl;
          for (const row of scrapePageImages(html, finalUrl)) {
            push({ url: row, engine: "page", sourceUrl: finalUrl });
          }
        } catch (error) {
          if (isAbort(error)) throw error;
          failures.push(`page ${pageUrl}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // 2) Search: Brave primary, Bing fallback.
      if (candidates.length < maxImages) {
        if (options2.braveApiKey !== undefined) {
          try {
            for (const row of await braveImageSearch(options2.braveApiKey, query, maxImages, exec.signal, options2)) push(row);
          } catch (error) {
            if (isAbort(error)) throw error;
            failures.push(`brave: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          failures.push("brave: no BRAVE_API_KEY configured");
        }
      }
      if (candidates.length < maxImages) {
        try {
          for (const row of await bingImageSearch(query, maxImages, exec.signal, options2)) push(row);
        } catch (error) {
          if (isAbort(error)) throw error;
          failures.push(`bing: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (candidates.length === 0) {
        throw new ImageFinderError(`no images found (failures: ${failures.join("; ") || "none"})`, "NO_RESULTS");
      }

      const results = candidates.slice(0, maxImages).map((row) => ({
        url: row.url,
        ...(row.sourceUrl !== undefined ? { sourceUrl: row.sourceUrl } : {}),
        ...(row.title !== undefined ? { title: row.title } : {}),
        engine: row.engine,
      }));

      // 3) Download into the workspace.
      let downloaded = 0;
      if (download) {
        const slug = slugify(query);
        for (const row of results) {
          if (exec.signal?.aborted === true) throw new ImageFinderError("aborted", "ABORTED");
          try {
            const image = await fetchImageBytes(row.url, exec.signal, options2);
            row.localPath = writeImage(options2.outDir, slug, image, row.url);
            row.contentType = image.contentType;
            downloaded += 1;
          } catch (error) {
            if (isAbort(error)) throw error;
            row.error = error instanceof Error ? error.message : String(error);
          }
        }
      }

      return {
        query,
        outDir: options2.outDir,
        results,
        downloaded,
        failures,
      };
    },
  };
}

function fetchImageTool(options) {
  return {
    name: "fetch_image",
    description:
      "Download one direct image URL into the session workspace and return the local path so you can view it with read_image. " +
      "Use it when you already have a direct image URL (e.g. from find_images or a page scrape) but not the file.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description: "Direct http(s) URL of the image file.",
        },
        destName: {
          type: "string",
          description: "Optional file name (without extension) for the saved image.",
        },
      },
      required: ["url"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          localPath: { type: "string" },
          contentType: { type: "string" },
          bytes: { type: "integer" },
        },
        required: ["url", "localPath", "contentType", "bytes"],
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `Saved ${value.contentType} image (${value.bytes} bytes) from ${value.url}\n${value.localPath}`,
        },
      ],
    },
    timeoutMs: 60000,
    async execute(args, exec) {
      const url = String(args.url ?? "").trim();
      if (url.length === 0) throw new ImageFinderError("url must be a non-empty string", "INVALID_ARGS");
      try {
        const image = await fetchImageBytes(url, exec.signal, options);
        const slug = (typeof args.destName === "string" && args.destName.trim().length > 0)
          ? slugify(args.destName)
          : slugify(url.split("/").pop() ?? "image");
        const localPath = writeImage(options.outDir, slug, image, url);
        return { url, localPath, contentType: image.contentType, bytes: image.bytes.length };
      } catch (error) {
        if (isAbort(error)) throw error;
        throw new ImageFinderError(
          `fetch_image failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
          "DOWNLOAD_ERROR",
        );
      }
    },
  };
}

/**
 * Register both tools on ctx.tools.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment config for this plugin.
 */
function apply(ctx, config = {}) {
  const merged = { ...DEFAULTS, ...config };
  const resolved = {
    braveApiKey: resolveKey(merged.braveApiKey, merged.braveApiKeyEnv),
    braveApiKeyEnv: merged.braveApiKeyEnv,
    outDir: merged.outDir.length > 0 ? merged.outDir : join(process.cwd(), "images"),
    maxImages: Number.isInteger(merged.maxImages) && merged.maxImages > 0 ? merged.maxImages : DEFAULTS.maxImages,
    timeoutMs: Number.isFinite(merged.timeoutMs) && merged.timeoutMs > 0 ? merged.timeoutMs : DEFAULTS.timeoutMs,
    maxDownloadBytes: Number.isFinite(merged.maxDownloadBytes) && merged.maxDownloadBytes > 0
      ? merged.maxDownloadBytes
      : DEFAULTS.maxDownloadBytes,
  };
  ctx.tools.register(findImagesTool(resolved));
  ctx.tools.register(fetchImageTool(resolved));
  ctx.logger?.info?.(
    `[image-finder] armed (braveKey=${resolved.braveApiKey !== undefined ? "yes" : "no"}, outDir=${resolved.outDir}, maxImages=${resolved.maxImages})`,
  );
}

export {
  apply,
  inject,
  name,
  braveImageSearch,
  bingImageSearch,
  parseBingImages,
  scrapePageImages,
  detectImageType,
  fetchImageBytes,
  slugify,
  resolveKey,
  readDshEnv,
  unescapeHtml,
  ImageFinderError,
};
