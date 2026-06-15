import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { resolveWith } from "../src/relations";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Exercises `with`-loading, `_count`, and `onDelete` against a real SQLite
 * engine (workerd can't run in the sandbox). The relation machinery is
 * dialect-agnostic, so proving it here proves the same code path D1 takes.
 */

let harness: ReturnType<typeof createSqliteExec>;

const makeWriter = (schema: SchemaLike): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

const ids = (docs: Record<string, unknown>[]): unknown[] => docs.map((document_) => document_["_id"]);

describe("ctx-db relations", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("with — loading relations", () => {
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [{ fields: ["authorId"], name: "by_author" }],
                    relationMap: {
                        author: { field: "authorId", kind: "one", references: "_id", table: "users" },
                        reactions: { field: "messageId", kind: "many", references: "_id", table: "reactions" },
                    },
                    shape: { authorId: { kind: "string" }, body: { kind: "string" } },
                },
                reactions: {
                    indexes: [{ fields: ["messageId"], name: "by_message" }],
                    shape: { emoji: { kind: "string" }, messageId: { kind: "string" } },
                },
                users: {
                    indexes: [],
                    relationMap: {
                        messages: { field: "authorId", kind: "many", references: "_id", table: "messages" },
                    },
                    shape: { name: { kind: "string" } },
                },
            },
        };

        const seed = async (writer: DatabaseWriterLike): Promise<void> => {
            await writer.insert("users", { _id: "u1", name: "Ada" }, { allowExplicitId: true });
            await writer.insert("users", { _id: "u2", name: "Linus" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m2", authorId: "u1", body: "yo" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m3", authorId: "u2", body: "hey" }, { allowExplicitId: true });
            await writer.insert("reactions", { _id: "r1", emoji: "👍", messageId: "m1" }, { allowExplicitId: true });
            await writer.insert("reactions", { _id: "r2", emoji: "🎉", messageId: "m1" }, { allowExplicitId: true });
            await writer.insert("reactions", { _id: "r3", emoji: "🔥", messageId: "m2" }, { allowExplicitId: true });
        };

        it("loads a one relation as Doc | null", async () => {
            expect.assertions(3);

            const writer = makeWriter(schema);

            await seed(writer);

            const { page } = await writer.findMany("messages", { where: { authorId: "u1" }, with: { author: true } });

            expect(page).toHaveLength(2);
            expect((page[0]!["author"] as Record<string, unknown>)["name"]).toBe("Ada");
            expect((page[1]!["author"] as Record<string, unknown>)["_id"]).toBe("u1");
        });

        it("one relation with no match attaches null", async () => {
            expect.assertions(1);

            const writer = makeWriter(schema);

            await writer.insert("messages", { _id: "m9", authorId: "ghost", body: "?" }, { allowExplicitId: true });

            const { page } = await writer.findMany("messages", { with: { author: true } });

            expect(page[0]!["author"]).toBeNull();
        });

        it("loads a many relation as Doc[] grouped per parent", async () => {
            expect.assertions(2);

            const writer = makeWriter(schema);

            await seed(writer);

            const { page } = await writer.findMany("users", { with: { messages: true } });
            const ada = page.find((row) => row["_id"] === "u1")!;
            const linus = page.find((row) => row["_id"] === "u2")!;

            expect(ids(ada["messages"] as Record<string, unknown>[])).toEqual(["m1", "m2"]);
            expect(ids(linus["messages"] as Record<string, unknown>[])).toEqual(["m3"]);
        });

        it("many relation with no children attaches []", async () => {
            expect.assertions(1);

            const writer = makeWriter(schema);

            await writer.insert("users", { _id: "u3", name: "Loner" }, { allowExplicitId: true });

            const { page } = await writer.findMany("users", { where: { _id: "u3" }, with: { messages: true } });

            expect(page[0]!["messages"]).toEqual([]);
        });

        it("nested with recurses (users → messages → reactions)", async () => {
            expect.assertions(1);

            const writer = makeWriter(schema);

            await seed(writer);

            const { page } = await writer.findMany("users", { where: { _id: "u1" }, with: { messages: { with: { reactions: true } } } });
            const messages = page[0]!["messages"] as Record<string, unknown>[];
            const m1 = messages.find((row) => row["_id"] === "m1")!;

            expect(ids(m1["reactions"] as Record<string, unknown>[])).toEqual(["r1", "r2"]);
        });

        it("nested where + orderBy + limit apply to a many relation", async () => {
            expect.assertions(1);

            const writer = makeWriter(schema);

            await seed(writer);

            const { page } = await writer.findMany("messages", {
                where: { _id: "m1" },
                with: { reactions: { limit: 1, orderBy: [{ emoji: "desc" }] } },
            });
            const reactions = page[0]!["reactions"] as Record<string, unknown>[];

            expect(reactions).toHaveLength(1);
        });

        it("_count attaches per-parent aggregate without loading rows", async () => {
            expect.assertions(4);

            const writer = makeWriter(schema);

            await seed(writer);

            const { page } = await writer.findMany("messages", { orderBy: [{ _id: "asc" }], with: { _count: { reactions: true } } });

            expect((page[0]!["_count"] as Record<string, number>)["reactions"]).toBe(2);
            expect((page[1]!["_count"] as Record<string, number>)["reactions"]).toBe(1);
            expect((page[2]!["_count"] as Record<string, number>)["reactions"]).toBe(0);
            expect(page[0]!["reactions"]).toBeUndefined();
        });

        it("throws on an unknown relation name", async () => {
            expect.assertions(1);

            const writer = makeWriter(schema);

            await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" }, { allowExplicitId: true });

            await expect(writer.findMany("messages", { with: { nope: true } })).rejects.toThrow(/unknown relation "nope"/);
        });
    });

    describe("onDelete", () => {
        const buildSchema = (action: "cascade" | "restrict" | "set null"): SchemaLike => {
            return {
                tables: {
                    messages: {
                        indexes: [{ fields: ["authorId"], name: "by_author" }],
                        relationMap: {
                            author: { field: "authorId", kind: "one", onDelete: action, references: "_id", table: "users" },
                            reactions: { field: "messageId", kind: "many", references: "_id", table: "reactions" },
                        },
                        shape: { authorId: { kind: "string" }, body: { kind: "string" } },
                    },
                    reactions: {
                        indexes: [{ fields: ["messageId"], name: "by_message" }],
                        relationMap: {
                            message: { field: "messageId", kind: "one", onDelete: "cascade", references: "_id", table: "messages" },
                        },
                        shape: { emoji: { kind: "string" }, messageId: { kind: "string" } },
                    },
                    users: { indexes: [], shape: { name: { kind: "string" } } },
                },
            };
        };

        it("cascade deletes holder rows (and chains recursively)", async () => {
            expect.assertions(2);

            const writer = makeWriter(buildSchema("cascade"));

            await writer.insert("users", { _id: "u1", name: "Ada" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" }, { allowExplicitId: true });
            await writer.insert("reactions", { _id: "r1", emoji: "👍", messageId: "m1" }, { allowExplicitId: true });

            await writer.delete("u1");

            await expect(writer.get("m1")).resolves.toBeNull();
            await expect(writer.get("r1")).resolves.toBeNull();
        });

        it("set null clears the FK on holder rows", async () => {
            expect.assertions(2);

            const writer = makeWriter(buildSchema("set null"));

            await writer.insert("users", { _id: "u1", name: "Ada" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" }, { allowExplicitId: true });

            await writer.delete("u1");

            const message = await writer.get("m1");

            expect(message).not.toBeNull();
            expect(message!["authorId"]).toBeNull();
        });

        it("restrict throws when a holder still references the parent", async () => {
            expect.assertions(2);

            const writer = makeWriter(buildSchema("restrict"));

            await writer.insert("users", { _id: "u1", name: "Ada" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" }, { allowExplicitId: true });

            await expect(writer.delete("u1")).rejects.toThrow(/still references it/);
            await expect(writer.get("u1")).resolves.not.toBeNull();
        });

        it("restrict allows deletion once no holders remain", async () => {
            expect.assertions(1);

            const writer = makeWriter(buildSchema("restrict"));

            await writer.insert("users", { _id: "u1", name: "Ada" }, { allowExplicitId: true });

            await writer.delete("u1");

            await expect(writer.get("u1")).resolves.toBeNull();
        });
    });

    describe("cross-backend relation load (DO parent → D1 child)", () => {
        const schema: SchemaLike = {
            tables: {
                globals: { indexes: [], shape: { value: { kind: "string" } }, shardMode: { kind: "global" } },
                local: {
                    indexes: [],
                    relationMap: { remote: { field: "ref", kind: "one", references: "_id", table: "globals" } },
                    shape: { ref: { kind: "string" } },
                    shardMode: { kind: "root" },
                },
            },
        };

        /** Minimal in-memory "D1" reader: answers `findMany` with `where._id in [...]`. */
        const buildFakeGlobalDatabase = (rows: Record<string, unknown>[]) => {
            const byId = new Map(rows.map((row) => [row["_id"] as string, row] as const));

            return {
                async count(_table: string, where?: { _id?: { in?: unknown[] } }) {
                    const inList = where?._id?.in;

                    return Array.isArray(inList) ? inList.filter((id) => byId.has(id as string)).length : byId.size;
                },
                async findMany(_table: string, query?: { where?: { _id?: { in?: unknown[] } } }) {
                    const inList = query?.where?._id?.in;
                    const page = Array.isArray(inList)
                        ? (inList.map((id) => byId.get(id as string)).filter(Boolean) as Record<string, unknown>[])
                        : [...byId.values()];

                    return { continueCursor: null, isDone: true, page };
                },
            };
        };

        it("loads a shard-local parent's global child through the supplied globalDb", async () => {
            expect.assertions(2);

            runShardMigrations(harness.sql, schema);

            const fake = buildFakeGlobalDatabase([
                { _id: "g1", value: "alpha" },
                { _id: "g2", value: "beta" },
            ]);
            const writer = createShardContextDatabase({
                clock: () => 1_700_000_000_000,
                globalDb: fake as unknown as DatabaseWriterLike,
                schema,
                sql: harness.sql,
            });

            await writer.insert("local", { _id: "l1", ref: "g1" }, { allowExplicitId: true });

            const { page } = await writer.findMany("local", { with: { remote: true } });

            expect(page).toHaveLength(1);
            expect(page[0]?.["remote"]).toMatchObject({ _id: "g1", value: "alpha" });
        });

        it("throws a wiring error when the global child has no globalDb to route to", async () => {
            expect.assertions(1);

            const writer = makeWriter(schema);

            await writer.insert("local", { _id: "l1", ref: "g1" }, { allowExplicitId: true });

            await expect(writer.findMany("local", { with: { remote: true } })).rejects.toThrow(/requires a globalDb writer/u);
        });

        it("delegates the reverse direction (global parent → shard-local child) to the injected fetcher", async () => {
            expect.assertions(2);

            // `globals` (global, D1) declares a relation to `local` (shard-local).
            // The loader no longer pre-rejects this direction — routing is the
            // injected fetcher's job (in production the D1 ctx-db's cross-shard
            // reader, or a clear throw when that capability is unwired).
            const reverseSchema: SchemaLike = {
                tables: {
                    globals: {
                        indexes: [],
                        relationMap: { owner: { field: "ownerId", kind: "one", references: "_id", table: "local" } },
                        shape: { ownerId: { kind: "string" } },
                        shardMode: { kind: "global" },
                    },
                    local: { indexes: [], shape: { name: { kind: "string" } }, shardMode: { kind: "root" } },
                },
            };

            const fetchedTables: string[] = [];
            const parents = [{ _id: "g1", ownerId: "l1" }];

            await resolveWith({
                counter: async () => 0,
                fetcher: async (table) => {
                    fetchedTables.push(table);

                    return { continueCursor: null, isDone: true, page: [{ _id: "l1", name: "Local One" }] };
                },
                parents,
                schema: reverseSchema,
                tableName: "globals",
                with: { owner: true },
            });

            // The loader delegated to the fetcher for the shard-local child …
            expect(fetchedTables).toEqual(["local"]);
            // … and attached the loaded child onto the global parent.
            expect(parents[0]).toMatchObject({ owner: { _id: "l1", name: "Local One" } });
        });
    });

    describe("generic global-table routing (ctx.db.insert/findMany/get → D1)", () => {
        const schema: SchemaLike = {
            tables: {
                globals: { indexes: [], shape: { value: { kind: "string" } }, shardMode: { kind: "global" } },
                local: { indexes: [], shape: { value: { kind: "string" } }, shardMode: { kind: "root" } },
            },
        };

        /** In-memory "D1" writer that records every call so the test can prove routing. */
        const buildRecordingGlobalDatabase = () => {
            const rows = new Map<string, Record<string, unknown>>();
            const calls: string[] = [];

            return {
                calls,
                async findMany(table: string) {
                    calls.push(`findMany:${table}`);

                    return { continueCursor: null, isDone: true, page: [...rows.values()] };
                },
                async get(id: string) {
                    calls.push(`get:${id}`);

                    return rows.get(id) ?? null;
                },
                async insert(table: string, document: Record<string, unknown>) {
                    calls.push(`insert:${table}`);
                    const id = (document["_id"] as string) ?? `g-${rows.size.toString()}`;

                    rows.set(id, { _id: id, ...document });

                    return id;
                },
                async rank(table: string) {
                    calls.push(`rank:${table}`);

                    return null;
                },
                async rankPage(table: string) {
                    calls.push(`rankPage:${table}`);

                    return { entries: [], hasMore: false };
                },
                rows,
            };
        };

        it("routes a generic insert + findMany on a global table to the globalDb", async () => {
            expect.assertions(4);

            runShardMigrations(harness.sql, schema);

            const fake = buildRecordingGlobalDatabase();
            const writer = createShardContextDatabase({
                clock: () => 1_700_000_000_000,
                globalDb: fake as unknown as DatabaseWriterLike,
                schema,
                sql: harness.sql,
            });

            await writer.insert("globals", { _id: "g1", value: "alpha" }, { allowExplicitId: true });

            // The global write landed in the D1 writer, not the DO's local SQLite.
            expect(fake.calls).toContain("insert:globals");
            expect(fake.rows.get("g1")).toMatchObject({ value: "alpha" });

            const { page } = await writer.findMany("globals");

            expect(fake.calls).toContain("findMany:globals");
            expect(page).toHaveLength(1);
        });

        it("falls back to the globalDb for an id-addressed get when the row isn't local", async () => {
            expect.assertions(2);

            runShardMigrations(harness.sql, schema);

            const fake = buildRecordingGlobalDatabase();
            fake.rows.set("g1", { _id: "g1", value: "alpha" });
            const writer = createShardContextDatabase({
                clock: () => 1_700_000_000_000,
                globalDb: fake as unknown as DatabaseWriterLike,
                schema,
                sql: harness.sql,
            });

            const row = await writer.get("g1");

            expect(fake.calls).toContain("get:g1");
            expect(row).toMatchObject({ value: "alpha" });
        });

        it("routes rank/rankPage on a global table to globalDb, and rejects rankBefore", async () => {
            expect.assertions(3);

            runShardMigrations(harness.sql, schema);

            const fake = buildRecordingGlobalDatabase();
            const writer = createShardContextDatabase({
                clock: () => 1_700_000_000_000,
                globalDb: fake as unknown as DatabaseWriterLike,
                schema,
                sql: harness.sql,
            });

            await writer.rank("globals", "byValue", { row: "g1" });
            await writer.rankPage("globals", "byValue", {});

            expect(fake.calls).toContain("rank:globals");
            expect(fake.calls).toContain("rankPage:globals");

            // `rankBefore` has no D1 twin — global tables must fail clearly, not
            // route into a non-existent `globalDb.rankBefore`.
            await expect(writer.rankBefore!("globals", "byValue", { partitionKey: "", rowId: "g1", sortValues: [] })).rejects.toThrow(
                /not supported on the global/u,
            );
        });

        it("throws a wiring error for a generic global insert when no globalDb is supplied", async () => {
            expect.assertions(1);

            const writer = makeWriter(schema);

            await expect(writer.insert("globals", { value: "alpha" })).rejects.toThrow(/requires a globalDb writer/u);
        });
    });

    describe("cross-backend onDelete cascade (DO parent → D1 holder)", () => {
        /**
         * Schema: `groups` lives on the DO (root); `memberships` lives on D1
         * (global) and holds an FK back to a group with `onDelete: cascade`. When
         * a group is deleted, the cascade has to reach across into D1 and remove
         * any membership pointing at it — that's what the new `globalDb` option
         * to `createShardCtxDb` enables.
         */
        const schema: SchemaLike = {
            tables: {
                groups: {
                    indexes: [],
                    shape: { name: { kind: "string" } },
                    shardMode: { kind: "root" },
                },
                memberships: {
                    indexes: [{ fields: ["groupId"], name: "by_group" }],
                    relationMap: {
                        group: { field: "groupId", kind: "one", onDelete: "cascade", references: "_id", table: "groups" },
                    },
                    shape: { groupId: { kind: "string" }, userId: { kind: "string" } },
                    shardMode: { kind: "global" },
                },
            },
        };

        /**
         * In-memory fake "D1" writer that captures the rows it sees so the test
         * can assert the cascade actually ran through it (not silently swallowed
         * by the DO writer's lookup-by-id miss). Only the surface the cascade
         * touches is implemented; everything else throws to surface accidental use.
         */
        const buildFakeGlobalDatabase = () => {
            const rows = new Map<string, Record<string, unknown>>();

            const writer = {
                async delete(id: string) {
                    rows.delete(id);
                },
                async findMany(_table: string, query?: { where?: Record<string, unknown> }) {
                    const where = query?.where ?? {};
                    const page = [...rows.values()].filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));

                    return { continueCursor: null, isDone: true, page };
                },
                async insert(_table: string, document_: Record<string, unknown>) {
                    const id = typeof document_["_id"] === "string" ? document_["_id"] : `m_${String(rows.size + 1)}`;

                    rows.set(id, { ...document_, _id: id });

                    return id;
                },
                async patch(id: string, patch: Record<string, unknown>) {
                    const existing = rows.get(id);

                    if (existing) {
                        rows.set(id, { ...existing, ...patch });
                    }
                },
            };

            return { rows, writer };
        };

        it("cascade reaches into the supplied globalDb when the holder is global", async () => {
            expect.assertions(1);

            runShardMigrations(harness.sql, schema);

            const { rows, writer: fake } = buildFakeGlobalDatabase();
            const writer = createShardContextDatabase({
                clock: () => 1_700_000_000_000,
                globalDb: fake as unknown as DatabaseWriterLike,
                schema,
                sql: harness.sql,
            });

            await writer.insert("groups", { _id: "g1", name: "Engineering" }, { allowExplicitId: true });
            await fake.insert("memberships", { _id: "m1", groupId: "g1", userId: "u1" });
            await fake.insert("memberships", { _id: "m2", groupId: "g1", userId: "u2" });
            await fake.insert("memberships", { _id: "m3", groupId: "g2", userId: "u3" });

            await writer.delete("g1");

            // The cascade should have removed every membership pointing at g1
            // and left the one pointing at g2 alone.
            expect([...rows.keys()].toSorted((a, b) => a.localeCompare(b))).toEqual(["m3"]);
        });

        it("missing globalDb throws a helpful error rather than silently dropping the cascade", async () => {
            expect.assertions(1);

            runShardMigrations(harness.sql, schema);

            // No `globalDb` passed in — the cascade should refuse rather than
            // delete the parent while leaving the global holders dangling.
            const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

            await writer.insert("groups", { _id: "g1", name: "Engineering" }, { allowExplicitId: true });

            await expect(writer.delete("g1")).rejects.toThrow(/cross-backend cascade.*globalDb/u);
        });
    });

    describe("cross-backend onDelete rejected (D1 parent → shardBy holder)", () => {
        /**
         * The reverse direction (global → shardBy) genuinely can't be supported
         * without Query Coordinator fan-out across DOs. The D1 writer's cascade
         * pre-flights and throws when it would have to reach into a shardBy
         * table. Tested in `@lunora/d1`; this comment-only stub documents the
         * symmetry from the DO side so a future Coordinator implementation
         * has a clear home.
         */
        it.todo("global → shardBy cascade is documented as unsupported; covered in @lunora/d1 tests");
    });
});
