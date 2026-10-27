import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Regression for the per-table by-id IDOR: the `ctx.db.<table>.get/delete/
 * patch/replace` facade pins a `tableName`, which is forwarded to the writer as
 * `expectedTable`. Row ids are globally-unique random UUIDs with no embedded
 * table, so without scoping a branded `Id<"posts">` carrying another table's id
 * would resolve cross-table — letting `ctx.db.posts.get(usersId)` read, or
 * `.delete`/`.patch`/`.replace` mutate, a `users` row. With the bound table
 * forwarded, a foreign id must resolve to "absent" (read → null, write → no-op)
 * while the unscoped/correctly-scoped lookup still works.
 */

const schema: SchemaLike = {
    tables: {
        posts: {
            indexes: [],
            shape: { title: { kind: "string" } },
        },
        users: {
            indexes: [],
            shape: { email: { kind: "string" } },
        },
    },
};

describe("by-id table scoping (IDOR)", () => {
    let harness: ReturnType<typeof createSqliteExec>;

    const makeWriter = (): DatabaseWriterLike => {
        runShardMigrations(harness.sql, schema);

        return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    };

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("get(foreignId, boundTable) returns null; get with the owning table returns the row", async () => {
        expect.assertions(3);

        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        // The posts facade asking for a users id must not read the users row.
        await expect(db.get("posts", userId)).resolves.toBeNull();
        // The correct table still resolves it.
        await expect(db.get("users", userId)).resolves.toMatchObject({ email: "victim@example.com" });
        // Both arguments are strings, so a swapped `(id, table)` call type-checks; it must fail loudly.
        await expect(db.get(userId, "users")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("a swapped (id, table) write fails loudly instead of reading as a missing row", async () => {
        expect.assertions(4);

        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        // Both arguments are strings, so the swap type-checks; without the table check each call resolves as a no-op.
        await expect(db.delete(userId, "users")).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(db.patch(userId, "users", { email: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(db.deleteMany!(userId, [userId])).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(db.get("users", userId)).resolves.toMatchObject({ email: "victim@example.com" });
    });

    it("lookupById resolves { row, tableName }; a foreign id scopes to null (same IDOR guard as get)", async () => {
        expect.assertions(3);

        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        // The owning table resolves to the full { row, tableName } the RLS/mask seam consumes.
        await expect(db.lookupById!(userId)).resolves.toMatchObject({ row: { email: "victim@example.com" }, tableName: "users" });
        // Pinned to a foreign table → null (so the membership probe can't reach another table's row).
        await expect(db.lookupById!(userId, "posts")).resolves.toBeNull();
        // Absent id → null.
        await expect(db.lookupById!("missing")).resolves.toBeNull();
    });

    it("lookupById fires onRead like get (preserves subscription dependency tracking)", async () => {
        expect.assertions(1);

        const reads: { id: string | undefined; table: string }[] = [];

        runShardMigrations(harness.sql, schema);

        const db = createShardContextDatabase({
            clock: () => 1_700_000_000_000,
            onRead: (table, id) => {
                reads.push({ id, table });
            },
            schema,
            sql: harness.sql,
        });

        const userId = await db.insert("users", { email: "v@example.com" });

        await db.lookupById!(userId);

        // The seam tracks the read exactly as `get` would, so a subscription that
        // resolves a row through the fast path still re-runs when it changes.
        expect(reads).toContainEqual({ id: userId, table: "users" });
    });

    it("delete(foreignId, boundTable) is a no-op; the row survives", async () => {
        expect.assertions(1);

        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        await db.delete("posts", userId);

        await expect(db.get("users", userId)).resolves.toMatchObject({ email: "victim@example.com" });
    });

    it("patch/replace(foreignId, boundTable) fail closed and do not mutate the foreign row", async () => {
        expect.assertions(3);

        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        // A foreign id behaves exactly like a genuinely-absent id: the write
        // gate finds nothing under the bound table, so patch/replace reject
        // before any mutation (delete/get stay silent — null/no-op).
        await expect(db.patch("posts", userId, { email: "attacker@example.com" })).rejects.toThrow(/document not found/);
        await expect(db.replace("posts", userId, { email: "attacker@example.com" })).rejects.toThrow(/document not found/);

        await expect(db.get("users", userId)).resolves.toMatchObject({ email: "victim@example.com" });
    });

    it("deleteMany([foreignId], …, boundTable) scopes every id; the foreign row survives", async () => {
        expect.assertions(2);

        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        // The per-table facade forwards its bound table as `expectedTable`. A
        // users id handed to the posts facade matches no row under the posts
        // table (a no-op, like the single delete); `deleted` still reports the
        // requested id count.
        const result = await db.deleteMany!("posts", [userId]);

        expect(result).toStrictEqual({ deleted: 1 });
        await expect(db.get("users", userId)).resolves.toMatchObject({ email: "victim@example.com" });
    });

    it("patchMany([{ foreignId }], …, boundTable) fails closed; the foreign row is untouched", async () => {
        expect.assertions(2);

        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        await expect(db.patchMany!("posts", [{ id: userId, patch: { email: "attacker@example.com" } }])).rejects.toThrow(/document not found/);

        await expect(db.get("users", userId)).resolves.toMatchObject({ email: "victim@example.com" });
    });
});

/**
 * `locateTablesByIds` (`ctx-db.ts`), exercised through the RLS guard's
 * `deleteMany`/`patchMany` batch pre-check — it has no public export of its
 * own, so its resolution is observed via the guard decisions and row state it
 * drives. Perf-plan companion to the IDOR suite above: same table-resolution
 * machinery, now batched for `.rls("required")` schemas.
 */
describe('a trusted dispatch under .rls("required")', () => {
    let harness: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    const trustedSchema: SchemaLike = {
        rlsMode: "required",
        tables: {
            posts: { indexes: [], isPublic: false, shape: { title: { kind: "string" } } },
        },
    };

    it("reads a protected table instead of being denied", async () => {
        expect.assertions(2);

        runShardMigrations(harness.sql, trustedSchema);

        // No `enforceRls` — the shape an init hook, a trigger, or a cron tick gets.
        const trusted = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: trustedSchema, sql: harness.sql });
        const id = await trusted.insert("posts", { title: "rebuilt" });

        await expect(trusted.findMany("posts", {})).resolves.toStrictEqual(
            expect.objectContaining({ page: [expect.objectContaining({ _id: id, title: "rebuilt" })] }),
        );

        // The same schema through the user-facing ctx still denies it, so the
        // assertion above is about the flag rather than a schema that forgot to
        // protect the table.
        const guarded = createShardContextDatabase({ clock: () => 1_700_000_000_000, enforceRls: true, schema: trustedSchema, sql: harness.sql });

        expect(() => guarded.findMany("posts", {})).toThrow(/\.rls\("required"\)/);
    });
});
