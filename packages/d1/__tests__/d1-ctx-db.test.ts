import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@cirrus/do";
import { ConflictError } from "@cirrus/do";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createD1CtxDb } from "../src/d1-ctx-db.js";
import { createD1Exec } from "./_helpers/node-sqlite-d1.js";

/**
 * Exercises the D1 column-dialect ctx-db against a real `node:sqlite` engine
 * (D1 is SQLite under the hood). Unlike the DO path's JSON-blob storage, every
 * field is a real column, so this proves the generated column SQL, UNIQUE
 * constraints, boolean 1/0 affinity, and keyset-seek ordering behave the way
 * they will against a live D1 database.
 */
const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => ({
    _meta: { column: { notNull: true, ...column } },
    kind,
});

const todosSchema: SchemaLike = {
    tables: {
        todos: {
            indexes: [],
            shape: {
                archived: col("boolean"),
                priority: col("string"),
                projectId: col("string"),
                seq: col("number"),
            },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

const setupTodos = (): DatabaseWriterLike => {
    harness.ddl(
        `CREATE TABLE "todos" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "archived" INTEGER,
            "priority" TEXT,
            "projectId" TEXT,
            "seq" INTEGER
        )`,
    );

    return createD1CtxDb({ clock: () => FIXED_CLOCK, exec: harness.exec, schema: todosSchema });
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
    harness = createD1Exec();
});

afterEach(() => {
    harness.close();
});

describe("findMany — where filtering", () => {
    test("filters by an equality field, defaulting to creation+id order", async () => {
        const writer = setupTodos();

        await seed(writer);

        const result = await writer.findMany("todos", { where: { projectId: "p1" } });

        // Fixed clock ⇒ equal _creationTime ⇒ the id tiebreak orders them.
        expect(ids(result.page)).toEqual(["t1", "t2", "t3", "t5"]);
        expect(result.isDone).toBe(true);
        expect(result.continueCursor).toBeNull();
    });

    test("combines equality, boolean and `in` operators", async () => {
        const writer = setupTodos();

        await seed(writer);

        const result = await writer.findMany("todos", {
            where: { archived: false, priority: { in: ["high", "medium"] }, projectId: "p1" },
        });

        expect(ids(result.page)).toEqual(["t1", "t2", "t5"]);
    });

    test("decodes a stored 1/0 column back into a boolean", async () => {
        const writer = setupTodos();

        await seed(writer);

        const archived = await writer.findFirst("todos", { where: { _id: "t3" } });
        const active = await writer.findFirst("todos", { where: { _id: "t1" } });

        expect(archived?.["archived"]).toBe(true);
        expect(active?.["archived"]).toBe(false);
    });

    test("returns an empty, done page when nothing matches", async () => {
        const writer = setupTodos();

        await seed(writer);

        const result = await writer.findMany("todos", { where: { projectId: "nope" } });

        expect(result.page).toEqual([]);
        expect(result.isDone).toBe(true);
        expect(result.continueCursor).toBeNull();
    });
});

describe("findMany — orderBy", () => {
    test("orders by a numeric field ascending and descending", async () => {
        const writer = setupTodos();

        await seed(writer);

        const asc = await writer.findMany("todos", { orderBy: [{ seq: "asc" }], where: { projectId: "p1" } });
        const desc = await writer.findMany("todos", { orderBy: [{ seq: "desc" }], where: { projectId: "p1" } });

        expect(ids(asc.page)).toEqual(["t5", "t1", "t2", "t3"]);
        expect(ids(desc.page)).toEqual(["t3", "t2", "t1", "t5"]);
    });

    test("applies a secondary sort key when the first ties", async () => {
        const writer = setupTodos();

        await seed(writer);

        const result = await writer.findMany("todos", {
            orderBy: [{ priority: "asc" }, { seq: "asc" }],
            where: { projectId: "p1" },
        });

        expect(ids(result.page)).toEqual(["t5", "t1", "t3", "t2"]);
    });
});

describe("findMany — keyset cursor pagination", () => {
    test("walks pages via continueCursor, covering every row exactly once", async () => {
        const writer = setupTodos();

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
        const writer = setupTodos();

        await seed(writer);

        const first = await writer.findMany("todos", { limit: 2, orderBy: [{ seq: "asc" }], where: { projectId: "p1" } });

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
        const writer = setupTodos();

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
        const writer = setupTodos();

        await seed(writer);

        const top = await writer.findFirst("todos", { orderBy: [{ seq: "desc" }], where: { projectId: "p1" } });
        const none = await writer.findFirst("todos", { where: { projectId: "nope" } });

        expect(top?.["_id"]).toBe("t3");
        expect(none).toBeNull();
    });
});

describe("count", () => {
    test("counts rows matching the where filter", async () => {
        const writer = setupTodos();

        await seed(writer);

        await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
        await expect(writer.count("todos", { archived: true, projectId: "p1" })).resolves.toBe(1);
        await expect(writer.count("todos")).resolves.toBe(5);
    });
});

describe("get / patch / replace / delete round-trips", () => {
    test("inserts, reads back, patches a field, and deletes by id", async () => {
        const writer = setupTodos();

        const id = await writer.insert("todos", { _id: "r1", archived: false, priority: "high", projectId: "p1", seq: 1 });

        expect((await writer.get(id))?.["priority"]).toBe("high");

        await writer.patch(id, { priority: "low" });

        const patched = await writer.get(id);

        expect(patched?.["priority"]).toBe("low");
        expect(patched?.["projectId"]).toBe("p1");

        await writer.delete(id);

        await expect(writer.get(id)).resolves.toBeNull();
    });

    test("replace overwrites unspecified fields with null", async () => {
        const writer = setupTodos();

        await writer.insert("todos", { _id: "r2", archived: true, priority: "high", projectId: "p1", seq: 5 });

        await writer.replace("r2", { priority: "medium", projectId: "p1" });

        const replaced = await writer.get("r2");

        expect(replaced?.["priority"]).toBe("medium");
        expect(replaced?.["seq"]).toBeNull();
    });
});

const FIXED_REV = (): { revCalls: () => number; schema: SchemaLike } => {
    let revs = 0;

    return {
        revCalls: () => revs,
        schema: {
            tables: {
                items: {
                    indexes: [],
                    shape: {
                        rev: col("number", {
                            onUpdateFn: () => {
                                revs += 1;

                                return revs;
                            },
                        }),
                        seq: col("number", { defaultFn: () => 7 }),
                        slug: col("string", { unique: true }),
                        status: col("string", { defaultValue: "todo" }),
                        title: col("string"),
                    },
                },
            },
        },
    };
};

const setupItems = (): { revCalls: () => number; writer: DatabaseWriterLike } => {
    const { revCalls, schema } = FIXED_REV();

    harness.ddl(
        `CREATE TABLE "items" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "rev" INTEGER,
            "seq" INTEGER,
            "slug" TEXT UNIQUE,
            "status" TEXT,
            "title" TEXT
        )`,
    );

    return { revCalls, writer: createD1CtxDb({ clock: () => FIXED_CLOCK, exec: harness.exec, schema }) };
};

describe("insert defaults", () => {
    test("fills a `.default()` literal and a `.$defaultFn()` factory when absent", async () => {
        const { writer } = setupItems();

        const id = await writer.insert("items", { _id: "i1", slug: "a", title: "first" });
        const doc = await writer.get(id);

        expect(doc?.["status"]).toBe("todo");
        expect(doc?.["seq"]).toBe(7);
    });

    test("a provided value overrides the default", async () => {
        const { writer } = setupItems();

        const id = await writer.insert("items", { _id: "i1", seq: 99, slug: "a", status: "done", title: "first" });
        const doc = await writer.get(id);

        expect(doc?.["status"]).toBe("done");
        expect(doc?.["seq"]).toBe(99);
    });

    test("does not run `$onUpdateFn` on insert", async () => {
        const { revCalls, writer } = setupItems();

        const id = await writer.insert("items", { _id: "i1", slug: "a", title: "first" });
        const doc = await writer.get(id);

        expect(doc?.["rev"]).toBeNull();
        expect(revCalls()).toBe(0);
    });
});

describe("$onUpdateFn", () => {
    test("recomputes on each patch that omits the field", async () => {
        const { revCalls, writer } = setupItems();

        await writer.insert("items", { _id: "i1", slug: "a", title: "first" });

        await writer.patch("i1", { title: "second" });

        expect((await writer.get("i1"))?.["rev"]).toBe(1);

        await writer.patch("i1", { title: "third" });

        expect((await writer.get("i1"))?.["rev"]).toBe(2);
        expect(revCalls()).toBe(2);
    });

    test("is skipped when the patch sets the field explicitly", async () => {
        const { revCalls, writer } = setupItems();

        await writer.insert("items", { _id: "i1", slug: "a", title: "first" });

        await writer.patch("i1", { rev: 99 });

        expect((await writer.get("i1"))?.["rev"]).toBe(99);
        expect(revCalls()).toBe(0);
    });

    test("recomputes on replace that omits the field, but honors an explicit value", async () => {
        const { writer } = setupItems();

        await writer.insert("items", { _id: "i1", slug: "a", title: "first" });

        await writer.replace("i1", { slug: "a", title: "auto" });

        expect((await writer.get("i1"))?.["rev"]).toBe(1);

        await writer.replace("i1", { rev: 42, slug: "a", title: "manual" });

        expect((await writer.get("i1"))?.["rev"]).toBe(42);
    });
});

describe(".unique() constraint", () => {
    test("a duplicate insert throws a ConflictError (code CONFLICT, status 409)", async () => {
        const { writer } = setupItems();

        await writer.insert("items", { _id: "i1", slug: "dup", title: "first" });

        const conflict = writer.insert("items", { _id: "i2", slug: "dup", title: "second" });

        await expect(conflict).rejects.toBeInstanceOf(ConflictError);
        await expect(conflict).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    });

    test("a patch that collides with another row's unique value conflicts", async () => {
        const { writer } = setupItems();

        await writer.insert("items", { _id: "i1", slug: "one", title: "first" });
        await writer.insert("items", { _id: "i2", slug: "two", title: "second" });

        await expect(writer.patch("i2", { slug: "one" })).rejects.toBeInstanceOf(ConflictError);
    });

    test("distinct unique values insert cleanly", async () => {
        const { writer } = setupItems();

        await writer.insert("items", { _id: "i1", slug: "one", title: "first" });
        await writer.insert("items", { _id: "i2", slug: "two", title: "second" });

        await expect(writer.count("items")).resolves.toBe(2);
    });
});
