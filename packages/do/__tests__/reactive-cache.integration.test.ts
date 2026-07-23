/**
 * Wiring tests: cache + ctx-db + shard-do together. Uses node's experimental
 * SQLite (the same backend the existing ctx-db tests run against) so we
 * exercise the real `onRead`/write-invalidation seam end-to-end.
 */
import { DatabaseSync } from "node:sqlite";

import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { ReactiveCache, reactiveCacheKey } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SchemaLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import type { ShardDOOptions, ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

interface NodeStatement {
    all: (...params: unknown[]) => Record<string, unknown>[];
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
    run: (...params: unknown[]) => void;
}

const makeSql = (): SqlExec & { __raw: DatabaseSync } => {
    const database = new DatabaseSync(":memory:");

    return {
        __raw: database,
        exec: <Row = Record<string, unknown>>(sqlText: string, ...params: unknown[]) => {
            const stmt = database.prepare(sqlText) as unknown as NodeStatement;
            const rows = stmt.all(...params) as unknown as Row[];

            return {
                one: () => rows[0] as Row,
                [Symbol.iterator]: () => rows[Symbol.iterator](),
                toArray: () => rows,
            };
        },
    };
};

const schema: SchemaLike = {
    tables: {
        messages: {
            indexes: [],
            shape: {
                ownerId: { kind: "string" },
                text: { kind: "string" },
            },
        },
        users: {
            indexes: [],
            shape: {
                name: { kind: "string" },
            },
        },
    },
};

const newDatabase = () => {
    const sql = makeSql();

    runShardMigrations(sql, schema);

    return sql;
};

describe("ctx-db + reactiveCache integration", () => {
    it("insert invalidates the inserted row id AND the table's *scan deps", async () => {
        expect.assertions(3);

        const sql = newDatabase();
        const cache = new ReactiveCache();
        const writer = createShardContextDatabase({ cache, schema, sql });

        // Seed a row so we have something to read.
        const u1 = await writer.insert("users", { name: "alice" });

        // Pretend a query ran and recorded both per-id and *scan deps.
        const tracker = new Set([`users:${u1}`]);
        const scanTracker = new Set(["users:*scan"]);

        await cache.run("byId", tracker, async () => {
            return { name: "alice" };
        });
        await cache.run("listAll", scanTracker, async () => [{ name: "alice" }]);

        expect(cache.size().entries).toBe(2);

        // Insert a NEW user — neither cache entry's per-id dep matches, but
        // the *scan entry MUST blow because any new row could appear in a
        // scan-shaped result.
        await writer.insert("users", { name: "bob" });

        // listAll (*scan) is gone; byId (u1) survives.
        expect(cache.size().entries).toBe(1);

        // Confirm byId is still cached by re-running with a poisoned executor.
        const cached = await cache.run("byId", tracker, async () => {
            throw new Error("byId should still be cached");
        });

        expect(cached).toEqual({ name: "alice" });
    });

    it("patch invalidates the row's per-id deps AND *scan entries", async () => {
        expect.assertions(1);

        const sql = newDatabase();
        const cache = new ReactiveCache();
        const writer = createShardContextDatabase({ cache, schema, sql });
        const u1 = await writer.insert("users", { name: "alice" });

        await cache.run("byId", new Set([`users:${u1}`]), async () => {
            return { name: "alice" };
        });
        await cache.run("scan", new Set(["users:*scan"]), async () => [{ name: "alice" }]);

        await writer.patch(u1, { name: "ALICE" });

        // Both go: per-id (u1 was patched) and *scan (predicate might flip).
        expect(cache.size().entries).toBe(0);
    });

    it("delete invalidates the row's per-id deps AND *scan entries", async () => {
        expect.assertions(1);

        const sql = newDatabase();
        const cache = new ReactiveCache();
        const writer = createShardContextDatabase({ cache, schema, sql });
        const u1 = await writer.insert("users", { name: "alice" });

        await cache.run("byId", new Set([`users:${u1}`]), async () => {
            return { name: "alice" };
        });
        await cache.run("scan", new Set(["users:*scan"]), async () => [{ name: "alice" }]);

        await writer.delete(u1);

        expect(cache.size().entries).toBe(0);
    });

    it("writes to one table do not blow cache entries on another table", async () => {
        expect.assertions(2);

        const sql = newDatabase();
        const cache = new ReactiveCache();
        const writer = createShardContextDatabase({ cache, schema, sql });

        await cache.run("messagesScan", new Set(["messages:*scan"]), async () => []);
        await cache.run("usersScan", new Set(["users:*scan"]), async () => []);

        await writer.insert("users", { name: "alice" });

        // usersScan invalidated; messagesScan untouched.
        expect(cache.size().entries).toBe(1);

        const survivor = await cache.run("messagesScan", new Set(["messages:*scan"]), async () => {
            throw new Error("messagesScan should still be cached");
        });

        expect(survivor).toEqual([]);
    });

    it("reads via writer.get stamp per-id deps on the configured ReadHook", async () => {
        expect.assertions(1);

        const sql = newDatabase();
        const reads: { idOrScan?: string; table: string }[] = [];
        const writer = createShardContextDatabase({
            onRead: (table, idOrScan) => {
                reads.push({ idOrScan, table });
            },
            schema,
            sql,
        });
        const u1 = await writer.insert("users", { name: "alice" });

        reads.length = 0;
        await writer.get(u1);

        expect(reads).toEqual([{ idOrScan: u1, table: "users" }]);
    });

    it("findMany without where stamps *scan, with where stamps per-row ids", async () => {
        expect.assertions(3);

        const sql = newDatabase();
        const reads: { idOrScan?: string; table: string }[] = [];
        const writer = createShardContextDatabase({
            onRead: (table, idOrScan) => {
                reads.push({ idOrScan, table });
            },
            schema,
            sql,
        });
        const a = await writer.insert("users", { name: "alice" });
        const b = await writer.insert("users", { name: "bob" });

        reads.length = 0;
        await writer.findMany("users");

        // Full scan: one *scan stamp, no per-row stamps.
        expect(reads).toEqual([{ idOrScan: "*scan", table: "users" }]);

        reads.length = 0;
        await writer.findMany("users", { where: { name: "alice" } });

        // Predicated scan: leading bare-table stamp (legacy), plus per-row id stamp.
        expect(reads).toContainEqual({ idOrScan: a, table: "users" });
        expect(reads).not.toContainEqual({ idOrScan: b, table: "users" });
    });

    it("count() registers *scan deps so any write to the table invalidates the cached count", async () => {
        expect.assertions(1);

        const sql = newDatabase();
        const reads: { idOrScan?: string; table: string }[] = [];
        const writer = createShardContextDatabase({
            onRead: (table, idOrScan) => {
                reads.push({ idOrScan, table });
            },
            schema,
            sql,
        });

        await writer.insert("users", { name: "alice" });

        reads.length = 0;
        await writer.count("users");

        expect(reads).toEqual([{ idOrScan: "*scan", table: "users" }]);
    });

    it("rank() and rankPage() register *scan deps so any write shifts the cached position", async () => {
        expect.assertions(2);

        // Rank position is `count(rows-strictly-before) + 1` — any insert /
        // delete to the partition can shift it. Same SCAN_DEP semantics as
        // count() so the reactive cache invalidates rank-returning queries
        // correctly. This is a regression guard: rank() / rankPage() were
        // added by §3.1 after the reactive-cache landed, and an earlier
        // version called `onRead(tableName)` without the dep marker, so
        // rank queries cached with empty deps and never invalidated.
        const rankSchema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    rankIndexes: [
                        {
                            name: "byChannel",
                            on: "messages",
                            partitionBy: ["channelId"],
                            sortBy: [{ direction: "asc", field: "_creationTime" }],
                        },
                    ],
                    shape: { channelId: { kind: "string" }, text: { kind: "string" } },
                },
            },
        };
        const sql = makeSql();

        runShardMigrations(sql, rankSchema);

        const reads: { idOrScan?: string; table: string }[] = [];
        const writer = createShardContextDatabase({
            onRead: (table, idOrScan) => {
                reads.push({ idOrScan, table });
            },
            schema: rankSchema,
            sql,
        });

        await writer.insert("messages", { _id: "m1", channelId: "c1", text: "hi" });

        reads.length = 0;
        await writer.rank("messages", "byChannel", { row: "m1" });

        expect(reads).toEqual([{ idOrScan: "*scan", table: "messages" }]);

        reads.length = 0;
        await writer.rankPage("messages", "byChannel", { take: 10 });

        expect(reads).toEqual([{ idOrScan: "*scan", table: "messages" }]);
    });
});

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    close: () => void;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
        close() {},
        deserializeAttachment() {
            return this.attachment;
        },
        send(data: string) {
            this.sent.push(data);
        },
        sent: [],
        serializeAttachment(value: unknown) {
            this.attachment = value as SocketAttachment | undefined;
        },
    };
};

