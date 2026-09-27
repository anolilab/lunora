import type { SchemaIR, ValidatorIR } from "@lunora/codegen";
import { describe, expect, it } from "vitest";

import { diffSnapshots, renderCreateTable } from "../../src/util/migration-diff";
import schemaIrToSnapshot from "../../src/util/schema-snapshot";

const field = (kind: string, column?: { notNull: boolean }): ValidatorIR => (column ? { column, kind } : { kind });

const schema = (shape: Record<string, ValidatorIR>): SchemaIR => {
    return {
        tables: [
            {
                indexes: [],
                name: "posts",
                rankIndexes: [],
                relations: [],
                searchIndexes: [],
                shape,
                shardMode: "global",
                vectorIndexes: [],
            },
        ],
        vectorIndexes: [],
    };
};

/**
 * `migrate generate` must emit the same DDL the runtime auto-provisioner would
 * create for the same table — `@lunora/d1`'s dialect promises the two are
 * byte-identical, and a mismatch means a table created from the migration file
 * rejects a value the same table created at runtime accepts.
 *
 * The runtime rule (`ctx-db-migrations.ts`) is `NOT NULL` iff the column is
 * `notNull` AND not `v.optional(...)`; `.nullable()` clears `notNull`. The CLI
 * looked only at `v.optional`, so a `.nullable()` column emitted `NOT NULL` and
 * the migrated table refused the null the column exists to accept.
 */
describe("schemaIrToSnapshot", () => {
    it("marks a `.nullable()` column nullable, so no NOT NULL is emitted", () => {
        expect.assertions(2);

        const snapshot = schemaIrToSnapshot(schema({ title: field("string", { notNull: false }) }));

        expect(snapshot.tables["posts"]?.columns["title"]?.nullable).toBe(true);
        expect(renderCreateTable(snapshot.tables["posts"]!)).toMatch(/"title" TEXT$/m);
    });

    it("keeps NOT NULL on a plain required column", () => {
        expect.assertions(2);

        const snapshot = schemaIrToSnapshot(schema({ title: field("string", { notNull: true }) }));

        expect(snapshot.tables["posts"]?.columns["title"]?.nullable).toBe(false);
        expect(renderCreateTable(snapshot.tables["posts"]!)).toContain('"title" TEXT NOT NULL');
    });

    it("keeps a `v.optional()` column nullable", () => {
        expect.assertions(1);

        const snapshot = schemaIrToSnapshot(schema({ title: { inner: field("string", { notNull: true }), kind: "optional" } }));

        expect(snapshot.tables["posts"]?.columns["title"]?.nullable).toBe(true);
    });

    it("emits no NOT NULL for a required kind that accepts null", () => {
        expect.assertions(2);

        const required = { notNull: true };
        const snapshot = schemaIrToSnapshot(
            schema({
                anything: field("any", required),
                literalNull: { column: required, kind: "literal", literalValue: "null" },
                note: { column: required, kind: "union", members: [field("string"), field("null")] },
                onlyNull: field("null", required),
                // Neither member accepts null, so the constraint stays.
                either: { column: required, kind: "union", members: [field("string"), field("number")] },
            }),
        );
        const table = snapshot.tables["posts"]!;

        expect(Object.fromEntries(Object.entries(table.columns).map(([name, column]) => [name, column.nullable]))).toStrictEqual({
            anything: true,
            either: false,
            literalNull: true,
            note: true,
            onlyNull: true,
        });
        expect(renderCreateTable(table)).toContain('"either" TEXT NOT NULL');
    });

    it("points a relaxed column on an existing table at the rebuild recipe", () => {
        expect.assertions(1);

        const before = schemaIrToSnapshot(schema({ note: field("string", { notNull: true }) }));
        const after = schemaIrToSnapshot(schema({ note: { column: { notNull: true }, kind: "union", members: [field("string"), field("null")] } }));

        expect(diffSnapshots(before, after).unsupported.map((entry) => entry.summary)).toContainEqual(
            expect.stringMatching(
                /nullability change on posts\.note: NOT NULL → NULL \(rebuild the table — https:\/\/lunora\.sh\/docs\/concepts\/migrations#relaxing-not-null-on-a-d1-table\)/u,
            ),
        );
    });

    it("marks `v.optional(v.string().nullable())` nullable", () => {
        expect.assertions(1);

        const snapshot = schemaIrToSnapshot(schema({ title: { inner: field("string", { notNull: false }), kind: "optional" } }));

        expect(snapshot.tables["posts"]?.columns["title"]?.nullable).toBe(true);
    });
});
