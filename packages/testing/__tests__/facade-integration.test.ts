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
