import type { SchemaLike, SqlExec, ValidatorLike } from "@lunora/shard-engine";
import { createShardCtxDb, TransactionHeadroomTracker } from "@lunora/shard-engine";

import type { SqlCtxExec } from "../../src/ctx-db";
import { createSqlCtxDb } from "../../src/ctx-db";
import type { SqlDialect } from "../../src/dialect";

/**
 * An unlimited `findMany` on a `.global()` table, read through the engine's byte meter over a real
 * SQL store. Runtime-neutral, so the node and the D1 suites run one copy: the caller supplies the
 * exec and dialect of the SQLite it owns.
 */

/** Enough rows for several full-size pages, every one tied on `bucket` and on `_creationTime`, so only the id splits them. */
const ROW_COUNT = 9000;
const BUCKETS = 3;

const meteredReadSchema = (table: string): SchemaLike => {
    const column = (kind: string): ValidatorLike => {
        return { _meta: { column: { notNull: true } }, kind };
    };

    return {
        tables: {
            [table]: {
                indexes: [{ fields: ["bucket"], name: "by_bucket" }],
                shape: { bucket: column("number"), label: column("string"), padding: column("string") },
                shardMode: { kind: "global" },
            },
        },
    } as never;
};

/** The meter never touches the shard-local SQLite for a global-only table; a read that does is a bug. */
const noLocalSql: SqlExec = {
    exec: () => {
        throw new Error("a global read must not touch the shard-local SQLite");
    },
};

type MeteredRead = {
    /** Rows the database handed back across every statement the read issued. */
    fetchedRows: () => number;
    /** SELECT statements run against the global table by the read. */
    selects: () => number;
    /** The unmetered writer, for the reference result. */
    store: ReturnType<typeof createSqlCtxDb>;
    writer: ReturnType<typeof createShardCtxDb>;
};

const openMeteredRead = async (options: {
    /** The read cap, as a number of this table's documents; no cap when omitted. */
    capRows?: number;
    dialect: SqlDialect;
    exec: SqlCtxExec;
    table: string;
}): Promise<MeteredRead> => {
    const { dialect, exec, table } = options;
    const schema = meteredReadSchema(table);
    // One instant for every row: the order keys tie completely, so a page boundary lands inside a group only `id` can split.
    const clock = (): number => 1_700_000_000_000;
    const store = createSqlCtxDb({ clock, dialect, exec, schema });

    // Provision the table, then fill it in one statement: thousands of single inserts would dominate the run.
    await store.findMany(table, { limit: 1 });
    await exec.run(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(ROW_COUNT)})
         INSERT INTO "${table}" (id, _creationTime, _version, bucket, label, padding)
         SELECT lower(hex(randomblob(16))), 1700000000000, 0, i % ${String(BUCKETS)}, 'row-' || i, substr(hex(randomblob(50)), 1, 100) FROM n`,
        [],
    );

    const sampled = await store.findMany(table, { limit: 1 });
    const [sample] = sampled.page;
    const documentBytes = new TextEncoder().encode(JSON.stringify(sample)).length;

    let selects = 0;
    let fetchedRows = 0;
    const counting: SqlCtxExec = {
        ...exec,
        all: async (query, parameters) => {
            const rows = await exec.all(query, parameters);

            if (query.startsWith("SELECT * FROM")) {
                selects += 1;
                fetchedRows += rows.length;
            }

            return rows;
        },
    };
    const reading = createSqlCtxDb({ clock, dialect, exec: counting, schema });
    const writer = createShardCtxDb({
        clock,
        globalDb: reading,
        headroom: new TransactionHeadroomTracker(options.capRows === undefined ? {} : { maxReadBytes: documentBytes * options.capRows }),
        schema,
        sql: noLocalSql,
    });

    return { fetchedRows: () => fetchedRows, selects: () => selects, store, writer };
};

export type { MeteredRead };
export { openMeteredRead, ROW_COUNT };
