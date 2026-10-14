import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb } from "../src/d1-ctx-db";
import { listGlobalTables } from "../src/introspect";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Auto-provisioning of `.global()` D1 tables. Mirrors how `@lunora/do`'s
 * `runShardMigrations` self-creates shard-local tables: a fresh database must
 * serve a `.global()` table from the schema alone — no hand-applied migration —
 * so reads, writes, indexes, and the studio introspector all work on first
 * use instead of failing with `no such table`.
 *
 * Every harness here builds a bare in-memory DB and never calls `ddl()`: the
 * tables under test exist only if the runtime created them from the schema.
 */

const col = (kind: string, notNull = true): ValidatorLike => {
    return { _meta: { column: { notNull } }, kind };
};

const globalSchema: SchemaLike = {
    tables: {
        channels: {
            indexes: [{ fields: ["name"], name: "by_name", unique: true }],
            shape: {
                createdAt: col("number"),
                name: col("string"),
            },
            shardMode: { kind: "global" },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

describe("d1 ctx-db auto-provisions .global() tables", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("creates the base table on first use so insert / findMany / get work without a manual migration", async () => {
        expect.assertions(4);

        // No ddl() — the `channels` table does not exist yet.
        const db = createD1CtxDb({ clock: () => 1_700_000_000_000, exec: harness.exec, idGenerator: () => "c1", schema: globalSchema });

        const id = await db.insert("channels", { createdAt: 1, name: "general" });

        expect(id).toBe("c1");

        const page = await db.findMany("channels");

        expect(page.page.map((document) => document["name"])).toStrictEqual(["general"]);

        const fetched = await db.get(id);

        expect(fetched?.["name"]).toBe("general");

        // The physical table now exists with the framework + field columns —
        // `_version` among them, the optimistic-concurrency row version the
        // guarded-write CAS compares on (it is never decoded into a document).
        const columns = await harness.exec.all(`PRAGMA table_info("channels")`, []);

        expect(columns.map((column) => String(column["name"])).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "_creationTime",
            "_version",
            "createdAt",
            "id",
            "name",
        ]);
    });

    it("enforces a UNIQUE index declared in the schema", async () => {
        expect.assertions(2);

        const db = createD1CtxDb({ exec: harness.exec, schema: globalSchema });

        await expect(db.insert("channels", { createdAt: 1, name: "dup" })).resolves.toBeDefined();
        // The `by_name` unique index must have been created, so a duplicate name is rejected.
        await expect(db.insert("channels", { createdAt: 2, name: "dup" })).rejects.toThrow(/unique constraint violation/i);
    });

    it("lets the introspector list a .global() table on a fresh database (no `no such table`)", async () => {
        expect.assertions(1);

        // The studio's global data browser path — must auto-create then count.
        const tables = await listGlobalTables(harness.exec, globalSchema);

        expect(tables).toStrictEqual([{ name: "channels", rowCount: 0 }]);
    });
});
