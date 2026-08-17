/**
 * The bridge between Rivet's asynchronous actor SQLite and the **synchronous**
 * SQL executor the Lunora engine requires.
 *
 * `ShardSqlExec.exec` returns a cursor whose `one()`, `toArray()` and iteration
 * are all synchronous — the engine's read paths walk rows without awaiting, and
 * that is not an oversight the contract left open but a shape it fixed
 * deliberately (see `packages/platform/src/shard-host.ts`). Rivet reaches its
 * actor database through the runtime, so every entry point there is a promise.
 * The two cannot be joined directly.
 *
 * `ShardSqlExec`'s own docstring names the way out: "implementations may be
 * sync (Cloudflare `SqlStorage`) or **async-backed with a sync facade**". This
 * module is that facade, in the simplest form that is actually correct:
 *
 * 1. **Working copy.** A `better-sqlite3` database held in the actor's own
 * memory answers every `exec` synchronously. It is the shard's live state.
 * 2. **Hydrate.** On open, the last snapshot is read out of Rivet's durable
 * SQLite and deserialized straight into that working copy.
 * 3. **Snapshot.** At every commit boundary the working copy is serialized
 * whole and written back to Rivet's SQLite.
 *
 * ## Why a whole-database snapshot, and not a statement journal
 *
 * A journal of executed statements would be cheaper per write and is the
 * obvious alternative. It is also wrong in a way that is very hard to see:
 * replaying `INSERT INTO t (id) VALUES (random())` — or `datetime('now')`, or
 * anything reading `last_insert_rowid()` after a differently-ordered replay —
 * reconstructs a *different* database. A snapshot cannot diverge from the state
 * it was taken of, so the durability story stays checkable by reading one
 * function.
 *
 * The cost is the honest one, and it is why `RIVET_CAPABILITIES.localSql` is
 * rated `emulated` rather than `native`: a commit is O(database size), and the
 * shard's whole database has to fit in the actor's memory. That makes this a
 * small-shard strategy. Sharding by tenant or room — which is what
 * `.shardBy()` is for — keeps it in the range it is good at; a single
 * unsharded shard accumulating a large table is exactly what it is bad at.
 */

import { LunoraError } from "@lunora/errors";
import Database from "better-sqlite3";

import type { RivetActorLike, RivetRawDatabaseLike } from "./rivet-context";

/**
 * The table Rivet's actor SQLite holds the snapshots in.
 *
 * Two rows, one per working copy (see {@link SHARD_SLOT} /
 * {@link REGISTRY_SLOT}). Rivet's database is the durable side of this package
 * and the app's own `onMigrate` tables live beside it, so the name is prefixed
 * the same way every other Lunora-owned table is.
 */
const SNAPSHOT_TABLE = "_lunora_shard_snapshot";

/** Snapshot slot for the shard's working copy — the engine's own SQL. */
const SHARD_SLOT = 0;

/**
 * Snapshot slot for the host registry copy — this package's bookkeeping.
 *
 * A **second connection**, not a second table on the first one, and the reason
 * is transactional isolation rather than tidiness. `ShardHost.transaction` runs
 * a raw `BEGIN`/`COMMIT` on the shard copy and awaits the caller's closure
 * inside it, while Rivet does *not* serialize `onWebSocket` against actions
 * (see `./rivet-shard-host`'s header). A socket accepted during that await
 * would join the open transaction on a shared connection and be **rolled back**
 * with it — the row would vanish while the runtime map still held the socket,
 * so every later attachment write would silently update zero rows. Symmetrically
 * a `close()`'s `DELETE` would be undone, resurrecting a dead subscriber on the
 * next wake.
 *
 * Separating the connections also keeps the snapshot cost honest: the engine
 * calls `serializeAttachment` on every subscription change, and on a shared
 * copy each one would dirty — and therefore re-serialize — the whole shard
 * database. Here it re-serializes only the socket registry.
 */
const REGISTRY_SLOT = 1;

/**
 * Base64, not a BLOB.
 *
 * Rivet's `execute` is typed to bind and return `unknown`, and its serde layer
 * is free to hand a bound `Uint8Array` back as any of several shapes depending
 * on runtime (napi vs wasm). Text is the one representation that survives every
 * path identically. The 4:3 inflation is real and is part of the cost this
 * strategy is already paying; a wrong-shaped blob read back after a sleep would
 * be a silent, total loss of the shard.
 */
const encodeSnapshot = (bytes: Buffer): string => bytes.toString("base64");

const decodeSnapshot = (data: string): Buffer => Buffer.from(data, "base64");

/** The shard's synchronous working copies, plus the durable snapshots around them. */
interface RivetShardState {
    /**
     * Close both working copies. Does **not** flush: a caller that wants the
     * pending writes durable calls {@link RivetShardState.flush} first, and one
     * tearing down after a failure deliberately does not.
     */
    close: () => void;

    /**
     * The shard's synchronous working copy — the engine's SQL and its
     * transactions. See {@link RivetShardState.registry} for the host's own
     * bookkeeping, which deliberately does not share this connection.
     */
    readonly database: Database.Database;

