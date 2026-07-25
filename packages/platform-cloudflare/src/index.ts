/**
 * `@lunora/platform-cloudflare` — the Cloudflare host: one place that composes
 * every `@lunora/platform` contract over Workers, Durable Objects, and
 * `SchedulerDO`.
 *
 * # Why this package exists
 *
 * The adapters themselves live in `@lunora/do`, because that is where the
 * Durable Object code they wrap lives. But wiring them up was the caller's job,
 * and that job had sharp edges: five separate factories, two different argument
 * shapes (`state` for some, `state.storage` for others), no scheduler at all,
 * and no association between a host and the capability matrix that describes
 * it. Every consumer re-derived the same assembly.
 *
 * This package is that assembly, done once. It presents **two** factories,
 * because a Worker has exactly two lifetimes worth distinguishing:
 *
 * - {@link createShardPlatform} — everything scoped to one Durable Object
 * instance, built from its `DurableObjectState`.
 * - {@link createWorkerPlatform} — everything scoped to the Worker, built from
 * its `env` bindings.
 *
 * Splitting on lifetime rather than on contract is what keeps the interface
 * small: a caller inside a DO never has to think about namespaces or origins,
 * and a caller in the Worker entry never has to hold a `DurableObjectState` it
 * does not have.
 *
 * # What is deliberately not here
 *
 * The contracts themselves are not re-exported — import those from
 * `@lunora/platform`, which is zero-dependency and safe on every runtime. This
 * package pulls in `@lunora/do` and `@lunora/scheduler`, so anything that needs
 * only types should not depend on it.
 */

import { createShardDirectory, createShardHost, createShardKvStore, createSocketHost } from "@lunora/do";
import type { PlatformCapabilities, SchedulerHost, ShardDirectory, ShardHost, ShardKvStore, SocketHost } from "@lunora/platform";
import { CLOUDFLARE_CAPABILITIES } from "@lunora/platform";

import type { CloudflareSchedulerOptions } from "./scheduler";
import { createCloudflareScheduler } from "./scheduler";

/**
 * The contracts available inside one Durable Object instance.
 *
 * `shard.alarms` is the alarm surface — there is deliberately no separate
 * `alarms` member, because a second route to the same thing is interface weight
 * without leverage.
 */
export interface ShardPlatform {
    /** Durable key-value storage for this shard. */
    kv: ShardKvStore;
    /** Single-writer execution, local SQL, transactions, alarms, identity. */
    shard: ShardHost;
    /** Hibernated WebSocket subscriptions for this shard. */
    sockets: SocketHost;
}

/** The contracts available in the Worker entry, resolved from its bindings. */
export interface WorkerPlatform {
    /** What this target supports, for codegen diagnostics and parity reporting. */
    capabilities: PlatformCapabilities;

    /**
     * Resolve a Durable Object namespace binding to a shard directory.
     *
     * A function rather than a value because a Worker routinely binds several
     * namespaces (`SHARD`, `SESSION`, `SCHEDULER`), and which one a caller wants
     * is call-site knowledge.
     * @throws when the named binding is absent from `env` — a missing namespace
     * is a deploy misconfiguration, and failing here beats surfacing later as an
     * unroutable shard.
     */
    directory: (binding: string) => ShardDirectory;

    /**
     * Durable delayed jobs, present only when the app supplies the `SchedulerDO`
     * wiring. Its `cron` member is always absent on this target — Cloudflare
     * crons are declared in `wrangler.jsonc`, not registered at runtime.
     */
    scheduler?: SchedulerHost;
}

/** Options for {@link createWorkerPlatform}. */
export interface WorkerPlatformOptions {
    /**
     * Wiring for the durable scheduler. Omit it when the app declares no
     * scheduled work: {@link WorkerPlatform.scheduler} is then `undefined`,
     * which callers already have to handle.
     *
     * `namespace` is the *binding name* to look up in `env` (default
     * `"SCHEDULER"`), not the namespace object — callers hold `env`, not
     * individual bindings.
     */
    scheduler?: Omit<CloudflareSchedulerOptions, "namespace"> & { namespace?: string };
}

/**
 * Compose every shard-scoped contract from a Durable Object's state.
 *
 * Cheap and allocation-light, so a DO can call it once in its constructor. The
 * adapters read through to `state` on each call rather than snapshotting it,
 * which is what keeps live values correct across a hibernation wake — the alarm
 * timestamp, the database size, and the live socket set all move underneath.
 *
 * `state` is typed `unknown` so this package does not force
 * `@cloudflare/workers-types` onto callers that are already holding the runtime
 * object; the adapters narrow it internally.
 */
export const createShardPlatform = (state: unknown): ShardPlatform => {
    const durableState = state as Parameters<typeof createShardHost>[0];

    return {
        kv: createShardKvStore(durableState.storage),
        shard: createShardHost(durableState),
        sockets: createSocketHost(durableState),
    };
};

/**
 * Compose every Worker-scoped contract from the Worker's `env`.
 *
 * `env` is typed `unknown` on purpose: its shape is the app's, generated per
 * project, and this package must not require a project-specific type to be
 * threaded through it.
 */
export const createWorkerPlatform = (env: unknown, options: WorkerPlatformOptions = {}): WorkerPlatform => {
    const bindings = (env ?? {}) as Record<string, unknown>;

    const directory = (binding: string): ShardDirectory => {
        const namespace = bindings[binding];

        if (namespace === undefined) {
            throw new Error(
                `@lunora/platform-cloudflare: no Durable Object namespace bound as "${binding}" — add it to wrangler.jsonc's durable_objects.bindings`,
            );
        }

        return createShardDirectory(namespace as Parameters<typeof createShardDirectory>[0]);
    };

    const schedulerOptions = options.scheduler;

    if (schedulerOptions === undefined) {
        return { capabilities: CLOUDFLARE_CAPABILITIES, directory };
    }

    const schedulerBinding = schedulerOptions.namespace ?? "SCHEDULER";
    const namespace = bindings[schedulerBinding];

    if (namespace === undefined) {
        throw new Error(
            `@lunora/platform-cloudflare: scheduler configured but no Durable Object namespace bound as "${schedulerBinding}" — add it to wrangler.jsonc or drop the scheduler option`,
        );
    }

    return {
        capabilities: CLOUDFLARE_CAPABILITIES,
        directory,
        scheduler: createCloudflareScheduler({
            ...schedulerOptions,
            namespace: namespace as CloudflareSchedulerOptions["namespace"],
        }),
    };
};

export type { CloudflareSchedulerOptions } from "./scheduler";
export { createCloudflareScheduler } from "./scheduler";
