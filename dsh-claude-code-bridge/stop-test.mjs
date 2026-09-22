// Live Stop test on a spare port: start a turn that runs a long shell command,
// abort the request after the command starts (what dsh Stop does), then check
// that the turn ended, no marker process survived, and the next turn resumes.
import { createServer, DEFAULTS } from "./lib/index.js";
import { execSync } from "node:child_process";
import os from "node:os";

const port = 3092;
const marker = `stoptest${Date.now() % 100000}`;
const bridge = createServer({ ...DEFAULTS, port, cwd: os.tmpdir() });
await new Promise((r) => bridge.server.listen(port, "127.0.0.1", r));
const status = async () => (await fetch(`http://127.0.0.1:${port}/status`)).json();
const alive = () => {
  const out = execSync(`powershell -NoProfile -Command "@(Get-CimInstance Win32_Process | ? { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'setTimeout' -and $_.CommandLine -match '${marker}' }).Count"`).toString().trim();
  return Number(out);
};
const body = (messages) => JSON.stringify({ model: "claude-code-spark", stream: true, messages, tools: [{ type: "function", function: { name: "noop", parameters: { type: "object" } } }] });
const sys = { role: "system", content: `[claude-code-bridge session stoptest-${marker}]` };
const u1 = { role: "user", content: `Run exactly this one bash command and wait for it: node -e "setTimeout(()=>{}, 300000)" ${marker}  -- then say FINISHED.` };

const ctl = new AbortController();
const req = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: body([sys, u1]), headers: { "content-type": "application/json" }, signal: ctl.signal })
  .then(async (r) => { for await (const _ of r.body) {} })
  .catch((e) => e.name);

// Wait until the long command is running.
const t0 = Date.now();
while (alive() === 0 && Date.now() - t0 < 180000) await new Promise((r) => setTimeout(r, 2000));
console.log(`command running after ${Math.round((Date.now() - t0) / 1000)} s: ${alive()} process(es)`);

const tStop = Date.now();
ctl.abort();
console.log("request:", await req);
let st;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  st = await status();
  if (!st[0]?.busy && alive() === 0) break;
}
console.log(`after Stop (${Math.round((Date.now() - tStop) / 1000)} s): busy=${st[0]?.busy} dead=${st[0]?.dead} marker processes=${alive()}`);

// Next turn must work and keep context.
const r2 = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: body([sys, u1, { role: "assistant", content: "(stopped)" }, { role: "user", content: "Reply with one word: what word was I going to have you say?" }]), headers: { "content-type": "application/json" } });
let text = "";
for (const line of (await r2.text()).split("\n")) {
  if (line.startsWith("data: {")) text += JSON.parse(line.slice(6)).choices[0].delta.content ?? "";
}
console.log("next turn:", JSON.stringify(text.trim().slice(-200)));
console.log("status:", JSON.stringify(await status()));
bridge.close();
process.exit(0);
