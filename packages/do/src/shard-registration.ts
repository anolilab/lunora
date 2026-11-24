/**
 * This shard's half of the shard registry: registering the `.shardBy()` tables a
 * committed write touched, and releasing the ones it no longer holds rows of.
 *
 * Owns the per-instance registration state (the claimed tables, the retry
 * window, the chain every round trip runs on) and reaches the shard only through
 * {@link ShardRegistrationHost}. The `releaseShardRegistration` admin RPC that
 * asks for a release, its audit row and its response stay on `ShardDO`.
 */
import { LunoraError } from "@lunora/errors";
import type { SqlExec } from "@lunora/shard-engine";
import { quoteIdentifier, siblingSecretOf, stubByName } from "@lunora/shard-engine";

import { parseRelayName } from "../../../shared/relay-name";
import { parseReplicaName } from "../../../shared/replica-name";
import { isRegistryNamespace, isRegistryRpc, registerShardKey, SHARD_REGISTRY_DO_NAME, unregisterShardKey } from "./shard-registry-do";

/** How long a failed shard-registry registration waits before a later write retries it. */
const SHARD_REGISTRY_RETRY_MS = 30_000;

/** The registry binding and the tables it tracks, as `ShardDO.shardRegistry` answers them. */
type ShardRegistryTarget = undefined | { namespace: unknown; shardedTables: ReadonlySet<string> };

/** The registry writes a shard makes, whether they reach a namespace or an entrypoint. */
interface RegistryWriter {
    register: (table: string, shardKey: string) => Promise<void>;
    unregister: (table: string, shardKey: string) => Promise<void>;
}

/**
 * What registration needs of the shard.
 *
 * Thunks rather than values because the instance is built as a field
 * initializer, before the DO's constructor has assigned `state` and `env`, and
 * because `registry` is the codegen subclass's override hook, which must be
 * asked on every call rather than captured once.
 */
interface ShardRegistrationHost {
    /** The worker `env`, for the secret that signs a write straight to the registry namespace. */
    env: () => unknown;
    /** This DO's jurisdiction: the subnamespace the worker pins the registry it reads. */
    jurisdiction: () => string | undefined;
    registry: () => ShardRegistryTarget;
    shardKey: () => string;
    sql: () => SqlExec;
}

/** Whether this shard's SQLite holds at least one row of `table` — `false` for a table it never created. */
const tableHasRows = (sql: SqlExec, table: string): boolean => {
    if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length === 0) {
        return false;
    }

    return sql.exec(`SELECT 1 FROM ${quoteIdentifier(table)} LIMIT 1`).toArray().length > 0;
};

/**
 * Per-instance registration state and behaviour. A class, like
 * `CdcRetentionRunner`, because the claims, the retry window and the chain are
 * per-DO-instance state: module-level state would let one shard's claim or
 * outage stand in for every other shard sharing the isolate.
 */
class ShardRegistration {
    private readonly host: ShardRegistrationHost;

    /**
     * The `.shardBy()` tables this instance has registered with the shard
     * registry, or is registering right now — claimed before the round trip so
     * two concurrent first writes send one. Registration is idempotent, so this
     * only saves round trips; it resets with the instance.
     */
    private readonly registeredTables = new Set<string>();

    /**
     * Epoch millis before which registration is not retried, set when one
     * fails: a registry outage costs one attempt per window rather than one per
     * write, against the single DO that has to recover.
     */
    private registryRetryAt = 0;

    /**
     * Every registry round trip this shard makes, in order — see
     * {@link ShardRegistration.serializeRegistry}. Never rejects.
     */
    private registryTail: Promise<void> = Promise.resolve();

    public constructor(host: ShardRegistrationHost) {
        this.host = host;
    }

