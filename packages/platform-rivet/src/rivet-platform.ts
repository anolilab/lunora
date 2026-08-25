/**
 * The Rivet composition root: assemble every `@lunora/platform` contract this
 * package implements from one Rivet actor context.
 *
 * Mirrors `@lunora/platform-cloudflare`'s `createShardPlatform` (one shard
 * instance) rather than its `createWorkerPlatform` (a Worker's `env`): the
 * shard directory needs a RivetKit *client*, which lives outside the actor, so
 * it is built separately with `createRivetShardDirectory`. An actor and the
 * client that addresses it are genuinely different scopes here, and collapsing
 * them would make every actor hold a client it does not use.
 *
 * ## Wiring it into an actor
 *
 * Rivet delivers schedules and alarms by invoking an **action on the actor**,
 * so three handlers have to exist on the actor definition. They are one line
 * each, and the action names are exported constants so a typo cannot silently
 * turn an alarm into an alarm that never arrives:
 *
 * ```ts
 * import { actor, setup } from "rivetkit";
 * import { db } from "rivetkit/db";
 * import {
 *     RIVET_ALARM_ACTION,
 *     RIVET_CRON_ACTION,
 *     RIVET_SCHEDULER_ACTION,
 *     createRivetPlatform,
 * } from "@lunora/platform-rivet";
 *
 * export const shard = actor({
 *     db: db({ onMigrate: async () => {} }),
 *     options: { canHibernateWebSocket: true },
 *     // Built once per wake, so every handler on this generation shares one
 *     // working copy. Building it per action would re-read the snapshot each
 *     // time and give two in-flight handlers divergent shard state.
 *     createVars: async (c) => ({ platform: await createRivetPlatform(c, { onAlarm, onDispatch }) }),
 *     // A connection that slept with the actor comes back through this
 *     // handler. Rebind it to the id it was accepted under — `accept`ing it a
 *     // second time mints a new id and orphans the engine's subscription
 *     // state. `c.conn.state` is where Rivet keeps per-connection state across
 *     // a sleep, so the id is stashed there.
 *     onWebSocket: (c, ws) => {
 *         const { socketId } = c.conn.state;
 *
 *         if (socketId === undefined || c.vars.platform.attachSocket(socketId, ws) === undefined) {
 *             const { sockets } = c.vars.platform;
 *
 *             c.conn.state.socketId = sockets.idFor(sockets.accept(ws));
 *         }
 *     },
 *     actions: {
 *         [RIVET_ALARM_ACTION]: async (c) => c.vars.platform.deliverAlarm(),
 *         [RIVET_SCHEDULER_ACTION]: async (c, id: string) => c.vars.platform.deliverScheduledJob(id),
 *         [RIVET_CRON_ACTION]: async (c, path: string, args: string) =>
 *             c.vars.platform.deliverCronTick(path, JSON.parse(args)),
 *     },
 * });
 * ```
 */

import type { PlatformCapabilities, SchedulerHost, ShardHost, ShardKvStore, SocketHandle, SocketHost } from "@lunora/platform";
import { RIVET_CAPABILITIES } from "@lunora/platform";

import type { RivetActorLike } from "./rivet-context";
import { createRivetShardKvStore } from "./rivet-kv-store";
import type { RivetSchedulerHostOptions } from "./rivet-scheduler-host";
import { createRivetSchedulerHost } from "./rivet-scheduler-host";
import type { RivetShardHostOptions } from "./rivet-shard-host";
import { createRivetShardHost, restoreRivetAlarm } from "./rivet-shard-host";
import { openRivetShardState } from "./rivet-shard-state";
import { createRivetSocketHost } from "./rivet-socket-host";

/** Every contract this package provides, composed for one Rivet actor. */
export interface RivetPlatform {
    /**
     * Rebind a hibernated connection to the socket record it was accepted
     * under. Wire to the actor's `onWebSocket` handler — see this module's
     * header for the shape, and `SocketHost` for why the id has to be the
     * original one.
     * @returns the rebound handle, or `undefined` when the id is unknown here
     * and the connection should be `accept`ed as new.
     */
    attachSocket: (id: string, socket: unknown) => SocketHandle | undefined;

    /** What this target supports — see `RIVET_CAPABILITIES` in `@lunora/platform`. */
    capabilities: PlatformCapabilities;

