/**
 * dsh-global-queue
 *
 * Serializes the complete lifetime of DSH `llm/stream` calls per backend. The lease is
 * acquired before the provider request is created and is released only after
 * the returned AsyncIterable finishes, throws, is aborted, or is closed by its
 * consumer. Because every AgentLoop request (including child agents) crosses
 * this waterfall, one scheduler covers every conversation in this DSH host.
 */

const name = "global-queue";
const inject = ["llm"];

const DEFAULTS = Object.freeze({
  concurrency: 2,
  logTransitions: true,
});

class FifoScheduler {
  constructor(concurrency = 1, onTransition = () => {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TypeError("concurrency must be a positive integer");
    }
    this.concurrency = concurrency;
    this.onTransition = onTransition;
    this.active = 0;
    this.waiters = [];
    this.closed = false;
    this.sequence = 0;
  }

  snapshot() {
    return Object.freeze({ active: this.active, waiting: this.waiters.length });
  }

  acquire(signal, metadata = {}) {
    if (this.closed) return Promise.resolve(undefined);

    const entry = {
      id: ++this.sequence,
      metadata,
      signal,
      settled: false,
      abort: undefined,
      resolve: undefined,
    };

    const promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });

    if (signal?.aborted) {
      entry.settled = true;
      entry.resolve(undefined);
      return promise;
    }

    if (signal) {
      entry.abort = () => {
        if (entry.settled) return;
        entry.settled = true;
        const index = this.waiters.indexOf(entry);
        if (index !== -1) this.waiters.splice(index, 1);
        entry.resolve(undefined);
        this.onTransition("cancelled", entry, this.snapshot());
      };
      signal.addEventListener("abort", entry.abort, { once: true });
    }

    this.waiters.push(entry);
    this.onTransition("queued", entry, this.snapshot());
    this.#drain();
    return promise;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const pending = this.waiters.splice(0);
    for (const entry of pending) {
      if (entry.settled) continue;
      entry.settled = true;
      if (entry.abort) entry.signal.removeEventListener("abort", entry.abort);
      entry.resolve(undefined);
      this.onTransition("cancelled", entry, this.snapshot());
    }
  }

  #drain() {
    while (!this.closed && this.active < this.concurrency && this.waiters.length > 0) {
      const entry = this.waiters.shift();
      if (entry.settled) continue;
      entry.settled = true;
      if (entry.abort) entry.signal.removeEventListener("abort", entry.abort);
      this.active += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.onTransition("released", entry, this.snapshot());
        this.#drain();
      });
      this.onTransition("admitted", entry, this.snapshot());
    }
  }
}

class BackendScheduler {
  constructor({ concurrency = 2, queueGroups = {}, onTransition = () => {} } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TypeError("concurrency must be a positive integer");
    }
    this.concurrency = concurrency;
    this.onTransition = onTransition;
    this.schedulers = new Map();
    this.providerBackends = new Map();
    this.closed = false;

    for (const [backend, providers] of Object.entries(queueGroups)) {
      if (!backend || !Array.isArray(providers) || providers.length === 0) {
        throw new TypeError("each backend must have a non-empty name and provider list");
      }
      for (const provider of providers) {
        if (typeof provider !== "string" || !provider) {
          throw new TypeError("backend providers must be non-empty strings");
        }
        if (this.providerBackends.has(provider)) {
          throw new TypeError(`provider ${JSON.stringify(provider)} belongs to multiple backends`);
        }
        this.providerBackends.set(provider, backend);
      }
    }
  }

  backendFor(provider) {
    return this.providerBackends.get(provider) ?? `provider:${provider ?? "unknown"}`;
  }

  schedulerFor(provider) {
    const backend = this.backendFor(provider);
    let scheduler = this.schedulers.get(backend);
    if (!scheduler) {
      scheduler = new FifoScheduler(this.concurrency, (event, entry, state) =>
        this.onTransition(event, { ...entry, backend }, state));
      if (this.closed) scheduler.close();
      this.schedulers.set(backend, scheduler);
    }
    return scheduler;
  }

  acquire(signal, metadata = {}) {
    return this.schedulerFor(metadata.provider).acquire(signal, metadata);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const scheduler of this.schedulers.values()) scheduler.close();
  }
}

function requestMetadata(options) {
  return {
    provider: options?.provider,
    model: options?.model,
    session: options?.sessionId,
    purpose: options?.purpose,
  };
}

function abortedChunk(message) {
  return {
    type: "finish",
    reason: {
      kind: "aborted",
      failure: { code: "ABORTED", message },
    },
  };
}

function queuedStream(scheduler, options, next) {
  return (async function* () {
    const release = await scheduler.acquire(options?.signal, requestMetadata(options));
    if (!release) {
      yield abortedChunk("model request cancelled while waiting for its backend queue");
      return;
    }

    try {
      yield* next();
    } finally {
      release();
    }
  })();
}

function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...config };
  const log = (event, entry, state) => {
    if (!opts.logTransitions) return;
    const details = {
      request: entry.id,
      backend: entry.backend,
      ...entry.metadata,
      active: state.active,
      waiting: state.waiting,
    };
    console.log(`[global-queue] ${event} ${JSON.stringify(details)}`);
  };
  const scheduler = new BackendScheduler({
    concurrency: opts.concurrency,
    queueGroups: opts.queueGroups,
    onTransition: log,
  });

  ctx.on(
    "llm/stream",
    (options, next) => queuedStream(scheduler, options, next),
    { global: true },
  );
  ctx.effect(() => () => scheduler.close(), "global-queue.close()");

  console.log(`[global-queue] armed ${JSON.stringify({
    concurrency: opts.concurrency,
    queueGroups: opts.queueGroups ?? {},
  })}`);
}

export { BackendScheduler, FifoScheduler, apply, inject, name, queuedStream };
