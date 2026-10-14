import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { columnNamesOfCreateTable, runSqlGlobalTableMigrations } from "../src/ctx-db-global-provisioning";
import type { SqlCtxExec } from "../src/sql-exec";
import { BIGINT_KEY_LENGTH } from "../src/value-codec";
import { createSqliteBatchHarness, createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * Provisioning on an exec with `batch` reads the catalog and writes the missing DDL in a few atomic
 * batches; without `batch` it runs statement by statement. The two must end in the same database, and the batched one
 * must only ever do LESS than the sequential one. A table that needs an ALTER, or whose batch fails, is handed to the
 * sequential path rather than approximated.
 */

const dialect = makeSqliteDialect();

const column = (kind: string, extra: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...extra } }, kind };
};

const optional = (inner: ValidatorLike): ValidatorLike => ({ _meta: inner._meta, inner, kind: "optional" }) as ValidatorLike;

/** A table shaped like a real app's: scalar columns, an optional one, two secondary indexes, and (every 5th) a unique column. */
const tableAt = (position: number, extraField?: string): SchemaLike["tables"][string] => {
    const shape: Record<string, ValidatorLike> = {
        body: optional(column("string")),
        createdBy: column("string"),
        done: column("boolean"),
        score: column("number"),
        title: column("string"),
    };

    if (position % 4 === 0) {
        shape["amount"] = column("bigint");
    }

    if (position % 6 === 0) {
        shape["payload"] = column("any");
    }

    if (position % 5 === 0) {
        shape["slug"] = column("string", { unique: true });
    }

    if (extraField !== undefined) {
        shape[extraField] = column("string");
    }

    return {
        indexes: [
            { fields: ["createdBy"], name: "by_creator" },
            { fields: ["done", "score"], name: "by_state" },
        ],
        shape,
        shardMode: { kind: "global" },
    } as unknown as SchemaLike["tables"][string];
};

const schemaOf = (count: number, overrides: Record<number, string> = {}): SchemaLike => {
    return {
        tables: Object.fromEntries(Array.from({ length: count }, (_, index) => [`table_${String(index)}`, tableAt(index, overrides[index])])),
    };
};

/** Everything the engine holds that provisioning is responsible for, in a comparable order. */
const catalogOf = (database: { prepare: (query: string) => { all: () => unknown[] } }): { markers: unknown[]; objects: unknown[] } => {
    return {
        markers: (database.prepare("SELECT name FROM __lunora_migration_state ORDER BY name").all() as { name: string }[]).map((row) => row.name),
        objects: database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
    };
};

/** The catalog a provisioned database ends with when provisioned statement by statement (an exec with no `batch`). */
const sequentialCatalog = async (schema: SchemaLike): Promise<{ markers: unknown[]; objects: unknown[]; trips: number }> => {
    const base = createSqliteHarness();
    let trips = 0;
    const exec: SqlCtxExec = {
        all: (query, parameters) => {
            trips += 1;

            return base.exec.all(query, parameters);
        },
        run: (query, parameters) => {
            trips += 1;

            return base.exec.run(query, parameters);
        },
    };

    await runSqlGlobalTableMigrations(exec, schema, dialect);

    // The harness hides its database; re-derive the catalog through the exec.
    const objects = await base.exec.all("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name", []);
    const markerRows = await base.exec.all("SELECT name FROM __lunora_migration_state ORDER BY name", []);
    const markers = markerRows.map((row) => row["name"]);

    base.close();

    return { markers, objects, trips };
};

