import { PGlite } from "@electric-sql/pglite";
import type { SqlExec } from "@lunora/sql-store";

import type { RowClient } from "../../src/global-exec";
import { buildPgExec } from "../../src/global-exec";

/**
 * Adapts [`@electric-sql/pglite`](https://pglite.dev) — a real, embedded
 * Postgres engine — to the async {@link SqlExec} the store core consumes, via
 * the package's own {@link buildPgExec} adapter (the core renders `$N`
 * placeholders for Postgres; the adapter forwards them verbatim).
 *
 * Running the generated `INSERT`/`SELECT`/`UPDATE`/DDL against a genuine
 * Postgres (not a string-shape mock) proves the Postgres dialect — column types,
 * `RETURNING`-based OCC, `ON CONFLICT` upserts, `information_schema` probes, and
 * the SQLite-shaped value codec — behaves against a live engine, without an
 * external server. This is the second real-engine gate alongside the D1 suite's
 * `node:sqlite`.
 */
interface PgliteHarness {
    /** Close the embedded database. */
    close: () => Promise<void>;
    /** The {@link SqlExec} the store core / migrations run against. */
    exec: SqlExec;
    /** Raw query escape hatch for assertions on the physical rows. */
    query: (sql: string, parameters?: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
}

const createPgliteHarness = async (): Promise<PgliteHarness> => {
    const database = new PGlite();

    await database.waitReady;

    const rowClient: RowClient = {
        query: async <Row = Record<string, unknown>>(text: string, parameters?: ReadonlyArray<unknown>): Promise<Row[]> => {
            const result = await database.query(text, parameters as unknown[]);

            return result.rows as Row[];
        },
    };

    return {
        close: () => database.close(),
        exec: buildPgExec(rowClient),
        query: async (sql, parameters = []) => {
            const result = await database.query(sql, parameters as unknown[]);

            return result.rows as Record<string, unknown>[];
        },
    };
};

export type { PgliteHarness };
export default createPgliteHarness;
