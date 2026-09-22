// Live smoke test: start the bridge on a spare port and run two turns of one
// conversation through claude-code-spark. Prints the streamed deltas.
import { createServer, DEFAULTS } from "./lib/index.js";
import os from "node:os";

const port = 3092;
const bridge = createServer({ ...DEFAULTS, port, cwd: os.tmpdir() });
await new Promise((r) => bridge.server.listen(port, "127.0.0.1", r));

async function turn(messages) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-code-spark",
      stream: true,
      messages,
      tools: [{ type: "function", function: { name: "noop", parameters: { type: "object" } } }],
    }),
  });
  let text = "", reasoning = "", finish = null, raw = "";
  for await (const c of res.body) raw += Buffer.from(c).toString();
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const ch = JSON.parse(line.slice(6)).choices[0];
    text += ch.delta.content ?? "";
    reasoning += ch.delta.reasoning_content ?? "";
    finish = ch.finish_reason ?? finish;
  }
  return { text, reasoning, finish };
}

const sys = { role: "system", content: "dsh system prompt (ignored by the bridge)" };
const u1 = { role: "user", content: `bridge-test ${Date.now()}: run the shell command \`echo hello-from-bridge\` and then tell me the word ORANGE.` };
const t1 = await turn([sys, u1]);
console.log("TURN 1", JSON.stringify(t1, null, 1));
const t2 = await turn([sys, u1, { role: "assistant", content: t1.text }, { role: "user", content: "What word did I ask you to say? One word." }]);
console.log("TURN 2", JSON.stringify(t2, null, 1));
const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
console.log("STATUS", JSON.stringify(status));
bridge.close();
process.exit(0);
