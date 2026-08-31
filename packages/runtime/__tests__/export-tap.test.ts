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

/** Build a fake coordinator whose `orchestrateCdcSync` returns scripted per-shard pages, recording the requests it was called with. */
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
    const requests: { defaultShardKey: string | null; limit?: number }[] = [];
    const coordinator = {
        orchestrateCdcSync: async (
            _namespace: ShardNamespaceLike,
            request: { cursors?: Record<string, number>; defaultShardKey: string | null; limit?: number },
        ) => {
            calls.push({ ...request.cursors });
            requests.push({ defaultShardKey: request.defaultShardKey, limit: request.limit });

            return pages(request.cursors ?? {});
        },
    } as unknown as QueryCoordinator;

    return { calls, coordinator, requests };
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

        const result = await runExportTap({ coordinator, cursorStore: store, defaultShardKey: null, shardDO: noopShardDO, sink, tables: ["messages"] });

        expect(result.delivered).toBe(3);
        expect(result.failures).toEqual([]);
        // Per-shard ordering preserved (seq 1 then 2 for tenant-a).
        expect(delivered.find((b) => b.shardKey === "tenant-a")?.changes.map((c) => c.seq)).toEqual([1, 2]);
        // Cursor persisted durably per shard.
        expect(store.snapshot()["warehouse"]).toEqual({ "tenant-a": 2, "tenant-b": 5 });

        // A second pass resumes from the persisted cursor (no re-scan from zero).
        await runExportTap({ coordinator, cursorStore: store, defaultShardKey: null, shardDO: noopShardDO, sink, tables: ["messages"] });

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
            defaultShardKey: null,
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

        await runExportTap({
            coordinator,
            cursorStore: store,
            defaultShardKey: null,
            initialBackoffMs: 10,
            maxRetries: 3,
            shardDO: noopShardDO,
            sink,
            sleep,
            tables: ["t"],
        });

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

    it("decodes wire-tagged bigint and bytes docs before a sink sees them", async () => {
        expect.assertions(4);

        // The raw CDC record arrives wire-form from the shard admin RPC; both
        // built-in sinks NDJSON-encode it straight to a third party, so the tags
        // must be values by the time `sanitizeChange` hands the batch over.
        const wireChange = {
            doc: { _id: "r1", blob: ["$lunora.wire$", "bytes", "AQID"], count: ["$lunora.wire$", "bigint", "42"] },
            id: "r1",
            op: "insert",
            seq: 1,
            table: "rows",
            ts: 5,
        };
        const batch: ExportBatch = { changes: [sanitizeChange(wireChange)], cursor: 1, shardKey: "s", sink: "hook" };

        expect(batch.changes[0]?.doc).toEqual({ _id: "r1", blob: "AQID", count: "42" });

        const seen: string[] = [];
        const fetchImpl = vi.fn<(url: string, init: { body: string }) => Promise<{ ok: boolean; status: number }>>(async (_url, init) => {
            seen.push(init.body);

            return { ok: true, status: 200 };
        });

        await webhookExportSink({ fetchImpl, name: "hook", url: "https://sink.example/ingest" }).deliver(batch);

        expect(seen[0]).toContain('"count":"42"');
        expect(seen[0]).not.toContain("$lunora.wire$");

        const puts: string[] = [];

        await r2Sink({
            bucket: {
                put: async (_key: string, value: string) => {
                    puts.push(value);
                },
            },
            name: "r2",
        }).deliver({ ...batch, sink: "r2" });

        expect(puts[0]).not.toContain("$lunora.wire$");
    });
});

describe("export-tap — empty shard discovery and page-size accounting", () => {
    it("forwards `defaultShardKey` so a root-DO app is drained instead of fanning out to nothing", async () => {
        expect.assertions(2);

        // A registry only knows the keys an app registers for its `.shardBy(...)`
        // tables, so a plain root-DO app discovers `[]`. Without this the tap fans
        // out to no shards and returns `{ delivered: 0, hasMore: false }` against a
        // full change feed — success reported over zero shards.
        const { coordinator, requests } = fakeCoordinator(() => {
            return { failed: 0, ok: 1, shards: [{ changes: [change("t", "r1", 1)], cursor: 1, shardKey: "__root__" }] };
        });

        const result = await runExportTap({
            coordinator,
            cursorStore: createMemoryCursorStore(),
            defaultShardKey: "__root__",
            shardDO: noopShardDO,
            sink: defineExportSink({ deliver: async () => undefined, name: "warehouse" }),
            tables: ["t"],
        });

        expect(requests[0]?.defaultShardKey).toBe("__root__");
        expect(result.delivered).toBe(1);
    });

    // Regression: `defaultShardKey` was optional here and forwarded as
    // `undefined`, so a tap that simply never mentioned it drained zero shards
    // and reported success. `null` is now the only way to ask for that, and it
    // has to be written down.
    it("forwards an explicit `null` unchanged (an empty fan-out stays empty)", async () => {
        expect.assertions(1);

        const { coordinator, requests } = fakeCoordinator(() => {
            return { failed: 0, ok: 0, shards: [] };
        });

        await runExportTap({
            coordinator,
            cursorStore: createMemoryCursorStore(),
            defaultShardKey: null,
            shardDO: noopShardDO,
            sink: defineExportSink({ deliver: async () => undefined, name: "warehouse" }),
            tables: ["t"],
        });

        expect(requests[0]?.defaultShardKey).toBeNull();
    });

    it("reports `hasMore` on a full page even when the caller passed no `limit`", async () => {
        expect.assertions(2);

        // `limit` is optional and the shard clamps an absent one to 1000, so
        // comparing the page length against `undefined` reported "caught up" while
        // a full page was still pending — a cron drained 1000 rows per tick out of
        // an arbitrarily large backlog and called itself done.
        const full = Array.from({ length: 1000 }, (_value, index) => change("t", `r${String(index)}`, index + 1));
        const { coordinator } = fakeCoordinator(() => {
            return { failed: 0, ok: 1, shards: [{ changes: full, cursor: 1000, shardKey: "__root__" }] };
        });

        const result = await runExportTap({
            coordinator,
            cursorStore: createMemoryCursorStore(),
            defaultShardKey: "__root__",
            shardDO: noopShardDO,
            sink: defineExportSink({ deliver: async () => undefined, name: "warehouse" }),
            tables: ["t"],
        });

        expect(result.delivered).toBe(1000);
        expect(result.hasMore).toBe(true);
    });

    it("reports `hasMore: false` on a short page with no `limit`", async () => {
        expect.assertions(1);

        const { coordinator } = fakeCoordinator(() => {
            return { failed: 0, ok: 1, shards: [{ changes: [change("t", "r1", 1)], cursor: 1, shardKey: "__root__" }] };
        });

        const result = await runExportTap({
            coordinator,
            cursorStore: createMemoryCursorStore(),
            defaultShardKey: "__root__",
            shardDO: noopShardDO,
            sink: defineExportSink({ deliver: async () => undefined, name: "warehouse" }),
            tables: ["t"],
        });

        expect(result.hasMore).toBe(false);
    });
});
