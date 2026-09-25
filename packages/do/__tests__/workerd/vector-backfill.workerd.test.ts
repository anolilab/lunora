/**
 * The vector backfill's SQL — its progress table (an `ON CONFLICT … excluded`
 * upsert) and its keyset page read — against a real Durable Object's SQLite.
 * `node:sqlite` builds with different defaults (notably `SQLITE_DQS`), so the
 * node suite cannot vouch for the statements workerd actually runs.
 */
import type { SqlExec, WriteEvent } from "@lunora/shard-engine";
import { backfillVectorIndexes, createShardCtxDb, runShardMigrations, VECTOR_BACKFILL_PAGE_ROWS } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const schema = { tables: { posts: { indexes: [], shape: { body: { kind: "string" } } } } } as const;

describe("backfillVectorIndexes on workerd SQLite", () => {
    it("walks every row across page boundaries and records completion", async () => {
        expect.assertions(4);

        const stub = env.SHARD.get(env.SHARD.idFromName("vector-backfill"));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = state.storage.sql as unknown as SqlExec;
            const rows = Math.floor(VECTOR_BACKFILL_PAGE_ROWS * 2.5);

            runShardMigrations(sql, schema);

            const writer = createShardCtxDb({ schema, sql });

            for (let index = 0; index < rows; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential ids
                await writer.insert("posts", { body: `body ${String(index)}` });
            }

            const seen = new Set<string>();
            const sync = async (event: WriteEvent): Promise<void> => {
                seen.add(event.id);
            };
            const targets = [{ profile: "p1", table: "posts" }];
            const ordered = async <T>(read: () => T, work: (value: T) => Promise<void>): Promise<void> => work(read());

            await expect(backfillVectorIndexes(sql, targets, sync, { ordered })).resolves.toStrictEqual({
                done: false,
                pages: 1,
                rows: VECTOR_BACKFILL_PAGE_ROWS,
            });
            await expect(backfillVectorIndexes(sql, targets, sync, { maxPages: 10, ordered })).resolves.toStrictEqual({
                done: true,
                pages: 2,
                rows: rows - VECTOR_BACKFILL_PAGE_ROWS,
            });
            await expect(backfillVectorIndexes(sql, targets, sync, { maxPages: 10, ordered })).resolves.toStrictEqual({ done: true, pages: 0, rows: 0 });

            expect(seen.size).toBe(rows);
        });
    });
});
