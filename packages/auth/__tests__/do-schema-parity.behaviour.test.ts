import { DatabaseSync } from "node:sqlite";

import { getMigrations } from "better-auth/db/migration";
import BetterSqlite3 from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { resolveAuthOptions } from "../src/create-auth";
import { authDoSchemaStatements } from "../src/do-schema";
import { admin, inviteOnly, scim } from "../src/plugins";

/**
 * Does our DDL produce the same schema better-auth's own migrator produces?
 *
 * ## Why this test is the important one
 *
 * `authDoSchemaStatements` reuses better-auth for everything it exposes — the resolved
 * tables, the field attributes, the index names — but better-auth does **not** export
 * its SQLite type map or its column renderer (`getType` is a closure inside
 * `getMigrations`; nothing in `@better-auth/core`'s exports surfaces it). So that last
 * mile is mirrored, and a mirror drifts silently: a release could change an affinity,
 * start emitting a default, or add a constraint kind, and every other test here would
 * still pass while the DO served subtly wrong tables.
 *
 * This closes that gap without putting kysely on the request path. It asks better-auth
 * to compile its own SQLite DDL (`getMigrations().compileMigrations()`, against a
 * throwaway in-memory database), executes both schemas, and compares what SQLite
 * actually ended up with. A drift in better-auth's rendering fails here, with the
 * column or table named.
 *
 * It already earned its place: the first run found that our `id` column was **nullable**
 * (a `TEXT PRIMARY KEY` in SQLite accepts NULL, unlike the `INTEGER PRIMARY KEY` rowid
 * alias) and that we emitted `DEFAULT` values upstream does not.
 *
 * ## What it compares, and what it deliberately does not
 *
 * Columns, types, and nullability are compared exactly. Uniqueness is compared as
 * coverage (which column tuples are uniquely constrained) rather than by index name,
 * because the two arrive at it differently and equivalently: upstream marks the column
 * `unique` in `CREATE TABLE` (SQLite then makes an implicit `sqlite_autoindex_*`), while
 * we emit a named `CREATE UNIQUE INDEX`. We do it uniformly because `ADD COLUMN` cannot
 * introduce a `UNIQUE` column at all, so the index form is the only one that works on
 * both paths. Comparing names would fail on a difference that enforces nothing
 * differently.
 */

const SECRET = "lunora-parity-secret-lunora-parity-secret";

const scimOptions = {
    connections: [{ credentials: [{ id: "primary", token: "parity-token", type: "bearer" as const }], id: "okta-acme" }], // secret-scanner:allow
};

/** A table's columns as `name:type:notnull`, sorted. */
type ColumnFacts = string[];

interface SchemaSnapshot {
    /** Column facts per table name. */
    tables: Record<string, ColumnFacts>;
    /** Uniquely-constrained column tuples per table, e.g. `user` → `["email"]`. */
    uniqueness: Record<string, string[]>;
}

/** Read back what SQLite actually built, so the comparison is of effect rather than text. */
const snapshotOf = (apply: (database: DatabaseSync) => void): SchemaSnapshot => {
    const database = new DatabaseSync(":memory:");

    apply(database);

    const tableNames = database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all()
        .map((row) => String(row.name));

    const tables: Record<string, ColumnFacts> = {};
    const uniqueness: Record<string, string[]> = {};

    for (const table of tableNames) {
        tables[table] = database
            .prepare(`SELECT name, type, "notnull" FROM pragma_table_info(?) ORDER BY name`)
            .all(table)
            .map((column) => `${String(column.name)}:${String(column.type).toLowerCase()}:notnull=${String(column.notnull)}`);

        // Every unique constraint, however it was declared — a named UNIQUE index and a
        // column-level `unique` both show up here, which is the point.
        const unique = database
            .prepare(`SELECT name FROM pragma_index_list(?) WHERE "unique" = 1`)
            .all(table)
            .map((index) => {
                const columns = database
                    .prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`)
                    .all(String(index.name))
                    .map((column) => String(column.name));

                return columns.join(",");
            });

        uniqueness[table] = unique.toSorted((a, b) => a.localeCompare(b));
    }

    return { tables, uniqueness };
};

/** Ask better-auth to compile its own SQLite DDL for these options. */
const upstreamDdl = async (options: Parameters<typeof resolveAuthOptions>[0]): Promise<string> => {
    // A throwaway database purely so the migrator has an empty schema to diff against;
    // `compileMigrations` returns SQL rather than executing it.
    const dialect = new SqliteDialect({ database: new BetterSqlite3(":memory:") });
    const { compileMigrations } = await getMigrations({
        ...resolveAuthOptions(options),
        database: { dialect, type: "sqlite" },
    });

    return compileMigrations();
};

/** Apply better-auth's compiled DDL to a fresh database. */
const upstreamSnapshot = async (options: Parameters<typeof resolveAuthOptions>[0]): Promise<SchemaSnapshot> => {
    const ddl = await upstreamDdl(options);

    return snapshotOf((database) => {
        database.exec(ddl);
    });
};

/** Apply our statements to a fresh database. */
const ourSnapshot = (options: Parameters<typeof resolveAuthOptions>[0]): SchemaSnapshot =>
    snapshotOf((database) => {
        for (const statement of authDoSchemaStatements(resolveAuthOptions(options))) {
            database.exec(statement);
        }
    });

describe("do schema parity with better-auth's own migrator", () => {
    it("builds the same tables and columns for a core config", async () => {
        expect.assertions(2);

        const options = { secret: SECRET };
        const ours = ourSnapshot(options);
        const theirs = await upstreamSnapshot(options);

        expect(Object.keys(ours.tables)).toStrictEqual(Object.keys(theirs.tables));
        expect(ours.tables).toStrictEqual(theirs.tables);
    });

    it("enforces the same uniqueness, however each side declares it", async () => {
        expect.assertions(1);

        const options = { secret: SECRET };
        const ours = ourSnapshot(options);
        const theirs = await upstreamSnapshot(options);

        expect(ours.uniqueness).toStrictEqual(theirs.uniqueness);
    });

    it("agrees on a plugin-heavy config, where the tables are generated rather than fixed", async () => {
        expect.assertions(2);

        // `admin` adds columns to `user`; `scim` adds seven tables of its own;
        // `inviteOnly` adds one with a UNIQUE string column. If the mirror is going
        // to drift anywhere, it is on plugin-contributed schema.
        const options = { plugins: [scim(scimOptions), admin(), inviteOnly()], secret: SECRET };
        const ours = ourSnapshot(options);
        const theirs = await upstreamSnapshot(options);

        expect(ours.tables).toStrictEqual(theirs.tables);
        expect(ours.uniqueness).toStrictEqual(theirs.uniqueness);
    });
});
