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

## 5. `crossShardFanout` is unsupported, and that is a finding

`@lunora/runtime`'s query coordinator needs to **enumerate** the shard keys
holding a table. The RivetKit client only **addresses** them — `getOrCreate`,
`getForId`, `resolve`. There is no key enumeration on the client surface.

The Node host rates this `emulated` because it can seed a key list from the
shard files on disk. Rivet has no equivalent, so a fan-out query here would
answer from no shards instead of all of them — a wrong answer, not a slow one.
It is therefore `unsupported`, which makes codegen's fail-closed gate refuse it
rather than ship a silent hole. Closing it needs either an engine-API listing
call or a Lunora-side shard registry actor.

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

## 7. Not built

No `lunora dev --target rivet`, no `@lunora/config` deploy driver, no
`.global()` table backend, no queue/object-storage/AI bindings. This is the host
layer only. The Node host needed a deploy driver before `--target node` would
resolve at all; Rivet will need the same, plus a decision about where a Lunora
app's Worker-equivalent entry point lives when the runtime is `registry.start()`
rather than a Cloudflare Worker.
