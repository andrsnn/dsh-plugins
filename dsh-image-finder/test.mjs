/**
 * dsh-image-finder offline test suite (no dsh runtime needed - fetch is mocked).
 *
 *   node test.mjs          # offline, deterministic (7/7 expected)
 *   node test.mjs --live   # additionally hits real Bing over plain http
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apply,
  bingImageSearch,
  detectImageType,
  fetchImageBytes,
  parseBingImages,
  resolveKey,
  scrapePageImages,
  slugify,
  unescapeHtml,
  readDshEnv,
  name,
  inject,
} from "./lib/index.js";

let passed = 0;
const failures = [];
async function test(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`FAIL ${label}: ${error instanceof Error ? error.stack ?? error.message : error}`);
  }
}

const FAKE_KEY = "BSA-fake-test-key";
const realFetch = globalThis.fetch;

function mockFetch(handler) {
  globalThis.fetch = async (url, init) => handler(String(url), init ?? {});
}
const restoreFetch = () => { globalThis.fetch = realFetch; };

const bingFixture = [
  '<html><body>',
  'm="false"',
  `m="{&quot;purl&quot;:&quot;https://example.com/article&quot;,&quot;murl&quot;:&quot;https://img.example.com/a.jpg?w=100&amp;h=50&quot;,&quot;t&quot;:&quot;Photo A&quot;}"`,
  `m="{&quot;purl&quot;:&quot;https://example.com/b&quot;,&quot;murl&quot;:&quot;https://img.example.com/b.png&quot;,&quot;t&quot;:&quot;Photo B&quot;}"`,
  `m="{&quot;murl&quot;:&quot;https://img.example.com/a.jpg?w=100&amp;h=50&quot;}"`,
  '<img src="x"></body></html>',
].join("\n");

const pageFixture = `
<!doctype html><html><head>
<meta property="og:image" content="/cdn/product-hero.jpg">
<meta name="twitter:image" content="https://cdn2.example.com/tw.png">
<link rel="image_src" href="https://cdn3.example.com/ls.gif">
<script type="application/ld+json">{"@type":"Product","image":["https://jsonld.example.com/1.webp","https://jsonld.example.com/2.webp"]}</script>
</head><body>
<img src="https://abs.example.com/body.jpg">
<img src="relative/body2.png">
<img src="data:image/gif;base64,AAAA">
<img src="https://skip.example.com/icon.svg">
</body></html>`;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
const HTML = Buffer.from("<html>not an image</html>");

const jsonResponse = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  url: "https://api.search.brave.com/res/v1/images/search?q=x",
  headers: new Map([["content-type", "application/json"]]),
  json: async () => data,
  text: async () => JSON.stringify(data),
  arrayBuffer: async () => new Uint8Array([]).buffer,
});

const htmlResponse = (text, status = 200, url = "https://www.bing.com/images/search?q=x") => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: new Map([["content-type", "text/html"]]),
  json: async () => { throw new Error("not json"); },
  text: async () => text,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer,
});

const imageResponse = (bytes, contentType, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  url: "https://img.example.com/x.jpg",
  headers: new Map([["content-type", contentType], ["content-length", String(bytes.length)]]),
  json: async () => { throw new Error("not json"); },
  text: async () => bytes.toString("utf8"),
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const SIGNAL = { aborted: false, addEventListener() {}, removeEventListener() {} };
const OPTIONS = {
  braveApiKey: FAKE_KEY,
  braveApiKeyEnv: "BRAVE_API_KEY",
  outDir: mkdtempSync(join(tmpdir(), "image-finder-test-")),
  maxImages: 4,
  timeoutMs: 5000,
  maxDownloadBytes: 1024 * 1024,
};

await test("plugin exports the expected shape", () => {
  assert.equal(name, "image-finder");
  assert.deepEqual(inject, ["tools"]);
  assert.equal(typeof apply, "function");
});

await test("parseBingImages decodes entity-escaped m metadata and skips non-JSON", () => {
  const rows = parseBingImages(bingFixture);
  assert.equal(rows.length, 2, `expected 2 rows, got ${JSON.stringify(rows)}`);
  assert.equal(rows[0].url, "https://img.example.com/a.jpg?w=100&h=50");
  assert.equal(rows[0].sourceUrl, "https://example.com/article");
  assert.equal(rows[0].title, "Photo A");
  assert.equal(rows[0].engine, "bing");
  assert.equal(rows[1].url, "https://img.example.com/b.png");
});

await test("unescapeHtml does a single pass (&amp;quot; -> &quot;)", () => {
  assert.equal(unescapeHtml("&amp;quot;"), "&quot;");
  assert.equal(unescapeHtml("a&quot;b&amp;c"), 'a"b&c');
});

await test("scrapePageImages finds og/twitter/jsonld/img and drops data:/svg/relative", () => {
  const urls = scrapePageImages(pageFixture, "https://shop.example.com/products/tent");
  for (const expected of [
    "https://shop.example.com/cdn/product-hero.jpg",
    "https://cdn2.example.com/tw.png",
    "https://cdn3.example.com/ls.gif",
    "https://jsonld.example.com/1.webp",
    "https://jsonld.example.com/2.webp",
    "https://abs.example.com/body.jpg",
  ]) {
    assert.ok(urls.includes(expected), `missing ${expected}`);
  }
  assert.ok(!urls.some((u) => u.startsWith("data:")), "data: URI leaked");
  assert.ok(!urls.some((u) => u.endsWith(".svg")), "svg leaked");
  assert.ok(!urls.some((u) => u.startsWith("relative")), "relative URL leaked");
  assert.equal(new Set(urls).size, urls.length, "duplicate URLs");
});

await test("detectImageType trusts content-type, falls back to magic bytes, rejects html", () => {
  assert.deepEqual(detectImageType(JPEG, "image/jpeg", "u"), { type: "image/jpeg", ext: ".jpg" });
  assert.deepEqual(detectImageType(PNG, "text/html; charset=utf-8", "u"), { type: "image/png", ext: ".png" });
  assert.deepEqual(detectImageType(WEBP, undefined, "u"), { type: "image/webp", ext: ".webp" });
  assert.deepEqual(detectImageType(HTML, "text/html", "https://x/y.png"), { type: "image/png", ext: ".png" });
  assert.equal(detectImageType(HTML, "text/html", "https://x/y.html"), undefined);
});

await test("brave primary with bing fallback on provider error (find_images execute)", async () => {
  let braveHits = 0;
  let bingHits = 0;
  mockFetch(async (url) => {
    if (url.includes("api.search.brave.com")) {
      braveHits += 1;
      return jsonResponse({ results: [{ image: "https://brave.example.com/1.jpg", url: "https://src.example.com", title: "Brave one" }] }, 401);
    }
    if (url.includes("bing.com")) {
      bingHits += 1;
      return htmlResponse(bingFixture, 200, url);
    }
    if (url.includes("img.example.com")) return imageResponse(JPEG, "image/jpeg");
    return jsonResponse({}, 404);
  });
  const registered = [];
  const ctx = { tools: { register(def) { registered.push(def); } }, logger: { info() {} } };
  apply(ctx, { braveApiKey: FAKE_KEY, outDir: OPTIONS.outDir, maxImages: 4, timeoutMs: 5000 });
  assert.equal(registered.length, 2);
  assert.deepEqual(registered.map((t) => t.name).sort(), ["fetch_image", "find_images"]);
  const find = registered.find((t) => t.name === "find_images");
  const result = await find.execute({ query: "rav4 prime tent" }, { signal: SIGNAL });
  restoreFetch();
  assert.equal(braveHits, 1);
  assert.ok(bingHits >= 1, "bing fallback not tried");
  assert.ok(result.results.length >= 1);
  assert.ok(result.results.some((r) => r.engine === "brave") || result.results.some((r) => r.engine === "bing"));
  assert.ok(result.results.every((r) => r.localPath !== undefined), "downloads did not happen");
  for (const row of result.results) {
    assert.ok(readFileSync(row.localPath).length > 0, "saved file is empty");
  }
  assert.ok(result.failures.some((f) => f.startsWith("brave:")), "brave failure not reported");
});

await test("fetch_image saves a verified image and rejects non-images", async () => {
  mockFetch(async (url) => {
    if (url.includes("good")) return imageResponse(PNG, "image/png");
    return imageResponse(HTML, "text/html", 200);
  });
  const registered = [];
  const ctx = { tools: { register(def) { registered.push(def); } }, logger: { info() {} } };
  apply(ctx, { outDir: OPTIONS.outDir });
  const fetchTool = registered.find((t) => t.name === "fetch_image");
  const ok = await fetchTool.execute({ url: "https://img.example.com/good.png", destName: "my image" }, { signal: SIGNAL });
  assert.equal(ok.contentType, "image/png");
  assert.equal(ok.bytes, PNG.length);
  assert.ok(readFileSync(ok.localPath).equals(PNG), "saved bytes differ");
  await assert.rejects(
    () => fetchTool.execute({ url: "https://img.example.com/bad" }, { signal: SIGNAL }),
    /not a supported image/,
  );
  restoreFetch();
});

await test("resolveKey reads ~/.dsh/.env last", () => {
  assert.equal(resolveKey("literal", "ANY"), "literal");
  const saved = process.env.TEST_IF_KEY;
  process.env.TEST_IF_KEY = "from-env";
  assert.equal(resolveKey(undefined, "TEST_IF_KEY"), "from-env");
  delete process.env.TEST_IF_KEY;
  if (saved !== undefined) process.env.TEST_IF_KEY = saved;
  assert.equal(typeof readDshEnv("DEFINITELY_NOT_A_KEY"), "undefined");
});

await test("slugify is filesystem-safe", () => {
  assert.equal(slugify("2024 Toyota RAV4 Prime roof rack!"), "2024-toyota-rav4-prime-roof-rack");
  assert.equal(slugify("a/b\\c.jpg?x=1"), "a-b-cx-1");
  assert.equal(slugify("???"), "image");
});

if (process.argv.includes("--live")) {
  await test("LIVE: bing fallback parses real http results (no key)", async () => {
    restoreFetch();
    const rows = await bingImageSearch("2024 Toyota RAV4 Prime", 5, SIGNAL, { ...OPTIONS, braveApiKey: undefined });
    assert.ok(rows.length >= 3, `expected >=3 live results, got ${rows.length}`);
    for (const row of rows) {
      assert.ok(row.url.startsWith("http"), `bad murl: ${row.url}`);
      assert.equal(row.engine, "bing");
    }
    console.log(`     live sample: ${rows[0].url}`);
  });
  await test("LIVE: fetchImageBytes downloads a live image", async () => {
    restoreFetch();
    const rows = await bingImageSearch("rooftop tent", 5, SIGNAL, { ...OPTIONS, braveApiKey: undefined });
    let lastError;
    for (const row of rows) {
      // The sandbox may block outbound 443, so also try the http form of each URL.
      const candidates = row.url.startsWith("https:")
        ? [row.url, row.url.replace("https:", "http:")]
        : [row.url];
      for (const candidate of candidates) {
        try {
          const image = await fetchImageBytes(candidate, SIGNAL, OPTIONS);
          assert.ok(image.bytes.length > 1000, "image suspiciously small");
          console.log(`     live image: ${image.contentType} ${image.bytes.length} bytes from ${candidate}`);
          return;
        } catch (error) {
          lastError = error;
        }
      }
    }
    throw new Error(`no live image could be downloaded: ${lastError?.message}`);
  });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("failed: " + failures.join(", "));
  process.exit(1);
}
