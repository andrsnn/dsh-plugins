/**
 * dsh-claude-code-bridge: Claude Code as a dsh model.
 *
 * The plugin serves a small OpenAI-compatible endpoint (default
 * http://127.0.0.1:3091/v1) inside the dsh process. A provider row in
 * ~/.dsh/cordis.patch.yml points dsh at it. Each dsh conversation owns one
 * long-lived `claude -p --input-format stream-json --output-format stream-json`
 * child. Every dsh user message is written to that child's stdin; the child's
 * text, thinking, tool calls and tool results stream back as the assistant turn.
 *
 * Claude Code runs its own tools. The bridge never returns tool_calls to dsh,
 * so dsh only displays the work.
 *
 * Conversation identity: the OpenAI request carries no session id, so the
 * plugin adds a system prompt line `[claude-code-bridge session <dsh id>]` to
 * claude-code chats and the bridge keys on it. That survives dsh compaction,
 * which rewrites the history. Without the line, the first user message is the
 * key. The map from key to Claude Code session id is kept in
 * ~/.dsh/claude-code-bridge/sessions.json, so a dsh restart resumes the same
 * Claude Code session with --resume.
 *
 * What is sent: every user message after the last assistant reply, minus the
 * "Current runtime context" snapshots dsh inserts after each prompt.
 *
 * Working directory: a first line `cwd: <path>` in the first message wins,
 * then the dsh session workspace named in the runtime snapshot, then config.cwd.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const name = "claude-code-bridge";
const inject = ["systemPrompt", "agents", "goals"];

// dsh ends a goal only when the model calls its update_goal tool, which Claude
// Code does not have. Goal rounds get this note instead, and a reply ending in
// the marker completes the dsh goal.
const GOAL_ROUND = /<goal_round>/;
const GOAL_MARKER = "GOAL_COMPLETE";
const GOAL_NOTE = `\n\n(dsh bridge note: you cannot call dsh goal tools. When the whole objective is achieved and verified, end your reply with a line containing only ${GOAL_MARKER}. If any work remains, do not print that word.)`;

const PROVIDER = "claude-code";
const SESSION_TAG = /\[claude-code-bridge session ([^\]\s]+)\]/;
const RUNTIME_SNAPSHOT = /^\s*Current runtime context\./;
const WORKSPACE = /session workspace:\s*"([^"]+)"/;

const STATE_DIR = path.join(os.homedir(), ".dsh", "claude-code-bridge");

const DEFAULTS = {
  host: "127.0.0.1",
  port: 3091,
  claudePath: path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
  cwd: os.homedir(),
  permissionMode: "bypassPermissions",
  toolResultChars: 400,
  // How much of Claude Code's tool work to show in the chat:
  //   "count" - one line per turn, e.g. "12 tool calls: Bash 7, Read 4, Edit 1" (default)
  //   "calls" - one line per tool call, no output
  //   "full"  - each call plus a quoted excerpt of its output
  // Overridable without a restart: {"toolDetail": "..."} in ~/.dsh/claude-code-bridge/settings.json
  toolDetail: "count",
  keepAliveMs: 15000,
  // After Stop, how long Claude Code gets to end the turn itself before the bridge kills its process tree.
  stopGraceMs: 3000,
  // model id (as dsh sees it) -> how to launch Claude Code for it
  models: {
    "claude-code-spark": {
      model: "qwen38-flash-next",
      // The hub accepts reasoning effort xhigh, medium or low and rejects Claude Code's usual "high".
      effort: "medium",
      env: {
        ANTHROPIC_BASE_URL: "http://192.168.68.60:8090",
        ANTHROPIC_AUTH_TOKEN: "local",
        ANTHROPIC_MODEL: "qwen38-flash-next",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen38-flash-next",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen38-flash-next",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen38-flash-next",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
    "claude-code": { model: "", env: {} },
  },
};

const log = (msg, extra) =>
  console.log(`[claude-code-bridge] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);

// ---------------------------------------------------------------- helpers

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    const url = p?.type === "image_url" ? (typeof p.image_url === "string" ? p.image_url : p.image_url?.url) : null;
    const m = url && /^data:(image\/[a-z+.-]+);base64,(.*)$/is.exec(url);
    if (m) out.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }
  return out;
}

function parseCwd(firstText, workspace, fallback) {
  const m = /^\s*cwd:\s*(.+?)\s*$/im.exec(firstText.split(/\r?\n/)[0] ?? "");
  if (m && fs.existsSync(m[1])) return m[1];
  if (workspace && fs.existsSync(workspace)) return workspace;
  return fallback;
}

function workspaceOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i].role === "user" ? textOf(messages[i].content) : "";
    const m = RUNTIME_SNAPSHOT.test(t) && WORKSPACE.exec(t);
    if (m) return m[1].replace(/\\\\/g, "\\");
  }
  return null;
}

function stripCwdLine(text) {
  return text.replace(/^\s*cwd:\s*.+?(\r?\n|$)/i, "");
}

function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    if (typeof input[k] === "string" && input[k]) {
      const s = input[k].replace(/\s+/g, " ").trim();
      return s.length > 200 ? s.slice(0, 200) + "..." : s;
    }
  }
  const s = JSON.stringify(input);
  return s.length > 200 ? s.slice(0, 200) + "..." : s;
}

function toolResultText(block) {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p?.type === "text" ? p.text : p?.type === "image" ? "[image]" : "")).join("\n");
  return "";
}

// ---------------------------------------------------------------- session map

class SessionStore {
  constructor(file) {
    this.file = file;
    try {
      this.map = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.map = {};
    }
  }
  get(key) {
    return this.map[key];
  }
  set(key, value) {
    this.map[key] = { ...this.map[key], ...value, updated: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.map, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

// ---------------------------------------------------------------- one Claude Code child

class ClaudeProc {
  constructor({ key, modelId, spec, cwd, resumeId, opts, store }) {
    Object.assign(this, { key, modelId, spec, cwd, opts, store });
    this.sessionId = resumeId ?? null;
    this.listener = null; // current turn's event sink
    this.queue = Promise.resolve();
    this.buf = "";
    this.dead = false;

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", opts.permissionMode,
    ];
    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("--effort", spec.effort);
    if (resumeId) args.push("--resume", resumeId);

    const env = { ...process.env, ...spec.env };
    // A child launched from inside another Claude Code session must not inherit its identity.
    for (const k of Object.keys(env)) if (k.startsWith("CLAUDECODE") || k === "CLAUDE_CODE_ENTRYPOINT") delete env[k];

    log("spawn", { key: key.slice(0, 10), modelId, cwd, resume: resumeId ?? null });
    this.child = spawn(opts.claudePath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.stderr = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d) => this.onData(d));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => {
      this.stderr = (this.stderr + d).slice(-4000);
    });
    this.child.on("error", (err) => this.onExit(-1, err.message));
    this.child.on("exit", (code) => this.onExit(code, this.stderr.trim()));
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.session_id && ev.session_id !== this.sessionId) {
        this.sessionId = ev.session_id;
        this.store.set(this.key, { claudeSessionId: ev.session_id, modelId: this.modelId, cwd: this.cwd });
      }
      this.listener?.(ev);
    }
  }

  onExit(code, detail) {
    if (this.dead) return;
    this.dead = true;
    log("exit", { key: this.key.slice(0, 10), code, detail: detail?.slice(-300) });
    this.listener?.({ type: "__exit", code, detail });
  }

  /** Run one user turn. sink(ev) receives every stream-json event until the turn's `result`. */
  turn(content, sink, signal) {
    const run = () =>
      new Promise((resolve) => {
        if (this.dead) {
          sink({ type: "__exit", code: "dead", detail: this.stderr });
          return resolve();
        }
        let killTimer = null;
        const done = () => {
          clearTimeout(killTimer);
          this.listener = null;
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          // Stop in dsh must stop Claude Code. Ask it to interrupt the turn; if the
          // turn has not ended within stopGraceMs, kill the whole process tree
          // (Claude Code and any command it is running). The session is on disk,
          // so the next message respawns it with --resume.
          log("stop requested", { key: this.key.slice(0, 16) });
          this.write({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
          killTimer = setTimeout(() => {
            if (this.listener) {
              log("interrupt did not end the turn; killing process tree", { key: this.key.slice(0, 16) });
              this.killTree();
            }
          }, this.opts.stopGraceMs);
        };
        signal?.addEventListener("abort", onAbort);
        this.listener = (ev) => {
          sink(ev);
          if (ev.type === "result" || ev.type === "__exit") done();
        };
        this.write({ type: "user", message: { role: "user", content } });
      });
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  write(obj) {
    if (this.dead || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Kill Claude Code and every process it started (shell commands, editors). */
  killTree() {
    const pid = this.child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        this.child.kill("SIGKILL");
      }
    }
  }

  kill() {
    this.dead = true;
    this.killTree();
  }
}

// ---------------------------------------------------------------- OpenAI endpoint

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function createServer(opts) {
  const store = new SessionStore(path.join(STATE_DIR, "sessions.json"));
  const procs = new Map(); // key -> ClaudeProc

  function procFor(key, modelId, firstText, workspace) {
    let p = procs.get(key);
    if (p && !p.dead && p.modelId === modelId) return p;
    const saved = store.get(key);
    const spec = opts.models[modelId];
    const cwd = saved?.cwd ?? parseCwd(firstText, workspace, opts.cwd);
    p = new ClaudeProc({
      key,
      modelId,
      spec,
      cwd,
      resumeId: saved?.modelId === modelId ? saved?.claudeSessionId : p?.sessionId ?? undefined,
      opts,
      store,
    });
    procs.set(key, p);
    return p;
  }

  async function chat(req, res, body) {
    const modelId = body.model;
    if (!opts.models[modelId]) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `unknown model ${modelId}` } }));
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const isPrompt = (m) => m.role === "user" && !RUNTIME_SNAPSHOT.test(textOf(m.content));
    const users = messages.filter(isPrompt);
    const first = users[0];
    let lastAssistant = -1;
    messages.forEach((m, i) => {
      if (m.role === "assistant") lastAssistant = i;
    });
    const pending = messages.slice(lastAssistant + 1).filter(isPrompt);
    const id = "chatcmpl-" + randomUUID();
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream !== false;

    let outText = "";
    let outReasoning = "";
    const chunk = (delta, finish = null, usage) => {
      if (!stream) {
        if (delta.content) outText += delta.content;
        if (delta.reasoning_content) outReasoning += delta.reasoning_content;
        return;
      }
      if (res.destroyed || res.writableEnded) return; // dsh stopped the request
      const o = { id, object: "chat.completion.chunk", created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] };
      if (usage) o.usage = usage;
      sse(res, o);
    };
    const finish = (usage) => {
      if (stream) {
        chunk({}, "stop", usage);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id, object: "chat.completion", created, model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: outText, reasoning_content: outReasoning || undefined }, finish_reason: "stop" }],
        usage,
      }));
    };

    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      chunk({ role: "assistant", content: "" });
    }

    // dsh utility calls (session titles, summaries) carry no tools. Answer them
    // locally so they never start a Claude Code process.
    if (!Array.isArray(body.tools) || body.tools.length === 0 || !first || pending.length === 0) {
      const t = stripCwdLine(textOf(first?.content ?? "")).replace(/\s+/g, " ").trim();
      chunk({ content: t.split(" ").slice(0, 6).join(" ") || "Claude Code" });
      return finish({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    }

    const firstText = textOf(first.content);
    const systemText = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
    const tag = SESSION_TAG.exec(systemText);
    const key = tag ? `dsh:${tag[1]}` : createHash("sha1").update(modelId + "\0" + firstText).digest("hex");
    const proc = procFor(key, modelId, firstText, workspaceOf(messages));

    const content = [];
    let goalRound = false;
    for (const m of pending) {
      content.push(...imagesOf(m.content));
      let t = m === first ? stripCwdLine(textOf(m.content)) : textOf(m.content);
      if (GOAL_ROUND.test(t)) {
        goalRound = true;
        t += GOAL_NOTE;
      }
      if (t.trim()) content.push({ type: "text", text: t });
    }
    let replyText = "";
    if (!content.some((b) => b.type === "text")) content.push({ type: "text", text: "(empty message)" });

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    const ping = setInterval(() => {
      // An empty delta, not an SSE comment: dsh's stream idle timer only sees data chunks.
      if (stream && !res.writableEnded) chunk({});
    }, opts.keepAliveMs);

    let detail = opts.toolDetail;
    try {
      detail = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "settings.json"), "utf8")).toolDetail ?? detail;
    } catch {}
    const toolCounts = new Map(); // tool name -> calls this turn
    const tools = new Map(); // content block index -> { name, json }
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let sawText = false;

    await proc.turn(content, (ev) => {
      if (ev.type === "stream_event") {
        const e = ev.event ?? {};
        if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
          tools.set(e.index, { name: e.content_block.name, json: "" });
        } else if (e.type === "content_block_delta") {
          const d = e.delta ?? {};
          if (d.type === "text_delta" && d.text) {
            sawText = true;
            replyText += d.text;
            chunk({ content: d.text });
          } else if (d.type === "thinking_delta" && d.thinking) {
            chunk({ reasoning_content: d.thinking });
          } else if (d.type === "input_json_delta" && tools.has(e.index)) {
            tools.get(e.index).json += d.partial_json ?? "";
          }
        } else if (e.type === "content_block_stop" && tools.has(e.index)) {
          const t = tools.get(e.index);
          tools.delete(e.index);
          toolCounts.set(t.name, (toolCounts.get(t.name) ?? 0) + 1);
          if (detail !== "count") {
            let input = {};
            try {
              input = JSON.parse(t.json || "{}");
            } catch {}
            chunk({ content: `\n\n**[${t.name}]** \`${summarizeToolInput(input).replace(/`/g, "'")}\`\n` });
          }
        } else if (e.type === "message_stop" && sawText) {
          chunk({ content: "\n" });
          sawText = false;
        }
      } else if (ev.type === "user" && Array.isArray(ev.message?.content) && detail === "full") {
        for (const b of ev.message.content) {
          if (b?.type !== "tool_result") continue;
          let r = toolResultText(b).trim();
          if (r.length > opts.toolResultChars) r = r.slice(0, opts.toolResultChars) + ` ... (${r.length} chars)`;
          const quoted = (r || "(no output)").split(/\r?\n/).map((l) => "> " + l).join("\n");
          chunk({ content: `${b.is_error ? "> **error**\n" : ""}${quoted}\n\n` });
        }
      } else if (ev.type === "result") {
        const u = ev.usage ?? {};
        const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        usage = { prompt_tokens: input, completion_tokens: u.output_tokens ?? 0, total_tokens: input + (u.output_tokens ?? 0) };
        if (ev.is_error || ev.subtype !== "success") {
          chunk({ content: `\n\n**Claude Code ended the turn: ${ev.subtype}** ${ev.result ?? ""}\n` });
        }
        const total = [...toolCounts.values()].reduce((a, b) => a + b, 0);
        const byName = [...toolCounts].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(", ");
        const toolLine = total ? ` · ${total} tool calls: ${byName}` : "";
        chunk({ content: `\n\n_${ev.num_turns ?? "?"} steps · ${Math.round((ev.duration_ms ?? 0) / 1000)} s${toolLine}_` });
      } else if (ev.type === "__exit") {
        chunk({ content: `\n\n**Claude Code process exited (${ev.code}).** ${String(ev.detail ?? "").slice(-800)}` });
      }
    }, abort.signal);

    clearInterval(ping);
    if (goalRound && tag && new RegExp(`^\\s*${GOAL_MARKER}\\s*$`, "m").test(replyText.slice(-400))) {
      const done = opts.completeGoal?.(tag[1]);
      chunk({ content: done ? "\n\n_dsh goal marked complete._" : "\n\n_Claude reported the goal complete, but no active dsh goal was found._" });
    }
    if (!res.writableEnded && !res.destroyed) finish(usage);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: Object.keys(opts.models).map((id) => ({ id, object: "model", owned_by: "claude-code" })) }));
      }
      if (req.method === "GET" && url.pathname === "/status") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify([...procs.values()].map((p) => ({ key: p.key.slice(0, 10), modelId: p.modelId, cwd: p.cwd, sessionId: p.sessionId, dead: p.dead, busy: !!p.listener }))));
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        let raw = "";
        for await (const c of req) raw += c;
        return await chat(req, res, JSON.parse(raw));
      }
      res.writeHead(404);
      res.end();
    } catch (err) {
      log("request failed", { error: String(err?.stack ?? err) });
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err?.message ?? err) } }));
    }
  });

  return {
    server,
    close() {
      for (const p of procs.values()) p.kill();
      procs.clear();
      server.close();
    },
  };
}

