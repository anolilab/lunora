import { bindTableFacade } from "@lunora/server";
import type { SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqlExec } from "../src/node-sqlite";

/**
 * The per-table facade's soft-delete surface (`ctx.db.&lt;table>.delete()` →
 * soft, `.restore()`, `.hardDelete()`, `findMany({ includeDeleted })`) over the
 * REAL `@lunora/do` writer — proving `bindTableFacade` wires `delete`'s `hard`
 * option and `restore` end to end.
 */
const schema: SchemaLike = {
    tables: {
        posts: {
            indexes: [],
            relationMap: {},
            shape: { deletedAt: { kind: "number" }, title: { kind: "string" } },
            softDeleteMode: { field: "deletedAt" },
        },
    },
};

let harness: ReturnType<typeof createSqlExec>;

const setup = () => {
    runShardMigrations(harness.sql, schema);

    return bindTableFacade(createShardCtxDb({ clock: () => 1_700_000_000_000, schema, sql: harness.sql }), "posts");
};

const ids = (page: unknown): unknown[] => (page as { page: Record<string, unknown>[] }).page.map((row) => row["_id"]);

describe("facade soft delete over the real writer", () => {
    beforeEach(() => {
        harness = createSqlExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("delete soft-hides, restore brings back, hardDelete removes", async () => {
        expect.assertions(5);

        const posts = setup();
        const a = (await posts.insert({ title: "a" })) as string;

        await posts.insert({ title: "b" });

        // Soft delete hides from findMany but the row survives.
        await posts.delete(a);

        expect(ids(await posts.findMany({}))).toHaveLength(1);
        await expect(posts.count()).resolves.toBe(1);

        // includeDeleted re-includes it; restore makes it live again.
        expect(ids(await posts.findMany({ includeDeleted: true }))).toHaveLength(2);

        await posts.restore(a);

        await expect(posts.count()).resolves.toBe(2);

        // hardDelete removes it for good.
        await posts.hardDelete(a);

        expect(ids(await posts.findMany({ includeDeleted: true }))).toHaveLength(1);
    });
});
