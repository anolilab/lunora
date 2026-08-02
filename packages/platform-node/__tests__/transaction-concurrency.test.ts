import { describe, expect, it } from "vitest";

import { createNodeShardHost } from "../src/node-shard-host";

/**
 * Plan 267 §4/§5 (S4): `transaction` runs raw `BEGIN`/`COMMIT`/`ROLLBACK`
 * against a single shared connection. Two overlapping `transaction()` calls
 * used to race that connection directly — the second `BEGIN` while the first
 * was still open either threw `cannot start a transaction within a
 * transaction` or, worse, silently interleaved commits/rollbacks. This pins
 * the fix: a dedicated `transactionTail` serialization lane, distinct from
 * `runSerialized`'s own tail (routing through the same one would deadlock the
 * engine's `runSerialized(() => transaction(work))` composition).
 */
describe("createNodeShardHost transaction concurrency", () => {
    const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => {
            setTimeout(resolve, ms);
        });

    it("serializes two overlapping bare transaction() calls instead of corrupting each other's commits", async () => {
        expect.assertions(1);

        const { dispose, host } = createNodeShardHost();

        try {
            host.sql.exec("CREATE TABLE rows_ (id TEXT PRIMARY KEY)");

            const first = host.transaction(async () => {
                host.sql.exec("INSERT INTO rows_ (id) VALUES ('A')");

                await sleep(20);

                host.sql.exec("INSERT INTO rows_ (id) VALUES ('B')");
            });

            // Started without awaiting `first` — this is the overlap that
            // corrupts an un-serialized raw BEGIN/COMMIT.
            const second = host.transaction(async () => {
                host.sql.exec("INSERT INTO rows_ (id) VALUES ('C')");
            });

            await Promise.all([first, second]);

            const rows = host.sql.exec<{ id: string }>("SELECT id FROM rows_ ORDER BY id").toArray();

            expect(rows.map((row) => row.id)).toStrictEqual(["A", "B", "C"]);
        } finally {
            dispose();
        }
    });

    it("rolls back only the throwing transaction's own writes, leaving earlier committed rows intact", async () => {
        expect.assertions(2);

        const { dispose, host } = createNodeShardHost();

        try {
            host.sql.exec("CREATE TABLE rows_ (id TEXT PRIMARY KEY)");

            await host.transaction(async () => {
                host.sql.exec("INSERT INTO rows_ (id) VALUES ('A')");
            });

            await expect(
                host.transaction(async () => {
                    host.sql.exec("INSERT INTO rows_ (id) VALUES ('D')");

                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");

            const rows = host.sql.exec<{ id: string }>("SELECT id FROM rows_ ORDER BY id").toArray();

            expect(rows.map((row) => row.id)).toStrictEqual(["A"]);
        } finally {
            dispose();
        }
    });
});
