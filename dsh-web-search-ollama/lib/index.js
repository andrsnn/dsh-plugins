/**
 * dsh-web-search-ollama: a `ctx.web` search provider that queries Ollama Cloud
 * web search first and falls back to the Brave Search API.
 *
 * The DeepSeek Harness exposes a model-facing `web_search` tool
 * (@deepseek-ai/dsh-tool-web) that delegates to the `ctx.web` seam
 * (@deepseek-ai/dsh-web). The seam picks ONE search provider: the id in the web
 * plugin's `searchProvider` config, else the single registered usable provider.
 * This plugin registers a provider under the id "ollama-brave"; point the seam
 * at it with:
 *
 *   - id: web
 *     config:
 *       searchProvider: ollama-brave
 *
 * Selection is otherwise ambiguous whenever another usable provider (e.g.
 * deepseek-official) is also registered.
 *
 * Ollama Cloud web search is the primary because it is cheap; Brave is the
 * fallback so a missing/expired Ollama key or an Ollama outage still returns
 * results. Both keys are read, in order, from: a literal value in this plugin's
 * config, then `process.env`, then `~/.dsh/.env` (the dsh credential file). No
 * secret is baked into the plugin or the committed profile.
 *
 * Result shape matches what the seam and tool expect:
 *   { sources: [{ url, title?, snippet?, publishedAt? }], truncated: boolean }
 * The seam enforces `request.maxResults`, so `truncated` is always false here.
 *
 * Self-contained on purpose: a profile-linked plugin cannot reliably resolve
 * sibling @deepseek-ai packages, so it defines its own WebError (an Error with a
 * machine-routable `code`, which is all the seam and tool read) instead of
 * importing @deepseek-ai/dsh-web.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const name = "web-search-ollama";
const inject = ["web"];

/** Stable id this provider registers under; name it in the web seam's searchProvider. */
const PROVIDER_ID = "ollama-brave";
const OLLAMA_ENDPOINT = "https://ollama.com/api/web_search";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const USER_AGENT = "dsh-web-search-ollama/0.1.0";

const DEFAULTS = {
  ollamaApiKeyEnv: "OLLAMA_API_KEY",
  braveApiKeyEnv: "BRAVE_API_KEY",
  maxResults: 5,
  timeoutMs: 15000,
  snippetMaxChars: 2000,
};

/** Typed error carrying an open-string `code`, the only field the seam/tool read. */
class WebError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "WebError";
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

/** Resolve a credential: literal config → process.env → ~/.dsh/.env. */
function resolveKey(literal, envName) {
  if (typeof literal === "string" && literal.length > 0) return literal;
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return readDshEnv(envName);
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/** fetch() with a hard timeout that also honors the seam's cancellation signal. */
async function fetchWithTimeout(url, init, signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new WebError("web search timed out", "WEB_TIMEOUT")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** Dedupe sources by URL, preserving order and dropping empty URLs. */
function dedupeByUrl(rows, project) {
  const seen = new Set();
  const sources = [];
  for (const row of rows) {
    const mapped = project(row);
    if (mapped === undefined || mapped.url.length === 0 || seen.has(mapped.url)) continue;
    seen.add(mapped.url);
    sources.push(mapped);
  }
  return sources;
}

/**
 * Ollama Cloud web search. POST { query, max_results } with a Bearer key;
 * response is { results: [{ title, url, content }] }.
 */
async function ollamaSearch(apiKey, query, maxResults, signal, options) {
  const response = await fetchWithTimeout(OLLAMA_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ query, max_results: maxResults }),
  }, signal, options.timeoutMs);
  if (!response.ok) {
    throw new WebError(`Ollama web_search HTTP ${response.status}`, "WEB_PROVIDER_ERROR");
  }
  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  const sources = dedupeByUrl(results, (r) => {
    const url = typeof r?.url === "string" ? r.url : "";
    return {
      url,
      ...(typeof r?.title === "string" && r.title.length > 0 ? { title: r.title } : {}),
      ...(typeof r?.content === "string" && r.content.length > 0
        ? { snippet: r.content.slice(0, options.snippetMaxChars) }
        : {}),
    };
  });
  if (sources.length === 0) throw new WebError("Ollama web_search returned no usable results", "WEB_PROVIDER_ERROR");
  return { sources, truncated: false };
}

/**
 * Brave Search API. GET ?q=&count= with X-Subscription-Token; response is
 * { web: { results: [{ title, url, description, age }] } }.
 */
