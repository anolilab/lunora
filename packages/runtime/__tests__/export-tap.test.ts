import { describe, expect, it, vi } from "vitest";

import type { ExportBatch } from "../src/export-tap";
import { createMemoryCursorStore, defineExportSink, r2Sink, runExportTap, sanitizeChange, webhookExportSink } from "../src/export-tap";
import type { QueryCoordinator } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const noopShardDO: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("ok") };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

/** Build a fake coordinator whose `orchestrateCdcSync` returns scripted per-shard pages, recording the cursors it was called with. */
const fakeCoordinator = (
    pages: (cursors: Record<string, number>) => {
        failed: number;
        ok: number;
        shards: ReadonlyArray<{
            changes?: ReadonlyArray<Record<string, unknown>>;
            cursor: number;
            error?: { message: string; timedOut: boolean };
            shardKey: string;
        }>;
    },
) => {
    const calls: Record<string, number>[] = [];
    const coordinator = {
        orchestrateCdcSync: async (_namespace: ShardNamespaceLike, request: { cursors?: Record<string, number> }) => {
            calls.push({ ...request.cursors });

            return pages(request.cursors ?? {});
        },
    } as unknown as QueryCoordinator;

    return { calls, coordinator };
};

const change = (table: string, id: string, seq: number): Record<string, unknown> => {
    return { doc: { _id: id, v: seq }, id, op: "insert", seq, table, ts: seq };
};

describe("export-tap — continuous CDC drain", () => {
    it("delivers an ordered per-shard change event at-least-once and advances a resumable cursor", async () => {
        expect.assertions(6);

        const store = createMemoryCursorStore();
        const delivered: ExportBatch[] = [];
        const sink = defineExportSink({
            deliver: async (batch) => {
                delivered.push(batch);
            },
            name: "warehouse",
        });

        const { calls, coordinator } = fakeCoordinator(() => {
            return {
                failed: 0,
                ok: 2,
                shards: [
                    { changes: [change("messages", "m1", 1), change("messages", "m2", 2)], cursor: 2, shardKey: "tenant-a" },
                    { changes: [change("messages", "m3", 5)], cursor: 5, shardKey: "tenant-b" },
                ],
            };
        });

        const result = await runExportTap({ coordinator, cursorStore: store, shardDO: noopShardDO, sink, tables: ["messages"] });

        expect(result.delivered).toBe(3);
        expect(result.failures).toEqual([]);
        // Per-shard ordering preserved (seq 1 then 2 for tenant-a).
        expect(delivered.find((b) => b.shardKey === "tenant-a")?.changes.map((c) => c.seq)).toEqual([1, 2]);
        // Cursor persisted durably per shard.
        expect(store.snapshot()["warehouse"]).toEqual({ "tenant-a": 2, "tenant-b": 5 });

        // A second pass resumes from the persisted cursor (no re-scan from zero).
        await runExportTap({ coordinator, cursorStore: store, shardDO: noopShardDO, sink, tables: ["messages"] });

        expect(calls[0]).toEqual({});
        expect(calls[1]).toEqual({ "tenant-a": 2, "tenant-b": 5 });
    });

    it("applies backpressure on sink failure without advancing the failed shard's cursor or stalling others", async () => {
        expect.assertions(5);

        const store = createMemoryCursorStore();

        // Sink rejects only for tenant-a; tenant-b always succeeds.
        const sink = defineExportSink({
            deliver: async (batch) => {
                if (batch.shardKey === "tenant-a") {
                    throw new Error("sink 503");
                }
            },
            name: "flaky",
        });

        const { coordinator } = fakeCoordinator(() => {
            return {
                failed: 0,
                ok: 2,
                shards: [
                    { changes: [change("t", "a1", 1)], cursor: 1, shardKey: "tenant-a" },
                    { changes: [change("t", "b1", 3)], cursor: 3, shardKey: "tenant-b" },
                ],
            };
        });

        const result = await runExportTap({
            coordinator,
            cursorStore: store,
            initialBackoffMs: 0,
            maxRetries: 2,
            shardDO: noopShardDO,
            sink,
            sleep: async () => undefined,
            tables: ["t"],
        });

        // tenant-b drained; tenant-a left for retry (backpressure), not fatal.
        expect(result.delivered).toBe(1);
        expect(result.failures.map((f) => f.shardKey)).toEqual(["tenant-a"]);
        expect(result.hasMore).toBe(true);
        // Only the healthy shard's cursor advanced; the failed shard stays at 0.
        expect(store.snapshot()["flaky"]).toEqual({ "tenant-b": 3 });
        expect(store.snapshot()["flaky"]?.["tenant-a"]).toBeUndefined();
    });

    it("retries with backoff then re-delivers on the next pass (at-least-once replay)", async () => {
        expect.assertions(3);

        const store = createMemoryCursorStore();
        const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
        let failFirstTwo = 2;
        const deliver = vi.fn<() => Promise<void>>(async () => {
            if (failFirstTwo > 0) {
                failFirstTwo -= 1;

                throw new Error("transient");
            }
        });
        const sink = defineExportSink({ deliver, name: "retry" });

        const { coordinator } = fakeCoordinator((cursors) => {
            return {
                failed: 0,
                ok: 1,
                // Same change re-offered while the cursor has not advanced past it.
                shards: [{ changes: cursors["s"] === undefined ? [change("t", "x1", 1)] : [], cursor: 1, shardKey: "s" }],
            };
        });

        await runExportTap({ coordinator, cursorStore: store, initialBackoffMs: 10, maxRetries: 3, shardDO: noopShardDO, sink, sleep, tables: ["t"] });

        // 2 failures + 1 success = 3 deliver calls, 2 backoff sleeps.
        expect(deliver).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(store.snapshot()["retry"]).toEqual({ s: 1 });
    });

    it("webhookExportSink posts NDJSON and rejects on a non-2xx (driving retry)", async () => {
        expect.assertions(3);

        const seen: { body: string; headers: Record<string, string> }[] = [];
        const fetchImpl = vi.fn<(url: string, init: { body: string; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number }>>(
            async (_url, init) => {
                seen.push({ body: init.body, headers: init.headers });

                return { ok: false, status: 502 };
            },
        );
        const sink = webhookExportSink({ fetchImpl, name: "hook", url: "https://sink.example/ingest" });

        await expect(sink.deliver({ changes: [sanitizeChange(change("t", "1", 1))], cursor: 1, shardKey: "s", sink: "hook" })).rejects.toThrow(/502/u);

        expect(seen[0]?.headers["x-lunora-shard"]).toBe("s");
        expect(seen[0]?.body.trim()).toBe(JSON.stringify(sanitizeChange(change("t", "1", 1))));
    });

    it("r2Sink writes an NDJSON object keyed by shard + cursor", async () => {
        expect.assertions(2);

        const puts: { key: string; value: string }[] = [];
        const bucket = {
            put: async (key: string, value: string) => {
                puts.push({ key, value });
            },
        };
        const sink = r2Sink({ bucket, name: "r2", prefix: "cdc" });

        await sink.deliver({ changes: [sanitizeChange(change("t", "1", 7))], cursor: 7, shardKey: "tenant-a", sink: "r2" });

        expect(puts[0]?.key).toBe("cdc/tenant-a/7.ndjson");
        expect(puts[0]?.value.trim()).toBe(JSON.stringify(sanitizeChange(change("t", "1", 7))));
    });
});
