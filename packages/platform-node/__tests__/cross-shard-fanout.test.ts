import { createQueryCoordinator } from "@lunora/runtime";
import { describe, expect, it } from "vitest";

import { createNodeShardRegistry } from "../src/node-shard-registry";

/**
 * `crossShardFanout` end-to-end on the Node target, driven by the **real**
 * `@lunora/runtime` query coordinator rather than a stand-in.
 *
 * This is the evidence behind the capability rating. The coordinator reaches
 * shards through exactly two seams — `registry.listShardKeys(table)` to decide
 * who to ask, and `resolveShard(namespace, key).fetch(...)` to ask them — and
 * both were unimplementable while the Node directory resolved to a stub that
 * echoed the shard key. Declaring the capability on the strength of "the types
 * line up" is the failure mode plan 267 caught in the scheduler; this asserts
 * rows actually come back from more than one database.
 */
describe("cross-shard fan-out over the node registry", () => {
    /** Stand up N shards, each holding one row, behind a real RPC handler. */
    const seedRegistry = (rows: Readonly<Record<string, number>>) => {
        const registry = createNodeShardRegistry({
            onFetch: async (request, shard) => {
                // The coordinator POSTs a JSON RPC envelope and expects a JSON
                // body back; anything else surfaces as a per-shard error rather
                // than a throw.
                await request.json();

                const found = shard.shard.sql.exec<{ value: number }>("SELECT value FROM notes").toArray();

                return Response.json(
                    found.map((row) => {
                        return { shardKey: shard.shardKey, value: row.value };
                    }),
                );
            },
        });

        for (const [key, value] of Object.entries(rows)) {
            const { shard } = registry.shardFor(key);

            shard.sql.exec("CREATE TABLE IF NOT EXISTS notes (value INTEGER)");
            shard.sql.exec("INSERT INTO notes (value) VALUES (?)", value);
        }

        return registry;
    };

    it("concatenates rows from every shard the registry knows", async () => {
        expect.assertions(3);

        const registry = seedRegistry({ "tenant-a": 1, "tenant-b": 2, "tenant-c": 3 });

        try {
            const coordinator = createQueryCoordinator({
                registry: { listShardKeys: () => registry.listShardKeys() },
            });

            const result = await coordinator.fanOut<{ shardKey: string; value: number }[]>(registry.directory, {
                fanOut: { merge: { kind: "concat" }, table: "notes" },
                functionPath: "notes:list",
            });

            expect(result.errors).toStrictEqual([]);
            expect(result.data.map((row) => row.value).toSorted((a, b) => a - b)).toStrictEqual([1, 2, 3]);
            // Three distinct databases answered, not one shard three times.
            expect(new Set(result.data.map((row) => row.shardKey)).size).toBe(3);
        } finally {
            registry.close();
        }
    });

    it("reports a failing shard as data rather than throwing, and still merges the rest", async () => {
        expect.assertions(3);

        const registry = createNodeShardRegistry({
            onFetch: (_request, shard) => {
                if (shard.shardKey === "tenant-b") {
                    return new Response("boom", { status: 500 });
                }

                return Response.json([shard.shardKey]);
            },
        });

        try {
            registry.shardFor("tenant-a");
            registry.shardFor("tenant-b");

            const coordinator = createQueryCoordinator({
                registry: { listShardKeys: () => registry.listShardKeys() },
            });

            const result = await coordinator.fanOut<string[]>(registry.directory, {
                fanOut: { merge: { kind: "concat" }, table: "notes" },
                functionPath: "notes:list",
            });

            // A partial fan-out is a partial answer, not an exception — the
            // coordinator's documented contract, now exercised on this host.
            expect(result.data).toStrictEqual(["tenant-a"]);
            expect(result.failed).toBe(1);
            expect(result.errors[0]?.shardKey).toBe("tenant-b");
        } finally {
            registry.close();
        }
    });
});
