/**
 * Self-contained test for dsh-goal-auto-resume. No dsh runtime needed: it mocks
 * the ctx surface the plugin uses (ctx.on, ctx.goals, ctx.agents) and a fetch
 * that reports the model healthy. Run: `node test.mjs`.
 *
 * Covers the gap this plugin was fixed for: a goal left `active` (not paused)
 * after an errored turn must be re-armed; a goal that is genuinely still
 * running (resume throws "already active and armed") must be left alone; a
 * human-paused goal (no error) must never be resumed.
 */
import assert from "node:assert";
import { apply } from "./lib/index.js";

globalThis.fetch = async () => ({ json: async () => ({ ready: true, starting: false }) });

function harness() {
  const handlers = new Map();
  const agent = { id: "s1" };
  const state = { goal: undefined, resumeCalls: 0, resumeImpl: null };
  const ctx = {
    on: (ev, fn) => { handlers.set(ev, fn); },
    emit: (ev, payload) => handlers.get(ev)?.(payload),
    agents: { get: (id) => (id === agent.id ? agent : undefined), list: () => [agent] },
    goals: {
      get: () => state.goal,
      resume: (_a, _ref) => { state.resumeCalls += 1; return state.resumeImpl(); },
    },
  };
  return { ctx, agent, state, handlers };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // Fast config so the test runs in ~50 ms, not 20 s.
  const cfg = { minDelayMs: 5, maxDelayMs: 10, pollMs: 5, abnormalWindowMs: 60_000 };

  // 1. Active-but-dormant goal after an error -> re-armed.
  {
    const { ctx, state, agent } = harness();
    let phase = "active";
    state.goal = { id: "g1", revision: 4, get phase() { return phase; } };
    state.resumeImpl = () => { phase = "active"; return { phase: "active" }; };
    apply(ctx, cfg);
    ctx.emit("agent/error", { agent });
    await wait(40);
    assert.strictEqual(state.resumeCalls >= 1, true, "dormant active goal should be resumed");
  }

  // 2. Genuinely running goal (resume rejects) -> attempted once, then left alone (no spin).
  {
    const { ctx, state, agent } = harness();
    state.goal = { id: "g2", revision: 4, phase: "active" };
    state.resumeImpl = () => { const e = new Error('goal "g2" is already active and armed'); e.code = "GOAL_INVALID_TRANSITION"; throw e; };
    apply(ctx, cfg);
    ctx.emit("agent/error", { agent });
    await wait(60);
    assert.strictEqual(state.resumeCalls, 1, "an already-armed goal must be tried once and then left alone, not spun on");
  }

  // 3. Human-paused goal (no error event) -> never resumed.
  {
    const { ctx, state, agent } = harness();
    state.goal = { id: "g3", revision: 4, phase: "paused" };
    state.resumeImpl = () => ({ phase: "active" });
    apply(ctx, cfg);
    // no agent/error emitted; give the sweep several ticks
    await wait(40);
    assert.strictEqual(state.resumeCalls, 0, "a human-paused goal (no error) must never be resumed");
  }

  // 4. Exhausted round budget -> reported and given up, not retried to the cap.
  {
    const { ctx, state, agent } = harness();
    state.goal = { id: "g4", revision: 4, phase: "paused" };
    state.resumeImpl = () => { throw new Error('goal "g4" exhausted 1000 goal rounds; increase maxGoalRounds before resuming'); };
    apply(ctx, cfg);
    ctx.emit("agent/error", { agent });
    await wait(60);
    assert.strictEqual(state.resumeCalls, 1, "an exhausted-budget goal must be tried once then given up, not retried");
  }

  console.log("dsh-goal-auto-resume: 4/4 tests passed");
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
