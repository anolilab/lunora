import { describe, expect, it, vi } from "vitest";

import type { ConnectorSyncPage } from "../src/connector-format";
import { toAirbyteMessages, toFivetranResponse } from "../src/connector-format";
import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("not used", { status: 200 }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

const ADMIN_TOKEN = "admin-bear";

type CdcChange = { doc?: Record<string, unknown>; id: string; op: string; seq: number; table: string };
type CdcShardOutcome = { changes: CdcChange[]; cursor: number; shardKey: string };

interface FakeStore {
    /** Per-shard CDC log, indexed by shard key; each entry is the full ordered change list. */
    logs: Record<string, CdcChange[]>;
}

/**
 * Build a worker whose `orchestrateCdcSync` reads from an in-memory CDC log,
 * honouring each shard's `sinceSeq` cursor and the page `limit` — so a follow-up
 * call with the returned cursor genuinely returns only newer changes.
 */
const createSyncWorker = (store: FakeStore) => {
    const orchestrateCdcSync = vi.fn<
        (namespace: unknown, request: { cursors?: Record<string, number>; defaultShardKey?: string; limit?: number }) => Promise<unknown>
    >(async (_namespace, request) => {
        const cursors = request.cursors ?? {};
        // Mirrors the real shard (`readCdcChanges`): an ABSENT limit is not
        // "unbounded", it clamps to 1000. The endpoint's `hasMore` has to be
        // computed against that, not against the caller's `undefined`.
        const limit = request.limit ?? 1000;
        const shards: CdcShardOutcome[] = [];

        for (const [shardKey, log] of Object.entries(store.logs)) {
            const since = cursors[shardKey] ?? 0;
            const page = log.filter((change) => change.seq > since).slice(0, limit);
            const cursor = page.at(-1)?.seq ?? since;

            shards.push({ changes: page, cursor, shardKey });
        }

        return { failed: 0, ok: shards.length, shards };
    });

    return {
        orchestrateCdcSync,
        worker: createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: orchestrateCdcSync as never,
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        }),
    };
};

const post = (worker: { fetch: (request: Request, env: unknown, context: ExecutionContextLike) => Promise<Response> }, body: unknown, token = ADMIN_TOKEN) =>
    worker.fetch(
        new Request("https://app.example/_lunora/admin/connector/sync", {
            body: JSON.stringify(body),
            headers: { authorization: `Bearer ${token}` },
            method: "POST",
        }),
        {},
        fakeContext,
    );

const syncPage = async (
    worker: { fetch: (request: Request, env: unknown, context: ExecutionContextLike) => Promise<Response> },
    body: unknown,
): Promise<ConnectorSyncPage> => {
    const response = await post(worker, body);

    return response.json<ConnectorSyncPage>();
};

