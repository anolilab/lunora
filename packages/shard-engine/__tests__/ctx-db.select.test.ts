import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `findMany`/`findFirst` field projection (`args.select`). The engine reads the
 * whole row (so dependency tracking + keyset cursors are unaffected) and trims
 * the returned payload to the selected fields plus the always-kept system fields
 * `_id`/`_creationTime`. Exercised against real SQLite so the projection runs on
 * actually-decoded documents.
 */
const todosSchema: SchemaLike = {
    tables: {
        todos: {
            indexes: [{ fields: ["projectId"], name: "by_project" }],
            shape: {
                archived: { kind: "boolean" },
                priority: { kind: "string" },
                projectId: { kind: "string" },
                seq: { kind: "number" },
            },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, todosSchema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: todosSchema, sql: harness.sql });
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("todos", { _id: "t1", archived: false, priority: "high", projectId: "p1", seq: 1 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t2", archived: false, priority: "medium", projectId: "p1", seq: 2 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t3", archived: true, priority: "low", projectId: "p1", seq: 3 }, { allowExplicitId: true });
};

describe("ctx-db findMany — select projection", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("trims each row to the selected fields plus _id/_creationTime", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        await seed(writer);

        const result = await writer.findMany("todos", { orderBy: [{ seq: "asc" }], select: ["priority"] });

        expect(result.page.map((document_) => Object.keys(document_).toSorted((a, b) => a.localeCompare(b)))).toStrictEqual([
            ["_creationTime", "_id", "priority"],
            ["_creationTime", "_id", "priority"],
            ["_creationTime", "_id", "priority"],
        ]);
        expect(result.page.map((document_) => document_["priority"])).toStrictEqual(["high", "medium", "low"]);
    });

    it("projects findFirst the same way", async () => {
        expect.assertions(1);

        const writer = setupWriter();

        await seed(writer);

        const first = await writer.findFirst("todos", { orderBy: [{ seq: "asc" }], select: ["projectId"] });

        expect(first).toStrictEqual({ _creationTime: 1_700_000_000_000, _id: "t1", projectId: "p1" });
    });

    it("returns the full document when select is omitted", async () => {
        expect.assertions(1);

        const writer = setupWriter();

        await seed(writer);

        const first = await writer.findFirst("todos", { orderBy: [{ seq: "asc" }] });

        expect(Object.keys(first ?? {}).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "_creationTime",
            "_id",
            "archived",
            "priority",
            "projectId",
            "seq",
        ]);
    });

    it("keeps keyset paging intact — the cursor is encoded from the full row, not the projection", async () => {
        expect.assertions(3);

        const writer = setupWriter();

        await seed(writer);

        // `seq` is not selected, yet ordering by it and paging must still work
        // because the cursor encodes the full (unprojected) row.
        const firstPage = await writer.findMany("todos", { limit: 2, orderBy: [{ seq: "asc" }], select: ["priority"] });

        expect(firstPage.page.map((document_) => document_["_id"])).toStrictEqual(["t1", "t2"]);
        expect(firstPage.isDone).toBe(false);

        const secondPage = await writer.findMany("todos", { cursor: firstPage.continueCursor, limit: 2, orderBy: [{ seq: "asc" }], select: ["priority"] });

        expect(secondPage.page.map((document_) => document_["_id"])).toStrictEqual(["t3"]);
    });
});
