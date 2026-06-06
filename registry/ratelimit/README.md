# ratelimit

Durable, ORM-backed rate limiting for Cirrus. Wraps [`@cirrus/ratelimit`](../../packages/ratelimit)'s `RateLimiter` over a `ctx.db`-backed store, so limits are persisted in your app's schema and survive Durable Object hibernation/eviction.

Supports token-bucket, fixed-window, and sliding-window algorithms (see `@cirrus/ratelimit`).

## Install

```bash
cirrus add ratelimit
```

This:

1. Adds `@cirrus/ratelimit` and `@cirrus/server` to your `package.json` (run `pnpm install` afterwards).
2. Copies `cirrus/ratelimit/schema.ts` (the limiter config + the `buckets` table + the plugin) and `cirrus/ratelimit/index.ts` (the `consume` / `check` / `reset` functions) into your project — these are **yours** to edit.
3. Splices a managed `.extend(ratelimit.extension)` into `cirrus/schema.ts`, merging the `buckets` table in as **`ratelimit_buckets`** (extension tables are auto-prefixed with the plugin key).

Then regenerate types:

```bash
cirrus codegen
```

## Wire it up

### Configure your limits

Edit `cirrus/ratelimit/schema.ts` — add named limits to the `limits` map:

```ts
export const limits = {
    default: { kind: "token bucket", period: 60_000, rate: 10 },
    login: { kind: "fixed window", period: 60_000, rate: 5 },
} as const satisfies RateLimitConfigMap;
```

### Expose the functions

Re-export from your `cirrus/` entry so codegen discovers them (they emit as `ratelimit/consume`, `ratelimit/check`, `ratelimit/reset`):

```ts
// cirrus/index.ts (or wherever you aggregate functions)
export { check, consume, reset } from "./ratelimit/index.js";
```

Call from a client:

```ts
const status = await client.mutation("ratelimit/consume", { name: "login", key: userId });
if (!status.ok) {
    throw new Error(`rate limited; retry in ${status.retryAfter}ms`);
}
```

### Or guard a procedure with the middleware

The plugin also ships middleware that injects `ctx.api.ratelimit` (a per-request limiter bound to `ctx.db`). Attach it to any procedure with `.use(...)`:

```ts
import { initCirrus } from "@cirrus/server";
import type { DataModel } from "./_generated/dataModel.js";
import { ratelimit } from "./ratelimit/index.js";

const c = initCirrus.dataModel<DataModel>().create();

export const sendMessage = c.mutation
    .use(ratelimit.middleware)
    .handler(async (ctx, args) => {
        const status = await ctx.api.ratelimit.limit("default", { key: ctx.userId });
        if (!status.ok) {
            throw new Error("slow down");
        }
        // ...
    });
```

## What you own

Everything under `cirrus/ratelimit/` is copied into your repo — change the limit configs, the table columns, the algorithm, or the functions however you like. `@cirrus/ratelimit` provides the algorithm + store helpers; this component is the idiomatic Cirrus glue around them.