const createFakeState = (): ShardDOState & { sockets: FakeWebSocket[] } => {
    const sockets: FakeWebSocket[] = [];

    return {
        acceptWebSocket(ws) {
            sockets.push(ws as unknown as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        sockets,
        storage: { sql: { exec: vi.fn<(query: string) => unknown>() } },
    };
};

/**
 * Subclass that exposes `runCachedQuery` to handler code, lets us drive a fake
 * dispatch table, and stamps deps via the base class's read-hook adapter. The
 * test then drives RPC + subscribe + mutation to verify the bridge re-runs
 * subscribers when the cache invalidates.
 */
class CachingShard extends ShardDO {
    public handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();

    public execCount = new Map<string, number>();

    public mutationTablesToInvalidate: { id: string; table: string }[] = [];

    public constructor(state: ShardDOState, env: unknown, options: ShardDOOptions = {}) {
        super(state, env, options);
    }

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        // Mutations advertise a table they wrote; the test fixture invalidates
        // through the cache directly so we don't need a real ctx-db here.
        if (functionPath.startsWith("mutation:")) {
            for (const { id, table } of this.mutationTablesToInvalidate) {
                this.reactiveCache?.invalidate(table, id);
                this.recordChangedTable(table);
            }

            return { ok: true };
        }

        return this.runCachedQuery(functionPath, args, async () => {
            const handler = this.handlers.get(functionPath);

            if (!handler) {
                throw new Error(`no handler for ${functionPath}`);
            }

            this.execCount.set(functionPath, (this.execCount.get(functionPath) ?? 0) + 1);

            return handler(args);
        });
    }

    public registerSocket(ws: FakeWebSocket, attachment?: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment ?? { subs: {} });
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    /**
     * Test-only: simulate a read inside the in-flight handler by calling the
     * tracker that `runCachedQuery` installed. Real subclasses would plumb
     * `getCtxDbReadHook()` into `createShardCtxDb`'s `onRead` option; this
     * test fakes that wiring inline so we don't need to build a full ctx
     * stack just to assert the cache-tracker contract.
     */
    public stampRead(table: string, idOrScan: string): void {
        const hook = this.getCtxDbReadHook();

        hook(table, idOrScan);
    }

    /** Test-only: expose the protected `reactiveCache` field for assertions. */
    public cacheRef(): typeof this.reactiveCache {
        return this.reactiveCache;
    }

    protected override executeSubscription(functionPath: string, args: Record<string, unknown>): Promise<SubscriptionOutcome | null> {
        const handler = this.handlers.get(functionPath);

        if (!handler) {
            return Promise.resolve(null);
        }

        return this.runCachedQuery(functionPath, args, async () => {
            this.execCount.set(functionPath, (this.execCount.get(functionPath) ?? 0) + 1);

            return handler(args);
        }).then((result) => {
            return { result, tables: new Set(["users"]) };
        });
    }
}

describe("shardDO + reactiveCache: dispatch path", () => {
    let state: ReturnType<typeof createFakeState>;
    let shard: CachingShard;

    beforeEach(() => {
        state = createFakeState();
        shard = new CachingShard(state, {}, { reactiveCache: {} });
    });

    it("cache hit: identical query+args runs handler once across two RPC dispatches", async () => {
        expect.assertions(1);

        shard.handlers.set("users:list", async () => {
            shard.stampRead("users", "*scan");

            return [{ name: "alice" }];
        });

        await shard.handleRpc("users:list", {});
        await shard.handleRpc("users:list", {});

        expect(shard.execCount.get("users:list")).toBe(1);
    });

    it("args sensitivity: different args go to different cache slots", async () => {
        expect.assertions(1);

        shard.handlers.set("users:list", async (args) => {
            shard.stampRead("users", "*scan");

            return [args];
        });

        await shard.handleRpc("users:list", { limit: 10 });
        await shard.handleRpc("users:list", { limit: 20 });
        await shard.handleRpc("users:list", { limit: 10 });

        expect(shard.execCount.get("users:list")).toBe(2);
    });

    it("opt-out: when no ReactiveCacheOptions is supplied, every dispatch re-runs (today's default)", async () => {
        expect.assertions(1);

        const uncached = new CachingShard(state, {});

        uncached.handlers.set("users:list", async () => [{ name: "alice" }]);

        await uncached.handleRpc("users:list", {});
        await uncached.handleRpc("users:list", {});

        expect(uncached.execCount.get("users:list")).toBe(2);
    });

    it("rLS interaction: restrictsCounts + baseWhere bake into the cache key", async () => {
        expect.assertions(1);

        shard.handlers.set("users:count", async () => 1);

        await shard.handleRpc("users:count", {});
        await shard.handleRpc("users:count", { baseWhere: { ownerId: "u1" }, restrictsCounts: true });
        await shard.handleRpc("users:count", {});

        // 2 slots: unrestricted (hit twice) and restricted (hit once).
        expect(shard.execCount.get("users:count")).toBe(2);
    });

    // Regression for finding #8: the reactive-cache discriminator folds the
    // FULL resolved identity (userId AND the `getIdentity()` claims RLS can key
    // on), not the userId alone. We drive the real dispatch path via `fetch` so
    // the identity is forwarded through the same `x-lunora-userid` /
    // `x-lunora-identity` headers the runtime sends, then parsed into the
    // `getCurrentUserId` / `getCurrentIdentity` getters `runCachedQuery` reads.
    const dispatchAs = (userId: string, claims: Record<string, unknown>, functionPath: string, args: Record<string, unknown>): Promise<Response> =>
        shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args, functionPath }),
                headers: {
                    "content-type": "application/json",
                    "x-lunora-identity": JSON.stringify(claims),
                    "x-lunora-userid": userId,
                },
                method: "POST",
            }),
        );

    it("identity isolation: same userId with DIFFERENT claims never shares a cache slot", async () => {
        expect.assertions(1);

        shard.handlers.set("org:list", async () => {
            shard.stampRead("users", "*scan");

            return [{ ok: true }];
        });

        // Same human (userId), same query+args, but a different active-org claim
        // per request (e.g. two tabs / sessions). Each MUST re-run its handler —
        // request A's org-A rows must never memoize for request B's org-B read.
        await dispatchAs("u1", { activeOrgId: "A" }, "org:list", {});
        await dispatchAs("u1", { activeOrgId: "B" }, "org:list", {});

        expect(shard.execCount.get("org:list")).toBe(2);
    });

    it("cache hit preserved: same userId AND identical claims collapse to one run (key order agnostic)", async () => {
        expect.assertions(1);

        shard.handlers.set("org:list", async () => {
            shard.stampRead("users", "*scan");

            return [{ ok: true }];
        });

        // Identical identity across the two requests — the claim object's key
        // order differs textually, but `stableStringify` canonicalizes it, so
        // both fold to the same discriminator and the second call is a cache hit.
        await dispatchAs("u1", { activeOrgId: "A", role: "admin" }, "org:list", {});
        await dispatchAs("u1", { role: "admin", activeOrgId: "A" }, "org:list", {});

        expect(shard.execCount.get("org:list")).toBe(1);
    });
});