async function braveSearch(apiKey, query, maxResults, signal, options) {
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      "x-subscription-token": apiKey,
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
  }, signal, options.timeoutMs);
  if (!response.ok) {
    throw new WebError(`Brave search HTTP ${response.status}`, "WEB_PROVIDER_ERROR");
  }
  const data = await response.json();
  const results = Array.isArray(data?.web?.results) ? data.web.results : [];
  const sources = dedupeByUrl(results, (r) => {
    const url = typeof r?.url === "string" ? r.url : "";
    return {
      url,
      ...(typeof r?.title === "string" && r.title.length > 0 ? { title: r.title } : {}),
      ...(typeof r?.description === "string" && r.description.length > 0
        ? { snippet: r.description.slice(0, options.snippetMaxChars) }
        : {}),
      ...(typeof r?.age === "string" && r.age.length > 0 ? { publishedAt: r.age } : {}),
    };
  });
  if (sources.length === 0) throw new WebError("Brave search returned no usable results", "WEB_PROVIDER_ERROR");
  return { sources, truncated: false };
}

/** True when the failure is caller cancellation rather than a provider fault. */
function isAbort(signal, error) {
  return signal?.aborted === true || (error instanceof WebError && error.code === "WEB_ABORTED");
}

/** The Ollama-primary, Brave-fallback search provider registered into `ctx.web`. */
class OllamaBraveSearchProvider {
  constructor(resolveOptions) {
    this.id = PROVIDER_ID;
    this.resolveOptions = resolveOptions;
  }

  /** Usable if either backend has a key; primary/fallback is decided per search. */
  available() {
    const options = this.resolveOptions();
    return options.ollamaApiKey !== undefined || options.braveApiKey !== undefined;
  }

  async search(request, signal) {
    const options = this.resolveOptions();
    const query = typeof request?.query === "string" ? request.query.trim() : "";
    if (query.length === 0) throw new WebError("web search requires a non-empty query", "WEB_PROVIDER_ERROR");
    if (signal?.aborted === true) throw new WebError("web search aborted", "WEB_ABORTED", { cause: signal.reason });
    const maxResults = isPositiveInt(request?.maxResults) ? request.maxResults : options.maxResults;

    const failures = [];

    // Primary: Ollama Cloud.
    if (options.ollamaApiKey !== undefined) {
      try {
        return await ollamaSearch(options.ollamaApiKey, query, maxResults, signal, options);
      } catch (error) {
        if (isAbort(signal, error)) throw new WebError("web search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
        failures.push(`ollama: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      failures.push(`ollama: no ${options.ollamaApiKeyEnv}`);
    }

    // Fallback: Brave.
    if (options.braveApiKey !== undefined) {
      try {
        return await braveSearch(options.braveApiKey, query, maxResults, signal, options);
      } catch (error) {
        if (isAbort(signal, error)) throw new WebError("web search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
        failures.push(`brave: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      failures.push(`brave: no ${options.braveApiKeyEnv}`);
    }

    throw new WebError(`web search failed (Ollama primary, Brave fallback): ${failures.join("; ")}`, "WEB_PROVIDER_ERROR");
  }
}

/** Register the Ollama+Brave search provider with `ctx.web`. */
function apply(ctx, config = {}) {
  const merged = { ...DEFAULTS, ...config };
  const resolveOptions = () => ({
    ollamaApiKey: resolveKey(merged.ollamaApiKey, merged.ollamaApiKeyEnv),
    braveApiKey: resolveKey(merged.braveApiKey, merged.braveApiKeyEnv),
    ollamaApiKeyEnv: merged.ollamaApiKeyEnv,
    braveApiKeyEnv: merged.braveApiKeyEnv,
    maxResults: merged.maxResults,
    timeoutMs: merged.timeoutMs,
    snippetMaxChars: merged.snippetMaxChars,
  });
  ctx.web.registerSearchProvider(new OllamaBraveSearchProvider(resolveOptions));
  const opts = resolveOptions();
  ctx.logger?.info?.(
    `[web-search-ollama] armed as "${PROVIDER_ID}" (Ollama primary, Brave fallback); ` +
      `ollamaKey=${opts.ollamaApiKey !== undefined ? "yes" : "no"} braveKey=${opts.braveApiKey !== undefined ? "yes" : "no"}`,
  );
}

export {
  apply,
  inject,
  name,
  PROVIDER_ID,
  OllamaBraveSearchProvider,
  ollamaSearch,
  braveSearch,
  resolveKey,
  readDshEnv,
};