    /**
     * Serialize whichever working copies changed back into Rivet's SQLite. A
     * no-op when both are clean, so calling it at every boundary costs nothing
     * on read-only work.
     *
     * The shard copy is skipped — and left dirty for the next boundary — while
     * a transaction is open on it, because `serialize()` captures uncommitted
     * rows and clearing the flag would make a subsequent `ROLLBACK` invisible
     * to every later snapshot.
     */
    flush: () => Promise<void>;

    /**
     * Whether a write has happened to the shard copy since the last successful
     * flush. Read by the shard host to decide whether a boundary needs a flush
     * at all, and by tests to pin that reads do not dirty the shard.
     */
    readonly isDirty: boolean;

    /**
     * Mark the shard copy as changed. Called by the SQL executor, which
     * classifies statements itself rather than having the flag sniffed from the
     * query text.
     */
    markDirty: () => void;

    /** Mark {@link RivetShardState.registry} as changed. */
    markRegistryDirty: () => void;

    /**
     * The host's own bookkeeping copy — today, the socket registry.
     *
     * Separate from {@link RivetShardState.database} so a write from an
     * `onWebSocket` handler cannot be swallowed by a shard transaction that
     * happens to be open; see {@link REGISTRY_SLOT}.
     */
    readonly registry: Database.Database;
}

/** Row shape of the snapshot table. */
interface SnapshotRow extends Record<string, unknown> {
    data: string;
    id: number;
}

/**
 * Open the shard's working copy, hydrating it from the last snapshot in
 * `actor.db`.
 *
 * Call this once per actor wake — from `createVars`, so the resulting state is
 * reachable as `c.vars.…` from every action, `onRequest` and `onWebSocket`
 * handler on that generation. Opening it per action would re-read the whole
 * snapshot on every call and, worse, give two in-flight handlers two divergent
 * copies of the same shard.
 */
const openRivetShardState = async (actor: Pick<RivetActorLike, "db">): Promise<RivetShardState> => {
    const { db } = actor;

    await db.execute(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (id INTEGER PRIMARY KEY CHECK (id IN (0, 1)), data TEXT NOT NULL)`);

    const rows = await db.execute<SnapshotRow>(`SELECT id, data FROM ${SNAPSHOT_TABLE}`);
    const snapshots = new Map(rows.map((row) => [row.id, row.data]));

    // `new Database(buffer)` restores a serialized database into memory;
    // `":memory:"` is the first-wake case, where there is nothing to restore.
    const open = (slot: number): Database.Database => {
        const snapshot = snapshots.get(slot);

        return snapshot === undefined ? new Database(":memory:") : new Database(decodeSnapshot(snapshot));
    };

    const database = open(SHARD_SLOT);
    const registry = open(REGISTRY_SLOT);

    let dirty = false;
    let registryDirty = false;
    let closed = false;

    const persist = async (slot: number, source: Database.Database): Promise<void> => {
        await db.execute(
            `INSERT INTO ${SNAPSHOT_TABLE} (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
            slot,
            encodeSnapshot(source.serialize()),
        );
    };

    const flush = async (): Promise<void> => {
        if (!dirty && !registryDirty) {
            return;
        }

        if (closed) {
            throw new LunoraError("INTERNAL_ERROR", "@lunora/platform-rivet: cannot flush a shard state that has already been closed");
        }

        // `Database.serialize()` has no transaction guard: called between
        // `BEGIN` and `ROLLBACK` it captures the uncommitted rows, and since a
        // successful flush clears `dirty`, nothing would ever re-snapshot the
        // state that actually survived — the next wake hydrates rows the shard
        // rolled back. Skipping leaves the flag set, and both boundaries
        // (`runSerialized`, `transaction`) flush again after their own
        // `COMMIT`, so the write is deferred rather than dropped.
        if (dirty && !database.inTransaction) {
            await persist(SHARD_SLOT, database);

            // Cleared only after the durable write resolves. Clearing first
            // would drop the very writes a failed flush still owes, and the
            // next boundary would find nothing to retry.
            dirty = false;
        }

        // No guard here, and none needed: nothing ever opens a transaction on
        // the registry copy — that is what it is separate for.
        if (registryDirty) {
            await persist(REGISTRY_SLOT, registry);
            registryDirty = false;
        }
    };

    return {
        close: () => {
            if (!closed) {
                closed = true;
                database.close();
                registry.close();
            }
        },
        database,
        flush,
        get isDirty(): boolean {
            return dirty;
        },
        markDirty: () => {
            dirty = true;
        },
        markRegistryDirty: () => {
            registryDirty = true;
        },
        registry,
    };
};

/**
 * Drop both persisted snapshots. Exposed for the destroy path — an actor that
 * Lunora tears down should not leave a shard database behind in Rivet's
 * storage — and for tests that need a first-wake actor over a reused database.
 */
const clearRivetShardSnapshot = async (database: RivetRawDatabaseLike): Promise<void> => {
    await database.execute(`DELETE FROM ${SNAPSHOT_TABLE}`);
};

export type { RivetShardState };
export { clearRivetShardSnapshot, openRivetShardState };