describe("shardDO + reactiveCache: subscription bridge", () => {
    let state: ReturnType<typeof createFakeState>;
    let shard: CachingShard;

    beforeEach(() => {
        state = createFakeState();
        shard = new CachingShard(state, {}, { reactiveCache: {} });
    });

    it("subscriber registered on a cached query gets a re-run + push when a mutation invalidates", async () => {
        expect.assertions(3);

        let counter = 0;

        shard.handlers.set("users:list", async () => {
            shard.stampRead("users", "*scan");
            counter += 1;

            return { version: counter };
        });

        // First HTTP dispatch lands the entry.
        await shard.handleRpc("users:list", {});
        // Subscribe explicitly on the cache key so the entry is pinned.
        const key = reactiveCacheKey("users:list", {}, null);

        shard.cacheRef()?.subscribe(key, "sub-a");

        // Open a WS subscription so refreshSubscriptions picks it up.
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        await shard.driveMessage(ws, { id: "sub-a", query: { args: {}, functionPath: "users:list" }, type: "subscribe" });

        const sentBefore = ws.sent.length;

        // Mutate: invalidate the *scan entry + record changed table to
        // trigger the bridge.
        shard.mutationTablesToInvalidate = [{ id: "irrelevant", table: "users" }];
        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "mutation:write" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        // The query re-ran and a fresh data frame went out.
        const sentAfter = ws.sent.length;

        expect(sentAfter).toBeGreaterThan(sentBefore);
        // Counter advanced: initial subscribe seed + post-mutation refresh.
        expect(counter).toBeGreaterThanOrEqual(2);

        const data = ws.sent.filter((line) => JSON.parse(line).type === "data");
        const lastPayload = JSON.parse(data.at(-1)!);

        expect(lastPayload).toMatchObject({ id: "sub-a", type: "data" });
    });

    it("invalidation BEFORE broadcast: re-run after mutation sees post-write state", async () => {
        expect.assertions(1);

        const sequence: string[] = [];

        shard.handlers.set("users:list", async () => {
            shard.stampRead("users", "*scan");
            sequence.push("query");

            return Date.now();
        });

        await shard.handleRpc("users:list", {});

        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        await shard.driveMessage(ws, { id: "sub-a", query: { args: {}, functionPath: "users:list" }, type: "subscribe" });

        // Mutation invalidates + records changed table; the bridge MUST see
        // the cleared cache when it re-runs (otherwise the subscriber gets
        // a stale memoized result).
        shard.mutationTablesToInvalidate = [{ id: "irrelevant", table: "users" }];
        sequence.length = 0;

        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "mutation:write" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        // The handler ran AT LEAST once during the refresh — proves cache
        // was empty when refresh kicked in.
        expect(sequence.filter((s) => s === "query").length).toBeGreaterThanOrEqual(1);
    });
});