    /**
     * Tell the shard registry this shard holds rows of each `.shardBy()` table
     * the flushed write touched, once per table per instance. The cross-shard
     * fan-outs (export, CDC sync, migrations) only reach the shards the registry
     * lists, so a shard that never registers is left out of every one of them.
     *
     * Runs past the response (see `ShardDO.flushChangedTables`) and never rejects:
     * the write has already committed, so a failure is logged, the table's claim
     * released, and the first write after {@link SHARD_REGISTRY_RETRY_MS} retries.
     */
    public async register(changed: ReadonlySet<string>): Promise<void> {
        await this.serializeRegistry(async () => {
            const registry = this.host.registry();

            if (registry === undefined || Date.now() < this.registryRetryAt) {
                return;
            }

            const shardKey = this.host.shardKey();

            // A replica or relay is a copy of (or a door to) another shard, not a
            // shard of its own. Listed, it would join every fan-out and refuse the
            // admin RPCs it was sent — a replica answers 421 to anything not routed
            // to it as a read — so every export and backup of the table would fail.
            if (parseReplicaName(shardKey) !== undefined || parseRelayName(shardKey) !== undefined) {
                return;
            }

            const tables = [...changed].filter((table) => registry.shardedTables.has(table) && !this.registeredTables.has(table));

            if (tables.length === 0) {
                return;
            }

            const writer = this.registryWriter(registry.namespace);

            if (writer === undefined) {
                // eslint-disable-next-line no-console -- server-side diagnostic: a misbound registry leaves this shard out of every fan-out
                console.error(
                    `[@lunora/do] shard registry binding is neither a Durable Object namespace in this shard's jurisdiction nor a registry entrypoint; shard "${shardKey}" is not registered`,
                );

                return;
            }

            await Promise.all(
                tables.map(async (table) => {
                    this.registeredTables.add(table);

                    try {
                        await writer.register(table, shardKey);
                    } catch (error: unknown) {
                        this.registeredTables.delete(table);
                        this.registryRetryAt = Date.now() + SHARD_REGISTRY_RETRY_MS;
                        // eslint-disable-next-line no-console -- server-side diagnostic for a committed write whose registration failed
                        console.error(
                            `[@lunora/do] could not register shard "${shardKey}" for "${table}"; cross-shard export, sync and migrations miss it until a later write registers it:`,
                            error,
                        );
                    }
                }),
            );
        });
    }

    /**
     * Drop this shard from the registry for each named table it holds no rows of,
     * and keep it for the rest. With `dryRun`, report the split without touching
     * the registry.
     *
     * The shard decides rather than the caller because only here can the check
     * be ordered against this shard's own writes. It runs on the registry chain
     * (see {@link ShardRegistration.serializeRegistry}) and clears the table's
     * claim, so a row written before the check is seen by it and keeps the table,
     * and one written after re-registers once the unregister has landed. A caller
     * that probed first and unregistered second could hide a shard written in
     * between: its claim would say "registered" while the registry said otherwise.
     *
     * A soft-deleted row still counts as a row — the shard is kept.
     */
    public async release(tables: ReadonlyArray<string>, dryRun: boolean): Promise<{ kept: string[]; released: string[] }> {
        return this.serializeRegistry(async () => {
            const registry = this.host.registry();
            const writer = registry === undefined ? undefined : this.registryWriter(registry.namespace);

            if (registry === undefined || writer === undefined) {
                throw new LunoraError("BAD_REQUEST", "releaseShardRegistration: this shard has no shard registry bound", { status: 400 });
            }

            const shardKey = this.host.shardKey();
            const kept: string[] = [];
            const released: string[] = [];

            for (const table of tables) {
                if (tableHasRows(this.host.sql(), table)) {
                    kept.push(table);
                    continue;
                }

                if (!dryRun) {
                    // eslint-disable-next-line no-await-in-loop -- one small round trip per table this shard is listed for; ordered with the rest of the chain
                    await writer.unregister(table, shardKey);
                    this.registeredTables.delete(table);
                }

                released.push(table);
            }

            return { kept, released };
        });
    }

    /**
     * Run one registry step after every step before it. Registration and release
     * both go through here, so a release's emptiness check and unregister can
     * never interleave with a registration: a write that lands mid-release
     * registers AFTER the unregister, not before it.
     */
    private async serializeRegistry<T>(work: () => Promise<T>): Promise<T> {
        const run = this.registryTail.then(work);

        this.registryTail = run.then(
            () => undefined,
            () => undefined,
        );

        return run;
    }

    /** The registry stub, pinned to this DO's own jurisdiction — the subnamespace the worker pins the registry it reads. */
    private registryStub(namespace: unknown): ReturnType<typeof stubByName> {
        return stubByName(namespace, SHARD_REGISTRY_DO_NAME, this.host.jurisdiction());
    }

    /**
     * Where this shard's registry writes go. A Durable Object namespace is this app's own
     * registry: signed directly with this worker's secret. Anything else is the RPC surface of
     * the worker that hosts the registry, reached through its service binding, so the binding
     * itself is the capability and no secret is needed. `undefined` when a namespace is not in
     * this shard's jurisdiction.
     */
    private registryWriter(binding: unknown): RegistryWriter | undefined {
        if (!isRegistryNamespace(binding)) {
            if (!isRegistryRpc(binding)) {
                return undefined;
            }

            const host = binding;

            return {
                register: async (table, shardKey) => host.register(table, shardKey),
                unregister: async (table, shardKey) => host.unregister(table, shardKey),
            };
        }

        const stub = this.registryStub(binding);

        if (stub === undefined) {
            return undefined;
        }

        const secret = siblingSecretOf(this.host.env());

        return {
            register: async (table, shardKey) => registerShardKey(stub, table, shardKey, secret),
            unregister: async (table, shardKey) => unregisterShardKey(stub, table, shardKey, secret),
        };
    }
}

export default ShardRegistration;
