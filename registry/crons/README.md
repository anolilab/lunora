# crons

Code-first scheduled jobs for Lunora — the `cronJobs()` builder (Convex `crons.ts` parity) plus an example internal function it fires. Declare recurring work in a `lunora/crons.ts` file and `@lunora/codegen` keeps `wrangler.jsonc`'s `triggers.crons` in sync; you never hand-edit the wrangler schedule array.

Built on `@lunora/scheduler` (re-exported from `@lunora/server`), so there's no extra package to install and no Durable-Object support to enable.

## Install

```bash
lunora registry add crons
```

This:

1. Adds `@lunora/server` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/crons.ts` (the `cronJobs()` registry, with one illustrative `interval` job) and `lunora/crons/jobs.ts` (the example `run` internal mutation that job fires) into your project — these are **yours** to edit.

Then regenerate types and the schedule:

```bash
lunora codegen
```

Codegen discovers the `crons.interval(...)` registration by AST, compiles its schedule to a standard cron expression, resolves the `internal.crons_jobs.run` reference to its `crons_jobs:run` dispatch ref, and emits both `lunora/_generated/crons.ts` (the dispatcher map the Worker's `scheduled()` handler consumes) and the matching `triggers.crons` entry in `wrangler.jsonc`.

## How it works

`lunora/crons.ts` builds a registry and default-exports it:

```ts
import { cronJobs } from "@lunora/server";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.interval("heartbeat", { hours: 1 }, internal.crons_jobs.run, {});

export default crons;
```

- **`cronJobs()`** returns a chainable builder. Each registration takes `(name, schedule, fnRef, args?)`.
- **`name`** must be a non-empty string literal and unique across the whole project — the runtime keys the dispatcher by name.
- **`fnRef`** must be a static two-segment property access on the generated proxy: `internal.<file>.<fn>` (or `api.<file>.<fn>`). The leading `internal`/`api` root is dropped and the file segment is sanitized, so `internal.crons_jobs.run` dispatches as `crons_jobs:run`. A dynamic reference can't be discovered by codegen.
- **`args`** is an optional static object literal, forwarded verbatim to the function on every fire.

### Why `internal`

Cron targets are **internal** functions (`internalMutation` / `internalAction` / `internalQuery`) — server-only, so a client can never invoke your scheduled job directly. The shipped `lunora/crons/jobs.ts` exposes `run` as an `internalMutation`. Make your job handlers idempotent: a missed tick may be retried and a slow tick can overlap the next one.

## Schedules

All schedule helpers are UTC. `interval` takes exactly one of `minutes` / `hours`. `{ seconds }` is rejected at definition time — Cloudflare Cron Triggers have a one-minute floor, so the 6-field expression it would compile to is refused by `wrangler deploy`; use `ctx.scheduler.runAfter`/`runAt` for sub-minute work, or `{ minutes: 1 }` for the fastest cron-native cadence.

```ts
crons.interval("sweep", { minutes: 30 }, internal.presence.sweep, { roomId: "lobby" });
crons.daily("digest", { hourUTC: 9, minuteUTC: 0 }, internal.email.digest, {});
crons.weekly("report", { dayOfWeek: "monday", hourUTC: 8, minuteUTC: 0 }, internal.reports.weekly, {});
crons.monthly("invoice", { day: 1, hourUTC: 0, minuteUTC: 0 }, internal.billing.invoice, {});
crons.cron("custom", "0 */6 * * *", internal.foo.bar, {}); // raw 5/6-field escape hatch
```

Schedules are validated at definition time, so an out-of-range value (e.g. `hourUTC: 25`) throws immediately rather than at codegen.

## Wire it to a real function

The example `run` is a placeholder. Point a job at one of your own internal functions instead — e.g. sweep an expired-rows table:

```ts
// lunora/crons.ts
crons.interval("sweep presence", { minutes: 5 }, internal.presence.sweep, { roomId: "lobby" });
```

Then delete `lunora/crons/jobs.ts` (and the sample `heartbeat` job) once nothing references it.

## What you own

Everything copied by this item — `lunora/crons.ts` and `lunora/crons/jobs.ts` — lives in your repo. Add, remove, or retune jobs, change the schedules, and swap in your own internal functions however you like. `@lunora/scheduler` (via `@lunora/server`) provides the builder and schedule compilation; this component is the idiomatic Lunora glue around them.
