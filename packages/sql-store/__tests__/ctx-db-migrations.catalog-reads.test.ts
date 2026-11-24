import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../src/ctx-db";
import type { SqlCtxExec } from "../src/sql-exec";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * A provisioning pass reads `sqlite_master` once for its index shapes, not once per declared index. `sqlite_master` has no
 * index to seek, so every lookup scans the whole catalog; the number of catalog reads must not grow with the index count.
 */
const dialect = makeSqliteDialect();

const column = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const schemaWithIndexes = (indexCount: number): SchemaLike => {
    const shape: Record<string, ValidatorLike> = { slug: column("string") };
    const indexes: { fields: string[]; name: string }[] = [];

    for (let index = 0; index < indexCount; index += 1) {
        const field = `f${String(index)}`;

        shape[field] = column("string");
        indexes.push({ fields: [field], name: `by_${field}` });
    }

    return { tables: { notes: { indexes, rankIndexes: [], shape, shardMode: { kind: "global" } } } } as never;
};

/** Provision the database once, then count the `sqlite_master` reads of a second pass over it (a warm wake). */
const catalogReadsOfWarmPass = async (indexCount: number): Promise<number> => {
    const harness = createSqliteHarness();

    try {
        const schema = schemaWithIndexes(indexCount);

        await createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema }).findMany("notes", { limit: 1 });

        let catalogReads = 0;
        const counting: SqlCtxExec = {
            ...harness.exec,
            all: (query, parameters) => {
                if (query.includes("sqlite_master")) {
                    catalogReads += 1;
                }

                return harness.exec.all(query, parameters);
            },
        };

        await createSqlCtxDb({ clock: () => 1, dialect, exec: counting, schema }).findMany("notes", { limit: 1 });

        return catalogReads;
    } finally {
        harness.close();
    }
};

describe("sqlite_master reads in a global provisioning pass", () => {
    it("does not grow with the number of declared indexes", async () => {
        expect.assertions(2);

        const oneIndex = await catalogReadsOfWarmPass(1);
        const eightIndexes = await catalogReadsOfWarmPass(8);

        expect(oneIndex).toBeGreaterThan(0);
        expect(eightIndexes).toBe(oneIndex);
    });
});
