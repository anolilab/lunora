/**
 * A replace-mode admin import on real workerd SQLite, inside the platform's own
 * `storage.transaction` — the boundary `ShardDO`'s replace runs in. `node:sqlite`
 * cannot stand in for either half: the SQL dialect differs, and the rollback is
 * the platform's, not a test double's.
 */
import type { SchemaLike, SqlExec } from "@lunora/shard-engine";
import { createShardCtxDb, importShardRows, runShardMigrations } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const schema: SchemaLike = {
    tables: { notes: { indexes: [], shape: { title: { kind: "string" } } } },
};

const withShard = async (name: string, body: (state: DurableObjectState) => Promise<void>): Promise<void> => {
    await runInDurableObject(env.SHARD.get(env.SHARD.idFromName(name)), async (_instance, state) => {
        runShardMigrations(state.storage.sql as unknown as SqlExec, schema);
        await body(state);
    });
};

const writerOf = (state: DurableObjectState) => createShardCtxDb({ schema, sql: state.storage.sql as never });

const seed = async (state: DurableObjectState): Promise<void> => {
    await writerOf(state).insert("notes", { _id: "kept", title: "edited since" }, { allowExplicitId: true });
    await writerOf(state).insert("notes", { _id: "created-since", title: "new" }, { allowExplicitId: true });
};

const titles = async (state: DurableObjectState): Promise<Record<string, unknown>> => {
    const { page } = await writerOf(state).findMany("notes", {});

    return Object.fromEntries(page.map((row) => [row["_id"], row["title"]]));
};

const rows = [
    { doc: { _id: "kept", title: "as snapshotted" }, table: "notes" },
    { doc: { _id: "deleted-since", title: "back" }, table: "notes" },
];

describe("replace import on workerd", () => {
    it("overwrites and prunes inside one storage transaction", async () => {
        expect.assertions(2);

        await withShard("replace-commit", async (state) => {
            await seed(state);

            const result = await state.storage.transaction(async () => importShardRows(writerOf(state), schema, { replaceTables: ["notes"], rows }));

            expect(result.deleted).toStrictEqual({ notes: 1 });
            await expect(titles(state)).resolves.toStrictEqual({ "deleted-since": "back", kept: "as snapshotted" });
        });
    });

    it("leaves the table as it was when the transaction is rolled back", async () => {
        expect.assertions(1);

        await withShard("replace-rollback", async (state) => {
            await seed(state);

            await state.storage
                .transaction(async () => {
                    await importShardRows(writerOf(state), schema, { replaceTables: ["notes"], rows });

                    throw new Error("refused");
                })
                .catch(() => undefined);

            await expect(titles(state)).resolves.toStrictEqual({ "created-since": "new", kept: "edited since" });
        });
    });
});
