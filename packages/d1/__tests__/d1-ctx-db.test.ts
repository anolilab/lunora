import type { ColumnMetaLike, DatabaseWriterLike, SchedulerLike, SchemaLike, TriggerEventLike, ValidatorLike } from "@lunora/shard-engine";
import { ConflictError } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Exercises the D1 column-dialect ctx-db against a real `node:sqlite` engine
 * (D1 is SQLite under the hood). Unlike the DO path's JSON-blob storage, every
 * field is a real column, so this proves the generated column SQL, UNIQUE
 * constraints, boolean 1/0 affinity, and keyset-seek ordering behave the way
 * they will against a live D1 database.
 */
const FIXED_CLOCK = 1_700_000_000_000;

// Error-message matchers hoisted to module scope (avoids per-call regex recompilation).
const FIND_FIRST_OR_THROW_RE = /findFirstOrThrow/;
const CROSS_BACKEND_CASCADE_RE = /cross-backend cascade.*shardBy/u;
const NO_SCHEDULER_RE = /no scheduler configured/;

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
            "_version" INTEGER,
            "archived" INTEGER,
            "priority" TEXT,
            "projectId" TEXT,
            "seq" INTEGER
        )`,
    );

    return createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema: todosSchema });
};

/** Seed four todos under p1 (t5,t1,t2,t3 by seq) and one under p2. */
const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("todos", { _id: "t1", archived: false, priority: "high", projectId: "p1", seq: 1 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t2", archived: false, priority: "medium", projectId: "p1", seq: 2 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t3", archived: true, priority: "low", projectId: "p1", seq: 3 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t4", archived: false, priority: "high", projectId: "p2", seq: 4 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t5", archived: false, priority: "high", projectId: "p1", seq: 0 }, { allowExplicitId: true });
};

const ids = (docs: Record<string, unknown>[]): unknown[] => docs.map((document_) => document_["_id"]);

describe("d1 ctx-db", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("findMany — where filtering", () => {
        it("filters by an equality field, defaulting to creation+id order", async () => {
            expect.assertions(3);

            const writer = setupTodos();

            await seed(writer);

            const result = await writer.findMany("todos", { where: { projectId: "p1" } });

            // Fixed clock ⇒ equal _creationTime ⇒ the id tiebreak orders them.
            expect(ids(result.page)).toEqual(["t1", "t2", "t3", "t5"]);
            expect(result.isDone).toBe(true);
            expect(result.continueCursor).toBeNull();
        });

        it("combines equality, boolean and `in` operators", async () => {
            expect.assertions(1);

            const writer = setupTodos();

            await seed(writer);

            const result = await writer.findMany("todos", {
                where: { archived: false, priority: { in: ["high", "medium"] }, projectId: "p1" },
            });

            expect(ids(result.page)).toEqual(["t1", "t2", "t5"]);
        });

        it("decodes a stored 1/0 column back into a boolean", async () => {
            expect.assertions(2);

            const writer = setupTodos();

            await seed(writer);

            const archived = await writer.findFirst("todos", { where: { _id: "t3" } });
            const active = await writer.findFirst("todos", { where: { _id: "t1" } });

            expect(archived?.["archived"]).toBe(true);
            expect(active?.["archived"]).toBe(false);
        });

        it("returns an empty, done page when nothing matches", async () => {
            expect.assertions(3);

            const writer = setupTodos();

            await seed(writer);

            const result = await writer.findMany("todos", { where: { projectId: "nope" } });

            expect(result.page).toEqual([]);
            expect(result.isDone).toBe(true);
            expect(result.continueCursor).toBeNull();
        });
    });

    describe("findMany — orderBy", () => {
        it("orders by a numeric field ascending and descending", async () => {
            expect.assertions(2);

            const writer = setupTodos();

            await seed(writer);

            const asc = await writer.findMany("todos", { orderBy: [{ seq: "asc" }], where: { projectId: "p1" } });
            const desc = await writer.findMany("todos", { orderBy: [{ seq: "desc" }], where: { projectId: "p1" } });

            expect(ids(asc.page)).toEqual(["t5", "t1", "t2", "t3"]);
            expect(ids(desc.page)).toEqual(["t3", "t2", "t1", "t5"]);
        });

        it("applies a secondary sort key when the first ties", async () => {
            expect.assertions(1);

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
        it("walks pages via continueCursor, covering every row exactly once", async () => {
            expect.assertions(6);

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

        it("is stable when a row is inserted before the cursor between pages", async () => {
            expect.assertions(1);

            const writer = setupTodos();

            await seed(writer);

            const first = await writer.findMany("todos", { limit: 2, orderBy: [{ seq: "asc" }], where: { projectId: "p1" } });

            await writer.insert("todos", { _id: "t6", archived: false, priority: "high", projectId: "p1", seq: 0.5 }, { allowExplicitId: true });

            const second = await writer.findMany("todos", {
                cursor: first.continueCursor,
                limit: 2,
                orderBy: [{ seq: "asc" }],
                where: { projectId: "p1" },
            });

            expect(ids(second.page)).toEqual(["t2", "t3"]);
        });

        it("a final page that exactly fills the limit reports isDone with no cursor", async () => {
            expect.assertions(3);

            const writer = setupTodos();

            await writer.insert("todos", { _id: "a", archived: false, priority: "p", projectId: "p1", seq: 1 }, { allowExplicitId: true });
            await writer.insert("todos", { _id: "b", archived: false, priority: "p", projectId: "p1", seq: 2 }, { allowExplicitId: true });

            const result = await writer.findMany("todos", { limit: 2, orderBy: [{ seq: "asc" }], where: { projectId: "p1" } });

            expect(ids(result.page)).toEqual(["a", "b"]);
            expect(result.isDone).toBe(true);
            expect(result.continueCursor).toBeNull();
        });
    });

    describe("findFirst", () => {
        it("returns the first row under the order, or null when none match", async () => {
            expect.assertions(2);

            const writer = setupTodos();

            await seed(writer);

            const top = await writer.findFirst("todos", { orderBy: [{ seq: "desc" }], where: { projectId: "p1" } });
            const none = await writer.findFirst("todos", { where: { projectId: "nope" } });

            expect(top?.["_id"]).toBe("t3");
            expect(none).toBeNull();
        });
    });

    describe("findFirstOrThrow", () => {
        it("returns the matched row, mirroring findFirst on a hit", async () => {
            expect.assertions(1);

            const writer = setupTodos();

            await seed(writer);

            const top = await writer.findFirstOrThrow("todos", { orderBy: [{ seq: "desc" }], where: { projectId: "p1" } });

            expect(top["_id"]).toBe("t3");
        });

        it("throws NotFoundError when no row matches", async () => {
            expect.assertions(1);

            const writer = setupTodos();

            await seed(writer);

            await expect(writer.findFirstOrThrow("todos", { where: { projectId: "nope" } })).rejects.toThrow(FIND_FIRST_OR_THROW_RE);
        });
    });

    describe("count", () => {
        it("counts rows matching the where filter", async () => {
            expect.assertions(3);

            const writer = setupTodos();

            await seed(writer);

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
            await expect(writer.count("todos", { archived: true, projectId: "p1" })).resolves.toBe(1);
            await expect(writer.count("todos")).resolves.toBe(5);
        });

        it("aND-merges baseWhere into the count predicate", async () => {
            expect.assertions(2);

            const writer = setupTodos();

            await seed(writer);

            await expect(writer.count("todos", { baseWhere: { projectId: "p1" } })).resolves.toBe(4);
            await expect(writer.count("todos", { baseWhere: { projectId: "p1" }, where: { archived: true } })).resolves.toBe(1);
        });

        it("count() throws COUNT_RLS_UNSUPPORTED when restrictsCounts is true", async () => {
            expect.assertions(1);

            const writer = setupTodos();

            await seed(writer);

            // The structural shape (`name: "LunoraError"` + `code` + `status`)
            // lets the runtime error mapper route it without an `instanceof`
            // check; `@lunora/d1` stays free of a runtime dep on `@lunora/server`.
            await expect(writer.count("todos", { restrictsCounts: true })).rejects.toMatchObject({
                code: "COUNT_RLS_UNSUPPORTED",
                name: "LunoraError",
                status: 422,
            });
        });
    });

    describe("baseWhere seam (RLS / aggregates)", () => {
        it("findMany AND-merges baseWhere before compilation", async () => {
            expect.assertions(1);

            const writer = setupTodos();

            await seed(writer);

            const result = await writer.findMany("todos", {
                baseWhere: { projectId: "p1" },
                where: { archived: false },
            });

            const matchedIds = result.page.map((row) => row["_id"]).toSorted((a, b) => String(a).localeCompare(String(b)));

            expect(matchedIds).toEqual(["t1", "t2", "t5"]);
        });

        it("baseWhere alone narrows the result", async () => {
            expect.assertions(1);

            const writer = setupTodos();

            await seed(writer);

            const result = await writer.findMany("todos", { baseWhere: { projectId: "p2" } });

            expect(result.page.map((row) => row["_id"])).toEqual(["t4"]);
        });
    });

    describe("get / patch / replace / delete round-trips", () => {
        it("inserts, reads back, patches a field, and deletes by id", async () => {
            expect.assertions(4);

            const writer = setupTodos();

            const id = await writer.insert("todos", { _id: "r1", archived: false, priority: "high", projectId: "p1", seq: 1 }, { allowExplicitId: true });

            const inserted = await writer.get(id);

            expect(inserted?.["priority"]).toBe("high");

            await writer.patch(id, { priority: "low" });

            const patched = await writer.get(id);

            expect(patched?.["priority"]).toBe("low");
            expect(patched?.["projectId"]).toBe("p1");

            await writer.delete(id);

            await expect(writer.get(id)).resolves.toBeNull();
        });

        it("replace overwrites unspecified fields with null", async () => {
            expect.assertions(2);

            const writer = setupTodos();

            await writer.insert("todos", { _id: "r2", archived: true, priority: "high", projectId: "p1", seq: 5 }, { allowExplicitId: true });

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
            "_version" INTEGER,
            "rev" INTEGER,
            "seq" INTEGER,
            "slug" TEXT UNIQUE,
            "status" TEXT,
            "title" TEXT
        )`,
        );

        return { revCalls, writer: createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema }) };
    };

    describe("insert defaults", () => {
        it("fills a `.default()` literal and a `.$defaultFn()` factory when absent", async () => {
            expect.assertions(2);

            const { writer } = setupItems();

            const id = await writer.insert("items", { _id: "i1", slug: "a", title: "first" }, { allowExplicitId: true });
            const doc = await writer.get(id);

            expect(doc?.["status"]).toBe("todo");
            expect(doc?.["seq"]).toBe(7);
        });

        it("a provided value overrides the default", async () => {
            expect.assertions(2);

            const { writer } = setupItems();

            const id = await writer.insert("items", { _id: "i1", seq: 99, slug: "a", status: "done", title: "first" }, { allowExplicitId: true });
            const doc = await writer.get(id);

            expect(doc?.["status"]).toBe("done");
            expect(doc?.["seq"]).toBe(99);
        });

        it("does not run `$onUpdateFn` on insert", async () => {
            expect.assertions(2);

            const { revCalls, writer } = setupItems();

            const id = await writer.insert("items", { _id: "i1", slug: "a", title: "first" }, { allowExplicitId: true });
            const doc = await writer.get(id);

            expect(doc?.["rev"]).toBeNull();
            expect(revCalls()).toBe(0);
        });
    });

    describe("$onUpdateFn", () => {
        it("recomputes on each patch that omits the field", async () => {
            expect.assertions(3);

            const { revCalls, writer } = setupItems();

            await writer.insert("items", { _id: "i1", slug: "a", title: "first" }, { allowExplicitId: true });

            await writer.patch("i1", { title: "second" });

            const afterFirstPatch = await writer.get("i1");

            expect(afterFirstPatch?.["rev"]).toBe(1);

            await writer.patch("i1", { title: "third" });

            const afterSecondPatch = await writer.get("i1");

            expect(afterSecondPatch?.["rev"]).toBe(2);
            expect(revCalls()).toBe(2);
        });

        it("is skipped when the patch sets the field explicitly", async () => {
            expect.assertions(2);

            const { revCalls, writer } = setupItems();

            await writer.insert("items", { _id: "i1", slug: "a", title: "first" }, { allowExplicitId: true });

            await writer.patch("i1", { rev: 99 });

            const afterExplicitPatch = await writer.get("i1");

            expect(afterExplicitPatch?.["rev"]).toBe(99);
            expect(revCalls()).toBe(0);
        });

        it("recomputes on replace that omits the field, but honors an explicit value", async () => {
            expect.assertions(2);

            const { writer } = setupItems();

            await writer.insert("items", { _id: "i1", slug: "a", title: "first" }, { allowExplicitId: true });

            await writer.replace("i1", { slug: "a", title: "auto" });

            const afterAutoReplace = await writer.get("i1");

            expect(afterAutoReplace?.["rev"]).toBe(1);

            await writer.replace("i1", { rev: 42, slug: "a", title: "manual" });

            const afterManualReplace = await writer.get("i1");

            expect(afterManualReplace?.["rev"]).toBe(42);
        });
    });

    describe(".unique() constraint", () => {
        it("a duplicate insert throws a ConflictError (code CONFLICT, status 409)", async () => {
            expect.assertions(2);

            const { writer } = setupItems();

            await writer.insert("items", { _id: "i1", slug: "dup", title: "first" }, { allowExplicitId: true });

            const conflict = writer.insert("items", { _id: "i2", slug: "dup", title: "second" }, { allowExplicitId: true });

            await expect(conflict).rejects.toBeInstanceOf(ConflictError);
            await expect(conflict).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
        });

        it("a patch that collides with another row's unique value conflicts", async () => {
            expect.assertions(1);

            const { writer } = setupItems();

            await writer.insert("items", { _id: "i1", slug: "one", title: "first" }, { allowExplicitId: true });
            await writer.insert("items", { _id: "i2", slug: "two", title: "second" }, { allowExplicitId: true });

            await expect(writer.patch("i2", { slug: "one" })).rejects.toBeInstanceOf(ConflictError);
        });

        it("distinct unique values insert cleanly", async () => {
            expect.assertions(1);

            const { writer } = setupItems();

            await writer.insert("items", { _id: "i1", slug: "one", title: "first" }, { allowExplicitId: true });
            await writer.insert("items", { _id: "i2", slug: "two", title: "second" }, { allowExplicitId: true });

            await expect(writer.count("items")).resolves.toBe(2);
        });
    });

    describe("relations", () => {
        const buildRelSchema = (action?: "cascade" | "restrict" | "set null"): SchemaLike => {
            return {
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
            };
        };

        const setupRelations = (action?: "cascade" | "restrict" | "set null"): DatabaseWriterLike => {
            // FK columns stay nullable so `set null` can clear them.
            harness.ddl(`CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "name" TEXT)`);
            harness.ddl(`CREATE TABLE "messages" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "authorId" TEXT, "body" TEXT)`);
            harness.ddl(
                `CREATE TABLE "reactions" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "messageId" TEXT, "emoji" TEXT)`,
            );

            return createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema: buildRelSchema(action) });
        };

        const seedRelations = async (writer: DatabaseWriterLike): Promise<void> => {
            await writer.insert("users", { _id: "u1", name: "Ada" }, { allowExplicitId: true });
            await writer.insert("users", { _id: "u2", name: "Linus" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m2", authorId: "u1", body: "yo" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m3", authorId: "u2", body: "hey" }, { allowExplicitId: true });
            await writer.insert("reactions", { _id: "r1", emoji: "thumbsup", messageId: "m1" }, { allowExplicitId: true });
            await writer.insert("reactions", { _id: "r2", emoji: "party", messageId: "m1" }, { allowExplicitId: true });
            await writer.insert("reactions", { _id: "r3", emoji: "fire", messageId: "m2" }, { allowExplicitId: true });
        };

        it("loads a one relation as Doc | null", async () => {
            expect.assertions(1);

            const writer = setupRelations();

            await seedRelations(writer);

            const { page } = await writer.findMany("messages", { where: { authorId: "u1" }, with: { author: true } });

            expect((page[0]!["author"] as Record<string, unknown>)["name"]).toBe("Ada");
        });

        it("loads a many relation grouped per parent", async () => {
            expect.assertions(1);

            const writer = setupRelations();

            await seedRelations(writer);

            const { page } = await writer.findMany("users", { with: { messages: true } });
            const ada = page.find((row) => row["_id"] === "u1")!;

            expect(ids(ada["messages"] as Record<string, unknown>[])).toEqual(["m1", "m2"]);
        });

        it("applies relationBaseWhere on a SAME-backend with hop (RLS on the relation)", async () => {
            expect.assertions(2);

            const writer = setupRelations();

            await seedRelations(writer);

            // This writer's `findMany` used to call `resolveWith` WITHOUT forwarding
            // `relationBaseWhere`, so a child table's read policy was dropped on
            // every relation hop — a cross-tenant read on the global backend. The
            // shard backend had always forwarded it; only this one drifted.
            const { page } = await writer.findMany("users", {
                relationBaseWhere: (table) => (table === "messages" ? { body: "hi" } : undefined),
                with: { messages: true },
            });
            const ada = page.find((row) => row["_id"] === "u1")!;
            const linus = page.find((row) => row["_id"] === "u2")!;

            // Only m1 ("hi") is readable; m2 ("yo") and m3 ("hey") are filtered out.
            expect(ids(ada["messages"] as Record<string, unknown>[])).toEqual(["m1"]);
            expect(linus["messages"]).toEqual([]);
        });

        it("applies relationMask on a SAME-backend with hop, at depth", async () => {
            expect.assertions(2);

            const writer = setupRelations();

            await seedRelations(writer);

            // The column-level twin of the hook above, threaded the same way: a
            // masked column on a `with`-hydrated child must not come back clear.
            const { page } = await writer.findMany("users", {
                relationMask: (table, rows) =>
                    table === "reactions"
                        ? rows.map((row) => {
                              return { ...row, emoji: null };
                          })
                        : rows,
                where: { _id: "u1" },
                with: { messages: { with: { reactions: true } } },
            });
            const messages = page[0]!["messages"] as Record<string, unknown>[];
            const reactions = messages.find((row) => row["_id"] === "m1")!["reactions"] as Record<string, unknown>[];

            expect(reactions.length).toBeGreaterThan(0);
            expect(reactions.every((row) => row["emoji"] === null)).toBe(true);
        });

        it("nested with recurses (users → messages → reactions)", async () => {
            expect.assertions(1);

            const writer = setupRelations();

            await seedRelations(writer);

            const { page } = await writer.findMany("users", { where: { _id: "u1" }, with: { messages: { with: { reactions: true } } } });
            const messages = page[0]!["messages"] as Record<string, unknown>[];
            const m1 = messages.find((row) => row["_id"] === "m1")!;

            expect(ids(m1["reactions"] as Record<string, unknown>[])).toEqual(["r1", "r2"]);
        });

        it("per-group limit caps a many relation in memory", async () => {
            expect.assertions(1);

            const writer = setupRelations();

            await seedRelations(writer);

            const { page } = await writer.findMany("users", { where: { _id: "u1" }, with: { messages: { limit: 1 } } });

            expect(page[0]!["messages"]).toHaveLength(1);
        });

        it("_count attaches per-parent aggregate", async () => {
            expect.assertions(2);

            const writer = setupRelations();

            await seedRelations(writer);

            const { page } = await writer.findMany("messages", { orderBy: [{ _id: "asc" }], with: { _count: { reactions: true } } });

            expect((page[0]!["_count"] as Record<string, number>)["reactions"]).toBe(2);
            expect((page[2]!["_count"] as Record<string, number>)["reactions"]).toBe(0);
        });

        it("onDelete cascade removes holder rows and chains", async () => {
            expect.assertions(2);

            const writer = setupRelations("cascade");

            await writer.insert("users", { _id: "u1", name: "Ada" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" }, { allowExplicitId: true });
            await writer.insert("reactions", { _id: "r1", emoji: "thumbsup", messageId: "m1" }, { allowExplicitId: true });

            await writer.delete("u1");

            await expect(writer.get("m1")).resolves.toBeNull();
            await expect(writer.get("r1")).resolves.toBeNull();
        });

        it("onDelete set null clears the FK", async () => {
            expect.assertions(2);

            const writer = setupRelations("set null");

            await writer.insert("users", { _id: "u1", name: "Ada" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" }, { allowExplicitId: true });

            await writer.delete("u1");

            const message = await writer.get("m1");

            expect(message).not.toBeNull();
            expect(message!["authorId"]).toBeNull();
        });

        it("onDelete restrict aborts when a holder remains", async () => {
            expect.assertions(2);

            const writer = setupRelations("restrict");

            await writer.insert("users", { _id: "u1", name: "Ada" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" }, { allowExplicitId: true });

            await expect(writer.delete("u1")).rejects.toBeInstanceOf(ConflictError);
            await expect(writer.get("u1")).resolves.not.toBeNull();
        });

        it("cross-backend (global → shardBy) cascade is refused with a clear message", async () => {
            expect.assertions(1);

            // `messages` is declared shardBy here — that's the unsupported
            // direction from D1's POV. The writer must throw on the cascade
            // attempt rather than silently leave the holders behind.
            const schema: SchemaLike = {
                tables: {
                    messages: {
                        indexes: [],
                        relationMap: {
                            author: { field: "authorId", kind: "one", onDelete: "cascade", references: "_id", table: "users" },
                        },
                        shape: { authorId: col("string"), body: col("string") },
                        shardMode: { field: "authorId", kind: "shardBy" },
                    },
                    users: { indexes: [], shape: { name: col("string") } },
                },
            };

            harness.ddl(`CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "name" TEXT)`);
            // No D1 messages table — they live on shards in the real topology;
            // the cascade must refuse before we'd reach the missing table.

            const writer = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

            await writer.insert("users", { _id: "u1", name: "Ada" }, { allowExplicitId: true });

            await expect(writer.delete("u1")).rejects.toThrow(CROSS_BACKEND_CASCADE_RE);
        });
    });

    describe("triggers", () => {
        const messagesDdl = (): void => {
            harness.ddl(`CREATE TABLE "messages" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "body" TEXT, "locked" INTEGER)`);
        };

        it("before/after insert fire in order with the new doc", async () => {
            expect.assertions(2);

            const events: { doc?: unknown; phase: string }[] = [];
            const schema: SchemaLike = {
                tables: {
                    messages: {
                        indexes: [],
                        shape: { body: col("string"), locked: col("boolean") },
                        triggerMap: {
                            a: {
                                handler: (_context, event) => {
                                    events.push({ doc: event.doc, phase: "after" });
                                },
                                op: "insert",
                                timing: "after",
                            },
                            b: {
                                handler: (_context, event) => {
                                    events.push({ doc: event.doc, phase: "before" });
                                },
                                op: "insert",
                                timing: "before",
                            },
                        },
                    },
                },
            };

            messagesDdl();

            const writer = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

            await writer.insert("messages", { _id: "m1", body: "hi", locked: false }, { allowExplicitId: true });

            expect(events.map((e) => e.phase)).toEqual(["before", "after"]);
            expect((events[1]!.doc as Record<string, unknown>)["_id"]).toBe("m1");
        });

        it("update triggers see merged doc and previous on patch", async () => {
            expect.assertions(2);

            let captured: TriggerEventLike | undefined;
            const schema: SchemaLike = {
                tables: {
                    messages: {
                        indexes: [],
                        shape: { body: col("string"), locked: col("boolean") },
                        triggerMap: {
                            a: {
                                handler: (_context, event) => {
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

            const writer = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

            await writer.insert("messages", { _id: "m1", body: "hi", locked: false }, { allowExplicitId: true });
            await writer.patch("m1", { body: "bye" });

            expect((captured!.doc as Record<string, unknown>)["body"]).toBe("bye");
            expect((captured!.previous as Record<string, unknown>)["body"]).toBe("hi");
        });

        it("a throwing beforeDelete aborts the delete — the row survives", async () => {
            expect.assertions(2);

            const schema: SchemaLike = {
                tables: {
                    messages: {
                        indexes: [],
                        shape: { body: col("string"), locked: col("boolean") },
                        triggerMap: {
                            guard: {
                                handler: (_context, event) => {
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

            const writer = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

            await writer.insert("messages", { _id: "m1", body: "hi", locked: true }, { allowExplicitId: true });

            await expect(writer.delete("m1")).rejects.toBeInstanceOf(ConflictError);
            await expect(writer.get("m1")).resolves.not.toBeNull();
        });

        it("an afterInsert handler writing another table via ctx.db persists", async () => {
            expect.assertions(2);

            const schema: SchemaLike = {
                tables: {
                    audit: { indexes: [], shape: { row: col("string"), table: col("string") }, triggerMap: {} },
                    messages: {
                        indexes: [],
                        shape: { body: col("string"), locked: col("boolean") },
                        triggerMap: {
                            audit: {
                                handler: async (context, event) => {
                                    await context.db.insert("audit", { row: event.id, table: event.table });
                                },
                                op: "insert",
                                timing: "after",
                            },
                        },
                    },
                },
            };

            messagesDdl();
            harness.ddl(`CREATE TABLE "audit" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "row" TEXT, "table" TEXT)`);

            const writer = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

            await writer.insert("messages", { _id: "m1", body: "hi", locked: false }, { allowExplicitId: true });

            const { page } = await writer.findMany("audit");

            expect(page).toHaveLength(1);
            expect(page[0]!["row"]).toBe("m1");
        });

        it("ctx.scheduler reaches the scheduler passed to createD1CtxDb", async () => {
            expect.assertions(1);

            const runAfter = vi.fn<SchedulerLike["runAfter"]>(async () => "job-1");
            const scheduler: SchedulerLike = { runAfter, runAt: async () => "job-2" };
            const schema: SchemaLike = {
                tables: {
                    messages: {
                        indexes: [],
                        shape: { body: col("string"), locked: col("boolean") },
                        triggerMap: {
                            bump: {
                                handler: async (context, event) => {
                                    await context.scheduler.runAfter(0, "counters:recount", { id: event.id });
                                },
                                op: "insert",
                                timing: "after",
                            },
                        },
                    },
                },
            };

            messagesDdl();

            const writer = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, scheduler, schema });

            await writer.insert("messages", { _id: "m1", body: "hi", locked: false }, { allowExplicitId: true });

            expect(runAfter).toHaveBeenCalledWith(0, "counters:recount", { id: "m1" });
        });

        it("the default scheduler throws when a trigger uses it unconfigured", async () => {
            expect.assertions(1);

            const schema: SchemaLike = {
                tables: {
                    messages: {
                        indexes: [],
                        shape: { body: col("string"), locked: col("boolean") },
                        triggerMap: {
                            bump: {
                                handler: async (context) => {
                                    await context.scheduler.runAfter(0, "noop");
                                },
                                op: "insert",
                                timing: "after",
                            },
                        },
                    },
                },
            };

            messagesDdl();

            const writer = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

            await expect(writer.insert("messages", { _id: "m1", body: "hi", locked: false }, { allowExplicitId: true })).rejects.toThrow(NO_SCHEDULER_RE);
        });
    });

    describe("optimistic concurrency (OCC)", () => {
        it("a concurrent modification during the write window raises ConflictError", async () => {
            expect.assertions(3);

            let raced = false;
            // Assigned below, once the schema it needs exists: the competing
            // writer is a SECOND store over the same database — which is what a
            // concurrent mutation actually is, another isolate running this same
            // code against the shared D1 — rather than hand-rolled SQL. The CAS
            // compares the row version every guarded write bumps, so a competitor
            // that does not go through the store is not what it detects.
            let competitor: undefined | ReturnType<typeof createD1ContextDatabase>;

            // A before-update trigger spans an `await`, giving a competing writer
            // a window to commit. The handler directly mutates the same row on the
            // first patch attempt (once) — exactly the race the CAS must catch.
            const schema: SchemaLike = {
                tables: {
                    todos: {
                        indexes: [],
                        shape: {
                            archived: col("boolean"),
                            priority: col("string"),
                            projectId: col("string"),
                            seq: col("number"),
                        },
                        triggerMap: {
                            race: {
                                handler: async () => {
                                    if (raced) {
                                        return;
                                    }

                                    raced = true;

                                    // Competing writer commits during the window.
                                    await competitor?.patch("t1", { seq: 999 });
                                },
                                op: "update",
                                timing: "before",
                            },
                        },
                    },
                },
            };

            harness.ddl(
                `CREATE TABLE "todos" (
                "id" TEXT PRIMARY KEY,
                "_creationTime" INTEGER NOT NULL,
                "_version" INTEGER,
                "archived" INTEGER,
                "priority" TEXT,
                "projectId" TEXT,
                "seq" INTEGER
            )`,
            );

            const writer = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

            competitor = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

            await writer.insert("todos", { _id: "t1", archived: false, priority: "high", projectId: "p1", seq: 1 }, { allowExplicitId: true });

            await expect(writer.patch("t1", { priority: "low" })).rejects.toBeInstanceOf(ConflictError);

            // The competing writer's value survives — the guarded UPDATE matched
            // zero rows rather than clobbering it.
            const reloaded = (await writer.get("t1")) as Record<string, unknown>;

            expect(reloaded["seq"]).toBe(999);
            expect(reloaded["priority"]).toBe("high");
        });

        it("single-writer patch / delete / replace succeed without false conflicts", async () => {
            expect.assertions(6);

            const writer = setupTodos();

            await seed(writer);

            // patch round-trips a representative spread of column types (boolean,
            // string, number) so a node:sqlite value round-trip mismatch would
            // surface as a false conflict here.
            await writer.patch("t1", { archived: true, priority: "low", seq: 42 });

            const patched = (await writer.get("t1")) as Record<string, unknown>;

            expect(patched["archived"]).toBe(true);
            expect(patched["priority"]).toBe("low");
            expect(patched["seq"]).toBe(42);

            // replace overwrites the whole row.
            await writer.replace("t2", { archived: false, priority: "medium", projectId: "p9", seq: 7 });

            const replaced = (await writer.get("t2")) as Record<string, unknown>;

            expect(replaced["projectId"]).toBe("p9");
            expect(replaced["seq"]).toBe(7);

            // delete removes it cleanly.
            await writer.delete("t3");

            await expect(writer.get("t3")).resolves.toBeNull();
        });
    });
});
