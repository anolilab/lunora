/**
 * The `sqlite-vec` `vec0` index behind `sqliteVectorStore({ ann })`: cosine
 * distance, one partition per namespace, in `<table>_ann` beside the store's
 * JSON table.
 *
 * The table stays the source of truth, and the write order keeps the two
 * consistent without a transaction: {@link SqliteVecIndex.put} runs BEFORE the
 * table write and {@link SqliteVecIndex.remove} AFTER the table delete. An
 * interrupted pair therefore leaves an index entry the table does not hold —
 * which the store drops when it hydrates matches — and never a stored chunk no
 * KNN lookup can find.
 * @experimental
 */
import { LunoraError } from "@lunora/errors";

import type { RagSqlExec } from "./sql";
import { placeholderList } from "./sql";

interface SqliteVecIndex {
    /** Create the index on first use, backfilling it from the table. */
    ensure: () => Promise<void>;
    /** The `k` nearest ids in `namespace`, closest first. `distance` is cosine distance (`1 - similarity`). */
    nearest: (namespace: string, vector: ReadonlyArray<number>, k: number) => Promise<ReadonlyArray<{ distance: number; id: string }>>;
    /** Index (or re-index) one vector. */
    put: (namespace: string, id: string, vector: ReadonlyArray<number>) => Promise<void>;
    /** Drop ids from the index — at most one `inListBatches` batch per call. */
    remove: (namespace: string, ids: ReadonlyArray<string>) => Promise<void>;
}

/** Rows copied per statement when an index is backfilled from an existing table. */
const BACKFILL_BATCH = 500;

/** vec0's ceiling on `k` in a KNN query. */
const MAX_K = 4096;

/**
 * The `vec0` primary key: unique across namespaces, so the pair rather than
 * the id. The id rides along as an auxiliary column to be read back.
 */
const refFor = (namespace: string, id: string): string => JSON.stringify([namespace, id]);

const sqliteVecIndex = (options: { dimensions: number; exec: RagSqlExec; table: string }): SqliteVecIndex => {
    const { dimensions, exec, table } = options;
    const index = `${table}_ann`;
    const marker = `${table}_ann_ready`;

    /** The `vec0` column rejects any other width; say which, instead of its bare error. */
    const assertWidth = (width: number, what: string): void => {
        if (width !== dimensions) {
            throw new LunoraError(
                "RAG_DIMENSION_MISMATCH",
                `@lunora/ai/rag: ${what} is ${String(width)}-dimension but the \`ann\` index is ${String(dimensions)}-dimension — ` +
                    "set `ann.dimensions` to the embedding model's width, or reindex into a new `table` after changing models",
            );
        }
    };

    const insert = async (namespace: string, id: string, vector: string): Promise<void> => {
        await exec(`INSERT INTO ${index} (ref, namespace, embedding, id) VALUES (?, ?, ?, ?)`, [refFor(namespace, id), namespace, vector, id]);
    };

    const backfill = async (): Promise<void> => {
        // Keyset pagination over rowid, so a large table is copied in bounded
        // statements rather than one read that materialises every vector.
        let after = 0;

        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- one bounded page at a time; the next page starts after this one's last rowid
            const rows = await exec(`SELECT rowid, id, namespace, vector FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`, [after, BACKFILL_BATCH]);

            for (const row of rows) {
                assertWidth((JSON.parse(String(row["vector"])) as unknown[]).length, `stored vector "${String(row["id"])}"`);
                // eslint-disable-next-line no-await-in-loop -- vec0 takes one row per INSERT; the page is already bounded
                await insert(String(row["namespace"]), String(row["id"]), String(row["vector"]));
            }

            if (rows.length < BACKFILL_BATCH) {
                return;
            }

            after = Number(rows.at(-1)?.["rowid"]);
        }
    };

    /**
     * The index counts as built only once {@link marker} exists, and the marker
     * is written after the backfill. So a build interrupted part-way — a throw,
     * or an isolate killed mid-loop — is dropped and rebuilt on the next call
     * rather than trusted as complete while it misses every row after the cut.
     */
    const ensure = async (): Promise<void> => {
        const built = await exec("SELECT name FROM sqlite_master WHERE name = ?", [marker]);

        if (built.length > 0) {
            const [row] = await exec(`SELECT dimensions FROM ${marker}`, []);

            assertWidth(Number(row?.["dimensions"]), "the existing index");

            return;
        }

        await exec(`DROP TABLE IF EXISTS ${index}`, []);

        try {
            await exec(
                `CREATE VIRTUAL TABLE ${index} USING vec0(ref TEXT PRIMARY KEY, namespace TEXT PARTITION KEY, embedding FLOAT[${String(dimensions)}] distance_metric=cosine, +id TEXT)`,
                [],
            );
        } catch (error) {
            if (error instanceof Error && error.message.includes("no such module: vec0")) {
                throw new Error(
                    "@lunora/ai/rag: sqliteVectorStore `ann` needs the sqlite-vec extension in this SQLite (`no such module: vec0`) — on celld set the `sqlite_vec` compatibility flag, on node:sqlite load the extension",
                    { cause: error },
                );
            }

            throw error;
        }

        await backfill();
        await exec(`CREATE TABLE ${marker} (dimensions INTEGER NOT NULL)`, []);
        await exec(`INSERT INTO ${marker} (dimensions) VALUES (?)`, [dimensions]);
    };

    return {
        ensure,
        nearest: async (namespace, vector, k) => {
            assertWidth(vector.length, "the query embedding");

            const rows = await exec(`SELECT id, distance FROM ${index} WHERE embedding MATCH ? AND k = ? AND namespace = ?`, [
                JSON.stringify([...vector]),
                Math.min(k, MAX_K),
                namespace,
            ]);

            return rows.map((row) => {
                return { distance: Number(row["distance"]), id: String(row["id"]) };
            });
        },
        put: async (namespace, id, vector) => {
            assertWidth(vector.length, `the embedding for "${id}"`);
            // vec0 has no upsert, so a re-index is DELETE then INSERT.
            await exec(`DELETE FROM ${index} WHERE ref = ?`, [refFor(namespace, id)]);
            await insert(namespace, id, JSON.stringify([...vector]));
        },
        remove: async (namespace, ids) => {
            await exec(
                `DELETE FROM ${index} WHERE ref IN (${placeholderList(ids.length)})`,
                ids.map((id) => refFor(namespace, id)),
            );
        },
    };
};

export type { SqliteVecIndex };
export { sqliteVecIndex };
