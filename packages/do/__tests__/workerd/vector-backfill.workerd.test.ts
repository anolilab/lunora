/**
 * The vector backfill's SQL — its progress table (an `ON CONFLICT … excluded`
 * upsert, read back through the shared backfill-state reader) and its keyset page
 * read with a one-row peek — against a real Durable Object's SQLite.
 * `node:sqlite` builds with different defaults (notably `SQLITE_DQS`), so the
 * node suite cannot vouch for the statements workerd actually runs.
 */
import type { SqlExec } from "@lunora/shard-engine";
import { backfillVectorIndexes, createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const schema = { tables: { posts: { indexes: [], shape: { body: { kind: "string" } } } } } as const;

/** The engine's page size — not exported, so pinned here; the counts below fail loudly if it moves. */
const PAGE_ROWS = 50;

describe("backfillVectorIndexes on workerd SQLite", () => {
    it("walks every row across page boundaries and records completion", async () => {
        expect.assertions(4);

        const stub = env.SHARD.get(env.SHARD.idFromName("vector-backfill"));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = state.storage.sql as unknown as SqlExec;
            const rows = Math.floor(PAGE_ROWS * 2.5);

            runShardMigrations(sql, schema);

            const writer = createShardCtxDb({ schema, sql });

            for (let index = 0; index < rows; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential ids
                await writer.insert("posts", { body: `body ${String(index)}` });
            }

            const seen = new Set<string>();
            const sync = async (_table: string, page: ReadonlyArray<{ id: string }>): Promise<[]> => {
                for (const { id } of page) {
                    seen.add(id);
                }

                return [];
            };
            const targets = [{ profile: "p1", table: "posts" }];
            const ordered = async <T, U>(read: () => T, work: (value: T) => Promise<U>): Promise<U> => work(read());
            const none = { failed: 0, failedIds: [] };

            await expect(backfillVectorIndexes(sql, targets, sync, { ordered })).resolves.toStrictEqual({ ...none, done: false, pages: 1, rows: PAGE_ROWS });
            await expect(backfillVectorIndexes(sql, targets, sync, { maxPages: 10, ordered })).resolves.toStrictEqual({
                ...none,
                done: true,
                pages: 2,
                rows: rows - PAGE_ROWS,
            });
            await expect(backfillVectorIndexes(sql, targets, sync, { maxPages: 10, ordered })).resolves.toStrictEqual({
                ...none,
                done: true,
                pages: 0,
                rows: 0,
            });

            expect(seen.size).toBe(rows);
        });
    });
});
