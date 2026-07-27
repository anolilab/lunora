import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

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

    return createShardContextDatabase({
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

const ids = (docs: Record<string, unknown>[]): unknown[] => docs.map((document_) => document_["_id"]);

describe("ctx-db paginate", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("reader.paginate — index ordering", () => {
        it("walks pages via continueCursor, covering every matching row exactly once", async () => {
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

        it("a final page that exactly fills numItems still reports isDone with no cursor", async () => {
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

        it("numItems larger than the result set returns everything and is done", async () => {
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

        it("an empty table yields an empty done page", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            const result = await writer.query("todos").paginate({ numItems: 5 });

            expect(result.page).toEqual([]);
            expect(result.isDone).toBe(true);
            expect(result.continueCursor).toBeNull();
        });

        it("the seek is stable when a row is inserted before the cursor between pages", async () => {
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

    describe("reader.paginate — reactive range (start + end cursor)", () => {
        it("returns exactly the half-open range (start, end]", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await seed(writer);

            // Two adjacent pages over the p1 feed (t5, t1, t2, t3 in seq order).
            const first = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ numItems: 2 });

            // Re-fetch page 1 as a *bounded* page pinned to its own end cursor:
            // covers (null, C1] where C1 is page 1's continueCursor.
            const bounded = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ endCursor: first.continueCursor, numItems: 2 });

            // Exactly the rows up to and including the boundary — t5 and t1.
            expect(ids(bounded.page)).toEqual(["t5", "t1"]);
            // A bounded page is always done and echoes its fixed end cursor.
            expect(bounded.isDone).toBe(true);
            expect(bounded.continueCursor).toBe(first.continueCursor);
        });

        it("inserting into a page's range grows it without touching adjacent pages", async () => {
            expect.assertions(4);

            const writer = setupWriter();

            await seed(writer);

            // Establish two stable page boundaries: C1 = end of page 1, C2 = end of page 2.
            const first = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ numItems: 2 });
            const second = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ cursor: first.continueCursor, numItems: 2 });

            const c1 = first.continueCursor;
            const c2 = second.continueCursor;

            // Insert a row INTO page 1's range (seq 0.5 sits between t5@0 and t1@1).
            await writer.insert("todos", { _id: "t6", archived: false, projectId: "p1", seq: 0.5 }, { allowExplicitId: true });

            const page1 = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ cursor: null, endCursor: c1, numItems: 2 });
            const page2 = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ cursor: c1, endCursor: c2, numItems: 2 });

            // Page 1 GREW to include t6 (seq 0.5 ⇒ t5, t6, t1); its boundary
            // (t1) still terminates it.
            expect(ids(page1.page)).toEqual(["t5", "t6", "t1"]);
            // Page 2 is untouched — no dup, no skip across the shared C1 boundary.
            expect(ids(page2.page)).toEqual(["t2", "t3"]);

            // The flattened feed has every row exactly once, in order.
            const flat = [...ids(page1.page), ...ids(page2.page)];

            expect(flat).toEqual(["t5", "t6", "t1", "t2", "t3"]);
            expect(new Set(flat).size).toBe(flat.length);
        });

        it("deleting a boundary-adjacent row leaves no gap and spares the neighbor", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await seed(writer);

            const first = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ numItems: 2 });
            const second = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ cursor: first.continueCursor, numItems: 2 });

            const c1 = first.continueCursor;
            const c2 = second.continueCursor;

            // Delete the first row of page 2 (t2) — adjacent to the C1 boundary.
            await writer.delete("t2");

            const page1 = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ cursor: null, endCursor: c1, numItems: 2 });
            const page2 = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .paginate({ cursor: c1, endCursor: c2, numItems: 2 });

            // Page 1 unaffected; page 2 simply shrank to {t3}. No gap, no dup.
            expect(ids(page1.page)).toEqual(["t5", "t1"]);
            expect(ids(page2.page)).toEqual(["t3"]);

            const flat = [...ids(page1.page), ...ids(page2.page)];

            expect(flat).toEqual(["t5", "t1", "t3"]);
        });

        it("a bounded final page composes with .order(desc) and .filter()", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            await seed(writer);

            // Descending p1 feed: t3, t2, t1, t5. Page 1 = [t3, t2].
            const first = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .order("desc")
                .paginate({ numItems: 2 });

            const bounded = await writer
                .query("todos")
                .withIndex("by_project_seq", (q) => q.eq("projectId", "p1"))
                .order("desc")
                .filter((document) => document["archived"] === false)
                .paginate({ endCursor: first.continueCursor, numItems: 2 });

            // (null, C1] descending with the archived filter: t3, t2 both pass.
            expect(ids(bounded.page)).toEqual(["t3", "t2"]);
            expect(bounded.isDone).toBe(true);
        });
    });

    describe("reader.paginate — with .filter()", () => {
        it("applies the in-memory predicate while keeping the cursor on a returned row", async () => {
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
