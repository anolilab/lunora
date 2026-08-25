# @lunora/platform-rivet

A [Rivet](https://rivet.dev/actors) implementation of the `@lunora/platform` host contracts — `ShardHost`, `SocketHost`, `ShardDirectory`, `ShardKvStore`, `SchedulerHost` — over Rivet Actors and the `rivetkit` runtime.

> **Experimental.** The contracts are implemented and pass `@lunora/platform`'s conformance TCK, but against an in-memory Rivet actor double rather than a live engine. There is no `lunora dev --target rivet`, no deploy driver, and no `.global()` table backend. See [`plans/rivet-host-findings.md`](../../plans/rivet-host-findings.md).

## Why Rivet

A Rivet Actor is the closest primitive to a Durable Object outside Cloudflare: one addressable, single-writer instance per key, with its own SQLite database, its own durable schedules, and a sleep/wake lifecycle. Most of what this host needs comes from the platform rather than being rebuilt — the rows below read `native` where `@lunora/platform-node`'s read `emulated`:

| Contract                          | Rivet primitive                           | Rating     |
| --------------------------------- | ----------------------------------------- | ---------- |
| Sharded state                     | one actor per shard key                   | native     |
| Shard alarms                      | `c.schedule.at` (wakes a sleeping actor)  | native     |
| Hibernated WebSockets             | `options.canHibernateWebSocket`           | native     |
| Scheduler, incl. **runtime cron** | `c.schedule` + `c.cron.set`               | native     |
| Placement at create time          | `getOrCreate(key, { createInRegion })`    | emulated\* |
| Local SQL                         | `c.db`, behind a synchronous working copy | emulated   |

\* Native in Rivet; `emulated` here because Rivet region slugs are deployment-defined and have to be mapped from Lunora's region vocabulary by the caller.

## The one structural mismatch

`ShardSqlExec.exec` is **synchronous** — the engine walks cursors without awaiting — while every Rivet SQLite entry point is a promise, because the actor reaches its database through the runtime. The contract anticipates this ("async-backed with a sync facade"), and this package is that facade:

1. A `better-sqlite3` **working copy** in the actor's memory answers every read and write synchronously.
2. On wake it is **hydrated** from the last snapshot in Rivet's SQLite.
3. At every commit boundary the whole database is **serialized back** into Rivet's SQLite.

A snapshot rather than a statement journal, because replaying `random()` or `datetime('now')` reconstructs a different database. The cost is the honest one: a commit is O(database size), and the shard must fit in the actor's memory — a small-shard strategy that `.shardBy()` keeps in range.

Rivet caps an actor at **10 GiB of storage shared between SQLite and KV**, and stores its SQLite through that KV layer. Base64 makes a working copy of size N occupy ~1.33 N durably, so the hard ceiling is ~7.5 GiB of shard data — and resident memory binds long before that. See [`plans/rivet-host-findings.md`](../../plans/rivet-host-findings.md) §7.

## Wiring

Rivet delivers schedules by invoking an **action on the actor**, so three one-line handlers have to exist. The action names are exported constants.

```ts
import { actor, setup } from "rivetkit";
import { db } from "rivetkit/db";
import { RIVET_ALARM_ACTION, RIVET_CRON_ACTION, RIVET_SCHEDULER_ACTION, createRivetPlatform } from "@lunora/platform-rivet";

export const shard = actor({
    db: db({ onMigrate: async () => {} }),
    options: { canHibernateWebSocket: true },
    // Once per wake: every handler on this generation shares one working copy.
    createVars: async (c) => ({ platform: await createRivetPlatform(c, { onAlarm, onDispatch }) }),
    onWebSocket: (c, ws) => {
        c.vars.platform.sockets.accept(ws);
    },
    onSleep: async (c) => c.vars.platform.close(),
    actions: {
        [RIVET_ALARM_ACTION]: async (c) => c.vars.platform.deliverAlarm(),
        [RIVET_SCHEDULER_ACTION]: async (c, id: string) => c.vars.platform.deliverScheduledJob(id),
        [RIVET_CRON_ACTION]: async (c, path: string, args: string) => c.vars.platform.deliverCronTick(path, JSON.parse(args)),
    },
});

export const registry = setup({ use: { shard } });
```

The shard directory lives outside the actor, on a RivetKit client:

```ts
import { createClient } from "rivetkit/client";
import { createRivetShardDirectory } from "@lunora/platform-rivet";

const client = createClient<typeof registry>("http://localhost:6420");
const directory = createRivetShardDirectory(client.shard, {
    // Rivet region slugs are deployment-defined; without this the hint is dropped.
    resolveRegion: (hint) => ({ apac: "sin", enam: "atl", weur: "fra" })[hint],
});
```

`c.db` is **required** — an actor declared without `db: db({ … })` type-checks and then loses every write on sleep.

## Not implemented

`.global()` tables, queues, workflows, object storage, and every Cloudflare product binding (Vectorize, Workers AI, Containers, Browser Rendering, Analytics, Pipelines, Hyperdrive, secrets). Cross-shard fan-out is **unsupported** rather than emulated: the query coordinator needs to enumerate shard keys, and the RivetKit client only addresses them — a fan-out query would answer from no shards instead of all of them, which is a wrong answer rather than a slow one. Rivet's own durable workflow SDK (`rivetkit/workflow`) and container runner are the obvious next targets.

Every rating is declared in `RIVET_CAPABILITIES` (`@lunora/platform`), which is what codegen's fail-closed gate reads.

## Testing

```bash
pnpm --filter "@lunora/platform-rivet" run test
```

`@lunora/platform-rivet/conformance` exports the actor and namespace doubles the suite runs against, so the same TCK that pins Cloudflare and Node pins this host too.
