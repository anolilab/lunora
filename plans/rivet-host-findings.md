# Rivet host — findings

What building `@lunora/platform-rivet` (the third `@lunora/platform` host, after
Cloudflare and Node) taught us about Rivet, about the contracts, and about what
is still open.

Companion to [`plans/234-node-host-findings.md`](./234-node-host-findings.md)
and [`plans/multi-platform-portability-assessment.md`](./multi-platform-portability-assessment.md),
whose verdict on Rivet was "credible alternative runtime, not a drop-in target
— porting would mean rewriting `@lunora/do`, `@lunora/runtime`, and parts of
`@lunora/server`". That verdict predates plan 114's split. With the contracts,
the engine and the hosts separated, none of those three packages was touched:
the port is one new package implementing five interfaces.

---

## 1. Rivet is the best contract fit outside Cloudflare so far

A Rivet Actor is one addressable, single-writer instance per key, with its own
SQLite database, its own durable schedules, and a **sleep/wake** lifecycle. Four
contracts map onto platform primitives rather than onto emulation:

| Contract member              | Rivet primitive                                    |
| ---------------------------- | -------------------------------------------------- |
| `ShardHost.runSerialized`    | actors already serialize their own work            |
| `ShardHost.alarms`           | `c.schedule.at` — wakes a sleeping actor           |
| `ShardHost.waitUntil`        | `c.waitUntil` (bounded by the sleep grace period)  |
| `SocketHost` hibernation     | `options.canHibernateWebSocket`                    |
| `SchedulerHost` + **`cron`** | `c.schedule.after`/`at`, `c.cron.set`/`every`      |
| `ShardDirectory.getByName`   | `client.<actor>.getOrCreate(key)` + `handle.fetch` |

Two of these are firsts.

**`SocketHost` hibernation is real here.** The Node host can persist a socket's
attachment but cannot keep the connection alive across a restart — a TCP socket
cannot outlive its process. Rivet sleeps the actor with its sockets open and
wakes it on the next frame. That makes Rivet the first non-Cloudflare host where
`websocketHibernation` is rated `native`.

**`SchedulerHost.cron` is implemented.** The member is optional precisely
because Cloudflare cannot offer it — `triggers.crons` lives in `wrangler.jsonc`
and is reconciled at build time. Rivet registers crons at runtime. The Node host
implements it over a table it maintains itself; this is the first host to get it
from the platform.

## 2. The one structural mismatch: synchronous SQL

`ShardSqlExec.exec` is synchronous — `one()`, `toArray()` and iteration all
return without awaiting, because the engine's read paths are built on that.
Every Rivet SQLite entry point (`c.db.execute`, `c.db.transaction`) is a
promise, because the actor reaches its database through the runtime rather than
through an in-process handle. There is no synchronous escape hatch, on either
the native (napi) or the wasm runtime.

The contract already names the way out — "implementations may be sync
(Cloudflare `SqlStorage`) or **async-backed with a sync facade**" — and
`src/rivet-shard-state.ts` is that facade: a `better-sqlite3` working copy in
the actor's memory answers every `exec`, hydrated on wake from a snapshot and
serialized back into Rivet's SQLite at each commit boundary.

**Why a snapshot and not a statement journal.** A journal is cheaper per write
and wrong in a way that is hard to see: replaying `random()`, `datetime('now')`
or anything reading `last_insert_rowid()` after a differently-ordered replay
reconstructs a _different_ database. A snapshot cannot diverge from the state it
was taken of.

**What it costs.** A commit is O(database size), and the shard has to fit in the
actor's memory. That is a small-shard strategy — which is what `.shardBy()` is
for — and it is why `localSql` is rated `emulated`. An unsharded shard
accumulating a large table is exactly the case it is bad at.

**Open question for the contracts.** This is the second host to hit the
sync/async boundary (the Node host dodged it only because `better-sqlite3`
happens to be synchronous). A third host on any networked store will hit it
again. Worth deciding, before there is a fourth: does `ShardHost` grow an
async-first read path the engine can use, or is "bring your own sync working
copy" the permanent answer? The facade works; it should be a choice rather than
a default.

