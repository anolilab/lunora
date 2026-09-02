---
name: lunora-setup-scheduler
description: Schedules deferred and recurring work in a Lunora app. Use for `ctx.scheduler.runAfter` / `runAt` (delayed function dispatch), cron jobs via `lunora registry add crons` (the `cronJobs()` builder), the `SchedulerDO` / `SCHEDULER` binding, retries, and the workpool for bounded concurrency.
---

# Lunora Setup Scheduler

Schedule work in Lunora two ways, both backed by `@lunora/scheduler` (re-exported
from `@lunora/server`):

- **Deferred dispatch** — `ctx.scheduler.runAfter` / `runAt` from any function,
  to run a function later. Built into the runtime; **no registry install**.
- **Recurring jobs (crons)** — declare them in `lunora/crons.ts` with
  `cronJobs()`. Add the starter with `lunora registry add crons`.

Both run jobs through the `SchedulerDO` Durable Object (binding `SCHEDULER`),
which owns the alarm and durable storage.

## When to Use

- Running a function after a delay or at a specific time
  (`runAfter` / `runAt`).
- Declaring recurring jobs (sweep, digest, report) on a cron schedule.
- Bounding concurrency for many enqueued jobs (a workpool).

## When Not to Use

- The project has no Lunora backend yet — use `lunora-quickstart` first.
- You just need to react to live data changes — use a reactive `query` /
  subscription (`lunora-realtime`), not a scheduled job.

## Deferred dispatch — `runAfter` / `runAt`

Available on `ctx.scheduler` in any function. Target functions are passed by
reference from the generated `api` / `internal` proxy:

```ts
import { mutation, v } from "#lunora/_generated/server.js";

import { internal } from "./_generated/api";

export const startTrial = mutation.input({ userId: v.string() }).mutation(async ({ ctx, args: { userId } }) => {
    // run an internal action 14 days from now
    const jobId = await ctx.scheduler.runAfter(14 * 24 * 60 * 60 * 1000, internal.billing.endTrial, { userId });

    return { jobId };
});
```

- `runAfter(delayMs, fnRef, args, options?)` — run after a delay (`delayMs` must
  be a non-negative finite number). `runAt(date, fnRef, args, options?)` — run at
  a `Date` or epoch-ms timestamp.
- Both resolve the job id. Cancel with `ctx.scheduler.cancel(id)`;
  inspect with `ctx.scheduler.get(id)` / `ctx.scheduler.list()`.
- `options` accepts a `retry` policy (`{ maxAttempts, backoff, baseMs, maxMs }`;
  DO defaults: `maxAttempts: 5`, `backoff: "exponential"`, `baseMs: 30_000`) and
  a `shardKey` routing hint. On retry exhaustion the job is dead-lettered, never
  silently dropped.
- The `SchedulerDO` binding (`SCHEDULER`) is **auto-inferred and reconciled**
  into `wrangler.jsonc` by `@lunora/config` once `@lunora/scheduler` is in use —
  run `lunora codegen` / `lunora doctor` to confirm. Scheduled jobs run with no
  end-user identity, so target **internal** functions (`internal.*`).

## Recurring jobs — crons

### Step 1: Add the starter

```bash
lunora registry add crons
```

This adds `@lunora/server` to `package.json` (run `pnpm install`) and copies
`lunora/crons.ts` (a `cronJobs()` registry with one illustrative job) and
`lunora/crons/jobs.ts` (the example `run` internal mutation it fires) into your
project — both **yours** to edit. No extra DO binding is required.

### Step 2: Declare jobs

```ts
import { cronJobs } from "@lunora/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep presence", { minutes: 5 }, internal.presence.sweep, { roomId: "lobby" });
crons.daily("digest", { hourUTC: 9, minuteUTC: 0 }, internal.email.digest, {});
crons.weekly("report", { dayOfWeek: "monday", hourUTC: 8, minuteUTC: 0 }, internal.reports.weekly, {});
crons.monthly("invoice", { day: 1, hourUTC: 0, minuteUTC: 0 }, internal.billing.invoice, {});
crons.cron("custom", "0 */6 * * *", internal.foo.bar, {}); // raw cron escape hatch

export default crons;
```

- `name` must be a non-empty **string literal**, unique across the project.
- `fnRef` must be a static two-segment access on the proxy
  (`internal.<file>.<fn>` or `api.<file>.<fn>`) so codegen can discover it.
  Cron targets must be **internal** functions — a client can never invoke them.
- All schedules are UTC and validated at definition time
  (`hourUTC: 25` throws immediately).

### Step 3: Regenerate types and the schedule

```bash
lunora codegen
```

Codegen discovers each registration by AST, compiles the schedule to a cron
expression, and emits `lunora/_generated/crons.ts` (the dispatcher the Worker's
`scheduled()` handler consumes) plus the matching `triggers.crons` entry in
`wrangler.jsonc`. You never hand-edit the wrangler schedule array.

## Bounded concurrency — workpool (optional)

For many enqueued jobs that must not all run at once, use a workpool — a named
logical pool inside the same `SchedulerDO` (no extra binding):

```ts
import { createWorkpool } from "@lunora/scheduler";

const pool = createWorkpool({
    namespace: env.SCHEDULER,
    originUrl: "https://my-app.example.com",
    name: "imports",
    maxConcurrency: 3,
});

await pool.enqueue(internal.imports.processRow, { rowId });
```

The DO caps simultaneous dispatch at `maxConcurrency` and queues the rest
durably. A Cloudflare-Queues-backed variant (`createQueueWorkpool`) leans on
queue config for concurrency/retries instead — reach for the DO workpool when you
need per-job cancel / status.

## Common Pitfalls

1. **Targeting a non-internal function from a job/cron.** Scheduled dispatch has
   no end-user identity — target `internal.*` functions.
2. **Non-static `fnRef` or `name` in `cronJobs()`.** Codegen discovers them by
   AST; a dynamic reference or computed name can't be found.
3. **Forgetting `lunora codegen` after editing crons.** The `triggers.crons`
   array and the dispatcher map are codegen output — re-run it.
4. **Non-idempotent job handlers.** A missed tick may be retried and a slow tick
   can overlap the next — make handlers idempotent.

## Checklist

- [ ] Deferred work uses `ctx.scheduler.runAfter` / `runAt` against
      `internal.*` functions.
- [ ] `SCHEDULER` (SchedulerDO) binding present in `wrangler.jsonc`
      (`lunora doctor` clean) when using the scheduler.
- [ ] Recurring jobs declared in `lunora/crons.ts` via `cronJobs()` (after
      `lunora registry add crons`).
- [ ] `lunora codegen` run so `_generated/crons.ts` + `triggers.crons` are
      synced.
- [ ] Job handlers are idempotent.
