#!/usr/bin/env node
/**
 * dsh-file-shuttle offline tests (no dsh runtime needed):
 *   node test.mjs          # server + zip + internals
 *   node test.mjs --live   # additionally: PowerShell Expand-Archive extraction
 *
 * The server runs on an ephemeral high port with a temp store root; a short
 * expiry exercises the 410 + purge path.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import zlib from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN = pathToFileURL(join(here, "lib", "index.js")).href;
const SERVER = join(here, "server.mjs");
const LIVE = process.argv.includes("--live");

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHA = (buf) => createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------------------
// 1) ZIP writer round-trip (pure, no server).
// ---------------------------------------------------------------------------
async function testZip() {
  console.log("\n[zip writer]");
  const mod = await import(PLUGIN);
  const root = mkdtempSync(join(tmpdir(), "shuttle-zip-"));
  mkdirSync(join(root, "sub", "deep"), { recursive: true });
  const a = Buffer.from("hello shuttle\n".repeat(1000));
  const b = Buffer.alloc(0); // empty file
  const c = Buffer.from(JSON.stringify({ n: Array.from({ length: 50 }, (_, i) => i * i) }, null, 2));
  const d = Buffer.from("binary\x00\x01\x02\xff\xfe".repeat(999), "latin1");
  writeFileSync(join(root, "a.txt"), a);
  writeFileSync(join(root, "empty.bin"), b);
  writeFileSync(join(root, "sub", "c.json"), c);
  writeFileSync(join(root, "sub", "deep", "d.bin"), d);

  const zipPath = join(root, "out.zip");
  const { createWriteStream } = await import("node:fs");
  const out = createWriteStream(zipPath);
  const entries = [
    { src: join(root, "a.txt"), arcName: "a.txt" },
    { src: join(root, "empty.bin"), arcName: "empty.bin" },
    { src: join(root, "sub", "c.json"), arcName: "sub/c.json" },
    { src: join(root, "sub", "deep", "d.bin"), arcName: "sub/deep/d.bin" },
  ];
  const result = await mod.zipEntriesToStream(out, entries, undefined);
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  check("zip reported entry count", result.entries === 4, JSON.stringify(result));
  check("zip compressed smaller than total", result.compressed < a.length + c.length + d.length);

  // Parse the zip back: EOCD -> central directory -> inflate each entry.
  const zip = readFileSync(zipPath);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  check("EOCD present", eocd >= 0);
  const count = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  check("entry count in EOCD", count === 4, `count=${count}`);
  const expected = {
    "a.txt": a,
    "empty.bin": b,
    "sub/c.json": c,
    "sub/deep/d.bin": d,
  };
  let cursor = cdOffset;
  let okEntries = true;
  let detail = "";
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) {
      okEntries = false;
      detail = "bad central sig";
      break;
    }
    const nameLen = zip.readUInt16LE(cursor + 28);
    const name = zip.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    const compSize = zip.readUInt32LE(cursor + 20);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLen;
    const comp = zip.subarray(dataStart, dataStart + compSize);
    const inflated = Buffer.from(zlib.inflateRawSync(comp));
    const want = expected[name];
    if (want === undefined || SHA(inflated) !== SHA(want)) {
      okEntries = false;
      detail = `entry ${name} mismatch`;
      break;
    }
    cursor += 46 + nameLen;
  }
  check("all entries inflate to original bytes", okEntries, detail);
  check("central dir contiguous to EOCD", cursor === eocd, `cdEnd=${cursor} eocd=${eocd}`);

  // Optional: prove a real unzipper accepts the zip (Windows Expand-Archive).
  if (LIVE) {
    const dest = join(root, "extracted");
    const proc = await new Promise((resolve) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`], { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (code) => resolve({ code, err }));
    });
    check("Expand-Archive extracts (exit 0)", proc.code === 0, proc.err.slice(0, 300));
    if (proc.code === 0) {
      const all = readdirSync(dest, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
      const names = all.map((e) => e.name.replace(/\\/gu, "/"));
      check("extracted file set", names.sort().join(",") === "a.txt,c.json,d.bin,empty.bin", names.join(","));
      check("extracted bytes match", all.every((e) => {
        const name = e.name.replace(/\\/gu, "/");
        const top = name.includes("/") ? name.split("/").slice(0, -1).join("/") : "";
        const full = name.includes("/") ? readFileSync(join(dest, top, e.name)) : readFileSync(join(dest, e.name));
        return SHA(full) === SHA(expected[name] ?? expected[`${top === "sub/deep" ? "sub/deep" : ""}${e.name}`]) || SHA(full) === SHA(expected[name]);
      }));
    }
  }
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2) Plugin internals.
// ---------------------------------------------------------------------------
async function testInternals() {
  console.log("\n[internals]");
  const mod = await import(PLUGIN);
  check("slugify trims and lowercases", mod.slugify("My Report (final).txt") === "my-report-final");
  check("slugify fallback", mod.slugify("???") === "image" || mod.slugify("???").length > 0);
  const t = mod.dosDateTime(new Date(2026, 8, 17, 15, 30, 10));
  check("dosDateTime encodes date", t.date === (((2026 - 1980) << 9) | (9 << 5) | 17));
  check("dosDateTime encodes time", t.time === ((15 << 11) | (30 << 5) | 5));
  const bad = mod.CRC_TABLE;
  check("crc table populated", bad.length === 256 && bad[1] === 0x77073096);
  const err = new mod.ShuttleError("x", "Y");
  check("ShuttleError carries code", err.code === "Y");
}

// ---------------------------------------------------------------------------
// 3) Server end-to-end.
// ---------------------------------------------------------------------------
async function testServer() {
  console.log("\n[server]");
  const port = 18000 + Math.floor(Math.random() * 20000);
  const root = mkdtempSync(join(tmpdir(), "shuttle-root-"));
  const sourceDir = mkdtempSync(join(tmpdir(), "shuttle-src-"));
  const fileA = Buffer.from("alpha payload ".repeat(5000));
  const fileB = Buffer.from("beta \u00e9\u65e5\u672c payload");
  const pathA = join(sourceDir, "report.txt");
  const pathB = join(sourceDir, "pic.png");
  writeFileSync(pathA, fileA);
  writeFileSync(pathB, fileB);

  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SHUTTLE_PORT: String(port), SHUTTLE_ROOT: root, SHUTTLE_SWEEP_MS: "10000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (c) => (serverLog += c));
  child.stderr.on("data", (c) => (serverLog += c));

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try {
      up = (await fetch(`${base}/healthz`)).ok;
    } catch {
      await sleep(150);
    }
  }
  try {
    check("server starts and answers /healthz", up, serverLog.slice(-300));
    if (!up) return;
    const health = await (await fetch(`${base}/healthz`)).json();
    check("health reports root", health.root === root, JSON.stringify(health));

    // publish two files with a 20-second lifetime
    const pub = await fetch(`${base}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ path: pathA }, { path: pathB, name: "photo.png" }], expiryMinutes: 20 / 60, note: "test note" }),
    });
    const pubText = await pub.text();
    check("publish ok", pub.status === 200, pubText);
    const data = JSON.parse(pubText);
    check("token is 32 hex chars", /^[0-9a-f]{32}$/.test(data.token ?? ""));
    check("publish echoes files", data.files.length === 2 && data.files[0].origName === "report.txt" && data.files[1].name === "photo.png");

    // index page
    const idx = await fetch(`${base}/f/${data.token}`);
    check("index page 200 html", idx.status === 200 && (await idx.text()).includes("test note"));

    // file download byte-exact
    const dlA = Buffer.from(await (await fetch(`${base}/f/${data.token}/report.txt`)).arrayBuffer());
    check("download A byte-exact", SHA(dlA) === SHA(fileA));
    const dlB = await fetch(`${base}/f/${data.token}/photo.png`);
    check("download B content-disposition", (dlB.headers.get("content-disposition") ?? "").includes("photo.png"));
    check("download B byte-exact", SHA(Buffer.from(await dlB.arrayBuffer())) === SHA(fileB));

    // unknown token / file
    check("unknown token 404", (await fetch(`${base}/f/deadbeef`)).status === 404);
    check("unknown file 404", (await fetch(`${base}/f/${data.token}/nope.bin`)).status === 404);
    check("bad path 404", (await fetch(`${base}/f/${data.token}/..%2f..%2fmanifest.json`)).status === 404);

    // links (loopback)
    const links = await (await fetch(`${base}/links`)).json();
    check("links lists the token", links.links.some((l) => l.token === data.token && l.files.length === 2));

    // short-expiry link: publish with 2s life, wait, expect 410 + purge
    const short = await (await fetch(`${base}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ path: pathA }], expiryMinutes: 2 / 60 }),
    })).json();
    await sleep(2600);
    const gone = await fetch(`${base}/f/${short.token}/report.txt`);
    check("expired link 410", gone.status === 410, `status=${gone.status}`);
    check("expired token purged from manifest", (await (await fetch(`${base}/links`)).json()).links.every((l) => l.token !== short.token));
    check("expired dir removed from disk", readdirSync(join(root, "outbox")).filter((d) => d === short.token).length === 0);

    // bad publish bodies
    check("publish empty 400", (await fetch(`${base}/publish`, { method: "POST", body: JSON.stringify({}) })).status === 400);
    check("publish missing file 400", (await fetch(`${base}/publish`, { method: "POST", body: JSON.stringify({ files: [{ path: join(sourceDir, "ghost.txt") }] }) })).status === 400);

    // purge specific token
    const purged = await (await fetch(`${base}/purge`, { method: "POST", body: JSON.stringify({ token: data.token }) })).json();
    check("purge removes token", purged.purged.includes(data.token));
    check("purged link gone", (await fetch(`${base}/f/${data.token}`)).status === 404);
  } finally {
    child.kill();
    await sleep(200);
    rmSync(root, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4) Non-loopback publish must be refused (connect through the LAN IP).
// ---------------------------------------------------------------------------
async function testNonLoopback() {
  console.log("\n[non-loopback publish]");
  const { networkInterfaces } = await import("node:os");
  let lan = undefined;
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" && !item.internal) lan = item.address;
    }
  }
  if (lan === undefined) {
    console.log("  skip  (no LAN IPv4 available)");
    return;
  }
  const port = 18000 + Math.floor(Math.random() * 20000);
  const root = mkdtempSync(join(tmpdir(), "shuttle-nl-"));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SHUTTLE_PORT: String(port), SHUTTLE_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      try {
        up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
      } catch {
        await sleep(150);
      }
    }
    if (!up) {
      console.log("  skip  (server did not start)");
      return;
    }
    const res = await fetch(`http://${lan}:${port}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });
    check("non-loopback publish refused (403)", res.status === 403, `status=${res.status}`);
    const health = await fetch(`http://${lan}:${port}/healthz`);
    check("health reachable via LAN IP (port bound 0.0.0.0)", health.ok);
  } finally {
    child.kill();
    await sleep(200);
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5) ensureServer reuse semantics (spawn once, second call reuses).
// ---------------------------------------------------------------------------
async function testEnsureServer() {
  console.log("\n[ensureServer]");
  const mod = await import(PLUGIN);
  const port = 18000 + Math.floor(Math.random() * 20000);
  const root = mkdtempSync(join(tmpdir(), "shuttle-es-"));
  const options = {
    port,
    storeRoot: root,
    expiryMinutes: 60,
    maxFileBytes: 1024 * 1024,
    tailscaleBin: "",
    tailscaleHost: "",
    lanHost: "",
    healthTimeoutMs: 1500,
    startTimeoutMs: 8000,
    zipDefault: "auto",
  };
  try {
    const first = await mod.ensureServer(options, undefined);
    check("first call starts the server", first === "started", first);
    const second = await mod.ensureServer(options, undefined);
    check("second call reuses it", second === "reused", second);
    // server must be DETACHED: still answering from this (separate) process
    check("detached server answers /healthz", await mod.serverHealth(port, 1500));
  } finally {
    // stop the detached server for cleanup
    const { spawnSync } = await import("node:child_process");
    if (process.platform === "win32") {
      spawnSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess -Force -ErrorAction SilentlyContinue`], { stdio: "ignore" });
    } else {
      spawnSync("pkill", ["-f", `SHUTTLE_PORT=${port}`], { stdio: "ignore" });
    }
    await sleep(300);
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 6) collectEntries behavior.
// ---------------------------------------------------------------------------
async function testCollectEntries() {
  console.log("\n[collectEntries]");
  const mod = await import(PLUGIN);
  const root = mkdtempSync(join(tmpdir(), "shuttle-ce-"));
  const dir = join(root, "proj");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "main.py"), "print(1)");
  writeFileSync(join(dir, "src", "x.py"), "x = 2");
  const options = { maxFileBytes: 1024 * 1024 * 1024 };
  const one = mod.collectEntries([join(dir, "main.py")], false, options, undefined);
  check("single file entry", one.entries.length === 1 && one.entries[0].arcName === "main.py");
  const both = mod.collectEntries([join(dir, "main.py"), join(dir, "src", "x.py")], true, options, undefined);
  check("two files zip entries", both.entries.length === 2);
  const dirWalk = mod.collectEntries([dir], true, options, undefined);
  check("directory walk prefixed", dirWalk.entries.length === 2 && dirWalk.entries.every((e) => e.arcName.startsWith("proj/")), dirWalk.entries.map((e) => e.arcName).join(","));
  let threw = false;
  try {
    mod.collectEntries([dir], false, options, undefined);
  } catch (error) {
    threw = error.code === "INVALID_ARGS";
  }
  check("directory without zip rejected", threw);
  threw = false;
  try {
    mod.collectEntries([join(root, "missing.txt")], true, options, undefined);
  } catch (error) {
    threw = error.code === "NOT_FOUND";
  }
  check("missing path rejected", threw);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------

try {
  await testZip();
  await testInternals();
  await testServer();
  await testNonLoopback();
  await testEnsureServer();
  await testCollectEntries();
} catch (error) {
  failed += 1;
  console.error(`  FAIL unhandled test error: ${error?.stack ?? error}`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
