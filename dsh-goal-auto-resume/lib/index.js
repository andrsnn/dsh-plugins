/**
 * dsh-goal-auto-resume: keep a long-running goal alive across model failures.
 *
 * The shipped goal driver has "no abnormal auto-retry": when a turn fails
 * (the local model reloaded, wedged, or reset the connection) it ends the round
 * and stops. On a box meant to run a goal for days unattended, this plugin is
 * the human who would otherwise have to press resume.
 *
 * Two failure shapes are recovered, both triggered by an `agent/error`:
 *   - the goal is left `paused` after the error, or
 *   - the goal is left `active` but DORMANT - the driver disarmed its
 *     process-local continuation and stopped, while the durable phase stays
 *     `active`. (Observed on a token-0 / poison-gate turn failure: the round
 *     ends with kind:error and the goal never transitions to paused.)
 * A `resume` re-arms either one. Activation (armed/disarmed) is deliberately
 * absent from the goal view, so we cannot read it; instead we just call resume
 * and let it tell us: resume on an `active` + already-armed goal throws
 * "already active and armed", which we treat as "the driver is still running
 * this goal, nothing to recover" and leave alone. That makes a resume attempt
 * safe even against a goal that is genuinely mid-round.
 *
 * A goal a PERSON paused is never touched: we only attempt after an
 * `agent/error`, and a human `/goal pause` produces no error. Recovery uses
 * exponential backoff and an attempt cap so a truly dead backend cannot loop
 * forever. An exhausted round budget is reported and given up on, not retried.
 *
 * Also re-arms an `active` goal when its session starts (activation is never
 * persisted, so a `dsh web` restart would otherwise strand an active run), and
 * optionally resumes goals found already `paused` at session start.
 */
const name = "goal-auto-resume";
const inject = ["goals", "agents"];

const DEFAULTS = {
  healthUrl: "http://127.0.0.1:8090/api/status", // llmhub: {ready, starting}
  pollMs: 15_000,          // sweep interval
  abnormalWindowMs: 600_000, // an error this recent makes a stop "abnormal"
  minDelayMs: 20_000,      // first retry delay
  maxDelayMs: 300_000,     // backoff ceiling
  maxAttempts: 40,         // ~3 h of retrying at the ceiling before giving up
  rearmActiveOnSessionStart: true,
  resumeStalePausedOnStart: false,
};

function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...config };
  const marks = new Map();   // agent -> { errorAt, attempts, timer, reason }
  const log = (level, msg, extra) =>
    console[level === "error" ? "error" : "log"](`[goal-auto-resume] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);

  const goalRef = (g) => ({ id: g.id, revision: g.revision });
  const live = (agent) => ctx.agents.get(agent.id) === agent;

  async function healthy() {
    try {
      const r = await fetch(opts.healthUrl, { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      return d.ready === true && d.starting !== true;
    } catch {
      return false;
    }
  }

  function mark(agent) {
    return marks.get(agent) ?? marks.set(agent, { attempts: 0, timer: null, errorAt: 0 }).get(agent);
  }

  function clear(agent) {
    const m = marks.get(agent);
    if (m?.timer) clearTimeout(m.timer);
    marks.delete(agent);
  }

  /** Try once now if the model is up; otherwise schedule with backoff. */
  async function attempt(agent, reason) {
    const m = mark(agent);
    if (!live(agent)) return clear(agent);
    let g;
    try { g = ctx.goals.get(agent); } catch { g = undefined; }
    // Only paused, blocked, or (dormant) active goals are recoverable.
    if (!g || (g.phase !== "paused" && g.phase !== "active" && g.phase !== "blocked")) return clear(agent);
    if (m.attempts >= opts.maxAttempts) {
      log("error", "giving up: model never came back", { session: agent.id, attempts: m.attempts, reason });
      return clear(agent);
    }
    if (!(await healthy())) return schedule(agent, reason);
    try {
      const view = ctx.goals.resume(agent, goalRef(g));
      log("log", g.phase === "active" ? "re-armed dormant active goal" : `resumed ${g.phase} goal`,
          { session: agent.id, reason, attempt: m.attempts + 1, phase: view?.phase });
      clear(agent);
    } catch (e) {
      const msg = String((e && e.message) || e);
      // Already running: resume refuses an active+armed goal. The driver is
      // alive and owns this goal - there is nothing to recover. Stop here.
      if (/already active and armed/i.test(msg)) {
        clear(agent);
        return;
      }
      // Round budget spent: resuming can never succeed. Report and give up
      // rather than hammer the backend to the attempt cap.
      if (/exhausted|maxGoalRounds/i.test(msg)) {
        log("error", "round budget exhausted; not resuming (raise maxGoalRounds)", { session: agent.id });
        clear(agent);
        return;
      }
      log("error", "resume failed", { session: agent.id, error: msg.slice(0, 200) });
      schedule(agent, reason);
    }
  }

  function schedule(agent, reason) {
    const m = mark(agent);
    if (m.timer) return;
    m.attempts += 1;
    m.reason = reason;
    const delay = Math.min(opts.maxDelayMs, opts.minDelayMs * 2 ** (m.attempts - 1));
    m.timer = setTimeout(() => { m.timer = null; void attempt(agent, reason); }, delay);
    m.timer.unref?.();
    log("log", "scheduled resume attempt", { session: agent.id, reason, attempt: m.attempts, inMs: delay });
  }

  // A failed turn: remember it and kick a recovery attempt. The driver may end
  // the round leaving the goal paused OR active-but-dormant; attempt() handles
  // both, and no-ops if the driver actually retried and is still running.
  ctx.on("agent/error", ({ agent }) => {
    mark(agent).errorAt = Date.now();
    schedule(agent, "agent/error");
  });

  ctx.on("agent/session-start", ({ agent }) => {
    let g;
    try { g = ctx.goals.get(agent); } catch { return; }
    if (!g) return;
    if (g.phase === "active" && opts.rearmActiveOnSessionStart) void attempt(agent, "session-start rearm");
    else if (g.phase === "paused" && opts.resumeStalePausedOnStart) void attempt(agent, "stale paused at session start");
  });

  ctx.on("agent/disposed", ({ agent }) => clear(agent));

  // Backstop: catch a recent error whose direct schedule was cleared or whose
  // event ordering left the goal recoverable. Fires for paused OR active goals
  // (the dormant-active gap) within the abnormal window.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const agent of ctx.agents.list()) {
      const m = marks.get(agent);
      if (!m || m.timer || !m.errorAt || now - m.errorAt > opts.abnormalWindowMs) continue;
      let g;
      try { g = ctx.goals.get(agent); } catch { continue; }
      if (g && (g.phase === "paused" || g.phase === "active" || g.phase === "blocked")) {
        void attempt(agent, "recovering after agent/error");
      }
    }
  }, opts.pollMs);
  sweep.unref?.();

  ctx.on("dispose", () => {
    clearInterval(sweep);
    for (const agent of [...marks.keys()]) clear(agent);
  });

  log("log", "armed", { healthUrl: opts.healthUrl, rearmActiveOnSessionStart: opts.rearmActiveOnSessionStart,
                        resumeStalePausedOnStart: opts.resumeStalePausedOnStart, maxAttempts: opts.maxAttempts });
}

export { apply, inject, name };
