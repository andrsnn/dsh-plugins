/**
 * Self-contained test for dsh-auto-continue. No dsh runtime needed: it mocks
 * the ctx surface the plugin uses (ctx.on("session/event"), ctx.agents,
 * ctx.goals.resume) and an agent with a followup() spy. Run: `node test.mjs`.
 *
 * Covers: a max-tokens turn end with an active goal re-arms it; with no goal it
 * sends a "continue" user message; a non-max-tokens turn end does nothing and
 * resets the streak; consecutive stalls are capped; an already-armed goal is
 * tried once and left alone.
 */
import assert from "node:assert";
import { apply } from "./lib/index.js";

function harness() {
  const handlers = new Map();
  const followups = [];
  const agent = { id: "s1", followup: (m) => followups.push(m) };
  agent.session = { id: "s1" };
  const state = { goal: undefined, resumeCalls: 0, resumeImpl: () => ({ phase: "active" }) };
  const ctx = {
    on: (ev, fn) => { handlers.set(ev, fn); },
    goals: { get: () => state.goal, resume: () => { state.resumeCalls += 1; return state.resumeImpl(); } },
    agents: { get: (id) => (id === agent.id ? agent : undefined) },
  };
  const turnEnd = (kind) => handlers.get("session/event")?.(agent.session, { type: "turn/end", data: { reason: { kind } } });
  return { ctx, agent, state, followups, turnEnd };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = { settleMs: 5, maxConsecutive: 3 };

async function run() {
  // 1. max-tokens + active goal -> re-armed, no continue message.
  {
    const { ctx, state, followups, turnEnd } = harness();
    state.goal = { id: "g1", revision: 2, phase: "active" };
    apply(ctx, cfg);
    turnEnd("max-tokens");
    await wait(30);
    assert.strictEqual(state.resumeCalls, 1, "active goal must be re-armed on max-tokens");
    assert.strictEqual(followups.length, 0, "goal path must not also send a continue message");
  }

  // 2. max-tokens + no goal -> a single "continue" user message.
  {
    const { ctx, state, followups, turnEnd } = harness();
    state.goal = undefined;
    apply(ctx, cfg);
    turnEnd("max-tokens");
    await wait(30);
    assert.strictEqual(state.resumeCalls, 0, "no goal means no resume");
    assert.strictEqual(followups.length, 1, "no-goal max-tokens must send one continue");
    assert.strictEqual(followups[0].role, "user");
    assert.strictEqual(followups[0].content[0].text, "continue");
    assert.strictEqual(followups[0].source.kind, "user");
  }

  // 3. a normal (completed) turn end does nothing.
  {
    const { ctx, state, followups, turnEnd } = harness();
    state.goal = { id: "g3", revision: 1, phase: "active" };
    apply(ctx, cfg);
    turnEnd("completed");
    await wait(30);
    assert.strictEqual(state.resumeCalls, 0, "a completed turn must not be auto-continued");
    assert.strictEqual(followups.length, 0);
  }

  // 4. consecutive max-tokens stalls are capped; a normal end resets the streak.
  {
    const { ctx, state, turnEnd } = harness();
    state.goal = { id: "g4", revision: 1, phase: "active" };
    apply(ctx, cfg);
    for (let i = 0; i < 5; i += 1) turnEnd("max-tokens"); // maxConsecutive = 3
    await wait(30);
    assert.strictEqual(state.resumeCalls, 3, "must stop after maxConsecutive consecutive stalls");
    turnEnd("completed");           // reset the streak
    turnEnd("max-tokens");          // allowed again
    await wait(30);
    assert.strictEqual(state.resumeCalls, 4, "a normal turn end must reset the consecutive cap");
  }

  // 5. an already-armed goal: resume throws, tried once, no crash.
  {
    const { ctx, state, turnEnd } = harness();
    state.goal = { id: "g5", revision: 1, phase: "active" };
    state.resumeImpl = () => { throw new Error('goal "g5" is already active and armed'); };
    apply(ctx, cfg);
    turnEnd("max-tokens");
    await wait(30);
    assert.strictEqual(state.resumeCalls, 1, "already-armed goal is tried once and left alone");
  }

  console.log("dsh-auto-continue: 5/5 tests passed");
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
