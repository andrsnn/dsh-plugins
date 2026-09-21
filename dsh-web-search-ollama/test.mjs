/**
 * Self-contained test for dsh-web-search-ollama. No dsh runtime and no network:
 * it stubs global.fetch and a minimal ctx.web.registerSearchProvider, then
 * drives the registered provider. Run: `node test.mjs`.
 *
 * Covers: registration; Ollama primary success (Brave not called); Ollama
 * failure falls back to Brave; both fail surfaces a combined error; missing
 * Ollama key skips straight to Brave; empty query rejected; available()
 * reflects key presence; response shapes map to { url,title,snippet,publishedAt }.
 */
import assert from "node:assert";
import { apply, PROVIDER_ID } from "./lib/index.js";

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

/** Install a fetch stub; returns { calls, restore }. handler(url, init) -> Response. */
function stubFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

/** Register the provider with literal keys (bypasses env/.env resolution). */
function register(config) {
  let provider;
  const ctx = {
    web: { registerSearchProvider: (p) => { provider = p; } },
    logger: { info: () => {} },
  };
  apply(ctx, config);
  return provider;
}

const OLLAMA = "https://ollama.com/api/web_search";
const BRAVE = "https://api.search.brave.com/res/v1/web/search";
const bothKeys = { ollamaApiKey: "ok-test", braveApiKey: "brave-test" };

let passed = 0;
const test = async (label, fn) => { await fn(); passed += 1; console.log(`  ok  ${label}`); };

// 1. Registration + id + available()
await test("registers a provider with id 'ollama-brave' and available() is true with a key", () => {
  const p = register(bothKeys);
  assert.equal(p.id, PROVIDER_ID);
  assert.equal(p.available(), true);
});

await test("available() is false with no keys", () => {
  const p = register({ ollamaApiKey: "", braveApiKey: "", ollamaApiKeyEnv: "OLLAMA_NOPE", braveApiKeyEnv: "BRAVE_NOPE" });
  // Only false if the env/.env fallbacks also miss; force miss with bogus env names.
  assert.equal(p.available(), false);
});

// 2. Ollama primary success, Brave never called
await test("Ollama success returns Ollama sources and does NOT call Brave", async () => {
  const { calls, restore } = stubFetch((url) => {
    if (url.startsWith(OLLAMA)) return jsonResponse({ results: [
      { title: "A", url: "https://a.example", content: "alpha snippet" },
      { title: "B", url: "https://b.example", content: "beta" },
    ] });
    throw new Error("Brave should not be called");
  });
  try {
    const p = register(bothKeys);
    const out = await p.search({ query: "hello", maxResults: 5 });
    assert.equal(out.truncated, false);
    assert.deepEqual(out.sources[0], { url: "https://a.example", title: "A", snippet: "alpha snippet" });
    assert.equal(out.sources.length, 2);
    assert.equal(calls.filter((c) => c.url.startsWith(BRAVE)).length, 0);
    assert.equal(calls.filter((c) => c.url.startsWith(OLLAMA)).length, 1);
  } finally { restore(); }
});

// 3. Ollama fails -> Brave fallback used
await test("Ollama HTTP 500 falls back to Brave and maps age->publishedAt", async () => {
  const { calls, restore } = stubFetch((url) => {
    if (url.startsWith(OLLAMA)) return jsonResponse({ error: "boom" }, false, 500);
    if (url.startsWith(BRAVE)) return jsonResponse({ web: { results: [
      { title: "C", url: "https://c.example", description: "gamma", age: "2 days ago" },
    ] } });
    throw new Error(`unexpected ${url}`);
  });
  try {
    const p = register(bothKeys);
    const out = await p.search({ query: "hello" });
    assert.deepEqual(out.sources[0], { url: "https://c.example", title: "C", snippet: "gamma", publishedAt: "2 days ago" });
    assert.equal(calls.filter((c) => c.url.startsWith(OLLAMA)).length, 1);
    assert.equal(calls.filter((c) => c.url.startsWith(BRAVE)).length, 1);
  } finally { restore(); }
});

// 4. No Ollama key -> straight to Brave (Ollama never called)
await test("missing Ollama key skips to Brave without calling Ollama", async () => {
  const { calls, restore } = stubFetch((url) => {
    if (url.startsWith(BRAVE)) return jsonResponse({ web: { results: [{ url: "https://d.example", title: "D" }] } });
    throw new Error(`unexpected ${url}`);
  });
  try {
    const p = register({ ollamaApiKey: "", braveApiKey: "brave-test", ollamaApiKeyEnv: "OLLAMA_NOPE" });
    const out = await p.search({ query: "hello" });
    assert.equal(out.sources[0].url, "https://d.example");
    assert.equal(calls.filter((c) => c.url.startsWith(OLLAMA)).length, 0);
  } finally { restore(); }
});

// 5. Both fail -> combined error naming both providers
await test("both backends failing throws one error naming ollama and brave", async () => {
  const { restore } = stubFetch((url) => jsonResponse({}, false, 500));
  try {
    const p = register(bothKeys);
    await assert.rejects(() => p.search({ query: "hello" }), (e) => {
      assert.match(e.message, /ollama:/);
      assert.match(e.message, /brave:/);
      assert.equal(e.code, "WEB_PROVIDER_ERROR");
      return true;
    });
  } finally { restore(); }
});

// 6. Empty query rejected before any fetch
await test("empty query is rejected without any network call", async () => {
  const { calls, restore } = stubFetch(() => { throw new Error("should not fetch"); });
  try {
    const p = register(bothKeys);
    await assert.rejects(() => p.search({ query: "   " }), /non-empty query/);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

// 7. Ollama returns zero results -> treated as failure, falls back to Brave
await test("empty Ollama results fall back to Brave", async () => {
  const { restore } = stubFetch((url) => {
    if (url.startsWith(OLLAMA)) return jsonResponse({ results: [] });
    if (url.startsWith(BRAVE)) return jsonResponse({ web: { results: [{ url: "https://e.example" }] } });
    throw new Error(`unexpected ${url}`);
  });
  try {
    const p = register(bothKeys);
    const out = await p.search({ query: "hello" });
    assert.equal(out.sources[0].url, "https://e.example");
  } finally { restore(); }
});

console.log(`\n${passed}/7 passed`);
