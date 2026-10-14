# ratelimit

Durable, ORM-backed rate limiting for Lunora. Wraps [`@lunora/ratelimit`](../../packages/ratelimit)'s `RateLimiter` over a `ctx.db`-backed store, so limits are persisted in your app's schema and survive Durable Object hibernation/eviction.

Supports token-bucket, fixed-window, and sliding-window algorithms (see `@lunora/ratelimit`).

## Install

```bash
lunora registry add ratelimit
```

This:

1. Adds `@lunora/ratelimit` and `@lunora/server` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/ratelimit/schema.ts` (the limiter config + the `buckets` table + the plugin) and `lunora/ratelimit/index.ts` (the server-only `consume` / `check` / `reset` functions) into your project — these are **yours** to edit.
3. Splices a managed `.extend(ratelimit.extension)` into `lunora/schema.ts`, merging the `buckets` table in as **`ratelimit_buckets`** (extension tables are auto-prefixed with the plugin key).

Then regenerate types:

```bash
lunora codegen
```

## Wire it up

### Configure your limits

Edit `lunora/ratelimit/schema.ts` — add named limits to the `limits` map:

```ts
export const limits = {
    send: { kind: "token bucket", period: 60_000, rate: 10 },
    login: { kind: "fixed window", period: 60_000, rate: 5 },
} as const satisfies RateLimitConfigMap;
```

### Expose the functions

Re-export from your `lunora/` entry so codegen discovers them. They are `internal*` procedures, so they emit into the **`internal`** namespace as `internal.ratelimit.consume` / `.check` / `.reset` — reachable from your own server handlers, never from a client:

```ts
// lunora/index.ts (or wherever you aggregate functions)
export { check, consume, reset } from "./ratelimit/index.js";
```

Call from a server handler that has already decided which key the caller may touch:

```ts
const status = await ctx.runMutation(internal.ratelimit.consume, { name: "login", key: ctx.auth.userId ?? ctx.ip ?? "anon" });
if (!status.ok) {
    throw new Error(`rate limited; retry in ${status.retryAfter}ms`);
}
```

#### Why these are server-only

Every one of these takes the bucket `key` from its caller. As public RPC, `reset` lets anyone clear any bucket — which nullifies every limit the app enforces — and `consume` lets anyone burn a known victim's bucket (their user id, their IP) to lock them out; `check` is a free oracle over the same key space. A guard on the management endpoints does not help, because such a guard is keyed by the _caller_ while the damage lands on _another_ key. Limit real traffic with the middleware below instead, where the key is derived server-side.

### Or guard a procedure with the middleware

The plugin also ships middleware that injects `ctx.api.ratelimit` (a per-request limiter bound to `ctx.db`). Attach it to any procedure with `.use(...)`:

```ts
import { initLunora } from "@lunora/server";
import type { DataModel } from "./_generated/dataModel.js";
import { ratelimit } from "./ratelimit/index.js";

const c = initLunora.dataModel<DataModel>().create();

export const sendMessage = c.mutation.use(ratelimit.middleware).mutation(async ({ ctx }) => {
    const status = await ctx.api.ratelimit.limit("send", { key: ctx.auth.userId ?? ctx.ip ?? "anon" });

    if (!status.ok) {
        throw new Error("slow down");
    }
    // ...
});
```

## What you own

Everything under `lunora/ratelimit/` is copied into your repo — change the limit configs, the table columns, the algorithm, or the functions however you like. `@lunora/ratelimit` provides the algorithm + store helpers; this component is the idiomatic Lunora glue around them.