describe("connector sync endpoint", () => {
    it("requires admin auth", async () => {
        expect.assertions(2);

        const { worker } = createSyncWorker({ logs: { c1: [] } });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/connector/sync", { body: "{}", method: "POST" }), {}, fakeContext);

        expect(response.status).toBe(403);

        const wrongToken = await post(worker, {}, "nope");

        expect(wrongToken.status).toBe(403);
    });

    it("returns a page plus a next cursor for a fresh (empty) cursor", async () => {
        expect.assertions(4);

        const { worker } = createSyncWorker({
            logs: {
                c1: [
                    { doc: { _id: "m1", text: "hi" }, id: "m1", op: "insert", seq: 1, table: "messages" },
                    { doc: { _id: "m2", text: "yo" }, id: "m2", op: "insert", seq: 2, table: "messages" },
                ],
            },
        });

        const response = await post(worker, { tables: ["messages"] });

        expect(response.status).toBe(200);

        const page = await response.json<ConnectorSyncPage>();

        expect(page.changes).toHaveLength(2);
        expect(page.changes[0]).toMatchObject({ doc: { _id: "m1" }, op: "insert", table: "messages" });
        expect(typeof page.nextCursor).toBe("string");
    });

    it("returns only newer changes when re-called with the returned cursor (incremental)", async () => {
        expect.assertions(3);

        const store: FakeStore = {
            logs: {
                c1: [{ doc: { _id: "m1" }, id: "m1", op: "insert", seq: 1, table: "messages" }],
            },
        };
        const { worker } = createSyncWorker(store);

        const first = await syncPage(worker, { tables: ["messages"] });

        expect(first.changes).toHaveLength(1);

        // A new change lands after the first sync.
        store.logs["c1"]!.push({ doc: { _id: "m2" }, id: "m2", op: "update", seq: 2, table: "messages" });

        const second = await syncPage(worker, { cursor: first.nextCursor, tables: ["messages"] });

        expect(second.changes).toHaveLength(1);
        expect(second.changes[0]).toMatchObject({ doc: { _id: "m2" }, op: "update" });
    });

    it("is empty (caught up) when nothing has changed since the cursor", async () => {
        expect.assertions(2);

        const { worker } = createSyncWorker({
            logs: { c1: [{ doc: { _id: "m1" }, id: "m1", op: "insert", seq: 1, table: "messages" }] },
        });

        const first = await syncPage(worker, { tables: ["messages"] });
        const second = await syncPage(worker, { cursor: first.nextCursor, tables: ["messages"] });

        expect(second.changes).toHaveLength(0);
        expect(second.hasMore).toBe(false);
    });

    it("reports hasMore when a shard fills the requested page limit", async () => {
        expect.assertions(2);

        const { worker } = createSyncWorker({
            logs: {
                c1: [
                    { doc: { _id: "m1" }, id: "m1", op: "insert", seq: 1, table: "messages" },
                    { doc: { _id: "m2" }, id: "m2", op: "insert", seq: 2, table: "messages" },
                    { doc: { _id: "m3" }, id: "m3", op: "insert", seq: 3, table: "messages" },
                ],
            },
        });

        const page = await syncPage(worker, { limit: 2, tables: ["messages"] });

        expect(page.changes).toHaveLength(2);
        expect(page.hasMore).toBe(true);
    });

    it("forwards `defaultShardKey` so a root-DO app is synced instead of fanning out to nothing", async () => {
        expect.assertions(2);

        // A registry only knows the keys registered for `.shardBy(...)` tables, so
        // a plain root-DO app discovers `[]`. Without the fallback this route
        // returned `200 { changes: [], hasMore: false }` — a warehouse connector
        // reads "caught up" forever against a full database.
        const { orchestrateCdcSync, worker } = createSyncWorker({
            logs: { __root__: [{ doc: { _id: "m1" }, id: "m1", op: "insert", seq: 1, table: "messages" }] },
        });

        await syncPage(worker, { tables: ["messages"] });

        expect(orchestrateCdcSync.mock.calls[0]?.[1].defaultShardKey).toBe("__root__");
        // Same fallback the sibling `/sync` route has always passed.
        expect(orchestrateCdcSync).toHaveBeenCalledTimes(1);
    });

    it("reports hasMore on a full shard page when the caller passed no `limit`", async () => {
        expect.assertions(2);

        // `limit` is optional and the shard clamps an absent one to 1000, so
        // comparing the page length against `undefined` claimed "caught up" while
        // a full page was pending: a cron poking this route with no limit drained
        // 1000 rows per tick out of an arbitrarily large backlog.
        const { worker } = createSyncWorker({
            logs: {
                c1: Array.from({ length: 1200 }, (_value, index) => {
                    return { doc: { _id: `m${String(index)}` }, id: `m${String(index)}`, op: "insert", seq: index + 1, table: "messages" };
                }),
            },
        });

        const page = await syncPage(worker, { tables: ["messages"] });

        expect(page.changes).toHaveLength(1000);
        expect(page.hasMore).toBe(true);
    });

    it("captures deletes (no post-image) as a tombstone with the primary key", async () => {
        expect.assertions(1);

        const { worker } = createSyncWorker({
            logs: { c1: [{ id: "m1", op: "delete", seq: 1, table: "messages" }] },
        });

        const page = await syncPage(worker, { tables: ["messages"] });

        expect(page.changes[0]).toMatchObject({ doc: { _id: "m1" }, op: "delete", table: "messages" });
    });

    it("merges global (D1) changes into the page when syncGlobals is configured", async () => {
        expect.assertions(2);

        const syncGlobals = vi.fn<() => Promise<{ changes: CdcChange[]; cursor: number }>>(async () => {
            return { changes: [{ doc: { _id: "u1" }, id: "u1", op: "insert", seq: 7, table: "users" }], cursor: 7 };
        });
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: async () => {
                    return { failed: 0, ok: 0, shards: [] };
                },
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
            syncGlobals,
        });

        const page = await syncPage(worker, {});

        expect(page.changes).toHaveLength(1);
        expect(page.changes[0]).toMatchObject({ op: "insert", table: "users" });
    });
});

