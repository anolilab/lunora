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
 * The table Rivet's actor SQLite holds the snapshot in.
 *
 * One row, checked to id 0. Rivet's database is the durable side of this
 * package and the app's own `onMigrate` tables live beside it, so the name is
 * prefixed the same way every other Lunora-owned table is.
 */
const SNAPSHOT_TABLE = "_lunora_shard_snapshot";

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

/** The shard's synchronous working copy, plus the durable snapshot around it. */
interface RivetShardState {
    /**
     * Close the working copy. Does **not** flush: a caller that wants the
     * pending writes durable calls {@link RivetShardState.flush} first, and one
     * tearing down after a failure deliberately does not.
     */
    close: () => void;

    /**
     * The synchronous working copy. Every contract in this package that needs
     * sync storage — the engine's SQL, the socket registry's attachments and
     * tags — runs against this one connection, so a single snapshot covers all
     * of them.
     */
    readonly database: Database.Database;

    /**
     * Serialize the working copy back into Rivet's SQLite, if anything changed
     * since the last flush. A no-op when clean, so calling it at every boundary
     * costs nothing on read-only work.
     */
    flush: () => Promise<void>;

    /**
     * Whether a write has happened since the last successful flush. Read by the
     * shard host to decide whether a boundary needs a flush at all, and by
     * tests to pin that reads do not dirty the shard.
     */
    readonly isDirty: boolean;

    /**
     * Mark the working copy as changed. Called by every writer against
     * {@link RivetShardState.database} — the SQL executor classifies statements
     * itself, but the socket registry writes through prepared statements it
     * owns, so the flag is set explicitly rather than sniffed.
     */
    markDirty: () => void;
}

/** Row shape of the snapshot table. */
interface SnapshotRow extends Record<string, unknown> {
    data: string;
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

    await db.execute(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 0), data TEXT NOT NULL)`);

    const rows = await db.execute<SnapshotRow>(`SELECT data FROM ${SNAPSHOT_TABLE} WHERE id = 0`);
    const snapshot = rows[0]?.data;

    // `new Database(buffer)` restores a serialized database into memory;
    // `":memory:"` is the first-wake case, where there is nothing to restore.
    const database = snapshot === undefined ? new Database(":memory:") : new Database(decodeSnapshot(snapshot));

    let dirty = false;
    let closed = false;

    const flush = async (): Promise<void> => {
        if (!dirty) {
            return;
        }

        if (closed) {
            throw new LunoraError("INTERNAL_ERROR", "@lunora/platform-rivet: cannot flush a shard state that has already been closed");
        }

        const encoded = encodeSnapshot(database.serialize());

        await db.execute(`INSERT INTO ${SNAPSHOT_TABLE} (id, data) VALUES (0, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data`, encoded);

        // Cleared only after the durable write resolves. Clearing first would
        // drop the very writes a failed flush still owes, and the next boundary
        // would find nothing to retry.
        dirty = false;
    };

    return {
        close: () => {
            if (!closed) {
                closed = true;
                database.close();
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
    };
};

/**
 * Drop the persisted snapshot. Exposed for the destroy path — an actor that
 * Lunora tears down should not leave a shard database behind in Rivet's
 * storage — and for tests that need a first-wake actor over a reused database.
 */
const clearRivetShardSnapshot = async (database: RivetRawDatabaseLike): Promise<void> => {
    await database.execute(`DELETE FROM ${SNAPSHOT_TABLE} WHERE id = 0`);
};

export type { RivetShardState };
export { clearRivetShardSnapshot, openRivetShardState };
