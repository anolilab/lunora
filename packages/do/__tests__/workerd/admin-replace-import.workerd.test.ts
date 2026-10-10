/**
 * A replace-mode admin import on real workerd SQLite, inside the platform's own
 * `storage.transaction` — the boundary `ShardDO`'s replace runs in. `node:sqlite`
 * cannot stand in for either half: the SQL dialect differs, and the rollback is
 * the platform's, not a test double's.
 */
import type { SchemaLike, SqlExec } from "@lunora/shard-engine";
import {
    advanceImportManifest,
    createShardCtxDb,
    importShardRows,
    markShardImportCommitted,
    readImportManifest,
    readShardImportSession,
    runShardMigrations,
    stagedImportIds,
    stagedImportPage,
    stageImportRows,
    sweepImportStaging,
    touchImportManifest,
} from "@lunora/shard-engine";
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

            const result = await state.storage.transaction(async () =>
                importShardRows(writerOf(state), schema, { keepIds: new Set(), replaceTables: ["notes"], rows }),
            );

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
                    await importShardRows(writerOf(state), schema, { keepIds: new Set(), replaceTables: ["notes"], rows });

                    throw new Error("refused");
                })
                .catch(() => undefined);

            await expect(titles(state)).resolves.toStrictEqual({ "created-since": "new", kept: "edited since" });
        });
    });

    it("stages, pages, commits and sweeps a session on workerd's SQLite", async () => {
        expect.assertions(6);

        await withShard("staged-session", async (state) => {
            const sql = state.storage.sql as unknown as SqlExec;
            const now = Date.now();

            const opened = touchImportManifest(sql, "s1", { begin: true, sections: ["kv"], shards: ["root"], tables: ["notes"] }, now).manifest;

            stageImportRows(
                sql,
                "s1",
                opened.generation,
                [
                    ...rows.map((row, index) => {
                        return { ...row, line: index + 1 };
                    }),
                    { doc: { key: "k" }, line: 3, table: "$kv" },
                ],
                now,
            );
            touchImportManifest(sql, "s1", { begin: false, tables: ["notes"] }, now);

            expect(stagedImportPage(sql, "s1", { afterSeq: 0, limit: 10 }).rows.map((row) => row.doc["_id"])).toStrictEqual(["kept", "deleted-since"]);
            expect([...stagedImportIds(sql, "s1")].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["deleted-since", "kept"]);

            advanceImportManifest(sql, "s1", { batches: opened.batches, state: "committing" }, now);
            await state.storage.transaction(async () => {
                markShardImportCommitted(sql, "s1", opened.generation, { inserted: { notes: 2 } }, now);
            });
            advanceImportManifest(sql, "s1", { state: "committed" }, now);

            expect(readShardImportSession(sql, "s1")?.state).toBe("committed");
            // The section records went with the manifest's commit.
            expect(stagedImportPage(sql, "s1", { afterSeq: 0, limit: 10, sections: ["$kv"] }).rows).toStrictEqual([]);

            const expired = sweepImportStaging(sql, now + 2 * 60 * 60 * 1000);

            expect(expired.map((manifest) => manifest.session)).toStrictEqual(["s1"]);
            expect(readImportManifest(sql, "s1", now)).toBeUndefined();
        });
    });

    it("never sweeps a shard session or a manifest whose state it cannot read", async () => {
        expect.assertions(2);

        await withShard("unreadable-session", async (state) => {
            const sql = state.storage.sql as unknown as SqlExec;
            const now = Date.now();

            stageImportRows(sql, "odd", "g1", [{ doc: { _id: "a" }, line: 1, table: "notes" }], now);
            touchImportManifest(sql, "garbled", { begin: true, tables: ["notes"] }, now);
            [...state.storage.sql.exec(`UPDATE "__lunora_import_session__" SET state = 'mystery', expires_at = 0 WHERE session = 'odd'`)];
            [...state.storage.sql.exec(`UPDATE "__lunora_import_manifest__" SET manifest = 'not json', expires_at = 0 WHERE session = 'garbled'`)];

            expect(sweepImportStaging(sql, now + 48 * 60 * 60 * 1000)).toStrictEqual([]);
            expect([...stagedImportIds(sql, "odd")]).toStrictEqual(["a"]);
        });
    });
});
