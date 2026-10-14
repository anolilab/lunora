import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";

/**
 * Hot-path cost of the two new read-layer features.
 *
 * Soft-delete scoping: a `.softDelete()` table ANDs `deletedAt IS NULL` into
 * every list read. Benched against an identical plain table so the
 * `json_extract(...) IS NULL` overhead is isolated.
 *
 * Select projection: `findMany({ select })` trims the returned payload in JS
 * after the rows decode. Benched against the full-document read.
 *
 * Row count is high enough (5 000) that the per-row work dominates fixed costs.
 */
const ROW_COUNT = 5000;

const plainSchema: SchemaLike = {
    tables: {
        todos: { indexes: [], shape: { archived: { kind: "boolean" }, priority: { kind: "string" }, projectId: { kind: "string" }, seq: { kind: "number" } } },
    },
};

const softSchema: SchemaLike = {
    tables: {
        todos: {
            indexes: [],
            shape: {
                archived: { kind: "boolean" },
                deletedAt: { kind: "number" },
                priority: { kind: "string" },
                projectId: { kind: "string" },
                seq: { kind: "number" },
            },
            softDeleteMode: { field: "deletedAt" },
        },
    },
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    for (let index = 0; index < ROW_COUNT; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seed, single-threaded SQLite
        await writer.insert("todos", { archived: index % 2 === 0, priority: "high", projectId: `p${String(index % 10)}`, seq: index });
    }
};

let plain: DatabaseWriterLike;
let soft: DatabaseWriterLike;

describe("soft-delete scoping + select projection", () => {
    beforeAll(async () => {
        const plainHarness = createSqliteExec();
        const softHarness = createSqliteExec();

        runShardMigrations(plainHarness.sql, plainSchema);
        runShardMigrations(softHarness.sql, softSchema);

        plain = createShardContextDatabase({ schema: plainSchema, sql: plainHarness.sql });
        soft = createShardContextDatabase({ schema: softSchema, sql: softHarness.sql });

        await seed(plain);
        await seed(soft);
    });

    bench("findMany — plain table (no scope)", async () => {
        await plain.findMany("todos", { where: { priority: "high" } });
    });

    bench("findMany — soft-delete table (deletedAt IS NULL scope)", async () => {
        await soft.findMany("todos", { where: { priority: "high" } });
    });

    bench("findMany — full document", async () => {
        await plain.findMany("todos", { where: { priority: "high" } });
    });

    bench("findMany — select projection (one field)", async () => {
        await plain.findMany("todos", { select: ["priority"], where: { priority: "high" } });
    });
});
