# @cirrus/scheduler

Delayed and scheduled function invocation for the Cirrus framework.

```ts
import { createScheduler } from "@cirrus/scheduler";

const scheduler = createScheduler({ namespace: env.SCHEDULER, originUrl: "https://app.acme.test" });

// Run in 5 minutes.
await scheduler.runAfter(5 * 60_000, api.email.sendReminder, { userId: "u-1" });

// Run at a specific moment.
await scheduler.runAt(new Date("2026-06-01T12:00:00Z"), api.cleanup.run, { older: 30 });
```

Backing: a `SchedulerDO` Durable Object that uses `state.storage.setAlarm()` to fire the next-earliest pending task. On alarm fire it dispatches the function via HTTP back to the Worker, which routes it to the right shard.

## Bounded concurrency: `createWorkpool` vs. Cloudflare Queues

`createWorkpool` is a bounded-concurrency action queue on the same `SchedulerDO`. Cloudflare **Queues** already cover concurrency-capped, retried, dead-lettered, delayed dispatch natively (`max_concurrency`, `max_retries`, `retry({ delaySeconds })`, `dead_letter_queue`) — if you just want to rate-limit fire-and-forget background work, use Queues.

The workpool exists for what a queue can't give you: a **hard** concurrency cap (the DO is the single serialization point, so there's no cross-consumer overshoot), per-job **cancellation**, and per-job **status** introspection, all keyed by a stable job id. Pick the workpool when you need those; pick Queues otherwise. Don't grow multi-step orchestration on either — that's Cloudflare **Workflows** (`step.do` / `step.sleep` / `step.waitForEvent`).

### Queues-backed workpool

For the "just rate-limit my background jobs" case, `createQueueWorkpool` enqueues function dispatches onto a Cloudflare Queue; concurrency, retries, backoff, and dead-lettering are configured on the consumer in `wrangler.jsonc` (`max_concurrency` / `max_retries` / `retry_delay` / `dead_letter_queue`).

```ts
// producer (anywhere in your Worker)
import { createQueueWorkpool } from "@cirrus/scheduler";

const pool = createQueueWorkpool({ queue: env.JOBS });
await pool.enqueue(internal.stripe.sync, { invoiceId }); // optionally { delaySeconds, shardKey }

// consumer (your Worker's `queue()` handler)
import { createQueueConsumer, httpDispatcher } from "@cirrus/scheduler";

const consume = createQueueConsumer({
    dispatch: httpDispatcher({ originUrl: "https://app.acme.test", adminToken: env.CIRRUS_ADMIN_TOKEN }),
});

export default {
    queue: (batch, env, ctx) => consume(batch),
};
```

`httpDispatcher` POSTs each job to the Worker's `/_cirrus/scheduler/dispatch` endpoint (the same path `SchedulerDO` uses) with the admin bearer; supply your own `dispatch` callback to route differently. Failed or malformed messages are `retry()`-ed so they ride Queues' retry + dead-letter machinery rather than being dropped. There is **no** hard cap, cancel, or status here — that's the `createWorkpool` trade-off above.

Declare the queue binding and consumer in `wrangler.jsonc` — this is where concurrency/retry/DLQ live:

```jsonc
{
    "queues": {
        "producers": [{ "binding": "JOBS", "queue": "cirrus-jobs" }],
        "consumers": [
            {
                "queue": "cirrus-jobs",
                "max_concurrency": 5,
                "max_retries": 3,
                "dead_letter_queue": "cirrus-jobs-dlq",
            },
        ],
    },
}
```

## Repeated tasks (Cron Triggers)

For repeated tasks use Cloudflare Cron Triggers — `createCronTrigger()` produces a snippet to paste into your `wrangler.jsonc`, and `@cirrus/codegen` keeps `triggers.crons` in sync from your `cronJobs()` definitions.

> **Limit:** a Worker can have at most **3 Cron Triggers** (distinct cron expressions). Codegen deduplicates by expression — multiple jobs sharing one schedule count as a single trigger — and `cirrus codegen` warns if you exceed it. For finer-grained or higher-cardinality scheduling, use Durable Object alarms (via `runAfter`/`runAt` above), which have no such cap.
