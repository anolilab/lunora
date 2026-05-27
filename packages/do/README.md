# @cirrus/do

Durable Object base classes for the Cirrus framework. Provides `ShardDO`
(SQLite-backed shard with the WebSocket Hibernation API and a subscription
registry) and `SessionDO` (auth session pinning). Subclass these from a Worker
that uses `@cirrus/runtime`.

```ts
import { createShardCtxDb, runShardMigrations, ShardDO } from "@cirrus/do";
import schema from "../cirrus/schema.js";

export class MyShard extends ShardDO {
    private migrated = false;

    public override async handleRpc(functionPath, args) {
        if (!this.migrated) {
            runShardMigrations(this.sql, schema);
            this.migrated = true;
        }

        const ctx = {
            auth: { userId: this.getCurrentUserId(), getIdentity: async () => this.getCurrentIdentity() },
            db: createShardCtxDb({
                broadcast: (delta) => this.broadcastDelta(delta),
                schema,
                sql: this.sql,
            }),
        };

        // dispatch into your generated function registry...
    }
}
```

## Identity forwarding

`@cirrus/runtime` sets two request headers when a `resolveIdentity` callback is
configured: `x-cirrus-userid` (the raw user id) and, optionally,
`x-cirrus-identity` (a JSON envelope with any extra claims the resolver
returned). `ShardDO.fetch` reads both headers, parses the envelope, and exposes
them to subclasses as `getCurrentUserId()` / `getCurrentIdentity()`. Both
methods return `undefined` once the request finishes, so subclasses can't leak
identity into background work that outlives the request.

## WebSocket upgrade gating

`ShardDO.fetch` enforces a two-stage check on `Upgrade: websocket` requests:

- `CIRRUS_ALLOWED_ORIGINS` — comma-separated allowlist matched against the
  `Origin` header. When unset, all origins pass; set it in production.
- `CIRRUS_WS_BEARER` — required bearer token. The DO accepts the token via the
  `Authorization: Bearer <token>` header or, as a fallback for browsers that
  can't set headers on the upgrade, the `?token=<token>` query parameter. The
  query-parameter form is convenient but leaks the token into proxy logs and
  the URL bar — prefer the header form when the client can produce it.

Both comparisons use constant-time string equality.

## Database adapter

`createShardCtxDb` returns the Convex-style `DatabaseWriterLike` surface
(`db.insert`, `db.get`, `db.patch`, `db.replace`, `db.delete`, `db.query()`)
that generated functions reach for. It stores documents as a single JSON blob
per row (`__doc__ TEXT`) and uses `json_extract(__doc__, '$.field')` for
secondary indexes — `runShardMigrations` emits matching expression indexes
from the schema's `defineTable(...).index(...)` declarations. Tables flagged
with `.global()` are skipped: those live in D1 via `@cirrus/d1`.

## Testing

Unit tests stub the `DurableObjectState` shape and pattern-match the small SQL
surface emitted by the ctx-db adapter, so the package can be exercised without
a workerd runtime. The opt-in workerd suite under `__tests__/workerd/` runs
the same RPC paths inside `@cloudflare/vitest-pool-workers` for the cases
where SQLite semantics actually matter.
