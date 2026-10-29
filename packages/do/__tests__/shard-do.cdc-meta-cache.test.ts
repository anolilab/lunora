import { ADMIN_FUNCTIONS, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `ShardDO` memoizes `__cdc_log` presence and the `__cdc_meta` epoch per
 * instance. A stale epoch lets a subscriber resume across a forked timeline,
 * so each path that rewrites the row — or the presence answer — gets a test
 * asserting the accessor still agrees with SQLite afterwards.
 */

const ADMIN_TOKEN = "s3cret-admin";

class CacheShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- abstract stub; these tests never dispatch an RPC
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve(undefined);
    }

    public epoch(): string | undefined {
        return this.currentCdcEpoch();
    }

    public seal(): string {
        return this.sealForkedTimeline();
    }

    public syncEpoch(): string | undefined {
        return this.runShardCdcSync({ limit: 10, sinceSeq: 0 }).epoch;
    }

    public failInTransaction(work: () => void): Promise<void> {
        return this.runInTransaction(() => {
            work();

            throw new Error("rolled back");
        });
    }
}

let database: ReturnType<typeof createSqliteExec>;

const storedEpoch = (): unknown => database.raw("SELECT epoch FROM __cdc_meta WHERE id = 1")[0]?.["epoch"];

const buildState = (): ShardDOState =>
    ({
        abort: vi.fn<(reason?: string) => void>(),
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        id: { name: "shard-a" },
        storage: {
            getBookmarkForTime: async () => "bm-for-time",
            getCurrentBookmark: async () => "bm-current",
            onNextSessionRestoreBookmark: async (bookmark: string) => `undo-of-${bookmark}`,
            sql: database.sql,
            transaction: async <T>(run: () => Promise<T>): Promise<T> => {
                database.sql.exec("BEGIN");

                try {
                    const result = await run();

                    database.sql.exec("COMMIT");

                    return result;
                } catch (error) {
                    database.sql.exec("ROLLBACK");

                    throw error;
                }
            },
        },
    }) as unknown as ShardDOState;

describe("shardDO CDC meta cache", () => {
    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    it("reads the epoch and probes for the changelog once across repeated reads", () => {
        expect.assertions(3);

        runShardMigrations(database.sql, messagesSchema, { cdc: true });

        const exec = vi.spyOn(database.sql, "exec");
        const shard = new CacheShard(buildState(), {});
        const first = shard.epoch();

        exec.mockClear();

        expect(shard.epoch()).toBe(first);
        expect(shard.syncEpoch()).toBe(first);
        expect(exec.mock.calls.filter(([query]) => /__cdc_meta|sqlite_master/u.test(query))).toHaveLength(0);
    });

    it("reports the re-minted epoch after sealing a forked timeline", () => {
        expect.assertions(2);

        runShardMigrations(database.sql, messagesSchema, { cdc: true });

        const shard = new CacheShard(buildState(), {});
        const before = shard.epoch();
        const sealed = shard.seal();

        expect(sealed).not.toBe(before);
        expect([shard.epoch(), shard.syncEpoch()]).toStrictEqual([storedEpoch(), storedEpoch()]);
    });

    it("reports the re-minted epoch after an admin pitrRestore", async () => {
        expect.assertions(2);

        runShardMigrations(database.sql, messagesSchema, { cdc: true });

        const shard = new CacheShard(buildState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const before = shard.epoch();
        const response = await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: { bookmark: "bm-x" }, functionPath: ADMIN_FUNCTIONS.pitrRestore }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(response.status).toBe(200);
        expect([before === storedEpoch(), shard.epoch()]).toStrictEqual([false, storedEpoch()]);
    });

    it("forgets an epoch minted inside a transaction that rolled back", async () => {
        expect.assertions(4);

        runShardMigrations(database.sql, messagesSchema, { cdc: true });

        const shard = new CacheShard(buildState(), {});
        let minted: string | undefined;

        await expect(
            shard.failInTransaction(() => {
                minted = shard.epoch();
            }),
        ).rejects.toThrow("rolled back");

        expect(minted).toBeDefined();
        // The rollback took the minted row with it.
        expect(storedEpoch()).toBeUndefined();
        expect(shard.epoch()).toBe(storedEpoch());
    });

    it("forgets a changelog migrated inside a transaction that rolled back", async () => {
        expect.assertions(2);

        const shard = new CacheShard(buildState(), {});

        await expect(
            shard.failInTransaction(() => {
                runShardMigrations(database.sql, messagesSchema, { cdc: true });
                shard.epoch();
            }),
        ).rejects.toThrow("rolled back");

        expect(shard.epoch()).toBeUndefined();
    });

    it("picks up a changelog a migration creates after a negative probe", () => {
        expect.assertions(3);

        runShardMigrations(database.sql, messagesSchema);

        const shard = new CacheShard(buildState(), {});

        expect(shard.epoch()).toBeUndefined();

        runShardMigrations(database.sql, messagesSchema, { cdc: true });

        const epoch = shard.epoch();

        expect(epoch).toBeDefined();
        expect(epoch).toBe(storedEpoch());
    });

    it("reads a restored epoch row on the instance a restore restarts into", () => {
        expect.assertions(2);

        runShardMigrations(database.sql, messagesSchema, { cdc: true });

        const state = buildState();
        const before = new CacheShard(state, {}).epoch();

        // A native restore reverts `__cdc_meta` underneath the object and applies on restart.
        database.sql.exec("UPDATE __cdc_meta SET epoch = 'restored' WHERE id = 1");

        const restarted = new CacheShard(state, {});

        expect(before).not.toBe("restored");
        expect(restarted.epoch()).toBe("restored");
    });
});
