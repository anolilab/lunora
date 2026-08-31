/**
 * Wiring tests: cache + ctx-db + shard-do together. Uses node's experimental
 * SQLite (the same backend the existing ctx-db tests run against) so we
 * exercise the real `onRead`/write-invalidation seam end-to-end.
 */
import { DatabaseSync } from "node:sqlite";

import type { DatabaseWriterLike, SchemaLike, SocketAttachment, SqlExec, SubscriptionEnvelope } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, ReactiveCache, reactiveCacheKey, runShardMigrations } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryReadScope, ShardDOOptions, ShardDOState, SubscriptionOutcome } from "../src/shard-do";
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
    public handlers = new Map<string, (args: Record<string, unknown>, scope?: QueryReadScope) => Promise<unknown>>();

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

        return this.runCachedQuery(functionPath, args, async (scope) => {
            const handler = this.handlers.get(functionPath);

            if (!handler) {
                throw new Error(`no handler for ${functionPath}`);
            }

            this.execCount.set(functionPath, (this.execCount.get(functionPath) ?? 0) + 1);

            return handler(args, scope);
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
     * hook bound to the scope `runCachedQuery` handed this dispatch. Real
     * subclasses plumb `getCtxDbReadHook(scope)` into `createShardCtxDb`'s
     * `onRead` option; this test fakes that wiring inline so we don't need to
     * build a full ctx stack just to assert the cache-tracker contract.
     */
    public stampRead(scope: QueryReadScope | undefined, table: string, idOrScan: string): void {
        const hook = this.getCtxDbReadHook(scope);

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

        return this.runCachedQuery(functionPath, args, async (scope) => {
            this.execCount.set(functionPath, (this.execCount.get(functionPath) ?? 0) + 1);

            return handler(args, scope);
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

        shard.handlers.set("users:list", async (_args, scope) => {
            shard.stampRead(scope, "users", "*scan");

            return [{ name: "alice" }];
        });

        await shard.handleRpc("users:list", {});
        await shard.handleRpc("users:list", {});

        expect(shard.execCount.get("users:list")).toBe(1);
    });

    it("args sensitivity: different args go to different cache slots", async () => {
        expect.assertions(1);

        shard.handlers.set("users:list", async (args, scope) => {
            shard.stampRead(scope, "users", "*scan");

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

        shard.handlers.set("org:list", async (_args, scope) => {
            shard.stampRead(scope, "users", "*scan");

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

        shard.handlers.set("org:list", async (_args, scope) => {
            shard.stampRead(scope, "users", "*scan");

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

        shard.handlers.set("users:list", async (_args, scope) => {
            shard.stampRead(scope, "users", "*scan");
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

        shard.handlers.set("users:list", async (_args, scope) => {
            shard.stampRead(scope, "users", "*scan");
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

describe("shardDO + reactiveCache: range-precise cached-query invalidation (plan 206)", () => {
    /**
     * A table with an index, so a `.withIndex(...).eq(...)` read can be
     * provably confined to one slice — the case `runCachedQuery`'s ranges
     * thunk (wired via `getCtxDbReadRangeHook`) exists to narrow.
     */
    const rangeSchema: SchemaLike = {
        tables: {
            messages: {
                indexes: [{ fields: ["channelId"], name: "by_channel" }],
                shape: {
                    body: { kind: "string" },
                    channelId: { kind: "string" },
                },
            },
        },
    };

    /**
     * Subclass wiring a REAL ctx-db through `getCtxDbReadHook()` AND
     * `getCtxDbReadRangeHook()` — the pairing a codegen subclass's
     * `createShardCtxDb(...)` call is meant to supply — so an index-narrowed
     * read actually reaches `runCachedQuery`'s ranges thunk, and a write goes
     * through the real invalidation path (`cache.invalidate(table, id,
     * indexKeys)`) instead of the other describe blocks' hand-rolled
     * `mutationTablesToInvalidate` shortcut.
     */
    class RangeCachingShard extends ShardDO {
        /** Scope-less writer the TEST writes through (a mutation builds no cache scope). */
        public readonly writer: DatabaseWriterLike;

        public handlers = new Map<string, (writer: DatabaseWriterLike) => Promise<unknown>>();

        public execCount = new Map<string, number>();

        private readonly rawSql: SqlExec;

        public constructor(state: ShardDOState, env: unknown, sql: SqlExec, options: ShardDOOptions = {}) {
            super(state, env, options);

            this.rawSql = sql;
            this.writer = this.buildWriter();
        }

        public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
            return this.runCachedQuery(functionPath, args, async (scope) => {
                const handler = this.handlers.get(functionPath);

                if (!handler) {
                    throw new Error(`no handler for ${functionPath}`);
                }

                this.execCount.set(functionPath, (this.execCount.get(functionPath) ?? 0) + 1);

                // A generated `buildCtx` builds the ctx-db per dispatch, with the
                // read hooks bound to that dispatch's scope. Mirror that here.
                return handler(this.buildWriter(scope));
            });
        }

        /** Test-only: expose the protected `reactiveCache` field for assertions. */
        public cacheRef(): typeof this.reactiveCache {
            return this.reactiveCache;
        }

        /** The ctx-db a generated `buildCtx` builds, with the read hooks bound to `scope`. */
        private buildWriter(scope?: QueryReadScope): DatabaseWriterLike {
            return createShardContextDatabase({
                // The slice a generated `buildCtx` spreads in: the cache plus the
                // relation knobs. Spread FIRST, exactly as the emitter must, so
                // per-request options below still win.
                ...this.ctxDbTuning(),
                onIndexUse: this.getCtxDbIndexUseHook(),
                onRead: this.getCtxDbReadHook(scope),
                onReadRange: scope === undefined ? undefined : this.getCtxDbReadRangeHook(scope),
                schema: rangeSchema,
                sql: this.rawSql,
            });
        }
    }

    const newRangeShard = (): RangeCachingShard => {
        const sql = makeSql();

        runShardMigrations(sql, rangeSchema);

        return new RangeCachingShard(createFakeState(), {}, sql, { reactiveCache: {} });
    };

    it("a write inside range A evicts query A's cache entry and does NOT evict query B's", async () => {
        expect.assertions(4);

        const shard = newRangeShard();

        shard.handlers.set("messages:byChannelA", async (writer) =>
            writer
                .query("messages")
                .withIndex("by_channel", (q) => q.eq("channelId", "A"))
                .collect(),
        );
        shard.handlers.set("messages:byChannelB", async (writer) =>
            writer
                .query("messages")
                .withIndex("by_channel", (q) => q.eq("channelId", "B"))
                .collect(),
        );

        await shard.handleRpc("messages:byChannelA", {});
        await shard.handleRpc("messages:byChannelB", {});

        expect(shard.cacheRef()?.size().entries).toBe(2);

        // A write INSIDE range A (channelId "A") — must evict query A's entry.
        await shard.writer.insert("messages", { body: "hi", channelId: "A" });

        // Query A's entry is gone; query B's — a DISJOINT slice on the same
        // table — survives. That is the whole point of range-precise
        // invalidation over the prior whole-table-dependency behavior.
        expect(shard.cacheRef()?.size().entries).toBe(1);

        // Confirm B is still served from cache (a poisoned handler would throw
        // if `runCachedQuery` re-executed it) and A re-executes.
        shard.handlers.set("messages:byChannelB", async () => {
            throw new Error("byChannelB should still be cached");
        });

        await expect(shard.handleRpc("messages:byChannelB", {})).resolves.toBeDefined();

        const beforeA = shard.execCount.get("messages:byChannelA") ?? 0;

        await shard.handleRpc("messages:byChannelA", {});

        expect(shard.execCount.get("messages:byChannelA")).toBe(beforeA + 1);
    });

    it("a write outside every cached range does not evict any entry", async () => {
        expect.assertions(1);

        const shard = newRangeShard();

        shard.handlers.set("messages:byChannelA", async (writer) =>
            writer
                .query("messages")
                .withIndex("by_channel", (q) => q.eq("channelId", "A"))
                .collect(),
        );

        await shard.handleRpc("messages:byChannelA", {});
        await shard.writer.insert("messages", { body: "hi", channelId: "Z" });

        expect(shard.cacheRef()?.size().entries).toBe(1);
    });

    // Regression for the missed-invalidation gap: a query that reads the SAME
    // table through BOTH a provable range (`.withIndex(...).eq(...)`, which
    // reports through `onReadRange` and deps nothing on its own) AND a by-id
    // read (`writer.get(id)`, which reports through `onRead` and marks the
    // table unnarrowable). Before the fix, `ReadFootprint.ranges()` drops the
    // table's slice entirely once it is marked unnarrowable, so the cache
    // entry ends up with deps `{messages:<seededId>}` and an EMPTY range set —
    // an insert of a brand-new row into the very same range then matches
    // neither the per-id dep nor any range dep, and the stale entry survives.
    // `runCachedQuery`'s whole-table `SCAN_DEP` fallback (mirroring
    // `executeSubscription`'s `footprint.tables` fallback) closes that gap.
    it("a mixed range + get(id) read on the same table falls back to whole-table invalidation on an insert inside the range", async () => {
        expect.assertions(2);

        const shard = newRangeShard();

        // Seed a row in channel A so `get(id)` has something to read
        // alongside the range scan.
        const seeded = await shard.writer.insert("messages", { body: "seed", channelId: "A" });

        shard.handlers.set("messages:mixed", async (writer) => {
            const ranged = await writer
                .query("messages")
                .withIndex("by_channel", (q) => q.eq("channelId", "A"))
                .collect();
            const byId = await writer.get(seeded);

            return { byId, ranged };
        });

        await shard.handleRpc("messages:mixed", {});

        expect(shard.cacheRef()?.size().entries).toBe(1);

        // A write INSIDE the range that was also read by id. Pre-fix this
        // evicts nothing (missed invalidation); post-fix the whole-table
        // fallback dep catches it.
        await shard.writer.insert("messages", { body: "new", channelId: "A" });

        expect(shard.cacheRef()?.size().entries).toBe(0);
    });
});

/**
 * The wiring the reactive cache was unreachable without: the BASE `/rpc`
 * dispatch path routing a registered `query` through `runCachedQuery`.
 *
 * Every codegen-emitted shard is `class extends ShardDOBase` with no constructor
 * and no cache wrap in `handleRpc`, so before this the cache could only run if a
 * hand-written subclass did both. The subclass below mirrors what the emitter
 * actually produces — a plain `handleRpc`, plus the two hooks it overrides —
 * and asserts the base class does the rest.
 */
describe("shardDO + reactiveCache: base dispatch wiring", () => {
    const REGISTRY: Readonly<Record<string, "action" | "mutation" | "query">> = {
        "notes:list": "query",
        "posts:list": "query",
        "users:create": "mutation",
        "users:list": "query",
        "users:notify": "action",
    };

    /** A promise plus its resolver, for parking a handler until the test releases it. */
    const gate = (): { open: () => void; wait: Promise<void> } => {
        let open!: () => void;
        const wait = new Promise<void>((resolve) => {
            open = resolve;
        });

        return { open, wait };
    };

    class GeneratedLikeShard extends ShardDO {
        public execCount = new Map<string, number>();

        /** functionPath -> a promise its handler parks on, resolved by the test. */
        public gates = new Map<string, Promise<void>>();

        /** functionPath -> resolver fired as its handler enters, so the test can sequence the interleave. */
        public entered = new Map<string, () => void>();

        public override async handleRpc(functionPath: string, args: Record<string, unknown>, _headroom?: unknown, scope?: QueryReadScope): Promise<unknown> {
            this.execCount.set(functionPath, (this.execCount.get(functionPath) ?? 0) + 1);

            if (REGISTRY[functionPath] === "mutation") {
                this.recordChangedTable("users");

                return { ok: true };
            }

            this.entered.get(functionPath)?.();

            // Park BEFORE the read, so a dispatch that arrives while this one is
            // suspended does its own reading first — the interleave that used to
            // stamp the second query's tables into the first query's dep set.
            await this.gates.get(functionPath);

            // Stands in for a `ctx.db` read: the same `onRead` hook a generated
            // `createShardCtxDb` call is handed, bound to THIS dispatch's scope.
            // One table per function namespace, so a dep set that picked up a
            // concurrent dispatch's reads is visible as a cross-table eviction.
            this.getCtxDbReadHook(scope)(functionPath.split(":")[0] ?? "", "*scan");

            return { args, rows: [] };
        }

        /** Test-only: expose the protected slice the emitter spreads into `createShardCtxDb`. */
        public tuning(): { cache?: unknown; maxRelationKeys?: number; relationExistsPushDown?: string } {
            return this.ctxDbTuning();
        }

        /** Test-only: expose the protected `reactiveCache` field for assertions. */
        public cacheRef(): typeof this.reactiveCache {
            return this.reactiveCache;
        }

        // eslint-disable-next-line class-methods-use-this -- test stub override: classifies by `functionPath` alone, no instance state.
        protected override isQueryFunction(functionPath: string): boolean {
            return REGISTRY[functionPath] === "query";
        }
    }

    const rpc = (shard: GeneratedLikeShard, functionPath: string, args: Record<string, unknown> = {}): Promise<Response> =>
        shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args, functionPath }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

    it("memoizes a registered query across two /rpc dispatches without the subclass wrapping anything", async () => {
        expect.assertions(2);

        const shard = new GeneratedLikeShard(createFakeState(), {}, { reactiveCache: {} });

        await rpc(shard, "users:list");
        await rpc(shard, "users:list");

        expect(shard.execCount.get("users:list")).toBe(1);
        expect(shard.cacheRef()?.stats().hits).toBe(1);
    });

    // Regression: the dep tracker used to be an INSTANCE field on the DO, which
    // serves concurrent `/rpc` dispatches. A second query arriving while the
    // first was parked on an await hit `runCachedQuery`'s re-entry guard — it
    // was never read from the cache and never stored, and its reads stamped
    // into the FIRST query's dep set. The tracker is threaded per dispatch now
    // (`runCachedQuery` -> `handleRpc` -> `buildCtx` -> the ctx-db read hooks),
    // so the two are independent.
    it("two concurrent dispatches each get their own tracker: both memoized, neither's deps include the other's tables", async () => {
        expect.assertions(5);

        const shard = new GeneratedLikeShard(createFakeState(), {}, { reactiveCache: {} });

        const parkA = gate();
        const enteredA = gate();
        const enteredB = gate();

        shard.gates.set("notes:list", parkA.wait);
        shard.entered.set("notes:list", enteredA.open);
        shard.entered.set("posts:list", enteredB.open);

        // A enters and parks; B arrives and runs to completion while A is
        // suspended — the interleave a busy shard actually serves.
        const a = rpc(shard, "notes:list");

        await enteredA.wait;

        const b = rpc(shard, "posts:list");

        await enteredB.wait;
        await b;

        parkA.open();
        await a;

        // Pre-fix B was bypassed entirely, leaving ONE entry.
        expect(shard.cacheRef()?.size().entries).toBe(2);

        // Both are real memos: neither handler re-runs.
        await rpc(shard, "notes:list");
        await rpc(shard, "posts:list");

        expect(shard.execCount.get("notes:list")).toBe(1);
        expect(shard.execCount.get("posts:list")).toBe(1);

        // A write to `posts` evicts B's entry and ONLY B's: `notes:list` never
        // read `posts`, and — the half the shared tracker got wrong —
        // `posts:list`'s reads never widened `notes:list`'s dep set either.
        shard.cacheRef()?.invalidateTable("posts");

        expect(shard.cacheRef()?.size().entries).toBe(1);

        await rpc(shard, "notes:list");

        expect(shard.execCount.get("notes:list")).toBe(1);
    });

    it("never memoizes a non-query: an action's side effects must run on every dispatch", async () => {
        expect.assertions(1);

        const shard = new GeneratedLikeShard(createFakeState(), {}, { reactiveCache: {} });

        await rpc(shard, "users:notify");
        await rpc(shard, "users:notify");

        expect(shard.execCount.get("users:notify")).toBe(2);
    });

    it("stays a pass-through when no reactiveCache is configured", async () => {
        expect.assertions(1);

        const shard = new GeneratedLikeShard(createFakeState(), {});

        await rpc(shard, "users:list");
        await rpc(shard, "users:list");

        expect(shard.execCount.get("users:list")).toBe(2);
    });

    it("a write invalidates the memo even when the subclass never handed the cache to ctx-db", async () => {
        expect.assertions(2);

        // The backstop in `recordChangedTable`. A subclass whose
        // `createShardCtxDb` call never took `ctxDbTuning()`'s `cache` has no
        // per-row invalidation, so without this the second read would be served
        // from the pre-write snapshot forever.
        const shard = new GeneratedLikeShard(createFakeState(), {}, { reactiveCache: {} });

        await rpc(shard, "users:list");
        await shard.handleRpc("users:create", {});

        expect(shard.cacheRef()?.size().entries).toBe(0);

        await rpc(shard, "users:list");

        expect(shard.execCount.get("users:list")).toBe(2);
    });

    it("carries the relation knobs from ShardDOOptions into the ctx-db slice", () => {
        expect.assertions(2);

        const tuned = new GeneratedLikeShard(createFakeState(), {}, { maxRelationKeys: 9000, relationExistsPushDown: "never" });
        const bare = new GeneratedLikeShard(createFakeState(), {});

        expect(tuned.tuning()).toStrictEqual({ maxRelationKeys: 9000, relationExistsPushDown: "never" });
        // Unset knobs are ABSENT, not `undefined` — spreading the slice must not
        // clobber an engine default with an explicit undefined.
        expect(bare.tuning()).toStrictEqual({});
    });
});
