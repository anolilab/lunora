import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { runSqlRankMigrations } from "../src/ctx-db-migrations";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

const col = (): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind: "number" };
};

const schemaWithSortKeys = (count: number): SchemaLike => {
    const fields = Array.from({ length: count }, (_, i) => `f${String(i)}`);

    return {
        tables: {
            scores: {
                indexes: [],
                rankIndexes: [
                    {
                        name: "wide",
                        on: "scores",
                        sortBy: fields.map((field) => {
                            return { direction: "asc", field };
                        }),
                    },
                ],
                shape: Object.fromEntries(fields.map((field) => [field, col()])),
                shardMode: { kind: "global" },
            },
        },
    } as unknown as SchemaLike;
};

describe(runSqlRankMigrations, () => {
    it("refuses a rank index too wide for a rebuild's insert to bind", async () => {
        expect.assertions(2);

        const harness = createSqliteHarness();

        try {
            // 2 framework columns + 2 fence parameters + the sort keys must fit one 100-parameter statement.
            await expect(runSqlRankMigrations(harness.exec, schemaWithSortKeys(97), makeSqliteDialect())).rejects.toThrow(/sort keys/u);
            await expect(runSqlRankMigrations(harness.exec, schemaWithSortKeys(96), makeSqliteDialect())).resolves.toBeUndefined();
        } finally {
            harness.close();
        }
    });
});
