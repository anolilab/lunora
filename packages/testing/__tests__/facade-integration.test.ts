import { bindTableFacade } from "@lunora/server";
import type { SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqlExec } from "../src/node-sqlite";

/**
 * End-to-end check that the per-table facade's composed methods
 * (`upsert`/`upsertMany`/`exists` + `insert({ skipDuplicates })`) work over the
 * REAL `@lunora/do` writer and a REAL SQLite UNIQUE index — not a mock. This is
 * what proves the `skipDuplicates` path actually recognises the `ConflictError`
 * the engine throws on a unique breach, and that `upsert` finds-then-patches a
 * genuinely-persisted row.
 */
const schema: SchemaLike = {
    tables: {
        users: {
            indexes: [],
            shape: {
                email: { _meta: { column: { notNull: true, unique: true } }, kind: "string" },
                name: { kind: "string" },
            },
        },
    },
};

let harness: ReturnType<typeof createSqlExec>;

const setup = () => {
    runShardMigrations(harness.sql, schema);

    const writer = createShardCtxDb({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

    return bindTableFacade(writer, "users");
};

describe("facade over the real writer — upsert / exists / skipDuplicates", () => {
    beforeEach(() => {
        harness = createSqlExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("insert({ skipDuplicates }) returns null on a real UNIQUE breach", async () => {
        expect.assertions(3);

        const users = setup();

        const id = await users.insert({ email: "a@b.c", name: "Ada" });

        expect(typeof id).toBe("string");
        // A second insert of the same email breaches the UNIQUE index → swallowed.
        await expect(users.insert({ email: "a@b.c", name: "Ada II" }, { skipDuplicates: true })).resolves.toBeNull();
        // Without skipDuplicates the same breach throws.
        await expect(users.insert({ email: "a@b.c", name: "Ada III" })).rejects.toMatchObject({ code: "CONFLICT", kind: "unique" });
    });

    it("exists reflects real rows", async () => {
        expect.assertions(2);

        const users = setup();

        await users.insert({ email: "a@b.c", name: "Ada" });

        await expect(users.exists({ email: "a@b.c" })).resolves.toBe(true);
        await expect(users.exists({ email: "nobody@b.c" })).resolves.toBe(false);
    });

    it("upsert inserts then updates the same row keyed by a unique target", async () => {
        expect.assertions(4);

        const users = setup();

        const created = await users.upsert({ create: { email: "a@b.c", name: "Ada" }, target: "email" });

        expect(created.created).toBe(true);

        const updated = await users.upsert({ create: { email: "a@b.c", name: "ignored" }, target: "email", update: { name: "Ada Lovelace" } });

        expect(updated).toStrictEqual({ created: false, id: created.id });

        const row = await users.get(created.id);

        expect(row).toMatchObject({ email: "a@b.c", name: "Ada Lovelace" });
        // Exactly one row exists — upsert updated in place rather than inserting a duplicate.
        await expect(users.count()).resolves.toBe(1);
    });

    it("upsertMany inserts new rows and updates existing ones in one call", async () => {
        expect.assertions(3);

        const users = setup();

        await users.insert({ email: "a@b.c", name: "Ada" });

        const results = await users.upsertMany({
            rows: [{ create: { email: "a@b.c", name: "x" }, update: { name: "Ada v2" } }, { create: { email: "g@b.c", name: "Grace" } }],
            target: "email",
        });

        expect(results.map((entry) => entry.created)).toStrictEqual([false, true]);
        await expect(users.count()).resolves.toBe(2);

        const ada = await users.findFirst({ where: { email: "a@b.c" } });

        expect(ada).toMatchObject({ name: "Ada v2" });
    });
});

/**
 * `.global()` tables live in D1, not this DO's SQLite, so every by-id call the
 * per-table facade makes (`ctx.db.profiles.get/patch/delete/...`) misses the
 * shard-local probe and has to fall through to the `globalDb` writer. The
 * facade pins its bound table on every one of those calls, so this is the only
 * shape that exercises the pinned-and-global combination — the generic
 * `writer.get(id)` form takes a different branch.
 */
const globalSchema: SchemaLike = {
    tables: {
        notes: { indexes: [], shape: { value: { kind: "string" } }, shardMode: { kind: "root" } },
        others: { indexes: [], shape: { value: { kind: "string" } }, shardMode: { kind: "global" } },
        profiles: {
            indexes: [{ fields: ["userId"], name: "by_user", unique: true }],
            shape: { deletedAt: { kind: "number" }, userId: { kind: "string" }, value: { kind: "string" } },
            shardMode: { kind: "global" },
            softDeleteMode: { field: "deletedAt" },
        },
    },
};

/**
 * Stand-in for the D1 writer. It enforces the same by-id table pin the real
 * `@lunora/sql-store` writer does (`resolveTableName` treats an id owned by
 * another table as absent), so the IDOR assertions below are checked by the
 * fake rather than assumed.
 */
const buildGlobalWriter = () => {
    const rows = new Map<string, { document: Record<string, unknown>; table: string }>();
    let next = 0;

    const locate = (id: string, expectedTable?: string) => {
        const entry = rows.get(id);

        return entry && (expectedTable === undefined || entry.table === expectedTable) ? entry : undefined;
    };

    /** The real writer throws on an unresolvable id for every op but `delete`. */
    const locateOrThrow = (id: string, expectedTable?: string) => {
        const entry = locate(id, expectedTable);

        if (!entry) {
            throw new Error(`document not found: ${id}`);
        }

        return entry;
    };

    return {
        async delete(id: string, expectedTable?: string) {
            const entry = locate(id, expectedTable);

            if (entry) {
                rows.delete(id);
            }
        },

        async findFirst(table: string, args?: { where?: Record<string, unknown> }) {
            const where = args?.where ?? {};

            return (
                [...rows.values()].find(
                    (entry) =>
                        entry.table === table &&
                        entry.document["deletedAt"] === undefined &&
                        Object.entries(where).every(([field, value]) => entry.document[field] === value),
                )?.document ?? null
            );
        },

        async findMany(table: string) {
            return {
                continueCursor: null,
                isDone: true,
                page: [...rows.values()].filter((entry) => entry.table === table).map((entry) => entry.document),
            };
        },

        async get(id: string, expectedTable?: string) {
            return locate(id, expectedTable)?.document ?? null;
        },

        async insert(table: string, document: Record<string, unknown>) {
            next += 1;

            const id = `${table}-${next.toString()}`;

            rows.set(id, { document: { _id: id, ...document }, table });

            return id;
        },

        async patch(id: string, patch: Record<string, unknown>, expectedTable?: string) {
            const entry = locateOrThrow(id, expectedTable);

            entry.document = { ...entry.document, ...patch };
        },

        async replace(id: string, document: Record<string, unknown>, expectedTable?: string) {
            locateOrThrow(id, expectedTable).document = { _id: id, ...document };
        },

        async restore(id: string, expectedTable?: string) {
            const entry = locateOrThrow(id, expectedTable);
            const { deletedAt, ...rest } = entry.document;

            entry.document = rest;
        },
        rows,
    };
};

describe("facade over a .global() table — by-id surface", () => {
    beforeEach(() => {
        harness = createSqlExec();
    });

    afterEach(() => {
        harness.close();
    });

    const setupGlobal = () => {
        runShardMigrations(harness.sql, globalSchema);

        const globalDb = buildGlobalWriter();
        const writer = createShardCtxDb({
            clock: () => 1_700_000_000_000,
            globalDb: globalDb as never,
            schema: globalSchema,
            sql: harness.sql,
        });

        return { globalDb, notes: bindTableFacade(writer, "notes"), others: bindTableFacade(writer, "others"), profiles: bindTableFacade(writer, "profiles") };
    };

    it("get/patch/replace reach the global row through the pinned facade", async () => {
        expect.assertions(3);

        const { profiles } = setupGlobal();
        const id = (await profiles.insert({ userId: "u1", value: "one" })) as string;

        await expect(profiles.get(id)).resolves.toMatchObject({ userId: "u1", value: "one" });

        await profiles.patch(id, { value: "two" });

        await expect(profiles.get(id)).resolves.toMatchObject({ value: "two" });

        await profiles.replace(id, { userId: "u1", value: "three" });

        await expect(profiles.get(id)).resolves.toMatchObject({ value: "three" });
    });

    it("delete/hardDelete/deleteMany actually remove the global row", async () => {
        expect.assertions(4);

        const { globalDb, profiles } = setupGlobal();
        const first = (await profiles.insert({ userId: "u1", value: "one" })) as string;

        await profiles.delete(first);

        expect(globalDb.rows.has(first)).toBe(false);

        const second = (await profiles.insert({ userId: "u2", value: "two" })) as string;

        await profiles.hardDelete(second);

        expect(globalDb.rows.has(second)).toBe(false);

        const third = (await profiles.insert({ userId: "u3", value: "three" })) as string;

        // The reported count must match what was removed — the batch form used
        // to report `{ deleted: 1 }` for a row it never touched.
        await expect(profiles.deleteMany([third])).resolves.toStrictEqual({ deleted: 1 });
        expect(globalDb.rows.has(third)).toBe(false);
    });

    it("patchMany/upsert/restore work on the global row", async () => {
        expect.assertions(4);

        const { globalDb, profiles } = setupGlobal();
        const created = await profiles.upsert({ create: { userId: "u1", value: "one" }, target: "userId" });

        expect(created.created).toBe(true);

        // The update branch routes through `writer.patch(id, …, "profiles")`.
        const updated = await profiles.upsert({ create: { userId: "u1", value: "ignored" }, target: "userId", update: { value: "two" } });

        expect(updated).toStrictEqual({ created: false, id: created.id });

        await profiles.patchMany([{ id: created.id, values: { value: "three" } }]);

        await expect(profiles.get(created.id)).resolves.toMatchObject({ value: "three" });

        await profiles.delete(created.id);
        globalDb.rows.set(created.id, { document: { _id: created.id, deletedAt: 1, userId: "u1", value: "three" }, table: "profiles" });
        await profiles.restore(created.id);

        await expect(profiles.get(created.id)).resolves.not.toHaveProperty("deletedAt");
    });

    it("keeps the IDOR guard: a pinned facade never reaches another table's row", async () => {
        expect.assertions(6);

        const { globalDb, notes, others, profiles } = setupGlobal();
        const profileId = (await profiles.insert({ userId: "u1", value: "mine" })) as string;
        const otherId = (await others.insert({ value: "theirs" })) as string;

        // A shard-local facade must not read or mutate a `.global()` row.
        await expect(notes.get(profileId)).resolves.toBeNull();
        await expect(notes.patch(profileId, { value: "hacked" })).rejects.toMatchObject({ code: "NOT_FOUND" });

        await notes.delete(profileId);

        expect(globalDb.rows.has(profileId)).toBe(true);

        // Nor may one global facade reach a different global table's row.
        await expect(others.get(profileId)).resolves.toBeNull();
        await expect(profiles.patch(otherId, { value: "hacked" })).rejects.toThrow(/document not found/u);

        await profiles.delete(otherId);

        expect(globalDb.rows.has(otherId)).toBe(true);
    });
});
