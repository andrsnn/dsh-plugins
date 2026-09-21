/**
 * dsh-auto-continue: keep a run moving when the model stops at the output
 * token limit.
 *
 * When an assistant step fills the output cap, the agent loop ends the turn
 * with `turn/end` reason `{ kind: "max-tokens" }`. This is a clean truncation,
 * not an error, so the shipped goal-round driver DISARMS the goal
 * (activation -> "disarmed", phase stays "active") and waits for a human to
 * send "continue". `dsh-goal-auto-resume` only reacts to `agent/error`, so it
 * never touches a max-tokens stall. On a box meant to run a goal for days
 * unattended, that stall sits forever.
 *
 * This plugin is the human for that case. On a max-tokens `turn/end`:
 *   - if the agent has an active goal, re-arm it with `ctx.goals.resume` (the
 *     same call goal-auto-resume uses for a dormant-active goal), so the round
 *     driver queues the next round and continues; or
 *   - if there is no goal (a plain interactive turn), send a "continue" user
 *     message via `agent.followup` - exactly what dsh tells the user to type.
 *
 * A per-session counter of CONSECUTIVE max-tokens stalls caps the automatic
 * continues (default 12) so a task that can only ever overflow cannot loop
 * forever; any turn that ends for another reason resets it. A goal a person
 * paused (a normal `/goal pause`, no max-tokens) is never touched.
 */
const name = "auto-continue";
const inject = ["agents", "goals"];

const DEFAULTS = {
  maxConsecutive: 12,        // cap consecutive auto-continues on one stall (~12 x maxTokens of output) before leaving it for a human
  continueInteractive: true, // also auto-continue a max-tokens stop when there is no active goal
  continueText: "continue",  // the message sent on the no-goal path
  settleMs: 100,             // let the turn fully settle before acting, like a human typing after the stop
};

function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...config };
  const counts = new Map(); // session id -> consecutive max-tokens count
  const log = (level, msg, extra) =>
    console[level === "error" ? "error" : "log"](`[auto-continue] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);

  const goalRef = (g) => ({ id: g.id, revision: g.revision });

  // Same shape createUserMessage produces (id + role + content blocks + source);
  // built by hand because the adapter package is not resolvable from a linked plugin.
  function continueMessage() {
    return Object.freeze({
      id: crypto.randomUUID(),
      role: "user",
      content: Object.freeze([Object.freeze({ type: "text", text: opts.continueText })]),
      source: Object.freeze({ kind: "user" }),
    });
  }

  function sendContinue(agent, sessionId, attempt) {
    try {
      agent.followup(continueMessage());
      log("log", "output limit reached; sent continue", { session: sessionId, attempt });
    } catch (e) {
      log("error", "failed to send continue", { session: sessionId, error: String(e).slice(0, 200) });
    }
  }

  ctx.on("session/event", (session, event) => {
    if (event?.type !== "turn/end") return;
    const agent = ctx.agents.get(session.id);
    if (agent === undefined || agent.session !== session) return;

    // Any non-max-tokens turn end clears the stall streak for this session.
    if (event.data?.reason?.kind !== "max-tokens") {
      counts.delete(session.id);
      return;
    }

    const attempt = (counts.get(session.id) ?? 0) + 1;
    if (attempt > opts.maxConsecutive) {
      log("error", "consecutive auto-continue cap reached; leaving it for a human",
          { session: session.id, maxConsecutive: opts.maxConsecutive });
      return;
    }
    counts.set(session.id, attempt);

    setTimeout(() => {
      if (ctx.agents.get(session.id) !== agent) return; // agent gone or replaced
      let g;
      try { g = ctx.goals.get(agent); } catch { g = undefined; }
      if (g && g.phase === "active") {
        try {
          ctx.goals.resume(agent, goalRef(g));
          log("log", "output limit reached; re-armed goal to continue", { session: session.id, attempt });
        } catch (e) {
          const msg = String(e);
          if (msg.includes("already active and armed")) log("log", "goal already armed; nothing to do", { session: session.id });
          else log("error", "goal resume failed; leaving it for a human", { session: session.id, error: msg.slice(0, 200) });
        }
      } else if (opts.continueInteractive) {
        sendContinue(agent, session.id, attempt);
      }
    }, opts.settleMs)?.unref?.();
  });

  ctx.on("agent/disposed", ({ agent }) => counts.delete(agent.id));

  log("log", "armed", { maxConsecutive: opts.maxConsecutive, continueInteractive: opts.continueInteractive });
}

export { apply, inject, name };
