import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

/**
 * Exercises the ORM query methods (`findMany`/`findFirst`/`count`) against a
 * real SQLite engine — per AGENTS.md these never run against the SQL-string
 * fake, so we catch `json_extract` ordering, keyset-seek correctness, and
 * boolean/number affinity the way a Durable Object would.
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

    return createShardCtxDb({
        clock: () => 1_700_000_000_000,
        schema: todosSchema,
        sql: harness.sql,
    });
};

/** Seed four todos under p1 (t5,t1,t2,t3 by seq) and one under p2. */
const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("todos", { _id: "t1", archived: false, priority: "high", projectId: "p1", seq: 1 });
    await writer.insert("todos", { _id: "t2", archived: false, priority: "medium", projectId: "p1", seq: 2 });
    await writer.insert("todos", { _id: "t3", archived: true, priority: "low", projectId: "p1", seq: 3 });
    await writer.insert("todos", { _id: "t4", archived: false, priority: "high", projectId: "p2", seq: 4 });
    await writer.insert("todos", { _id: "t5", archived: false, priority: "high", projectId: "p1", seq: 0 });
};

const ids = (docs: Array<Record<string, unknown>>): unknown[] => docs.map((doc) => doc["_id"]);

beforeEach(() => {
    harness = createSqliteExec();
});

afterEach(() => {
    harness.close();
});

describe("findMany — where filtering", () => {
    test("filters by an equality field, defaulting to creation+id order", async () => {
        const writer = setupWriter();

        await seed(writer);

        const result = await writer.findMany("todos", { where: { projectId: "p1" } });

        // Fixed clock ⇒ equal _creationTime ⇒ the id tiebreak orders them.
        expect(ids(result.page)).toEqual(["t1", "t2", "t3", "t5"]);
        expect(result.isDone).toBe(true);
        expect(result.continueCursor).toBeNull();
    });

    test("combines equality, boolean and `in` operators", async () => {
        const writer = setupWriter();

        await seed(writer);

        const result = await writer.findMany("todos", {
            where: { archived: false, priority: { in: ["high", "medium"] }, projectId: "p1" },
        });

        expect(ids(result.page)).toEqual(["t1", "t2", "t5"]);
    });

    test("returns an empty, done page when nothing matches", async () => {
        const writer = setupWriter();

        await seed(writer);

        const result = await writer.findMany("todos", { where: { projectId: "nope" } });

        expect(result.page).toEqual([]);
        expect(result.isDone).toBe(true);
        expect(result.continueCursor).toBeNull();
    });
});

describe("findMany — orderBy", () => {
    test("orders by a numeric field ascending and descending", async () => {
        const writer = setupWriter();

        await seed(writer);

        const asc = await writer.findMany("todos", { orderBy: [{ seq: "asc" }], where: { projectId: "p1" } });
        const desc = await writer.findMany("todos", { orderBy: [{ seq: "desc" }], where: { projectId: "p1" } });

        expect(ids(asc.page)).toEqual(["t5", "t1", "t2", "t3"]);
        expect(ids(desc.page)).toEqual(["t3", "t2", "t1", "t5"]);
    });

    test("applies a secondary sort key when the first ties", async () => {
        const writer = setupWriter();

        await seed(writer);

        // priority asc → high (t1 seq1, t5 seq0), low (t3), medium (t2); high ties break on seq asc.
        const result = await writer.findMany("todos", {
            orderBy: [{ priority: "asc" }, { seq: "asc" }],
            where: { projectId: "p1" },
        });

        expect(ids(result.page)).toEqual(["t5", "t1", "t3", "t2"]);
    });
});

describe("findMany — keyset cursor pagination", () => {
    test("walks pages via continueCursor, covering every row exactly once", async () => {
        const writer = setupWriter();

        await seed(writer);

        const first = await writer.findMany("todos", { limit: 2, orderBy: [{ seq: "asc" }], where: { projectId: "p1" } });

        expect(ids(first.page)).toEqual(["t5", "t1"]);
        expect(first.isDone).toBe(false);
        expect(first.continueCursor).not.toBeNull();

        const second = await writer.findMany("todos", {
            cursor: first.continueCursor,
            limit: 2,
            orderBy: [{ seq: "asc" }],
            where: { projectId: "p1" },
        });

        expect(ids(second.page)).toEqual(["t2", "t3"]);
        expect(second.isDone).toBe(true);
        expect(second.continueCursor).toBeNull();
    });

    test("is stable when a row is inserted before the cursor between pages", async () => {
        const writer = setupWriter();

        await seed(writer);

        const first = await writer.findMany("todos", { limit: 2, orderBy: [{ seq: "asc" }], where: { projectId: "p1" } });

        // Insert a row with seq 0.5 — it sorts *before* the cursor position (t1, seq 1).
        // Keyset pagination must not let it leak into or shift the next page.
        await writer.insert("todos", { _id: "t6", archived: false, priority: "high", projectId: "p1", seq: 0.5 });

        const second = await writer.findMany("todos", {
            cursor: first.continueCursor,
            limit: 2,
            orderBy: [{ seq: "asc" }],
            where: { projectId: "p1" },
        });

        expect(ids(second.page)).toEqual(["t2", "t3"]);
    });

    test("a final page that exactly fills the limit reports isDone with no cursor", async () => {
        const writer = setupWriter();

        await writer.insert("todos", { _id: "a", archived: false, priority: "p", projectId: "p1", seq: 1 });
        await writer.insert("todos", { _id: "b", archived: false, priority: "p", projectId: "p1", seq: 2 });

        const result = await writer.findMany("todos", { limit: 2, orderBy: [{ seq: "asc" }], where: { projectId: "p1" } });

        expect(ids(result.page)).toEqual(["a", "b"]);
        expect(result.isDone).toBe(true);
        expect(result.continueCursor).toBeNull();
    });
});

describe("findFirst", () => {
    test("returns the first row under the order, or null when none match", async () => {
        const writer = setupWriter();

        await seed(writer);

        const top = await writer.findFirst("todos", { orderBy: [{ seq: "desc" }], where: { projectId: "p1" } });
        const none = await writer.findFirst("todos", { where: { projectId: "nope" } });

        expect(top?.["_id"]).toBe("t3");
        expect(none).toBeNull();
    });
});

describe("findFirstOrThrow", () => {
    test("returns the matched row, mirroring findFirst on a hit", async () => {
        const writer = setupWriter();

        await seed(writer);

        const top = await writer.findFirstOrThrow("todos", { orderBy: [{ seq: "desc" }], where: { projectId: "p1" } });

        expect(top["_id"]).toBe("t3");
    });

    test("throws NotFoundError when no row matches", async () => {
        const writer = setupWriter();

        await seed(writer);

        await expect(writer.findFirstOrThrow("todos", { where: { projectId: "nope" } })).rejects.toThrow(/findFirstOrThrow/);
    });
});

describe("count", () => {
    test("counts rows matching the where filter", async () => {
        const writer = setupWriter();

        await seed(writer);

        await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
        await expect(writer.count("todos", { archived: true, projectId: "p1" })).resolves.toBe(1);
        await expect(writer.count("todos")).resolves.toBe(5);
    });
});
