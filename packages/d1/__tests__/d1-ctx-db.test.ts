import type { ColumnMetaLike, DatabaseWriterLike, SchedulerLike, SchemaLike, TriggerEventLike, ValidatorLike } from "@cirrus/do";
import { ConflictError } from "@cirrus/do";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

describe("findFirstOrThrow", () => {
    test("returns the matched row, mirroring findFirst on a hit", async () => {
        const writer = setupTodos();

        await seed(writer);

        const top = await writer.findFirstOrThrow("todos", { orderBy: [{ seq: "desc" }], where: { projectId: "p1" } });

        expect(top["_id"]).toBe("t3");
    });

    test("throws NotFoundError when no row matches", async () => {
        const writer = setupTodos();

        await seed(writer);

        await expect(writer.findFirstOrThrow("todos", { where: { projectId: "nope" } })).rejects.toThrow(/findFirstOrThrow/);
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

    test("AND-merges baseWhere into the count predicate", async () => {
        const writer = setupTodos();

        await seed(writer);

        await expect(writer.count("todos", { baseWhere: { projectId: "p1" } })).resolves.toBe(4);
        await expect(
            writer.count("todos", { baseWhere: { projectId: "p1" }, where: { archived: true } }),
        ).resolves.toBe(1);
    });

    test("count() throws CountRlsUnsupportedError when restrictsCounts is true", async () => {
        const writer = setupTodos();

        await seed(writer);

        await expect(writer.count("todos", { restrictsCounts: true })).rejects.toMatchObject({
            code: "COUNT_RLS_UNSUPPORTED",
            name: "CountRlsUnsupportedError",
        });
    });
});

describe("baseWhere seam (RLS / aggregates)", () => {
    test("findMany AND-merges baseWhere before compilation", async () => {
        const writer = setupTodos();

        await seed(writer);

        const result = await writer.findMany("todos", {
            baseWhere: { projectId: "p1" },
            where: { archived: false },
        });

        const matchedIds = result.page.map((row) => row["_id"]).sort();

        expect(matchedIds).toEqual(["t1", "t2", "t5"]);
    });

    test("baseWhere alone narrows the result", async () => {
        const writer = setupTodos();

        await seed(writer);

        const result = await writer.findMany("todos", { baseWhere: { projectId: "p2" } });

        expect(result.page.map((row) => row["_id"])).toEqual(["t4"]);
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

describe("relations", () => {
    const buildRelSchema = (action?: "cascade" | "restrict" | "set null"): SchemaLike => ({
        tables: {
            messages: {
                indexes: [],
                relationMap: {
                    author: { field: "authorId", kind: "one", onDelete: action, references: "_id", table: "users" },
                    reactions: { field: "messageId", kind: "many", references: "_id", table: "reactions" },
                },
                shape: { authorId: col("string"), body: col("string") },
            },
            reactions: {
                indexes: [],
                relationMap: { message: { field: "messageId", kind: "one", onDelete: "cascade", references: "_id", table: "messages" } },
                shape: { emoji: col("string"), messageId: col("string") },
            },
            users: {
                indexes: [],
                relationMap: { messages: { field: "authorId", kind: "many", references: "_id", table: "messages" } },
                shape: { name: col("string") },
            },
        },
    });

    const setupRelations = (action?: "cascade" | "restrict" | "set null"): DatabaseWriterLike => {
        // FK columns stay nullable so `set null` can clear them.
        harness.ddl(`CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "name" TEXT)`);
        harness.ddl(`CREATE TABLE "messages" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "authorId" TEXT, "body" TEXT)`);
        harness.ddl(`CREATE TABLE "reactions" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "messageId" TEXT, "emoji" TEXT)`);

        return createD1CtxDb({ clock: () => FIXED_CLOCK, exec: harness.exec, schema: buildRelSchema(action) });
    };

    const seedRelations = async (writer: DatabaseWriterLike): Promise<void> => {
        await writer.insert("users", { _id: "u1", name: "Ada" });
        await writer.insert("users", { _id: "u2", name: "Linus" });
        await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" });
        await writer.insert("messages", { _id: "m2", authorId: "u1", body: "yo" });
        await writer.insert("messages", { _id: "m3", authorId: "u2", body: "hey" });
        await writer.insert("reactions", { _id: "r1", emoji: "thumbsup", messageId: "m1" });
        await writer.insert("reactions", { _id: "r2", emoji: "party", messageId: "m1" });
        await writer.insert("reactions", { _id: "r3", emoji: "fire", messageId: "m2" });
    };

    test("loads a one relation as Doc | null", async () => {
        const writer = setupRelations();

        await seedRelations(writer);

        const { page } = await writer.findMany("messages", { where: { authorId: "u1" }, with: { author: true } });

        expect((page[0]!["author"] as Record<string, unknown>)["name"]).toBe("Ada");
    });

    test("loads a many relation grouped per parent", async () => {
        const writer = setupRelations();

        await seedRelations(writer);

        const { page } = await writer.findMany("users", { with: { messages: true } });
        const ada = page.find((row) => row["_id"] === "u1")!;

        expect(ids(ada["messages"] as Array<Record<string, unknown>>)).toEqual(["m1", "m2"]);
    });

    test("nested with recurses (users → messages → reactions)", async () => {
        const writer = setupRelations();

        await seedRelations(writer);

        const { page } = await writer.findMany("users", { where: { _id: "u1" }, with: { messages: { with: { reactions: true } } } });
        const messages = page[0]!["messages"] as Array<Record<string, unknown>>;
        const m1 = messages.find((row) => row["_id"] === "m1")!;

        expect(ids(m1["reactions"] as Array<Record<string, unknown>>)).toEqual(["r1", "r2"]);
    });

    test("per-group limit caps a many relation in memory", async () => {
        const writer = setupRelations();

        await seedRelations(writer);

        const { page } = await writer.findMany("users", { where: { _id: "u1" }, with: { messages: { limit: 1 } } });

        expect(page[0]!["messages"]).toHaveLength(1);
    });

    test("_count attaches per-parent aggregate", async () => {
        const writer = setupRelations();

        await seedRelations(writer);

        const { page } = await writer.findMany("messages", { orderBy: [{ _id: "asc" }], with: { _count: { reactions: true } } });

        expect((page[0]!["_count"] as Record<string, number>)["reactions"]).toBe(2);
        expect((page[2]!["_count"] as Record<string, number>)["reactions"]).toBe(0);
    });

    test("onDelete cascade removes holder rows and chains", async () => {
        const writer = setupRelations("cascade");

        await writer.insert("users", { _id: "u1", name: "Ada" });
        await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" });
        await writer.insert("reactions", { _id: "r1", emoji: "thumbsup", messageId: "m1" });

        await writer.delete("u1");

        await expect(writer.get("m1")).resolves.toBeNull();
        await expect(writer.get("r1")).resolves.toBeNull();
    });

    test("onDelete set null clears the FK", async () => {
        const writer = setupRelations("set null");

        await writer.insert("users", { _id: "u1", name: "Ada" });
        await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" });

        await writer.delete("u1");

        const message = await writer.get("m1");

        expect(message).not.toBeNull();
        expect(message!["authorId"]).toBeNull();
    });

    test("onDelete restrict aborts when a holder remains", async () => {
        const writer = setupRelations("restrict");

        await writer.insert("users", { _id: "u1", name: "Ada" });
        await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" });

        await expect(writer.delete("u1")).rejects.toBeInstanceOf(ConflictError);
        await expect(writer.get("u1")).resolves.not.toBeNull();
    });
});

describe("triggers", () => {
    const messagesDdl = (): void => {
        harness.ddl(`CREATE TABLE "messages" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "body" TEXT, "locked" INTEGER)`);
    };

    test("before/after insert fire in order with the new doc", async () => {
        const events: Array<{ doc?: unknown; phase: string }> = [];
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: col("string"), locked: col("boolean") },
                    triggerMap: {
                        a: { handler: (_ctx, event) => void events.push({ doc: event.doc, phase: "after" }), op: "insert", timing: "after" },
                        b: { handler: (_ctx, event) => void events.push({ doc: event.doc, phase: "before" }), op: "insert", timing: "before" },
                    },
                },
            },
        };

        messagesDdl();

        const writer = createD1CtxDb({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

        await writer.insert("messages", { _id: "m1", body: "hi", locked: false });

        expect(events.map((e) => e.phase)).toEqual(["before", "after"]);
        expect((events[1]!.doc as Record<string, unknown>)["_id"]).toBe("m1");
    });

    test("update triggers see merged doc and previous on patch", async () => {
        let captured: TriggerEventLike | undefined;
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: col("string"), locked: col("boolean") },
                    triggerMap: {
                        a: {
                            handler: (_ctx, event) => {
                                captured = event;
                            },
                            op: "update",
                            timing: "after",
                        },
                    },
                },
            },
        };

        messagesDdl();

        const writer = createD1CtxDb({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

        await writer.insert("messages", { _id: "m1", body: "hi", locked: false });
        await writer.patch("m1", { body: "bye" });

        expect((captured!.doc as Record<string, unknown>)["body"]).toBe("bye");
        expect((captured!.previous as Record<string, unknown>)["body"]).toBe("hi");
    });

    test("a throwing beforeDelete aborts the delete — the row survives", async () => {
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: col("string"), locked: col("boolean") },
                    triggerMap: {
                        guard: {
                            handler: (_ctx, event) => {
                                if ((event.previous as Record<string, unknown>)["locked"]) {
                                    throw new ConflictError("row is locked");
                                }
                            },
                            op: "delete",
                            timing: "before",
                        },
                    },
                },
            },
        };

        messagesDdl();

        const writer = createD1CtxDb({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

        await writer.insert("messages", { _id: "m1", body: "hi", locked: true });

        await expect(writer.delete("m1")).rejects.toBeInstanceOf(ConflictError);
        await expect(writer.get("m1")).resolves.not.toBeNull();
    });

    test("an afterInsert handler writing another table via ctx.db persists", async () => {
        const schema: SchemaLike = {
            tables: {
                audit: { indexes: [], shape: { row: col("string"), table: col("string") }, triggerMap: {} },
                messages: {
                    indexes: [],
                    shape: { body: col("string"), locked: col("boolean") },
                    triggerMap: {
                        audit: {
                            handler: async (ctx, event) => {
                                await ctx.db.insert("audit", { row: event.id, table: event.table });
                            },
                            op: "insert",
                            timing: "after",
                        },
                    },
                },
            },
        };

        messagesDdl();
        harness.ddl(`CREATE TABLE "audit" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "row" TEXT, "table" TEXT)`);

        const writer = createD1CtxDb({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

        await writer.insert("messages", { _id: "m1", body: "hi", locked: false });

        const { page } = await writer.findMany("audit");

        expect(page).toHaveLength(1);
        expect(page[0]!["row"]).toBe("m1");
    });

    test("ctx.scheduler reaches the scheduler passed to createD1CtxDb", async () => {
        const runAfter = vi.fn(async () => "job-1");
        const scheduler: SchedulerLike = { runAfter, runAt: async () => "job-2" };
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: col("string"), locked: col("boolean") },
                    triggerMap: {
                        bump: {
                            handler: async (ctx, event) => {
                                await ctx.scheduler.runAfter(0, "counters:recount", { id: event.id });
                            },
                            op: "insert",
                            timing: "after",
                        },
                    },
                },
            },
        };

        messagesDdl();

        const writer = createD1CtxDb({ clock: () => FIXED_CLOCK, exec: harness.exec, scheduler, schema });

        await writer.insert("messages", { _id: "m1", body: "hi", locked: false });

        expect(runAfter).toHaveBeenCalledWith(0, "counters:recount", { id: "m1" });
    });

    test("the default scheduler throws when a trigger uses it unconfigured", async () => {
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: col("string"), locked: col("boolean") },
                    triggerMap: {
                        bump: {
                            handler: async (ctx) => {
                                await ctx.scheduler.runAfter(0, "noop");
                            },
                            op: "insert",
                            timing: "after",
                        },
                    },
                },
            },
        };

        messagesDdl();

        const writer = createD1CtxDb({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

        await expect(writer.insert("messages", { _id: "m1", body: "hi", locked: false })).rejects.toThrow(/no scheduler configured/);
    });
});
