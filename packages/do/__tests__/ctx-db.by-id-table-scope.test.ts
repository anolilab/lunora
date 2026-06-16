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

let harness: ReturnType<typeof createSqliteExec>;

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

describe("by-id table scoping (IDOR)", () => {
    it("get(foreignId, boundTable) returns null; get with the owning table returns the row", async () => {
        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        // The posts facade asking for a users id must not read the users row.
        expect(await db.get(userId, "posts")).toBeNull();
        // The correct table still resolves it.
        expect(await db.get(userId, "users")).toMatchObject({ email: "victim@example.com" });
        // An unscoped lookup (no bound table) keeps its global behaviour.
        expect(await db.get(userId)).toMatchObject({ email: "victim@example.com" });
    });

    it("delete(foreignId, boundTable) is a no-op; the row survives", async () => {
        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        await db.delete(userId, "posts");

        expect(await db.get(userId, "users")).toMatchObject({ email: "victim@example.com" });
    });

    it("patch/replace(foreignId, boundTable) fail closed and do not mutate the foreign row", async () => {
        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        // A foreign id behaves exactly like a genuinely-absent id: the write
        // gate finds nothing under the bound table, so patch/replace reject
        // before any mutation (delete/get stay silent — null/no-op).
        await expect(db.patch(userId, { email: "attacker@example.com" }, "posts")).rejects.toThrow();
        await expect(db.replace(userId, { email: "attacker@example.com" }, "posts")).rejects.toThrow();

        expect(await db.get(userId, "users")).toMatchObject({ email: "victim@example.com" });
    });
});
