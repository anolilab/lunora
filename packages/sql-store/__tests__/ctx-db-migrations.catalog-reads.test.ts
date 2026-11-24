import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../src/ctx-db";
import type { SqlCtxExec } from "../src/sql-exec";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * A provisioning pass reads `sqlite_master` for the index shapes it judges, not once per declared index. `sqlite_master` has
 * no index to seek, so every lookup scans the whole catalog; the reads must not grow with the index count, and a table with
 * no declared index must not read its catalog at all.
 */
const dialect = makeSqliteDialect();

const column = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const globalTable = (shape: Record<string, ValidatorLike>, indexes: { fields: string[]; name: string; unique?: boolean }[]): SchemaLike =>
    ({ tables: { notes: { indexes, rankIndexes: [], shape, shardMode: { kind: "global" } } } }) as never;

const schemaWithIndexes = (indexCount: number): SchemaLike => {
    const shape: Record<string, ValidatorLike> = { slug: column("string") };
    const indexes: { fields: string[]; name: string }[] = [];

    for (let index = 0; index < indexCount; index += 1) {
        const field = `f${String(index)}`;

        shape[field] = column("string");
        indexes.push({ fields: [field], name: `by_${field}` });
    }

    return globalTable(shape, indexes);
};

const isCatalogRead = (query: string): boolean => query.includes("sqlite_master");
const isTableCatalogRead = (query: string): boolean => query.includes("sqlite_master") && query.includes("WHERE tbl_name");

/** Provision the database once, then count the reads `matches` selects during a second pass over it (a warm wake). */
const warmPassReads = async (schema: SchemaLike, matches: (query: string) => boolean): Promise<number> => {
    const harness = createSqliteHarness();

    try {
        await createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema }).findMany("notes", { limit: 1 });

        let reads = 0;
        const counting: SqlCtxExec = {
            ...harness.exec,
            all: (query, parameters) => {
                if (matches(query)) {
                    reads += 1;
                }

                return harness.exec.all(query, parameters);
            },
        };

        await createSqlCtxDb({ clock: () => 1, dialect, exec: counting, schema }).findMany("notes", { limit: 1 });

        return reads;
    } finally {
        harness.close();
    }
};

describe("sqlite_master reads in a global provisioning pass", () => {
    it("does not grow with the number of declared indexes", async () => {
        expect.assertions(2);

        const oneIndex = await warmPassReads(schemaWithIndexes(1), isCatalogRead);
        const eightIndexes = await warmPassReads(schemaWithIndexes(8), isCatalogRead);

        expect(oneIndex).toBeGreaterThan(0);
        expect(eightIndexes).toBe(oneIndex);
    });

    it("reads no table catalog for a table with no declared index", async () => {
        expect.assertions(1);

        await expect(warmPassReads(schemaWithIndexes(0), isTableCatalogRead)).resolves.toBe(0);
    });
});

describe("case-variant index names in one provisioning pass", () => {
    it("judges a case-variant declaration against the index the same run has just created", async () => {
        expect.assertions(3);

        // Both declarations fold to `notes_by_slug`: the second is UNIQUE on a different column, so it must replace the first.
        const schema = globalTable({ slug: column("string"), title: column("string") }, [
            { fields: ["slug"], name: "by_slug" },
            { fields: ["title"], name: "BY_SLUG", unique: true },
        ]);
        const harness = createSqliteHarness();

        try {
            await createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema }).findMany("notes", { limit: 1 });

            const rows = await harness.exec.all(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'notes_by_slug' COLLATE NOCASE`, []);
            const statement = String(rows[0]?.["sql"]);

            expect(rows).toHaveLength(1);
            expect(statement).toMatch(/UNIQUE/u);
            expect(statement).toContain("title");
        } finally {
            harness.close();
        }
    });
});
