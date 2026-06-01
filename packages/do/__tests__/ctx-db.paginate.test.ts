import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

/**
 * Exercises the reader's `.paginate()` surface against a real SQLite engine —
 * the keyset seek, `json_extract` ordering, and over-fetch boundary only
 * behave correctly on a genuine engine, so (per AGENTS.md) we never run these
 * through the SQL-string fake.
 */
const todosSchema: SchemaLike = {
    tables: {
        todos: {
            indexes: [
                { fields: ["projectId", "seq"], name: "by_project_seq" },
                { fields: ["seq"], name: "by_seq" },
            ],
            shape: {
                archived: { kind: "boolean" },
                projectId: { kind: "string" },
                seq: { kind: "number" },
            },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, todosSchema);

    return createShardCtxDb({
        clock: () => 1_700_000_000_000,
        schema: todosSchema,
        sql: harness.sql,
    });
};

/** Seed four p1 todos (seq 0..3 ⇒ t5,t1,t2,t3 in seq order) and one p2 todo. */
const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("todos", { _id: "t1", archived: true, projectId: "p1", seq: 1 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t2", archived: false, projectId: "p1", seq: 2 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t3", archived: false, projectId: "p1", seq: 3 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t4", archived: false, projectId: "p2", seq: 4 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t5", archived: false, projectId: "p1", seq: 0 }, { allowExplicitId: true });
};

const ids = (docs: Array<Record<string, unknown>>): unknown[] => docs.map((doc) => doc["_id"]);

describe("ctx-db paginate", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("reader.paginate — index ordering", () => {
        test("walks pages via continueCursor, covering every matching row exactly once", async () => {
            expect.assertions(6);

            const writer = setupWriter();

            await seed(writer);

            const first = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ numItems: 2 });

            expect(ids(first.page)).toEqual(["t5", "t1"]);
            expect(first.isDone).toBe(false);
            expect(first.continueCursor).not.toBeNull();

            const second = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ cursor: first.continueCursor, numItems: 2 });

            expect(ids(second.page)).toEqual(["t2", "t3"]);
            expect(second.isDone).toBe(true);
            expect(second.continueCursor).toBeNull();
        });

        test("a final page that exactly fills numItems still reports isDone with no cursor", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await writer.insert("todos", { _id: "a", archived: false, projectId: "p1", seq: 1 }, { allowExplicitId: true });
            await writer.insert("todos", { _id: "b", archived: false, projectId: "p1", seq: 2 }, { allowExplicitId: true });

            const result = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ numItems: 2 });

            expect(ids(result.page)).toEqual(["a", "b"]);
            expect(result.isDone).toBe(true);
            expect(result.continueCursor).toBeNull();
        });

        test("numItems larger than the result set returns everything and is done", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await seed(writer);

            const result = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ numItems: 50 });

            expect(ids(result.page)).toEqual(["t5", "t1", "t2", "t3"]);
            expect(result.isDone).toBe(true);
            expect(result.continueCursor).toBeNull();
        });

        test("an empty table yields an empty done page", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            const result = await writer.query("todos").paginate({ numItems: 5 });

            expect(result.page).toEqual([]);
            expect(result.isDone).toBe(true);
            expect(result.continueCursor).toBeNull();
        });

        test("the seek is stable when a row is inserted before the cursor between pages", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await seed(writer);

            const first = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ numItems: 2 });

            // seq 0.5 sorts before the cursor position (t1, seq 1) — keyset paging
            // must neither leak it into nor shift the next page.
            await writer.insert("todos", { _id: "t6", archived: false, projectId: "p1", seq: 0.5 }, { allowExplicitId: true });

            const second = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ cursor: first.continueCursor, numItems: 2 });

            expect(ids(second.page)).toEqual(["t2", "t3"]);
        });
    });

    describe("reader.paginate — with .filter()", () => {
        test("applies the in-memory predicate while keeping the cursor on a returned row", async () => {
            expect.assertions(6);

            const writer = setupWriter();

            await seed(writer);

            const first = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .filter((document) => document["archived"] === false)
                .paginate({ numItems: 2 });

            // t1 (archived) is skipped, so the page is t5 then t2.
            expect(ids(first.page)).toEqual(["t5", "t2"]);
            expect(first.isDone).toBe(false);
            expect(first.continueCursor).not.toBeNull();

            const second = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .filter((document) => document["archived"] === false)
                .paginate({ cursor: first.continueCursor, numItems: 2 });

            expect(ids(second.page)).toEqual(["t3"]);
            expect(second.isDone).toBe(true);
            expect(second.continueCursor).toBeNull();
        });
    });
});