function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...config, models: { ...DEFAULTS.models, ...(config.models ?? {}) } };
  opts.completeGoal = (sessionId) => {
    try {
      const agent = ctx.agents.get(sessionId);
      const g = agent && ctx.goals.get(agent);
      if (!g || g.phase !== "active") return false;
      ctx.goals.complete(agent, { id: g.id, revision: g.revision });
      log("goal completed", { sessionId, goal: g.id });
      return true;
    } catch (err) {
      log("goal complete failed", { sessionId, error: String(err?.message ?? err) });
      return false;
    }
  };
  ctx.effect(() => ctx.systemPrompt.section({
    name: "claude-code-bridge:session",
    order: 1000,
    text: (context) =>
      context?.agent?.options?.provider === PROVIDER && context.agent.id ? `[claude-code-bridge session ${context.agent.id}]` : "",
  }), "claude-code-bridge.section()");
  ctx.effect(() => {
    const bridge = createServer(opts);
    bridge.server.on("error", (err) => log("listen failed", { error: err.message }));
    bridge.server.listen(opts.port, opts.host, () => log(`listening on http://${opts.host}:${opts.port}/v1`));
    return () => bridge.close();
  }, "claude-code-bridge.server()");
}

export { apply, createServer, inject, name, DEFAULTS };
