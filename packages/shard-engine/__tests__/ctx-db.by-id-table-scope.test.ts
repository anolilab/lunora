import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Regression for the per-table by-id IDOR: the `ctx.db.&lt;table>.get/delete/
 * patch/replace` facade pins a `tableName`, which is forwarded to the writer as
 * `expectedTable`. Row ids are globally-unique random UUIDs with no embedded
 * table, so without scoping a branded `Id&lt;"posts">` carrying another table's id
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
        await expect(db.get(userId, "posts")).resolves.toBeNull();
        // The correct table still resolves it.
        await expect(db.get(userId, "users")).resolves.toMatchObject({ email: "victim@example.com" });
        // An unscoped lookup (no bound table) keeps its global behaviour.
        await expect(db.get(userId)).resolves.toMatchObject({ email: "victim@example.com" });
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

        await db.delete(userId, "posts");

        await expect(db.get(userId, "users")).resolves.toMatchObject({ email: "victim@example.com" });
    });

    it("patch/replace(foreignId, boundTable) fail closed and do not mutate the foreign row", async () => {
        expect.assertions(3);

        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        // A foreign id behaves exactly like a genuinely-absent id: the write
        // gate finds nothing under the bound table, so patch/replace reject
        // before any mutation (delete/get stay silent — null/no-op).
        await expect(db.patch(userId, { email: "attacker@example.com" }, "posts")).rejects.toThrow(/document not found/);
        await expect(db.replace(userId, { email: "attacker@example.com" }, "posts")).rejects.toThrow(/document not found/);

        await expect(db.get(userId, "users")).resolves.toMatchObject({ email: "victim@example.com" });
    });

    it("deleteMany([foreignId], …, boundTable) scopes every id; the foreign row survives", async () => {
        expect.assertions(2);

        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        // The per-table facade forwards its bound table as `expectedTable`. A
        // users id handed to the posts facade matches no row under the posts
        // table (a no-op, like the single delete); `deleted` still reports the
        // requested id count.
        const result = await db.deleteMany!([userId], undefined, "posts");

        expect(result).toStrictEqual({ deleted: 1 });
        await expect(db.get(userId, "users")).resolves.toMatchObject({ email: "victim@example.com" });
    });

    it("patchMany([{ foreignId }], …, boundTable) fails closed; the foreign row is untouched", async () => {
        expect.assertions(2);

        const db = makeWriter();
        const userId = await db.insert("users", { email: "victim@example.com" });

        await expect(db.patchMany!([{ id: userId, patch: { email: "attacker@example.com" } }], undefined, "posts")).rejects.toThrow(/document not found/);

        await expect(db.get(userId, "users")).resolves.toMatchObject({ email: "victim@example.com" });
    });
});

/**
 * `locateTablesByIds` (`ctx-db.ts`), exercised through the RLS guard's
 * `deleteMany`/`patchMany` batch pre-check — it has no public export of its
 * own, so its resolution is observed via the guard decisions and row state it
 * drives. Perf-plan companion to the IDOR suite above: same table-resolution
 * machinery, now batched for `.rls("required")` schemas.
 */