    /**
     * Flush pending writes and close the working copy.
     *
     * Call from the actor's `onSleep`/`onDestroy`. Unlike the Node host's
     * `close()`, this one is asynchronous and *does* flush: the working copy
     * is in the actor's memory and sleeping without a flush is exactly how a
     * committed-looking write disappears.
     */
    close: () => Promise<void>;

    /** Deliver a fired shard alarm. Wire to the `RIVET_ALARM_ACTION` handler. */
    deliverAlarm: () => Promise<void>;
    /** Deliver a cron tick. Wire to the `RIVET_CRON_ACTION` handler. */
    deliverCronTick: (functionPath: string, args: Record<string, unknown>) => Promise<void>;
    /** Deliver one due scheduled job. Wire to the `RIVET_SCHEDULER_ACTION` handler. */
    deliverScheduledJob: (id: string) => Promise<boolean>;

    /** Wait for every promise handed to `shard.waitUntil` to settle. */
    drain: () => Promise<void>;

    /**
     * Snapshot the shard's pending writes into Rivet's SQLite now.
     *
     * The boundaries (`runSerialized`, `transaction`) already do this, so a
     * caller needs it only for a write made outside one — and for the sleep
     * path, which is what {@link RivetPlatform.close} is.
     */
    flush: () => Promise<void>;

    /** Durable key-value storage, written straight through to the actor's SQLite. */
    kv: ShardKvStore;

    /** Delayed jobs and runtime-registered crons, over Rivet's own schedules. */
    scheduler: SchedulerHost;

    /** Single-writer execution, local SQL, transactions, durable alarms. */
    shard: ShardHost;
    /** Socket registry with mutable tags and snapshot-persisted attachments. */
    sockets: SocketHost;
}

/** Options for {@link createRivetPlatform} — the shard host's and the scheduler's. */
export type RivetPlatformOptions = RivetSchedulerHostOptions & RivetShardHostOptions;

/**
 * Compose every contract this package provides over one Rivet actor context.
 *
 * Asynchronous because the working copy has to be hydrated from the last
 * snapshot before anything can read it — there is no synchronous way to reach
 * Rivet's storage, and handing back a platform whose shard is still loading
 * would make the first read a race.
 */
export const createRivetPlatform = async (actor: RivetActorLike, options: RivetPlatformOptions = {}): Promise<RivetPlatform> => {
    const state = await openRivetShardState(actor);

    const { deliverAlarm, drain, host: shard } = createRivetShardHost(actor, state, options);
    // `simulateRecycle` is the socket host's one test-only hook and is not
    // taken here; `restoreSockets`/`attachSocket` are the wake path and very
    // much part of the runtime surface.
    const { attachSocket, restoreSockets, socket: sockets } = createRivetSocketHost(state);
    const { kv, ready: kvReady } = createRivetShardKvStore(actor.db);
    const { deliverCronTick, deliverScheduledJob, ready: schedulerReady, scheduler } = createRivetSchedulerHost(actor, options);

    // Both table creations are already in flight; awaiting them here surfaces a
    // construction failure at `createVars` rather than on whichever call
    // happens to touch the table first.
    await Promise.all([kvReady, schedulerReady]);

    // A shard alarm armed before the last sleep is still pending in Rivet, but
    // this host's in-memory mirror of it is not — so `alarms.get()` would
    // report `null` for an alarm that is very much armed, and the next `set()`
    // would leak the old schedule.
    await restoreRivetAlarm(actor, shard);

    // Same problem one layer up: the durable socket rows survived the sleep and
    // the runtime map did not, so without this `getSockets(tag)` answers `[]`
    // and every poke for a hibernated connection is dropped silently.
    restoreSockets();

    return {
        attachSocket,
        capabilities: RIVET_CAPABILITIES,
        close: async () => {
            try {
                await state.flush();
            } finally {
                // In a `finally`, because a rejected flush must not leak the
                // working copies: the actor is going to sleep either way, and
                // an unclosed better-sqlite3 handle outlives it.
                state.close();
            }
        },
        deliverAlarm,
        deliverCronTick,
        deliverScheduledJob,
        drain,
        flush: state.flush,
        kv,
        scheduler,
        shard,
        sockets,
    };
};