## 3. Two storage mechanisms, on purpose

The package writes to Rivet's SQLite two different ways, and the split is by
contract shape rather than by convenience:

- **Synchronous contracts** — `ShardSqlExec` and `SocketHandle.serializeAttachment`
  — go through the working copy and are durable at the next flush. Anything else
  would mean fire-and-forgetting a durable write, which is how an attachment
  goes missing exactly when it matters: after an unplanned sleep.
- **Asynchronous contracts** — `ShardKvStore` and the scheduler's job table —
  write straight through to `c.db` and are durable per write. Routing them
  through the working copy would re-serialize the whole shard database on every
  `put`, buying nothing.

## 4. Things Rivet has that this host does not use

- **`c.kv`.** An almost literal match for `ShardKvStore` — actor-scoped,
  durable, prefix and range scans. It is also deprecated ("a low-level escape
  hatch kept for backward compatibility") on every member, so the host uses a
  table in the actor's SQLite instead and rates `keyValueStore` `emulated`
  rather than `native`. Revisit if Rivet un-deprecates it.
- **`rivetkit/workflow`.** A durable TypeScript workflow SDK, and the obvious
  backing for `defineWorkflow` — the same move `@lunora/platform-node` made onto
  `@visulima/workflow`. Rated `unsupported` today because nothing compiles onto
  it yet.
- **The container runner.** A credible `defineContainer` target, same status.
- **`c.state`, `c.broadcast`, `c.conns`, `c.queue`.** Deliberately unused: the
  Lunora engine owns state, fan-out and subscription bookkeeping, and an adapter
  that also reached for Rivet's would give one shard two sources of truth.

## 5. `crossShardFanout`: unsupported because unwired, not because impossible

**This section originally said Rivet has no way to enumerate shard keys. That
was wrong, and the correction is the more useful finding.**

`@lunora/runtime`'s query coordinator needs to **enumerate** the shard keys
holding a table. The _actor-handle_ client only addresses them — `getOrCreate`,
`getForId`, `resolve` — which is where the mistaken conclusion came from. But
the **engine** client has `listActorsByName` (`GET /actors?name=<actor>`,
`src/engine-client/api-endpoints.ts`), and it returns exactly what a
`listShardKeys` needs:

```ts
interface ActorOutput {
    actorId: string;
    name: string;
    key: ActorKey;
    createTs?: number;
    destroyTs?: number | null; /* … */
}
```

So the rating stays `unsupported` for the ordinary reason — nothing in this
package wires it — rather than for the interesting one. Whoever wires it has to
handle two things the endpoint does not:

- **No pagination.** `ActorsListResponse` is `{ actors: Actor[] }`: no cursor,
  no limit, no filter parameters. For a tenant-sharded app that is one array of
  every actor ever created under that name, which does not survive scale. See
  §10 — this is the upstream ask.
- **No liveness filter.** Destroyed actors come back with a `destroyTs`, so the
  caller skips them client-side.

The lesson generalises: "the client can't do X" is worth checking against the
engine API before it goes in a capability note. A capability matrix that is
wrong in the pessimistic direction is still wrong.

## 6. Testing: what is proven and what is not

The package passes `@lunora/platform`'s conformance TCK in full — all 32 legs,
no skips — plus targeted unit tests for the Rivet-specific behaviour (snapshot
durability across a wake, alarm re-attachment, cron registration, the retry
ladder, `LIKE`-metacharacter escaping).

**Against an in-memory actor double, not a live engine.** What that proves is
that the adapters satisfy the contracts given a context that behaves the way
Rivet documents. What it does not prove is that Rivet behaves that way. Open:

- schedule delivery semantics across a real sleep and a real upgrade;
- the serde shape of a bound parameter on the napi vs wasm runtimes (the
  snapshot is base64 TEXT specifically to avoid depending on this — worth
  re-measuring, since a BLOB would remove the 4:3 inflation);
- hibernation wake ordering, and whether a frame can arrive before the working
  copy is hydrated;
- whether `c.db` handles captured in `createVars` stay valid for the life of an
  actor generation (the `c.vars.drizzle` pattern in Rivet's own docs implies
  yes).

**One more caveat, on the type projections.** `src/rivet-context.ts` is a
hand-written narrowing of `rivetkit@2.3.10`'s types, checked by
`__tests__/rivet-context-projection.test.ts` against _copies_ of the upstream
declarations rather than against `rivetkit` itself — depending on it for types
alone would pull the napi and wasm binaries, `drizzle-orm`, `hono` and `pino`
into every install of this repo. The copy catches a projection that was always
wrong; it catches drift only when somebody refreshes it against a newer release.

## 7. The published limits, and how they bound this design

From [Limits](https://rivet.dev/actors/docs/limits.md). These were read after
the host was built and sharpen the "small shard" caveat from a hand-wave into a
number.

| Limit                                         | Value                                | Why it matters here                                  |
| --------------------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| Storage per actor (SQLite **and** KV, shared) | 10 GiB hard                          | The absolute shard ceiling                           |
| HTTP request / response body                  | 20 MiB hard                          | Bounds one shard RPC — the `ShardStub.fetch` payload |
| `onRequest` timeout                           | 60 s (from `actionTimeout`)          | Bounds one shard round trip                          |
| WebSocket outgoing message                    | 1 MiB soft / 32 MiB hard             | Bounds a poke, delta or whisper frame                |
| Buffered while hibernating                    | 128 MiB / 65,535 msgs per connection | What a sleeping actor can absorb before a wake       |
| Wake timeout                                  | 90 s                                 | Past this the hibernated client is disconnected      |
| Queue message                                 | 64 KiB soft / 128 KiB                | Only relevant if `c.queue` is ever adopted           |

Two of these bite the snapshot strategy specifically:

- **10 GiB is shared between SQLite and KV**, and the snapshot is base64, so a
  working copy of size N occupies ~1.33 N durably. The ceiling is therefore
  ~7.5 GiB of shard data — and memory, not storage, binds long before that,
  since the working copy is resident.
- **Rivet's SQLite is itself stored through the KV layer.** A whole-database
  snapshot per commit is not merely O(N) bytes written; it is O(N) bytes written
  _through KV_. This is the strongest argument yet for revisiting the facade
  (§2) rather than treating it as settled — a dirty-page-level or incremental
  snapshot would cut the constant enormously, and a BLOB column instead of
  base64 would cut a further third.

## 8. Lifecycle budgets the wiring has to live inside

Verified against `rivetkit@2.3.10` source and the Lifecycle docs after the host
was written. The documented hook order is
`onMigrate → createState → onCreate → createVars → onWake`, which confirms the
wiring recommendation: `c.db` **is** available in `createVars`, and migrations
have already run by then. Two budgets, though, are tighter than the host's work:

- **`createVarsTimeout` defaults to 5000 ms**, and `createRivetPlatform` runs
  inside `createVars`: it reads the whole base64 snapshot, deserializes it into
  a `better-sqlite3` database, creates two tables and re-arms the alarm. On a
  large shard that is a real risk of timing out at wake. Apps should raise
  `createVarsTimeout` in proportion to shard size — and this is a second reason
  the whole-database snapshot deserves replacing (§7).
- **`sleepGracePeriod` defaults to 15 s and is a single shared budget** covering
  `onSleep`, every `waitUntil` promise, `keepAwake`, and async raw-WebSocket
  handlers. `platform.close()` runs a final full snapshot flush inside it,
  competing with the app's own background work.

And one durability caveat that follows from the same docs: **`onSleep` is
best-effort and does not run if the actor crashes.** The host's real durability
boundary is therefore the flush at each `runSerialized` / `transaction` — which
is every write the engine makes — and _not_ `close()`. A bare `sql.exec` issued
outside both boundaries by non-engine code is durable only at the next boundary,
and is lost on a crash before one arrives. That is the intended design, but it
should be read as "the boundaries are the guarantee", not "close() will catch
it".

Two smaller confirmations worth recording, since both were assumptions when the
code was written:

- `handle.fetch(request)` really does forward a whole `Request` — `rawHttpFetch`
  merges method, body, headers, signal and the rest. It keeps only
  `pathname + search` from the URL, discarding the origin, which is fine for a
  shard RPC but means the stub cannot address by host.
- Action names have no reserved-prefix validation, so `__lunoraShardAlarm` and
  friends are safe. Dots are not: action names are flattened with
  dot-separated paths for nested groups.

One wiring hazard with no compile-time signal: Rivet **deletes a recurring job
whose action no longer exists**. An app that registers a cron through
`SchedulerHost.cron` but forgets the `RIVET_CRON_ACTION` handler loses the cron
silently.

## 9. Not built

No `lunora dev --target rivet`, no `@lunora/config` deploy driver, no
`.global()` table backend, no queue/object-storage/AI bindings. This is the host
layer only. The Node host needed a deploy driver before `--target node` would
resolve at all; Rivet will need the same, plus a decision about where a Lunora
app's Worker-equivalent entry point lives when the runtime is `registry.start()`
rather than a Cloudflare Worker.

## 10. Upstream asks for Rivet

Ordered by how much they would change this host. Numbers 1 and 2 are the ones
that would let ratings move from `emulated`/`unsupported` to `native`.

1. **A synchronous read path for actor SQLite.** The single structural blocker
   (§2). Any of these would remove the working copy entirely: a sync `exec` on
   the napi runtime, an exposed SQLite handle/file path the host can open
   directly, or a documented "the database is a real file at P" contract. This
   is the difference between `localSql: emulated` with an O(N)-per-commit
   snapshot and `localSql: native`.
2. **Pagination on `GET /actors?name=`.** A cursor + limit, and ideally a
   `destroyed=false` filter (§5). Without it, actor enumeration is unusable
   past a few thousand actors, which is exactly the scale a sharded app reaches
   first.
3. **A durable-blob-friendly binding round-trip for SQLite parameters.** The
   snapshot is base64 TEXT purely because it was unclear whether a bound
   `Uint8Array` round-trips identically on both the napi and wasm runtimes. A
   documented guarantee (or a `BLOB` example) would cut 33% off every snapshot
   write.
4. **A replacement for the deprecated `c.kv`,** or a statement that it is
   staying. It is the natural fit for a durable per-actor record store (§4);
   right now the deprecation pushes hosts onto SQLite for data that is not
   relational.
5. **Retry policy on scheduled actions.** Rivet explicitly does not retry a
   failed run, so every consumer that needs at-least-once rebuilds the same
   backoff-and-dead-letter ladder (this host included). A built-in retry
   policy on `schedule.after`/`at` would delete that code.
6. **Streaming responses / SSE from `onRequest`** — already tracked upstream as
   [rivet-dev/rivet#3529](https://github.com/rivet-dev/rivet/issues/3529). It
   bounds anything Lunora wants to stream over the shard RPC edge.
7. **A region-slug discovery API.** Region names are deployment-defined, which
   is why `shardPlacement` needs a caller-supplied `resolveRegion` and is rated
   `emulated`. An endpoint listing the deployment's regions would let a host map
   placement hints itself.
8. **Delivery to a handler rather than a named action.** Schedules invoke an
   action by name, so a library integrating with Rivet must ask apps to paste
   handler wiring into their actor definition (three handlers, here) and a typo
   is a silent no-op — worse, Rivet _deletes_ a recurring job whose action does
   not exist. A registerable callback, or a documented namespace libraries can
   own, would remove a whole class of silent misconfiguration.

Numbers 1, 2 and 8 are the ones worth filing first; the rest are either already
tracked or are trade-offs Rivet may have made deliberately.
