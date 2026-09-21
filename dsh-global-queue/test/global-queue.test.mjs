import assert from "node:assert/strict";
import test from "node:test";

import { BackendScheduler, FifoScheduler, queuedStream } from "../lib/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test("provider streams run in strict FIFO order at concurrency one", async () => {
  const scheduler = new FifoScheduler(1);
  const events = [];

  const call = (label, delay) => queuedStream(scheduler, { provider: "gpu", model: label }, () =>
    (async function* () {
      events.push(`start:${label}`);
      yield { type: "text-delta", delta: label };
      await sleep(delay);
      events.push(`end:${label}`);
      yield { type: "finish", reason: { kind: "stop" } };
    })());

  const results = await Promise.all([
    collect(call("a", 25)),
    collect(call("b", 5)),
    collect(call("c", 1)),
  ]);

  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  assert.deepEqual(results.map((items) => items[0].delta), ["a", "b", "c"]);
  assert.deepEqual(scheduler.snapshot(), { active: 0, waiting: 0 });
});

test("lease is released when a consumer closes a stream early", async () => {
  const scheduler = new FifoScheduler(1);
  const events = [];
  const first = queuedStream(scheduler, {}, () => (async function* () {
    try {
      events.push("first:start");
      yield { type: "text-delta", delta: "one" };
      await new Promise(() => {});
    } finally {
      events.push("first:closed");
    }
  })());
  const second = queuedStream(scheduler, {}, () => (async function* () {
    events.push("second:start");
    yield { type: "finish", reason: { kind: "stop" } };
  })());

  const iterator = first[Symbol.asyncIterator]();
  await iterator.next();
  const secondResult = collect(second);
  await sleep(5);
  assert.deepEqual(events, ["first:start"]);
  await iterator.return();
  await secondResult;
  assert.deepEqual(events, ["first:start", "first:closed", "second:start"]);
});

test("an aborted queued request is removed without consuming a slot", async () => {
  const scheduler = new FifoScheduler(1);
  const gate = Promise.withResolvers();
  const first = collect(queuedStream(scheduler, {}, () => (async function* () {
    await gate.promise;
    yield { type: "finish", reason: { kind: "stop" } };
  })()));

  await sleep(0);
  const controller = new AbortController();
  const shouldNotRun = collect(queuedStream(scheduler, { signal: controller.signal }, () => {
    throw new Error("aborted request reached provider");
  }));
  controller.abort();
  const aborted = await shouldNotRun;
  assert.equal(aborted[0].reason.kind, "aborted");
  assert.equal(aborted[0].reason.failure.code, "ABORTED");

  gate.resolve();
  await first;
  assert.deepEqual(scheduler.snapshot(), { active: 0, waiting: 0 });
});

test("configured concurrency is honored", async () => {
  const scheduler = new FifoScheduler(2);
  const gate = Promise.withResolvers();
  let active = 0;
  let peak = 0;
  const call = () => collect(queuedStream(scheduler, {}, () => (async function* () {
    active += 1;
    peak = Math.max(peak, active);
    await gate.promise;
    active -= 1;
    yield { type: "finish", reason: { kind: "stop" } };
  })()));
  const all = [call(), call(), call()];
  await sleep(5);
  assert.equal(peak, 2);
  gate.resolve();
  await Promise.all(all);
});

test("different backends run concurrently", async () => {
  const scheduler = new BackendScheduler({
    concurrency: 1,
    queueGroups: { local: ["local4090"], spark: ["flash-next"] },
  });
  const gate = Promise.withResolvers();
  const started = [];
  const call = (provider) => collect(queuedStream(scheduler, { provider }, () => (async function* () {
    started.push(provider);
    await gate.promise;
    yield { type: "finish", reason: { kind: "stop" } };
  })()));

  const calls = [call("local4090"), call("flash-next")];
  await sleep(5);
  assert.deepEqual(started.sort(), ["flash-next", "local4090"]);
  gate.resolve();
  await Promise.all(calls);
});

test("each backend admits two streams and queues the third by default", async () => {
  const scheduler = new BackendScheduler({
    queueGroups: { local: ["local4090"] },
  });
  const gate = Promise.withResolvers();
  const started = [];
  const call = (label) => collect(queuedStream(
    scheduler,
    { provider: "local4090", model: label },
    () => (async function* () {
      started.push(label);
      await gate.promise;
      yield { type: "finish", reason: { kind: "stop" } };
    })(),
  ));

  const calls = [call("a"), call("b"), call("c")];
  await sleep(5);
  assert.deepEqual(started, ["a", "b"]);
  gate.resolve();
  await Promise.all(calls);
  assert.deepEqual(started, ["a", "b", "c"]);
});

test("provider aliases for one backend serialize in FIFO order", async () => {
  const scheduler = new BackendScheduler({
    concurrency: 1,
    queueGroups: { spark: ["spark-hub", "flash-next"] },
  });
  const firstGate = Promise.withResolvers();
  const events = [];
  const call = (provider, gate) => collect(queuedStream(scheduler, { provider }, () => (async function* () {
    events.push(`start:${provider}`);
    if (gate) await gate.promise;
    events.push(`end:${provider}`);
    yield { type: "finish", reason: { kind: "stop" } };
  })()));

  const calls = [call("spark-hub", firstGate), call("flash-next")];
  await sleep(5);
  assert.deepEqual(events, ["start:spark-hub"]);
  firstGate.resolve();
  await Promise.all(calls);
  assert.deepEqual(events, ["start:spark-hub", "end:spark-hub", "start:flash-next", "end:flash-next"]);
});

test("a cancelled backend waiter does not block the following request", async () => {
  const scheduler = new BackendScheduler({
    concurrency: 1,
    queueGroups: { spark: ["spark-a", "spark-b"] },
  });
  const gate = Promise.withResolvers();
  const events = [];
  const first = collect(queuedStream(scheduler, { provider: "spark-a" }, () => (async function* () {
    await gate.promise;
    yield { type: "finish", reason: { kind: "stop" } };
  })()));
  await sleep(0);
  const controller = new AbortController();
  const cancelled = collect(queuedStream(scheduler, { provider: "spark-b", signal: controller.signal }, () => {
    throw new Error("cancelled request reached provider");
  }));
  const third = collect(queuedStream(scheduler, { provider: "spark-a" }, () => (async function* () {
    events.push("third:start");
    yield { type: "finish", reason: { kind: "stop" } };
  })()));
  controller.abort();
  assert.equal((await cancelled)[0].reason.kind, "aborted");
  gate.resolve();
  await Promise.all([first, third]);
  assert.deepEqual(events, ["third:start"]);
});

test("a provider failure releases only its backend lease", async () => {
  const scheduler = new BackendScheduler({ queueGroups: { local: ["local"], spark: ["spark"] } });
  await assert.rejects(
    collect(queuedStream(scheduler, { provider: "local" }, () => (async function* () {
      throw new Error("provider failed");
    })())),
    /provider failed/,
  );
  const result = await collect(queuedStream(scheduler, { provider: "local" }, () => (async function* () {
    yield { type: "finish", reason: { kind: "stop" } };
  })()));
  assert.equal(result[0].reason.kind, "stop");
});

test("a provider cannot be assigned to multiple backends", () => {
  assert.throws(
    () => new BackendScheduler({ queueGroups: { one: ["alias"], two: ["alias"] } }),
    /multiple backends/,
  );
});
