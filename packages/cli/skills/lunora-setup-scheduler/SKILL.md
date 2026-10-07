---
name: lunora-setup-scheduler
description: Schedules deferred and recurring work in a Lunora app. Covers `ctx.scheduler.runAfter` / `runAt` (delayed dispatch of a function or workflow), cron jobs in `lunora/crons.ts` via `lunora registry add crons` and the `cronJobs()` builder, the `SchedulerDO` / `SCHEDULER` binding and `LUNORA_ORIGIN_URL`, retries and dead-lettering, and `createWorkpool` for bounded concurrency. Use when the user wants to "run this later", "send a reminder in 3 days", "run every night / every 5 minutes", add a cron, cancel a scheduled job, or sees `ORIGIN_NOT_CONFIGURED` or a missing `SchedulerDO` export.
---

# Lunora Setup Scheduler

Lunora schedules work in two ways, both implemented in `@lunora/scheduler`:

- **Deferred dispatch**: `ctx.scheduler.runAfter` / `runAt` run a function (or
  start a workflow) later. Jobs are stored in the `SchedulerDO` Durable Object
  (binding `SCHEDULER`), which owns the alarm, the retries and the dead-letter list.
- **Recurring jobs (crons)**: declared in `lunora/crons.ts` with `cronJobs()`.
  Codegen compiles them into Cloudflare Cron Triggers, and the Worker's
  `scheduled()` handler dispatches them directly. They don't go through the
  `SchedulerDO`.

## When Not to Use

- The project has no Lunora backend yet: use `lunora-quickstart` first.
- You only need to react to data changes: use a reactive `query` /
  subscription (`lunora-realtime`).
- Multi-step orchestration with sleeps and waits belongs in a durable workflow.
  A scheduler or cron can start one, but don't build step logic on top of jobs.

## Deferred dispatch: `runAfter` / `runAt`

### Wire it once

```bash
pnpm add @lunora/scheduler
lunora codegen
```

Codegen needs `@lunora/scheduler` installed as soon as `ctx.scheduler` is used,
because the generated `_generated/app.ts` imports `createScheduler`. Once the
dependency is present, codegen emits `_generated/scheduler.ts` (re-exporting
`SchedulerDO`) and a `.scheduler()` method on the app builder.

- **Vite-first apps** (generated worker entry): the plugin forwards
  `SchedulerDO` and calls `.scheduler()` for you.
- **Hand-written worker entry** (`src/server.ts` with `defineApp`): wire it yourself.
  `wrangler.jsonc`'s `SCHEDULER` binding is reconciled from this export:

```ts
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .scheduler({ namespace: (env) => env.SCHEDULER })
    .build();

export const ShardDO = app.ShardDO;
export { SchedulerDO } from "../lunora/_generated/scheduler.js";
```

The `SchedulerDO` calls back into the Worker at `LUNORA_ORIGIN_URL`. It reads
that value from its own env and never from the request, so a caller can't point
dispatch at an arbitrary URL. Without it, every `runAfter`/`runAt` fails with
`ORIGIN_NOT_CONFIGURED`, and nothing provisions it for you:

