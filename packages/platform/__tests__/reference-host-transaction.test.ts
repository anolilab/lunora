import { describe, expect, it } from "vitest";

import { createReferenceHost } from "../src/conformance";

/**
 * Plan 267 §4/§5 (S4): the `node:sqlite` reference host has the identical
 * raw-BEGIN/COMMIT/ROLLBACK shape as `@lunora/platform-node`'s shard host, and
 * the identical un-serialized-overlap bug. This is the reference host's
 * sibling of `packages/platform-node/__tests__/transaction-concurrency.test.ts`
 * — same assertions, same dedicated `transactionTail` lane fix.
 */
describe("createReferenceHost transaction concurrency", () => {
    const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => {
            setTimeout(resolve, ms);
        });

    it("serializes two overlapping bare transaction() calls instead of corrupting each other's commits", async () => {
        expect.assertions(1);

        const host = createReferenceHost();

        try {
            host.shard.sql.exec("CREATE TABLE rows_ (id TEXT PRIMARY KEY)");

            const first = host.shard.transaction(async () => {
                host.shard.sql.exec("INSERT INTO rows_ (id) VALUES ('A')");

                await sleep(20);

                host.shard.sql.exec("INSERT INTO rows_ (id) VALUES ('B')");
            });

            // Started without awaiting `first` — this is the overlap that
            // corrupts an un-serialized raw BEGIN/COMMIT.
            const second = host.shard.transaction(async () => {
                host.shard.sql.exec("INSERT INTO rows_ (id) VALUES ('C')");
            });

            await Promise.all([first, second]);

            const rows = host.shard.sql.exec<{ id: string }>("SELECT id FROM rows_ ORDER BY id").toArray();

            expect(rows.map((row) => row.id)).toStrictEqual(["A", "B", "C"]);
        } finally {
            host.cleanup?.();
        }
    });

    it("rolls back only the throwing transaction's own writes, leaving earlier committed rows intact", async () => {
        expect.assertions(2);

        const host = createReferenceHost();

        try {
            host.shard.sql.exec("CREATE TABLE rows_ (id TEXT PRIMARY KEY)");

            await host.shard.transaction(async () => {
                host.shard.sql.exec("INSERT INTO rows_ (id) VALUES ('A')");
            });

            await expect(
                host.shard.transaction(async () => {
                    host.shard.sql.exec("INSERT INTO rows_ (id) VALUES ('D')");

                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");

            const rows = host.shard.sql.exec<{ id: string }>("SELECT id FROM rows_ ORDER BY id").toArray();

            expect(rows.map((row) => row.id)).toStrictEqual(["A"]);
        } finally {
            host.cleanup?.();
        }
    });
});