describe("toFivetranResponse", () => {
    it("buckets inserts/updates/deletes per table and carries the cursor as state", () => {
        expect.assertions(5);

        const page: ConnectorSyncPage = {
            changes: [
                { doc: { _id: "m1" }, op: "insert", table: "messages" },
                { doc: { _id: "m2" }, op: "update", table: "messages" },
                { doc: { _id: "m3" }, op: "delete", table: "messages" },
                { doc: { _id: "u1" }, op: "upsert", table: "users" },
            ],
            hasMore: true,
            nextCursor: "TOKEN",
        };

        const out = toFivetranResponse(page);

        expect(out.insert["messages"]).toHaveLength(1);
        expect(out.update["messages"]).toHaveLength(1);
        expect(out.delete["messages"]).toHaveLength(1);
        // upsert collapses into insert (upsert-on-PK); state echoes the cursor.
        expect(out.insert["users"]).toHaveLength(1);
        expect(out.state).toEqual({ cursor: "TOKEN" });
    });

    it("declares a per-table primary-key schema", () => {
        expect.assertions(1);

        const page: ConnectorSyncPage = {
            changes: [{ doc: { id: "x" }, op: "insert", table: "invoices" }],
            hasMore: false,
            nextCursor: "T",
        };

        const out = toFivetranResponse(page, { invoices: "id" });

        expect(out.schema["invoices"]).toEqual({ primary_key: ["id"] });
    });

    it("routes an out-of-union change op to insert instead of throwing", () => {
        expect.assertions(2);

        // A connector that has drifted from the schema must not 500 the whole
        // sync — the row lands on the upsert-on-PK insert bucket like a bare
        // insert, so Fivetran still ingests it.
        const page: ConnectorSyncPage = {
            changes: [{ doc: { _id: "x" }, op: "moved" as ConnectorSyncPage["changes"][number]["op"], table: "users" }],
            hasMore: false,
            nextCursor: "T",
        };

        const out = toFivetranResponse(page);

        expect(out.insert["users"]).toEqual([{ _id: "x" }]);
        expect(out.delete["users"]).toBeUndefined();
    });

    it("decodes wire-tagged bigint and bytes values into portable JSON", () => {
        expect.assertions(2);

        // Docs arrive wire-form from the shard admin RPC (`encodeWire`): a
        // bigint is a `["$lunora.wire$","bigint","…"]` tag, bytes a base64 tag.
        // Warehouse output must carry values, never the tag arrays.
        const page: ConnectorSyncPage = {
            changes: [
                {
                    doc: {
                        _id: "r1",
                        blob: ["$lunora.wire$", "bytes", "AQID"],
                        count: ["$lunora.wire$", "bigint", "42"],
                        huge: ["$lunora.wire$", "bigint", "9007199254740993"],
                    },
                    op: "insert",
                    table: "rows",
                },
            ],
            hasMore: false,
            nextCursor: "T",
        };

        const out = toFivetranResponse(page);

        // Every bigint is a decimal string (one stable JSON type per column,
        // whichever side of 2^53 a row falls on); bytes become a base64 string.
        expect(out.insert["rows"]).toEqual([{ _id: "r1", blob: "AQID", count: "42", huge: "9007199254740993" }]);
        expect(JSON.stringify(out.insert["rows"])).not.toContain("$lunora.wire$");
    });

    it("passes a pure-JSON doc through unchanged", () => {
        expect.assertions(1);

        const doc = { _id: "p1", nested: { flag: true, list: [1, "two", null] }, note: "plain" };
        const page: ConnectorSyncPage = {
            changes: [{ doc, op: "insert", table: "plain" }],
            hasMore: false,
            nextCursor: "T",
        };

        const out = toFivetranResponse(page);

        expect(JSON.stringify(out.insert["plain"]?.[0])).toBe(JSON.stringify(doc));
    });
});