- dev: `LUNORA_ORIGIN_URL="http://localhost:5173"` in `.dev.vars` (your dev
  server's URL)
- prod: `vars.LUNORA_ORIGIN_URL` in `wrangler.jsonc`, or
  `wrangler secret put LUNORA_ORIGIN_URL` (per `--env`)

`lunora doctor` warns when the scheduler binding exists and the variable is unset.

### Schedule from a mutation or action

```ts
import { mutation, v } from "#lunora/_generated/server.js";

import { internal } from "#lunora/_generated/internal.js";

export const startTrial = mutation.input({ userId: v.string() }).mutation(async ({ ctx, args: { userId } }) => {
    // run an internal action 14 days from now; the id is a plain string
    const jobId = await ctx.scheduler.runAfter(14 * 24 * 60 * 60 * 1000, internal.billing.endTrial, { userId });

    return { jobId };
});
```

- The full `ctx.scheduler` surface is `runAfter(delayMs, target, args?)`,
  `runAt(timestampMs, target, args?)` (epoch ms), `cancel(id)`, `get(id)`, and `list()`.
  It is not available in a `query`, because queries are deterministic and re-run.
- `target` is a generated `internal.*` / `api.*` mutation or action reference, a
  `"file:fn"` string, or a `workflows.<name>` / `agents.<name>` reference.
  A workflow or agent reference starts a fresh instance when the job fires, with
  `args` as its params. Scheduled jobs run with no end-user identity, so target
  `internal.*` functions.
- **Inside a mutation, scheduling is transactional.** The call is buffered and
  dispatched only after the mutation commits. If the mutation rolls back (OCC
  conflict, validation error), the job is dropped too. The returned id is final
  immediately, so you can store it on the row you're writing and `cancel` it later.
- Retries use the DO defaults: 5 retries, exponential backoff from 30 s. A job
  that exhausts them is dead-lettered (visible in the studio), not dropped. To set
  a per-job `retry` policy (`{ maxAttempts, backoff: "exponential" | "linear",
baseMs, maxMs }`) or a `shardKey`, build your own client with
  `createScheduler({ namespace })` from `@lunora/scheduler`. Its `runAfter`/`runAt`
  take a fourth `RunOptions` argument and add `dead()` / `deadRetry(id)`.

## Recurring jobs: crons

### Step 1: Add the starter

```bash
lunora registry add crons
pnpm install
```

This adds `@lunora/server` + `@lunora/scheduler` to `package.json` and copies two
files you own: `lunora/crons.ts` (a `cronJobs()` registry) and
`lunora/crons/jobs.ts` (an example `internalMutation`, `internal.crons.jobs.run`).

### Step 2: Declare jobs

```ts
import { cronJobs } from "@lunora/server";

import { internal } from "#lunora/_generated/internal.js";

const crons = cronJobs();

crons.interval("sweep presence", { minutes: 5 }, internal.presence.sweep, { roomId: "lobby" });
crons.hourly("rollup", { minuteUTC: 17 }, internal.stats.rollup);
crons.daily("digest", { hourUTC: 9, minuteUTC: 0 }, internal.email.digest);
crons.weekly("report", { dayOfWeek: "monday", hourUTC: 8, minuteUTC: 0 }, internal.reports.weekly);
crons.monthly("invoice", { day: 1, hourUTC: 0, minuteUTC: 0 }, internal.billing.invoice);
crons.cron("custom", "0 */6 * * *", internal.foo.bar); // raw cron escape hatch

export default crons;
```

- Names must be non-empty string literals, unique across the project.
- Targets must be static property accesses (`internal.<…path>.<fn>`, one segment
  per folder and file, e.g. `internal.crons.jobs.run`) or a `workflows.<name>` /
  `agents.<name>` reference. Codegen resolves them from the AST, so a computed
  reference fails codegen. `args` is optional and must be a literal.
- Schedules are UTC and validated when the job is defined. `interval` takes exactly one of
  `{ minutes }` (must divide 60) or `{ hours }` (must divide 24). `{ seconds }`
  is rejected because Cron Triggers have a one-minute floor. For sub-minute work,
  use `runAfter`.
- Use `hourly` with an offset minute to spread jobs away from `:00`.

### Step 3: Regenerate

```bash
lunora codegen
```

Codegen emits `lunora/_generated/crons.ts` (`LUNORA_CRON_TRIGGERS` plus the
`LUNORA_CRONS` dispatcher map, which `defineApp` wires into `scheduled()`) and
syncs `triggers.crons` in `wrangler.jsonc`. Don't hand-edit that array.

**Verify:** the studio's scheduled-jobs view lists each cron and has a "Run now"
action, which calls the same dispatch path as a real tick.

## Bounded concurrency: workpool (optional)

A workpool is a named pool inside the same `SchedulerDO`. It needs no extra
binding. Build it in Worker code that has the raw `env`:

```ts
import { createWorkpool } from "@lunora/scheduler";

const pool = createWorkpool({ namespace: env.SCHEDULER, name: "imports", maxConcurrency: 3 });

await pool.enqueue(internal.imports.processRow, { rowId }, { retry: { maxAttempts: 3 } });
// pool.cancel(id), pool.status() → { inFlight, queued, maxConcurrency }
```

The DO dispatches at most `maxConcurrency` jobs at once and queues the rest
durably. One alarm drain keeps at most six dispatches in flight (the DO connection limit),
so a long-running job holds a slot for its whole duration. For individually long jobs
(LLM calls, exports), prefer `createQueueWorkpool`, which is backed by Cloudflare Queues.
You give up the hard cap, per-job cancel and per-job status in exchange.

## Common Pitfalls

1. **`ORIGIN_NOT_CONFIGURED`**: `LUNORA_ORIGIN_URL` is unset for the `SchedulerDO`
   (see above).
2. **`SchedulerDO` not exported** from a hand-written worker entry: wrangler
   only binds classes the entry exports, so `SCHEDULER` is never provisioned.
3. **Dynamic `name` or target in `cronJobs()`**: codegen cannot discover it.
4. **Editing crons without re-running `lunora codegen`**: `triggers.crons` and the
   dispatcher map are generated output and go stale.
5. **Non-idempotent handlers**: a failed job is retried, and a slow cron tick
   can overlap the next one.
