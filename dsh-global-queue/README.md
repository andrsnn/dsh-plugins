# dsh-global-queue

Per-backend FIFO admission control for DeepSeek Harness model calls. It wraps the
`llm/stream` waterfall, so ordinary conversations, retries, title calls, and
sub-agent model calls to the same backend share the same queue.

With the default `concurrency: 2`, DSH allows two complete response streams on
the same model backend. A third waits in FIFO order until either stream ends.
Requests to different backends can run concurrently. A queued request can still be
cancelled; cancellation removes it from the queue without touching the active
request. The lease is also released if a consumer closes a stream early.

The `llm/stream` API exposes the provider route, but not its configured endpoint.
Declare endpoint-equivalent provider aliases together under `queueGroups`; this
keeps aliases on one physical GPU serialized without guessing from their names.
An undeclared provider gets its own queue keyed by its exact provider route.

```yaml
- insert:
    - id: global-queue
      name: dsh-global-queue
      config:
        concurrency: 2
        logTransitions: true
        queueGroups:
          rtx4090:
            - rtx4090-hub
          spark:
            - spark-hub
            - flash-next
```

`concurrency` applies independently to every backend queue. Provider aliases
for the same physical model server belong in one `queueGroups` entry so they
share the same two-request allowance. This limits
model inference, not tool execution. A parent agent consumes a
model stream completely before it executes a tool or waits for a sub-agent, so
child-agent requests can take the lease without deadlocking their parent.

Run the scheduler tests with `npm test`.
