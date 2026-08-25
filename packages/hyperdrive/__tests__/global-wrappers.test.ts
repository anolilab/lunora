import type { ColumnMetaLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { runSqlGlobalTableMigrations } from "@lunora/sql-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMysqlGlobalCtxDb, createPostgresGlobalCtxDb } from "../src/global";
import { postgresDialect } from "../src/global-dialect";
import type { Mysql2Execute } from "../src/global-exec";
import type { PgliteHarness } from "./_helpers/pglite-exec";
import createPgliteHarness from "./_helpers/pglite-exec";

/**
 * The two documented convenience entry points — README and docs both tell users
 * to call these rather than wiring the generic store factory to an exec builder
 * themselves. What they own is the composition: pick the engine's dialect, build the exec
 * from the driver handle they were passed. Postgres is proved end to end against
 * the embedded engine; MySQL — whose real server is a slow, skippable download —
 * is proved by the dialect the rendered statements are in (backticks and `?`,
 * never `"…"` and `$1`).
 */
const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return {
        _meta: { column: { notNull: true, ...column } },
        kind,
    };
};

const todosSchema: SchemaLike = {
    tables: {
        todos: {
            indexes: [],
            shape: { done: col("boolean"), title: col("string") },
            shardMode: { kind: "global" },
        },
    },
};

describe("createPostgresGlobalCtxDb", () => {
    let harness: PgliteHarness;

    beforeEach(async () => {
        harness = await createPgliteHarness();
        await runSqlGlobalTableMigrations(harness.exec, todosSchema, postgresDialect);
    });

    afterEach(async () => {
        await harness.close();
    });

    it("builds a working Postgres writer from a bare row-client", async () => {
        expect.assertions(2);

        const writer = createPostgresGlobalCtxDb(harness.client, { clock: () => FIXED_CLOCK, schema: todosSchema });

        await writer.insert("todos", { _id: "t1", done: false, title: "write tests" }, { allowExplicitId: true });

        await expect(writer.findFirst("todos", { where: { _id: "t1" } })).resolves.toMatchObject({ _id: "t1", done: false, title: "write tests" });

        // The row really landed in Postgres' own column-per-field layout, so the
        // wrapper selected the Postgres dialect (a MySQL one would not have run
        // at all) and routed writes through the client it was handed.
        await expect(harness.query("SELECT title FROM todos WHERE id = $1", ["t1"])).resolves.toStrictEqual([{ title: "write tests" }]);
    });
});

describe("createMysqlGlobalCtxDb", () => {
    /** A never-connected `mysql2/promise` double that records what it is asked to run. */
    const recordingConnection = (): { calls: string[]; connection: Mysql2Execute } => {
        const calls: string[] = [];

        return {
            calls,
            connection: {
                // `CLIENT_FOUND_ROWS`; without it `buildMysqlExec` throws before recording anything.
                config: { clientFlags: 0x00_00_00_02 },
                execute: async (sql: string) => {
                    calls.push(sql);

                    return /^\s*select/i.test(sql)
                        ? ([[], undefined] as [Record<string, unknown>[], undefined])
                        : ([{ affectedRows: 1 }, undefined] as [Record<string, unknown>, undefined]);
                },
            },
        };
    };

    it("renders MySQL, not Postgres, through the connection it was handed", async () => {
        expect.assertions(3);

        const { calls, connection } = recordingConnection();
        const writer = createMysqlGlobalCtxDb(connection, { clock: () => FIXED_CLOCK, schema: todosSchema });

        await writer.insert("todos", { _id: "t1", done: false, title: "write tests" }, { allowExplicitId: true });

        const insert = calls.find((sql) => /^\s*insert/i.test(sql));

        expect(insert).toContain("`todos`");
        expect(insert).toContain("?");
        expect(insert).not.toMatch(/\$\d/);
    });
});