describe("toAirbyteMessages", () => {
    it("emits a RECORD per change and a trailing STATE with the cursor", () => {
        expect.assertions(4);

        const page: ConnectorSyncPage = {
            changes: [
                { doc: { _id: "m1" }, op: "insert", table: "messages" },
                { doc: { _id: "m2" }, op: "delete", table: "messages" },
            ],
            hasMore: false,
            nextCursor: "TOKEN",
        };

        const messages = toAirbyteMessages(page, 1000);

        expect(messages).toHaveLength(3);
        expect(messages[0]).toEqual({ record: { data: { _id: "m1" }, emitted_at: 1000, stream: "messages" }, type: "RECORD" });
        // A delete is marked with `_lunora_deleted` so a downstream step can tombstone.
        expect(messages[1]).toMatchObject({ record: { data: { _lunora_deleted: true } }, type: "RECORD" });
        expect(messages[2]).toEqual({ state: { data: { cursor: "TOKEN" } }, type: "STATE" });
    });

    it("decodes wire-tagged bigint and bytes values in RECORD data", () => {
        expect.assertions(3);

        const page: ConnectorSyncPage = {
            changes: [
                {
                    doc: {
                        _id: "r1",
                        blob: ["$lunora.wire$", "bytes", "AQID"],
                        count: ["$lunora.wire$", "bigint", "42"],
                        huge: ["$lunora.wire$", "bigint", "9007199254740993"],
                    },
                    op: "insert",
                    table: "rows",
                },
                { doc: { _id: "r2", count: ["$lunora.wire$", "bigint", "7"] }, op: "delete", table: "rows" },
            ],
            hasMore: false,
            nextCursor: "T",
        };

        const messages = toAirbyteMessages(page, 1000);

        expect(messages[0]).toEqual({
            record: { data: { _id: "r1", blob: "AQID", count: "42", huge: "9007199254740993" }, emitted_at: 1000, stream: "rows" },
            type: "RECORD",
        });
        // The delete marker spreads over the decoded doc, not the wire form.
        expect(messages[1]).toEqual({
            record: { data: { _id: "r2", _lunora_deleted: true, count: "7" }, emitted_at: 1000, stream: "rows" },
            type: "RECORD",
        });
        expect(JSON.stringify(messages)).not.toContain("$lunora.wire$");
    });

    it("passes a pure-JSON doc through unchanged", () => {
        expect.assertions(1);

        const doc = { _id: "p1", nested: { flag: true, list: [1, "two", null] } };
        const page: ConnectorSyncPage = {
            changes: [{ doc, op: "insert", table: "plain" }],
            hasMore: false,
            nextCursor: "T",
        };

        const messages = toAirbyteMessages(page, 1000);

        expect(JSON.stringify((messages[0] as { record: { data: unknown } }).record.data)).toBe(JSON.stringify(doc));
    });
});