describe("the RLS guard batch id→table probe (deleteMany/patchMany)", () => {
    let harness: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    const rlsSchema: SchemaLike = {
        rlsMode: "required",
        tables: {
            posts: { indexes: [], isPublic: false, shape: { title: { kind: "string" } } },
            stats: { indexes: [], isPublic: true, shape: { value: { kind: "number" } } },
        },
    };

    const makeGuardedWriter = (targetSchema: SchemaLike): DatabaseWriterLike => {
        runShardMigrations(harness.sql, targetSchema);

        return createShardContextDatabase({ clock: () => 1_700_000_000_000, enforceRls: true, schema: targetSchema, sql: harness.sql });
    };

    it("denies a bare-id batch spanning tables when one id resolves to a protected table; nothing is removed", async () => {
        expect.assertions(3);

        runShardMigrations(harness.sql, rlsSchema);

        // Seed through an UNGUARDED admin writer — `insert` is itself
        // table-named and gated, so the guarded writer under test can't
        // populate the protected table directly.
        const admin = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: rlsSchema, sql: harness.sql });
        const publicId = await admin.insert("stats", { value: 1 });
        const protectedId = await admin.insert("posts", { title: "secret" });

        const db = createShardContextDatabase({ clock: () => 1_700_000_000_000, enforceRls: true, schema: rlsSchema, sql: harness.sql });

        await expect(db.deleteMany!([publicId, protectedId, "totally-absent-id"])).rejects.toThrow(/\.rls\("required"\)/);

        // Deny-before-delegate: neither row was actually removed.
        await expect(admin.get(publicId, "stats")).resolves.not.toBeNull();
        await expect(admin.get(protectedId, "posts")).resolves.not.toBeNull();
    });

    it("resolves a bare-id batch spanning multiple PUBLIC tables; the absent id is a no-op", async () => {
        expect.assertions(3);

        const publicOnlySchema: SchemaLike = {
            rlsMode: "required",
            tables: {
                a: { indexes: [], isPublic: true, shape: { value: { kind: "number" } } },
                b: { indexes: [], isPublic: true, shape: { value: { kind: "number" } } },
                posts: { indexes: [], isPublic: false, shape: { title: { kind: "string" } } },
            },
        };

        const db = makeGuardedWriter(publicOnlySchema);
        const idA = await db.insert("a", { value: 1 });
        const idB = await db.insert("b", { value: 2 });

        const result = await db.deleteMany!([idA, idB, "totally-absent-id"]);

        expect(result).toStrictEqual({ deleted: 3 });
        await expect(db.get(idA, "a")).resolves.toBeNull();
        await expect(db.get(idB, "b")).resolves.toBeNull();
    });

    it("resolves ids correctly across chunk boundaries on a wide (many-table) schema", async () => {
        expect.assertions(1);

        // 100 tables ⇒ chunkSize = floor(900 / 100) = 9: 25 ids cross 3 chunk
        // boundaries (9 + 9 + 7), exercising the fold-into-map loop across
        // multiple probe statements rather than the single-statement case above.
        const tableCount = 100;
        const idCount = 25;
        const wideSchema: SchemaLike = {
            rlsMode: "required",
            tables: Object.fromEntries(
                Array.from({ length: tableCount }, (_, index) => [`t${String(index)}`, { indexes: [], isPublic: true, shape: { value: { kind: "number" } } }]),
            ),
        };

        const db = makeGuardedWriter(wideSchema);
        const ids: string[] = [];

        for (let index = 0; index < idCount; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding, test setup only
            ids.push(await db.insert(`t${String(index)}`, { value: index }));
        }

        const result = await db.patchMany!(
            ids.map((id) => {
                return { id, patch: { value: -1 } };
            }),
            undefined,
        );

        expect(result).toStrictEqual({ patched: idCount });
    });

    it("issues far fewer guard-probe statements than one per bare id (pre-fix: one per id)", async () => {
        expect.assertions(2);

        // All-public so the batch resolves cleanly with no denial — isolates the
        // STATEMENT COUNT, not the guard's allow/deny decision (covered above).
        const allPublicSchema: SchemaLike = {
            rlsMode: "required",
            tables: {
                a: { indexes: [], isPublic: true, shape: { value: { kind: "number" } } },
                b: { indexes: [], isPublic: true, shape: { value: { kind: "number" } } },
                c: { indexes: [], isPublic: true, shape: { value: { kind: "number" } } },
            },
        };
        const nonGlobalTableCount = 3;

        const db = makeGuardedWriter(allPublicSchema);
        const ids: string[] = [];

        for (let index = 0; index < 50; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding, test setup only
            ids.push(await db.insert("a", { value: index }));
        }

        const originalExec = harness.sql.exec;
        const queries: string[] = [];

        harness.sql.exec = (query: string, ...parameters: unknown[]) => {
            queries.push(query);

            return originalExec(query, ...parameters);
        };

        const result = await db.patchMany!(
            ids.map((id) => {
                return { id, patch: { value: -1 } };
            }),
        );

        harness.sql.exec = originalExec;

        expect(result).toStrictEqual({ patched: 50 });

        // Any table-resolution probe (guard batch OR the writer's own per-row
        // CAS resolution) shares this `AS __t__, id` shape. Pre-fix, the guard
        // alone issued one such statement PER id (50); post-fix it issues at
        // most `ceil(ids / chunkSize)` — here 1, since 50 ids fit in a single
        // chunk of 300 (`floor(900 / 3)`). The writer's own 50 (one per row,
        // unavoidable — the OCC/CAS snapshot) are untouched and included below.
        const probeLikeCount = queries.filter((query) => /AS __t__, id\b/u.test(query)).length;
        const chunkSize = Math.max(1, Math.floor(900 / nonGlobalTableCount));
        const expectedMax = Math.ceil(50 / chunkSize) + 50;

        expect(probeLikeCount).toBeLessThanOrEqual(expectedMax);
    });
});