describe("batched .global() provisioning", () => {
    it("ends in the same database as the statement-by-statement path", async () => {
        expect.assertions(2);

        const schema = schemaOf(42);
        const sequential = await sequentialCatalog(schema);
        const harness = createSqliteBatchHarness();

        await runSqlGlobalTableMigrations(harness.exec, schema, dialect);

        expect(catalogOf(harness.database)).toEqual({ markers: sequential.markers, objects: sequential.objects });
        expect(sequential.markers.length).toBeGreaterThan(0);

        harness.close();
    });

    it("provisions a fresh database in a handful of round trips instead of one per statement", async () => {
        expect.assertions(2);

        const schema = schemaOf(42);
        const sequential = await sequentialCatalog(schema);
        const harness = createSqliteBatchHarness();

        await runSqlGlobalTableMigrations(harness.exec, schema, dialect);

        // The catalog (one read, plus the marker table's rows when it exists) plus ceil(statements / 50) batches.
        expect(harness.trips()).toBeLessThanOrEqual(10);
        expect(sequential.trips).toBeGreaterThan(300);

        harness.close();
    });

    it("sends no write when the database is already provisioned", async () => {
        expect.assertions(2);

        const schema = schemaOf(42);
        const harness = createSqliteBatchHarness();

        await runSqlGlobalTableMigrations(harness.exec, schema, dialect);

        const before = harness.trips();
        const writes: string[] = [];
        const exec: SqlCtxExec = {
            ...harness.exec,
            batch: (statements) => {
                writes.push(...statements.map((statement) => statement.sql));

                return harness.exec.batch?.(statements) ?? Promise.resolve();
            },
            run: (query, parameters) => {
                writes.push(query);

                return harness.exec.run(query, parameters);
            },
        };

        await runSqlGlobalTableMigrations(exec, schema, dialect);

        expect(writes).toEqual([]);
        expect(harness.trips() - before).toBe(2);

        harness.close();
    });

    it("adds only the new table when the schema grows", async () => {
        expect.assertions(2);

        const harness = createSqliteBatchHarness();

        await runSqlGlobalTableMigrations(harness.exec, schemaOf(10), dialect);

        const before = harness.trips();

        await runSqlGlobalTableMigrations(harness.exec, schemaOf(11), dialect);

        // Two catalog reads and one batch for the single new table.
        expect(harness.trips() - before).toBe(3);

        const expected = await sequentialCatalog(schemaOf(11));

        expect(catalogOf(harness.database)).toEqual({ markers: expected.markers, objects: expected.objects });

        harness.close();
    });

    it("hands a table that needs an ALTER to the sequential path", async () => {
        expect.assertions(1);

        const harness = createSqliteBatchHarness();

        await runSqlGlobalTableMigrations(harness.exec, schemaOf(6), dialect);
        await runSqlGlobalTableMigrations(harness.exec, schemaOf(6, { 2: "label" }), dialect);

        const columns = harness.database.prepare("SELECT name FROM pragma_table_info('table_2')").all() as { name: string }[];

        expect(columns.map((row) => row.name)).toContain("label");

        harness.close();
    });

    it("leaves an index whose stored columns differ to the sequential path, which re-creates it", async () => {
        expect.assertions(2);

        const schema = schemaOf(3);
        const harness = createSqliteBatchHarness();

        await runSqlGlobalTableMigrations(harness.exec, schema, dialect);
        harness.database.exec('DROP INDEX "table_1_by_creator"; CREATE INDEX "table_1_by_creator" ON "table_1" ("title")');
        await runSqlGlobalTableMigrations(harness.exec, schema, dialect);

        const held = harness.database.prepare("SELECT sql FROM sqlite_master WHERE name = 'table_1_by_creator'").all() as { sql: string }[];

        expect(held[0]?.sql).toContain('"createdBy"');
        expect(held[0]?.sql).not.toContain('("title")');

        harness.close();
    });

    // SQLite folds identifier case, so a table stored as "Table_0" IS the declared "table_0". Treating it as new left the
    // `CREATE TABLE IF NOT EXISTS` a no-op and skipped the repair of its missing columns.
    it("repairs the columns of an existing table whose stored name differs from the declared one only in case", async () => {
        expect.assertions(2);

        const harness = createSqliteBatchHarness();

        harness.database.exec('CREATE TABLE "Table_0" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL)');

        // No declared indexes: nothing in the new-table plan references a missing column, so a misclassified table
        // would not even fail its batch and fall back; it would just never be repaired.
        const bare = { tables: { table_0: { ...tableAt(1), indexes: [] } } } as unknown as SchemaLike;

        await runSqlGlobalTableMigrations(harness.exec, bare, dialect);

        const columns = (harness.database.prepare("SELECT name FROM pragma_table_info('table_0')").all() as { name: string }[]).map((row) => row.name);

        expect(columns).toContain("title");
        expect(columns).toContain("_version");

        harness.close();
    });

    it("does not re-create an index whose stored name differs from the declared one only in case", async () => {
        expect.assertions(1);

        const harness = createSqliteBatchHarness();

        await runSqlGlobalTableMigrations(harness.exec, schemaOf(2), dialect);
        harness.database.exec('DROP INDEX "table_1_by_creator"; CREATE INDEX "TABLE_1_BY_CREATOR" ON "table_1" ("createdBy", "_creationTime", "id")');

        const writes: string[] = [];

        await runSqlGlobalTableMigrations(
            {
                ...harness.exec,
                batch: (statements) => {
                    writes.push(...statements.map((statement) => statement.sql));

                    return harness.exec.batch?.(statements) ?? Promise.resolve();
                },
            },
            schemaOf(2),
            dialect,
        );

        expect(writes.filter((statement) => /by_creator/iu.test(statement))).toEqual([]);

        harness.close();
    });

    it("re-records a missing rewrite marker on an existing table instead of skipping it", async () => {
        expect.assertions(1);

        const schema = schemaOf(8);
        const harness = createSqliteBatchHarness();

        await runSqlGlobalTableMigrations(harness.exec, schema, dialect);
        harness.database.exec("DELETE FROM __lunora_migration_state");
        await runSqlGlobalTableMigrations(harness.exec, schema, dialect);

        const expected = await sequentialCatalog(schema);

        expect(catalogOf(harness.database).markers).toEqual(expected.markers);

        harness.close();
    });

    it("never records a rewrite as finished over legacy rows when the catalog it read was stale", async () => {
        expect.assertions(4);

        const schema = schemaOf(4);
        const harness = createSqliteBatchHarness();

        await runSqlGlobalTableMigrations(harness.exec, schema, dialect);

        // table_0 carries a bigint column. Put it back in the state of a database provisioned before the key encoding:
        // decimal text in the column, and no record that the rewrite ran.
        harness.database.exec("DELETE FROM __lunora_migration_state");
        harness.database.exec("INSERT INTO table_0 (id, _creationTime, title, createdBy, done, score, slug, amount) VALUES ('a', 1, 't', 'c', 0, 1, 's', '5')");

        // A read that does not see table_0 (a lagging replica): the planner believes the table is new.
        const stale: SqlCtxExec = {
            ...harness.exec,
            all: async (query, parameters) => {
                const rows = await harness.exec.all(query, parameters);

                return query.includes("FROM sqlite_master WHERE type IN") ? rows.filter((row) => !String(row["name"]).startsWith("table_0")) : rows;
            },
        };

        await runSqlGlobalTableMigrations(stale, schema, dialect);

        const recorded = (harness.database.prepare("SELECT name FROM __lunora_migration_state").all() as { name: string }[]).map((row) => row.name);

        expect(recorded).not.toContain("bigint-key:table_0");

        // The next sweep reads a true catalog, finds the marker missing, and runs the rewrite.
        await runSqlGlobalTableMigrations(harness.exec, schema, dialect);

        const row = harness.database.prepare("SELECT amount FROM table_0 WHERE id = 'a'").all() as { amount: string }[];
        const after = (harness.database.prepare("SELECT name FROM __lunora_migration_state").all() as { name: string }[]).map((entry) => entry.name);

        expect(row[0]?.amount).toHaveLength(BIGINT_KEY_LENGTH);
        expect(row[0]?.amount).not.toBe("5");
        expect(after).toContain("bigint-key:table_0");

        harness.close();
    });

    it("rolls a failed batch back whole and falls back to the sequential path", async () => {
        expect.assertions(2);

        const schema = schemaOf(12);
        const harness = createSqliteBatchHarness();
        let failed = false;
        const exec: SqlCtxExec = {
            ...harness.exec,
            batch: (statements) => {
                if (!failed) {
                    failed = true;

                    // Apply a prefix through the real transaction, then fail: nothing of it may survive.
                    return harness.exec.batch?.([...statements.slice(0, 3), { params: [], sql: "THIS IS NOT SQL" }]) ?? Promise.resolve();
                }

                return harness.exec.batch?.(statements) ?? Promise.resolve();
            },
        };

        await runSqlGlobalTableMigrations(exec, schema, dialect);

        const sequential = await sequentialCatalog(schema);

        expect(failed).toBe(true);
        expect(catalogOf(harness.database)).toEqual({ markers: sequential.markers, objects: sequential.objects });

        harness.close();
    });

    it("reports a unique index over duplicate rows with the diagnostic the sequential path gives", async () => {
        expect.assertions(1);

        const harness = createSqliteBatchHarness();
        const plain = schemaOf(2);

        await runSqlGlobalTableMigrations(harness.exec, plain, dialect);

        harness.database.exec(
            "INSERT INTO table_1 (id, _creationTime, title, createdBy, done, score) VALUES ('a', 1, 't', 'same', 0, 1), ('b', 2, 't', 'same', 0, 1)",
        );

        const unique = {
            tables: {
                ...plain.tables,
                table_1: { ...plain.tables["table_1"], indexes: [{ fields: ["createdBy"], name: "by_creator_unique", unique: true }] },
            },
        } as unknown as SchemaLike;

        await expect(runSqlGlobalTableMigrations(harness.exec, unique, dialect)).rejects.toThrow(/unique index "table_1_by_creator_unique"/u);

        harness.close();
    });

    it("provisions sequentially when the catalog read is refused", async () => {
        expect.assertions(1);

        const schema = schemaOf(6);
        const harness = createSqliteBatchHarness();
        const exec: SqlCtxExec = {
            ...harness.exec,
            all: (query, parameters) =>
                query.includes("FROM sqlite_master WHERE type IN") ? Promise.reject(new Error("not authorized")) : harness.exec.all(query, parameters),
        };

        await runSqlGlobalTableMigrations(exec, schema, dialect);

        const sequential = await sequentialCatalog(schema);

        expect(catalogOf(harness.database)).toEqual({ markers: sequential.markers, objects: sequential.objects });

        harness.close();
    });
});

