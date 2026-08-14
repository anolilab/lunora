/**
 * `@lunora/platform-rivet` — a Rivet implementation of the `@lunora/platform`
 * host contracts (`ShardHost`, `SocketHost`, `ShardDirectory`, `ShardKvStore`,
 * `SchedulerHost`) over [Rivet Actors](https://rivet.dev/actors) and the
 * `rivetkit` runtime.
 *
 * A Rivet Actor is the closest primitive to a Durable Object outside
 * Cloudflare: one addressable, single-writer instance per key, with its own
 * SQLite database, its own durable schedules, and a sleep/wake lifecycle. Five
 * things this host therefore gets from the platform rather than rebuilding —
 * sharded state, alarms, hibernated WebSockets, runtime cron registration, and
 * placement at create time — are things `@lunora/platform-node` has to emulate
 * with `setTimeout` and a table.
 *
 * ## The one structural mismatch
 *
 * `ShardSqlExec.exec` is **synchronous**; every Rivet SQLite entry point is a
 * promise, because the actor reaches its database through the runtime. The
 * contract anticipates this ("async-backed with a sync facade"), and
 * `./rivet-shard-state` is that facade: a `better-sqlite3` working copy in the
 * actor's memory answers every read, and the whole database is serialized back
 * into Rivet's SQLite at each commit. That is why `RIVET_CAPABILITIES.localSql`
 * reads `emulated`, and why the strategy is a small-shard one — a commit costs
 * O(database size). `.shardBy()` is what keeps it in the range it is good at.
 *
 * ## Status
 *
 * Experimental, and narrower than the Node host in one important way: there is
 * no `lunora dev --target rivet`, no deploy driver, and no `.global()` table
 * backend. The contracts are implemented and pass `@lunora/platform`'s
 * conformance TCK against an in-memory Rivet actor double
 * (`./conformance`); they have not been driven against a live Rivet engine in
 * CI. See `plans/rivet-host-findings.md` for what that leaves open.
 */

export type {
    RivetActorHandleLike,
    RivetActorLike,
    RivetActorNamespaceLike,
    RivetCronLike,
    RivetCronSetOptions,
    RivetGetOrCreateOptions,
    RivetRawDatabaseLike,
    RivetScheduledEventLike,
    RivetScheduleLike,
    RivetWebSocketLike,
} from "./rivet-context";
export { createRivetShardKvStore } from "./rivet-kv-store";
export type { RivetPlatform, RivetPlatformOptions } from "./rivet-platform";
export { createRivetPlatform } from "./rivet-platform";
export type { RivetSchedulerHost, RivetSchedulerHostOptions } from "./rivet-scheduler-host";
export { createRivetSchedulerHost, RIVET_CRON_ACTION, RIVET_SCHEDULER_ACTION } from "./rivet-scheduler-host";
export type { RivetShardDirectoryOptions } from "./rivet-shard-directory";
export { createRivetShardDirectory } from "./rivet-shard-directory";
export type { RivetShardDatabase, RivetShardHost, RivetShardHostOptions } from "./rivet-shard-host";
export { createRivetShardHost, restoreRivetAlarm, RIVET_ALARM_ACTION } from "./rivet-shard-host";
export type { RivetShardState } from "./rivet-shard-state";
export { clearRivetShardSnapshot, openRivetShardState } from "./rivet-shard-state";
export type { RivetSocketHost } from "./rivet-socket-host";
export { createRivetSocketHost } from "./rivet-socket-host";
