# @cirrus/ratelimit

Rate limiting for Cirrus: token-bucket / fixed-window / sliding-window algorithms, a deny list, optional sharding for hot limits, and procedure middleware that rides the `.use()` chain.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.

## Usage

```ts
import { RateLimiter, rateLimit } from "@cirrus/ratelimit";

const limiter = new RateLimiter({
    config: {
        login: { kind: "fixed window", period: 60_000, rate: 5 },
        send: { kind: "token bucket", period: 1_000, rate: 10 },
    },
});

// As procedure middleware — throws a structural CirrusError (429/403) on rejection.
const guarded = mutation.use(rateLimit(limiter, "send", { key: (ctx) => ctx.auth.userId ?? undefined }));

// Or directly.
const status = await limiter.limit("send", { key: userId });
if (!status.ok) {
    // status.retryAfter is in milliseconds.
}
```

### Stores

The default store is in-memory: accounting lives for the lifetime of the
Durable Object instance, which is enough for most per-DO limits but resets if
the instance is evicted.

For durable accounting, `createSqlStore({ sql })` persists each `(name, key)`
pair as a row. It takes anything matching workerd's `SqlStorage` shape, so it is
meant for code with **direct** access to a DO's `state.storage.sql` (e.g. a
custom Durable Object) — note that the procedure `ctx` does not expose raw SQL,
so persisting a procedure-level limit means binding the limiter where `sql` is
available rather than reading it off `ctx`:

```ts
import { createSqlStore, RateLimiter } from "@cirrus/ratelimit";

class MyDurableObject {
    private readonly limiter: RateLimiter;

    constructor(state: DurableObjectState) {
        this.limiter = new RateLimiter({ config, store: createSqlStore({ sql: state.storage.sql }) });
    }
}
```

`createDbStore({ db })` persists through the Cirrus ORM, so a **procedure** can
keep durable limits without raw SQL — pass `ctx.db` from inside a mutation or
action. Declare a table for the rows and an index on the key column:

```ts
import { createDbStore, RateLimiter } from "@cirrus/ratelimit";

// schema.ts
export default defineSchema({
    rateLimits: defineTable({
        key: v.string(),
        ts: v.number(),
        value: v.number(),
        prev: v.optional(v.number()), // sliding-window only
    }).index("by_key", ["key"]),
});

// inside a mutation/action
const limiter = new RateLimiter({ config, store: createDbStore({ db: ctx.db }) });
```

The table, index, and key column are configurable (`table` / `index` /
`keyField`, defaulting to `rateLimits` / `by_key` / `key`). Each operation is a
read-then-write that runs under the DO input gate, so it is atomic against
concurrent calls in the same DO.

### Sharding hot limits

A global limit hammered by every request contends on a single key (and, with a
durable store, a single DO). Set `shards` to spread it across N sub-buckets,
each enforcing `rate / shards`; a request is routed to one shard at random:

```ts
const limiter = new RateLimiter({
    config: { api: { kind: "token bucket", period: 1_000, rate: 10_000, shards: 8 } },
});
```

Aggregate throughput approximates `rate`, and `getValue` / `reset` fan out across
every shard. The tradeoff is variance: an unlucky shard can reject while a
sibling still holds capacity, so reserve sharding for genuinely hot limits and
keep `shards` well below `rate` (it must be a positive integer).

## Operational notes

- **Concurrency / atomicity.** A limit decision is a read-modify-write. Inside a
  Durable Object this is safe without an explicit transaction: workerd's
  `SqlStorage.exec` is synchronous, so a single `limit()` completes within one
  event-loop turn, and the DO input/output gates serialize concurrent requests
  around any truly-async storage. Outside a DO — sharing one limiter across
  genuinely concurrent async callers with an async store — the read and write can
  interleave and over-admit; serialize those calls yourself.
- **Idle keys are not evicted.** Each `(name, key)` pair is one row, overwritten
  in place — so windows don't accumulate stale rows. But a key that goes
  permanently idle (e.g. a per-IP limit) leaves its row behind. If your key space
  is unbounded, periodically `reset()` or sweep cold rows; a row older than one
  `period` would re-initialize to full anyway.
- **`createSqlStore({ table })` is a trusted identifier.** It is interpolated into
  DDL/queries, so it must be a constant you control, never user input.

## Algorithms

- **token bucket** — tokens refill continuously at `rate / period` per ms up to
  `capacity` (default `rate`). Best for smoothing bursts.
- **fixed window** — `rate` tokens granted at each window aligned to
  `start + n * period`. Set `capacity > rate` to roll unused tokens forward.
- **sliding window** — `rate` requests per `period`, estimated by blending the
  current window's count with the previous window's, weighted by how far the
  previous one has scrolled out. Avoids the double-burst a fixed window permits
  at its boundary. `capacity` is ignored.

`reserve: true` permits a request to borrow against future capacity (the stored
value goes negative); `retryAfter` then reports when the debt clears.

`getValue(name, { key })` reports the units admittable **right now** — it
projects the stored state forward to the current clock (token-bucket refill,
fixed-window rollover, sliding-window decay) rather than echoing the last
persisted figure, and sums every shard for a sharded limit.