describe("columnNamesOfCreateTable", () => {
    it("reads the columns a Lunora table is created with", () => {
        expect.assertions(1);

        const names = columnNamesOfCreateTable(
            'CREATE TABLE "notes" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "_version" INTEGER, "body" TEXT NOT NULL)',
        );

        expect([...names]).toEqual(["id", "_creationTime", "_version", "body"]);
    });

    it("reads a column appended by ALTER TABLE ADD COLUMN, which rewrites the stored text", () => {
        expect.assertions(1);

        expect(columnNamesOfCreateTable('CREATE TABLE "notes" ("id" TEXT PRIMARY KEY, "body" TEXT, "slug" TEXT)').has("slug")).toBe(true);
    });

    it("does not split on commas or parentheses inside a type, a default or a quoted name", () => {
        expect.assertions(1);

        const names = columnNamesOfCreateTable(
            `CREATE TABLE "weird" ("a,b" TEXT, "c(d" TEXT DEFAULT ('x,y'), price NUMERIC(10, 2), "q""r" TEXT, [br] TEXT, \`tick\` TEXT)`,
        );

        expect([...names]).toEqual(["a,b", "c(d", "price", 'q"r', "br", "tick"]);
    });

    it("finds nothing in a statement it cannot read, so the caller treats every column as missing", () => {
        expect.assertions(2);

        expect(columnNamesOfCreateTable("not a create statement").size).toBe(0);
        expect(columnNamesOfCreateTable('CREATE TABLE "t" (').size).toBe(0);
    });
});
