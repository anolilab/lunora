import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AggregateIndexDefinitionLike } from "../src/aggregates";
import type { DatabaseWriterLike, SchemaLike, SqlExec } from "../src/ctx-db";
import { applyCdcChanges, createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import type { DataMigrationLike, MigrationRunResult } from "../src/data-migration";
import { runDataMigration } from "../src/data-migration";
import type { AdvisoryFinding } from "../src/introspect";
import { ADMIN_FUNCTIONS } from "../src/introspect";
import type { RankIndexDefinitionLike } from "../src/rank";
import { rankKeyFromDoc } from "../src/rank";
import type {
    RunShardApplyCdcArgs,
    RunShardApplyCdcResult,
    RunShardMigrationArgs,
    RunShardRankBeforeArgs,
    RunShardWriteArgs,
    RunShardWriteResult,
    ShardDOState,
} from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import type { SocketAttachment } from "../src/types";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A real-SQLite-backed ShardDO whose `handleRpc` throws — proving the admin
 * branch in `fetch` short-circuits before user dispatch is ever reached.
 */
class AdminShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }
}

const ADMIN_TOKEN = "s3cret-admin";

/**
 * A shard whose `handleRpc` fails for one marked path, so the request/error
 * counters and the log buffer can be driven through the public `fetch` surface.
 */
class CountingShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; routes by functionPath only, no instance state
    public override async handleRpc(functionPath: string): Promise<unknown> {
        if (functionPath === "boom:explode") {
            throw new Error("boom");
        }

        return { ok: true };
    }
}

/**
 * Exposes the protected `recordUserLog` so the `ctx.log` capture path — buffer
 * push, console event, optional sink — can be driven directly the way the
 * codegen-generated `buildCtx` logger closure drives it.
 */
class LoggingShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; this shard exists only to expose recordUserLog
    public override async handleRpc(): Promise<unknown> {
        return { ok: true };
    }

    public log(functionPath: string, level: "error" | "info" | "log" | "warn", args: unknown[], sink?: Parameters<LoggingShard["recordUserLog"]>[3]): void {
        this.recordUserLog(functionPath, level, args, sink);
    }
}

/** An ordinary (non-admin) RPC request — no bearer, so it routes to `handleRpc`. */
const userRequest = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("shardDO admin introspection", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        database.raw(`CREATE TABLE "messages" ("__id__" TEXT PRIMARY KEY, "text" TEXT)`);
        database.raw(`INSERT INTO "messages" VALUES ('m1', 'hello'), ('m2', 'world')`);

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const adminRequest = (functionPath: string, args: Record<string, unknown>, token?: string): Request => {
        const headers: Record<string, string> = { "content-type": "application/json" };

        if (token !== undefined) {
            headers.authorization = `Bearer ${token}`;
        }

        return new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath }),
            headers,
            method: "POST",
        });
    };

    it("lists tables when a valid admin bearer is presented", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}, ADMIN_TOKEN));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ result: [{ name: "messages", rowCount: 2 }] });
    });

    it("reads a page of rows for a table", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.readTablePage, { limit: 1, table: "messages" }, ADMIN_TOKEN));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            result: { columns: ["__id__", "text"], rows: [{ __id__: "m1", text: "hello" }], total: 2 },
        });
    });

    it("reports no indexes from the base hook, and the subclass-declared ones when overridden", async () => {
        expect.assertions(2);

        // Base ShardDO can't see the user schema, so it reports an empty list.
        const base = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const baseResponse = await base.fetch(adminRequest(ADMIN_FUNCTIONS.listTableIndexes, { table: "messages" }, ADMIN_TOKEN));

        await expect(baseResponse.json()).resolves.toEqual({ result: { indexes: [] } });

        // The codegen subclass overrides `tableIndexes` from the schema; mimic it.
        class IndexedShard extends AdminShard {
            // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
            protected override tableIndexes(
                table: string,
            ): { fields: string[]; name: string; type: "index" | "rank" | "search" | "vector"; unique?: boolean }[] {
                return table === "messages" ? [{ fields: ["author"], name: "by_author", type: "index", unique: true }] : [];
            }
        }

        const indexed = new IndexedShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await indexed.fetch(adminRequest(ADMIN_FUNCTIONS.listTableIndexes, { table: "messages" }, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({
            result: { indexes: [{ fields: ["author"], name: "by_author", type: "index", unique: true }] },
        });
    });

    it("reports no advisories from the base hook, and the subclass-declared ones when overridden", async () => {
        expect.assertions(2);

        // Base ShardDO can't see the user schema, so it reports none.
        const base = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const baseResponse = await base.fetch(adminRequest(ADMIN_FUNCTIONS.getAdvisories, {}, ADMIN_TOKEN));

        await expect(baseResponse.json()).resolves.toEqual({ result: { advisories: [] } });

        // The codegen subclass overrides `advisories()` with the baked list.
        const finding: AdvisoryFinding = {
            cacheKey: "unindexed_foreign_key:posts:authorId",
            categories: ["PERFORMANCE"],
            description: "A foreign-key column has no index.",
            detail: 'Relation "author" on table "posts" references "users" via column "authorId".',
            facing: "EXTERNAL",
            level: "INFO",
            metadata: { table: "posts" },
            name: "unindexed_foreign_key",
            remediation: "Add an index leading with the FK column.",
            title: "Unindexed foreign key",
        };

        class AdvisedShard extends AdminShard {
            // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
            protected override advisories(): AdvisoryFinding[] {
                return [finding];
            }
        }

        const advised = new AdvisedShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await advised.fetch(adminRequest(ADMIN_FUNCTIONS.getAdvisories, {}, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({ result: { advisories: [finding] } });
    });

    it("derives an unused_index runtime advisory for a declared index no query exercised", async () => {
        expect.assertions(2);

        // A shard that declares two indexes on `posts` and lets a test exercise one.
        class UnusedIndexShard extends AdminShard {
            /** Simulate a query exercising `table`'s `index`, the way the ctx-db read hook would. */
            public exercise(table: string, index: string): void {
                this.getCtxDbIndexUseHook()(table, index);
            }

            // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
            protected override tableIndexes(
                table: string,
            ): { fields: string[]; name: string; type: "index" | "rank" | "search" | "vector"; unique?: boolean }[] {
                return table === "posts"
                    ? [
                          { fields: ["authorId"], name: "byAuthor", type: "index" },
                          { fields: ["createdAt"], name: "byCreated", type: "index" },
                      ]
                    : [];
            }
        }

        const shard = new UnusedIndexShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        // No reads yet → no runtime advisories (a never-queried table never spams).
        const cold = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getAdvisories, {}, ADMIN_TOKEN));

        await expect(cold.json()).resolves.toEqual({ result: { advisories: [] } });

        // A query exercises `byAuthor`; `byCreated` is now the unused one. The
        // exact `toEqual` asserts a single finding — so `byAuthor` is absent.
        shard.exercise("posts", "byAuthor");

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getAdvisories, {}, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({
            result: {
                advisories: [
                    {
                        cacheKey: "unused_index:posts:byCreated",
                        categories: ["PERFORMANCE"],
                        description: expect.any(String),
                        detail: expect.any(String),
                        facing: "INTERNAL",
                        level: "INFO",
                        metadata: { index: "byCreated", indexKind: "index", since: "instance-woke", table: "posts" },
                        name: "unused_index",
                        remediation: expect.any(String),
                        title: "Unused index",
                    },
                ],
            },
        });
    });

    it("is disabled (403) when no admin token is configured, even with a bearer", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, {});

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}, ADMIN_TOKEN));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "ADMIN_FORBIDDEN" } });
    });

    it("rejects (403) a missing or mismatched bearer when a token is configured", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const missing = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}));
        const wrong = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}, "wrong"));

        expect(missing.status).toBe(403);
        expect(wrong.status).toBe(403);
    });

    it("maps an unknown table to a 404 CirrusError", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.readTablePage, { table: "nope" }, ADMIN_TOKEN));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "UNKNOWN_TABLE" } });
    });

    it("returns 404 for an unrecognised admin op", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest("__cirrus_admin__:bogus", {}, ADMIN_TOKEN));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "UNKNOWN_ADMIN_OP" } });
    });

    it("listSubscriptions enumerates connected sockets, their subs, and aggregate counts", async () => {
        expect.assertions(2);

        // A socket whose attachment is read back via `deserializeAttachment`,
        // mirroring the workerd hibernation surface `readAttachment` uses.
        const makeSocket = (attachment: SocketAttachment): WebSocket => ({ deserializeAttachment: () => attachment }) as unknown as WebSocket;

        const sockets: WebSocket[] = [
            makeSocket({ admin: true, subs: { "s-1": { args: { room: "general" }, functionPath: "messages:list", table: "messages" } } }),
            makeSocket({
                subs: {
                    "s-a": { functionPath: "presence:list", table: "presence" },
                    "s-b": { args: { since: 5 }, functionPath: "feed:recent", table: "posts" },
                },
            }),
            makeSocket({ subs: {} }),
        ];
        const socketState: ShardDOState = { ...state, getWebSockets: () => sockets };
        const shard = new AdminShard(socketState, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listSubscriptions, {}, ADMIN_TOKEN));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            result: {
                connections: [
                    { admin: true, id: 0, subscriptions: [{ args: { room: "general" }, functionPath: "messages:list", table: "messages" }] },
                    {
                        admin: false,
                        id: 1,
                        subscriptions: [
                            { functionPath: "presence:list", table: "presence" },
                            { args: { since: 5 }, functionPath: "feed:recent", table: "posts" },
                        ],
                    },
                    { admin: false, id: 2, subscriptions: [] },
                ],
                totalConnections: 3,
                totalSubscriptions: 3,
            },
        });
    });

    it("listSubscriptions returns an empty, zeroed result when no sockets are connected", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listSubscriptions, {}, ADMIN_TOKEN));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ result: { connections: [], totalConnections: 0, totalSubscriptions: 0 } });
    });

    it("recordAuthEvent then getAuthMetrics round-trips the app-level auth-failure signal", async () => {
        expect.assertions(6);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        // Two successful attempts and one failure, recorded via the write op.
        const ok1 = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordAuthEvent, { outcome: "ok" }, ADMIN_TOKEN));
        await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordAuthEvent, { outcome: "ok" }, ADMIN_TOKEN));
        await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordAuthEvent, { outcome: "fail" }, ADMIN_TOKEN));

        expect(ok1.status).toBe(200);
        await expect(ok1.json()).resolves.toEqual({ result: { recorded: true } });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getAuthMetrics, {}, ADMIN_TOKEN));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { attempts: number; failureRate: number; failures: number; history: unknown[] } }>();

        expect(body.result).toMatchObject({ attempts: 3, failures: 1 });
        // 1 failure / 3 attempts.
        expect(body.result.failureRate).toBeCloseTo(1 / 3, 10);
        expect(body.result.history.length).toBeGreaterThan(0);
    });

    it("rejects (400) a recordAuthEvent with an invalid outcome", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordAuthEvent, { outcome: "bogus" }, ADMIN_TOKEN));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    });

    it("admin-gates recordAuthEvent and getAuthMetrics (403 without the bearer)", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const recordResponse = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordAuthEvent, { outcome: "ok" }));
        const readResponse = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getAuthMetrics, {}));

        expect(recordResponse.status).toBe(403);
        expect(readResponse.status).toBe(403);
    });
});

const usersSchema: SchemaLike = {
    tables: {
        users: {
            indexes: [],
            shape: {
                name: { kind: "string" },
                version: { kind: "number" },
            },
        },
    },
};

/** Bump every user's `version` by one — the migration the admin RPC runs. */
const bumpVersion: DataMigrationLike = {
    id: "bump-version",
    table: "users",
    up: (document) => {
        return { ...document, version: Number(document["version"] ?? 0) + 1 };
    },
};

const MIGRATIONS: Record<string, DataMigrationLike> = { [bumpVersion.id]: bumpVersion };

/**
 * Mirrors the codegen-generated subclass: overrides the base
 * `runShardDataMigration` hook to resolve a migration from a registry and drive
 * `runDataMigration` against a real-SQLite, schema-aware writer.
 */
class MigrationShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override runShardDataMigration(args: RunShardMigrationArgs): Promise<MigrationRunResult> {
        const migration = MIGRATIONS[args.id];

        if (!migration) {
            return Promise.reject(
                Object.assign(new Error(`data migration "${args.id}" is not registered`), { code: "MIGRATION_NOT_FOUND", name: "CirrusError", status: 404 }),
            );
        }

        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: usersSchema,
            sql: this.sql as SqlExec,
        });

        return runDataMigration({
            batchSize: args.batchSize,
            direction: args.direction,
            dryRun: args.dryRun,
            maxBatches: args.maxBatches,
            migration,
            sql: this.sql as SqlExec,
            writer,
        });
    }
}

describe("shardDO admin data migrations", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(async () => {
        database = createSqliteExec();
        runShardMigrations(database.sql, usersSchema);

        const writer: DatabaseWriterLike = createShardContextDatabase({ schema: usersSchema, sql: database.sql });

        for (let index = 1; index <= 3; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
            await writer.insert("users", { _id: `u${String(index)}`, name: `user ${String(index)}`, version: 0 });
        }

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const adminRequest = (functionPath: string, args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    const versions = (): unknown[] =>
        database.raw(`SELECT json_extract("__doc__", '$.version') AS version FROM "users" ORDER BY id`).map((row) => row["version"]);

    it("runs a registered migration and reports completed counts", async () => {
        expect.assertions(3);

        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "bump-version" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            result: { changed: 3, cursor: null, direction: "up", dryRun: false, id: "bump-version", processed: 3, status: "completed" },
        });
        expect(versions()).toEqual([1, 1, 1]);
    });

    it("records an audit entry after a successful runMigration", async () => {
        expect.assertions(3);

        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "bump-version" }));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getAuditLog, {}));
        const body = await response.json<{ result: { entries: { detail?: Record<string, unknown>; op: string; seq: number }[] } }>();

        expect(response.status).toBe(200);
        expect(body.result.entries).toHaveLength(1);
        expect(body.result.entries[0]).toMatchObject({ detail: { changed: 3, processed: 3 }, op: "runMigration" });
    });

    it("dryRun previews counts without rewriting rows", async () => {
        expect.assertions(3);

        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { dryRun: true, id: "bump-version" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ result: { changed: 3, dryRun: true, processed: 3, status: "completed" } });
        // The preview leaves rows untouched.
        expect(versions()).toEqual([0, 0, 0]);
    });

    it("reports persisted status after a run, and [] before any run", async () => {
        expect.assertions(3);

        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const before = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.migrationStatus, {}));

        await expect(before.json()).resolves.toEqual({ result: { migrations: [] } });

        await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "bump-version" }));

        const after = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.migrationStatus, { id: "bump-version" }));
        const body = await after.json<{ result: { migrations: Record<string, unknown>[] } }>();

        expect(body.result.migrations).toHaveLength(1);
        expect(body.result.migrations[0]).toMatchObject({ changed: 3, direction: "up", id: "bump-version", processed: 3, status: "completed" });
    });

    it("rejects runMigration without an id (400)", async () => {
        expect.assertions(2);

        const shard = new MigrationShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, {}));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "MIGRATION_ID_REQUIRED" } });
    });

    it("maps an unknown migration id to a 404 via the base hook default", async () => {
        expect.assertions(2);

        // AdminShard implements `handleRpc` but not `runShardDataMigration`, so
        // the base hook's not-found rejection surfaces through the admin path.
        const shard = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "ghost" }));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "MIGRATION_NOT_FOUND" } });
    });

    it("getMetrics returns a health snapshot with request/error counts", async () => {
        expect.assertions(5);

        const shard = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(userRequest("messages:list"));
        await shard.fetch(userRequest("boom:explode"));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getMetrics, {}));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { cache: unknown; errors: number; requests: number; shard: string } }>();

        expect(body.result.requests).toBe(2);
        expect(body.result.errors).toBe(1);
        expect(body.result.cache).toBeNull();
        expect(body.result.shard).toBeTypeOf("string");
    });

    it("getLogs returns the captured RPC errors, newest first", async () => {
        expect.assertions(3);

        // A failed dispatch is what the log buffer captures (path + message), so
        // a single boom call yields exactly one row; the successful call is not logged.
        const shard = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(userRequest("messages:list"));
        await shard.fetch(userRequest("boom:explode"));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getLogs, {}));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { entries: { functionPath?: string; level: string; message: string }[] } }>();

        expect(body.result.entries).toHaveLength(1);
        expect(body.result.entries[0]).toMatchObject({ functionPath: "boom:explode", level: "error", message: "boom" });
    });

    it("getFunctionStats reports per-function call and error counts", async () => {
        expect.assertions(6);

        const shard = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        // Two successes for one path, one failure for another — so the two paths
        // accumulate independently and the error path advances its error counter.
        await shard.fetch(userRequest("messages:list"));
        await shard.fetch(userRequest("messages:list"));
        await shard.fetch(userRequest("boom:explode"));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getFunctionStats, {}));

        expect(response.status).toBe(200);

        const body = await response.json<{
            result: { functions: { calls: number; errors: number; lastErrorMessage: null | string; path: string }[]; sinceMs: number };
        }>();

        const byPath = new Map(body.result.functions.map((stat) => [stat.path, stat]));

        expect(body.result.functions).toHaveLength(2);
        expect(byPath.get("messages:list")).toMatchObject({ calls: 2, errors: 0, lastErrorMessage: null });
        expect(byPath.get("boom:explode")).toMatchObject({ calls: 1, errors: 1, lastErrorMessage: "boom" });
        expect(byPath.get("messages:list")?.lastErrorMessage).toBeNull();
        expect(body.result.sinceMs).toBeTypeOf("number");
    });

    it("getRequestLog records one durable entry per dispatch with the acting user, outcome and redacted args", async () => {
        expect.assertions(7);

        const shard = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        // A user-attributed success and a failing dispatch, so the durable log
        // captures BOTH outcomes (unlike the error-only in-memory `getLogs`).
        const authedRequest = (functionPath: string): Request =>
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: { password: "p@ssw0rd" }, functionPath }), // gitleaks:allow -- test fixture password, not a real secret
                headers: { "content-type": "application/json", "x-cirrus-userid": "u1" },
                method: "POST",
            });

        await shard.fetch(authedRequest("messages:list"));
        await shard.fetch(userRequest("boom:explode"));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getRequestLog, {}));

        expect(response.status).toBe(200);

        const body = await response.json<{
            result: { entries: { functionPath: string; outcome: string; redactedArgs?: Record<string, unknown>; userId?: string }[] };
        }>();

        // Newest first: the boom error precedes the messages:list success.
        expect(body.result.entries).toHaveLength(2);
        expect(body.result.entries[0]).toMatchObject({ functionPath: "boom:explode", outcome: "error" });
        expect(body.result.entries[1]).toMatchObject({ functionPath: "messages:list", outcome: "ok", userId: "u1" });

        // Args are redacted by default — the raw secret never reaches the log, but the shape survives.
        const loggedArgs = body.result.entries[1]!.redactedArgs!;

        expect(Object.keys(loggedArgs)).toEqual(["password"]);
        expect(loggedArgs.password).not.toBe("p@ssw0rd"); // gitleaks:allow -- test fixture password, not a real secret

        // And the correlated filters narrow on those fields.
        const filtered = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getRequestLog, { outcome: "error" }));
        const filteredBody = await filtered.json<{ result: { entries: { functionPath: string }[] } }>();

        expect(filteredBody.result.entries.map((entry) => entry.functionPath)).toStrictEqual(["boom:explode"]);
    });

    it("samples out successful dispatches at rate 0 but always records errors", async () => {
        expect.assertions(2);

        const shard = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN, CIRRUS_REQUEST_LOG_SAMPLE: "0" });

        await shard.fetch(userRequest("messages:list")); // ok → sampled out
        await shard.fetch(userRequest("messages:get")); // ok → sampled out
        await shard.fetch(userRequest("boom:explode")); // error → always recorded

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getRequestLog, {}));
        const body = await response.json<{ result: { entries: { functionPath: string; outcome: string }[] } }>();

        expect(body.result.entries).toHaveLength(1);
        expect(body.result.entries[0]).toMatchObject({ functionPath: "boom:explode", outcome: "error" });
    });

    it("captures raw args in a dev environment (CIRRUS PII dev escape hatch)", async () => {
        expect.assertions(1);

        const shard = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN, ENVIRONMENT: "development" });

        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: { password: "p@ssw0rd" }, functionPath: "messages:list" }), // gitleaks:allow -- test fixture password, not a real secret
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getRequestLog, {}));
        const body = await response.json<{ result: { entries: { redactedArgs?: Record<string, unknown> }[] } }>();

        // Dev → raw capture: the value is NOT redacted.
        expect(body.result.entries[0]!.redactedArgs).toStrictEqual({ password: "p@ssw0rd" }); // gitleaks:allow -- test fixture password, not a real secret
    });

    /** Collect the parsed cirrus `type: "request"` events among a console spy's calls. */
    const cirrusRequestEvents = (spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] =>
        spy.mock.calls
            .map((call) => {
                try {
                    return JSON.parse(String(call[0])) as Record<string, unknown>;
                } catch {
                    return undefined;
                }
            })
            .filter((event): event is Record<string, unknown> => event?.source === "cirrus" && event.type === "request");

    it("always streams an error dispatch to console.error even without the emit flag", async () => {
        expect.assertions(2);

        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const shard = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(userRequest("boom:explode"));

        const events = cirrusRequestEvents(error);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ function: "boom:explode", outcome: "error" });

        vi.restoreAllMocks();
    });

    it("does NOT stream a successful dispatch to console unless CIRRUS_REQUEST_LOG_EMIT is set", async () => {
        expect.assertions(2);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        const quiet = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        await quiet.fetch(userRequest("messages:list"));

        expect(cirrusRequestEvents(log)).toHaveLength(0);

        const loud = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN, CIRRUS_REQUEST_LOG_EMIT: "1" });

        await loud.fetch(userRequest("messages:list"));

        expect(cirrusRequestEvents(log)).toHaveLength(1);

        vi.restoreAllMocks();
    });

    it("streams a successful dispatch by default in a dev environment (WORKER_ENV)", async () => {
        expect.assertions(1);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        // No CIRRUS_REQUEST_LOG_EMIT — the dev env (set by `cirrus dev` / the Vite plugin) flips it on.
        const dev = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN, WORKER_ENV: "development" });

        await dev.fetch(userRequest("messages:list"));

        expect(cirrusRequestEvents(log)).toHaveLength(1);

        vi.restoreAllMocks();
    });

    it("lets an explicit request-log emit of `false` silence summaries even in dev", async () => {
        expect.assertions(1);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const dev = new CountingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN, CIRRUS_REQUEST_LOG_EMIT: "false", WORKER_ENV: "development" });

        await dev.fetch(userRequest("messages:list"));

        expect(cirrusRequestEvents(log)).toHaveLength(0);

        vi.restoreAllMocks();
    });

    it("recordUserLog buffers the line, emits a console event, and forwards to the sink", async () => {
        expect.assertions(5);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const seen: { args: unknown[]; functionPath: string; level: string; message: string }[] = [];
        const shard = new LoggingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        shard.log("messages:list", "info", ["loaded", { count: 3 }], { onLog: (event) => seen.push(event) });

        // Forwarded to the programmatic sink, args un-redacted, attributed.
        expect(seen).toStrictEqual([
            {
                args: ["loaded", { count: 3 }],
                functionPath: "messages:list",
                level: "info",
                message: 'loaded {"count":3}',
                shardKey: undefined,
                ts: expect.any(Number),
                userId: undefined,
            },
        ]);

        // Structured console event for the dev terminal / Workers Logs.
        const events = log.mock.calls
            .map((call) => {
                try {
                    return JSON.parse(String(call[0])) as Record<string, unknown>;
                } catch {
                    return undefined;
                }
            })
            .filter((event): event is Record<string, unknown> => event?.source === "cirrus" && event.type === "log");

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ function: "messages:list", level: "info", message: 'loaded {"count":3}' });

        vi.restoreAllMocks();

        // Buffered for the studio Logs panel via the admin getLogs RPC.
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getLogs, {}));
        const body = await response.json<{ result: { entries: { functionPath: string; level: string; message: string }[] } }>();

        expect(body.result.entries).toHaveLength(1);
        expect(body.result.entries[0]).toMatchObject({ functionPath: "messages:list", level: "info", message: 'loaded {"count":3}' });
    });

    it("folds the bare `log` level onto info for the studio buffer", async () => {
        expect.assertions(1);

        vi.spyOn(console, "log").mockImplementation(() => {});
        const shard = new LoggingShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        shard.log("a:b", "log", ["hi"]);
        vi.restoreAllMocks();

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getLogs, {}));
        const body = await response.json<{ result: { entries: { level: string }[] } }>();

        expect(body.result.entries[0]!.level).toBe("info");
    });
});

/**
 * Drives the `__cirrus_admin__:writeRow` op through a real schema-aware writer,
 * mirroring what the codegen-generated subclass emits. Proves single-row
 * insert/patch/replace/delete land in SQLite via the admin path.
 */
class EditableShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override async runShardWrite(args: RunShardWriteArgs): Promise<RunShardWriteResult> {
        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: usersSchema,
            sql: this.sql as SqlExec,
        });

        if (args.op === "insert") {
            return { id: await writer.insert(args.table, args.doc ?? {}), op: "insert" };
        }

        if (args.op === "delete") {
            await writer.delete(args.id ?? "");

            return { id: args.id ?? null, op: "delete" };
        }

        if (args.op === "replace") {
            await writer.replace(args.id ?? "", args.doc ?? {});

            return { id: args.id ?? null, op: "replace" };
        }

        await writer.patch(args.id ?? "", args.doc ?? {});

        return { id: args.id ?? null, op: "patch" };
    }
}

describe("shardDO admin row writes", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        runShardMigrations(database.sql, usersSchema);

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const writeRequest = (args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath: ADMIN_FUNCTIONS.writeRow }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    const rowCount = (): number => Number(database.raw(`SELECT COUNT(*) AS c FROM "users"`)[0]?.["c"] ?? 0);

    it("inserts a row and returns its assigned id", async () => {
        expect.assertions(4);

        const shard = new EditableShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: { name: "Ada", version: 1 }, op: "insert", table: "users" }));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: RunShardWriteResult }>();

        expect(body.result.op).toBe("insert");

        expect(typeof body.result.id).toBe("string");

        expect(rowCount()).toBe(1);
    });

    it("patches an existing row", async () => {
        expect.assertions(2);

        const seed = createShardContextDatabase({ schema: usersSchema, sql: database.sql });
        const id = await seed.insert("users", { name: "old", version: 1 });

        const shard = new EditableShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: { name: "new" }, id, op: "patch", table: "users" }));

        expect(response.status).toBe(200);

        const name = database.raw(`SELECT json_extract("__doc__", '$.name') AS name FROM "users" WHERE id = ?`, id)[0]?.["name"];

        expect(name).toBe("new");
    });

    it("deletes a row", async () => {
        expect.assertions(2);

        const seed = createShardContextDatabase({ schema: usersSchema, sql: database.sql });
        const id = await seed.insert("users", { name: "doomed", version: 1 });

        const shard = new EditableShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ id, op: "delete", table: "users" }));

        expect(response.status).toBe(200);
        expect(rowCount()).toBe(0);
    });

    it("rejects an unknown op (400)", async () => {
        expect.assertions(1);

        const shard = new EditableShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: {}, op: "bogus", table: "users" }));

        expect(response.status).toBe(400);
    });

    it("requires an id for patch (400)", async () => {
        expect.assertions(1);

        const shard = new EditableShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: { name: "x" }, op: "patch", table: "users" }));

        expect(response.status).toBe(400);
    });

    it("base ShardDO rejects writeRow as an unknown table (no override)", async () => {
        expect.assertions(2);

        class BareShard extends ShardDO {
            // eslint-disable-next-line class-methods-use-this -- override stub; the admin-write path never dispatches an RPC
            public override async handleRpc(): Promise<unknown> {
                return null;
            }
        }

        const shard = new BareShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: { name: "x" }, op: "insert", table: "users" }));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "UNKNOWN_TABLE" } });
    });
});

/** A global leaderboard rank index (`partitionBy: []`) on the `messages` table. */
const rankByScoreDesc: RankIndexDefinitionLike = {
    name: "leaderboard",
    on: "messages",
    sortBy: [{ direction: "desc", field: "score" }],
};

const messagesRankSchema: SchemaLike = {
    tables: {
        messages: {
            indexes: [],
            rankIndexes: [rankByScoreDesc],
            shape: {
                channelId: { kind: "string" },
                score: { kind: "number" },
            },
        },
    },
};

/**
 * Drives the `__cirrus_admin__:rankBefore` op through a real schema-aware
 * writer, mirroring the codegen-generated subclass. Proves the cross-shard
 * rank's per-shard `{before, total}` count is served over the admin path.
 */
class RankableShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override async runShardRankBefore(args: RunShardRankBeforeArgs): Promise<{ before: number; total: number }> {
        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: messagesRankSchema,
            sql: this.sql as SqlExec,
        });

        return writer.rankBefore!(args.table, args.index, {
            partitionKey: args.partitionKey,
            rowId: args.rowId,
            sortValues: args.sortValues,
        });
    }
}

describe("shardDO admin rankBefore", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        runShardMigrations(database.sql, messagesRankSchema);

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const rankBeforeRequest = (args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath: ADMIN_FUNCTIONS.rankBefore }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    it("counts strictly-before rows for an explicit key on this shard", async () => {
        expect.assertions(2);

        // This shard owns a disjoint slice of the global leaderboard partition.
        const seed = createShardContextDatabase({ schema: messagesRankSchema, sql: database.sql });

        await seed.insert("messages", { _id: "m1", channelId: "c1", score: 90 }, { allowExplicitId: true });
        await seed.insert("messages", { _id: "m2", channelId: "c1", score: 70 }, { allowExplicitId: true });
        await seed.insert("messages", { _id: "m3", channelId: "c1", score: 20 }, { allowExplicitId: true });

        const shard = new RankableShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        // Rank a foreign row scored 75: desc order → m1(90) is strictly before
        // it, m2(70)/m3(20) are after. before=1, total=3 (this shard's rows).
        const key = rankKeyFromDoc(rankByScoreDesc, { _id: "x1", channelId: "c9", score: 75 });
        const response = await shard.fetch(rankBeforeRequest({ index: "leaderboard", table: "messages", ...key }));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { before: number; total: number } }>();

        expect(body.result).toEqual({ before: 1, total: 3 });
    });

    it("rejects a non-array sortValues (400)", async () => {
        expect.assertions(1);

        const shard = new RankableShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(rankBeforeRequest({ index: "leaderboard", partitionKey: "", rowId: "x1", sortValues: 5, table: "messages" }));

        expect(response.status).toBe(400);
    });

    it("base ShardDO rejects rankBefore as not implemented (no override)", async () => {
        expect.assertions(2);

        class BareShard extends ShardDO {
            // eslint-disable-next-line class-methods-use-this -- override stub; the admin-rank path never dispatches an RPC
            public override async handleRpc(): Promise<unknown> {
                return null;
            }
        }

        const shard = new BareShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(rankBeforeRequest({ index: "leaderboard", partitionKey: "", rowId: "x1", sortValues: [75], table: "messages" }));

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_IMPLEMENTED" } });
    });
});

describe("shardDO admin cdcSync", () => {
    let database: ReturnType<typeof createSqliteExec>;

    const stateFor = (sql: unknown): ShardDOState => {
        return {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: sql as ShardDOState["storage"]["sql"] },
        };
    };

    const cdcRequest = (args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath: ADMIN_FUNCTIONS.cdcSync }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    afterEach(() => {
        database.close();
    });

    it("pages this shard's changelog past sinceSeq", async () => {
        expect.assertions(3);

        database = createSqliteExec();
        runShardMigrations(database.sql, usersSchema, { cdc: true });

        const writer = createShardContextDatabase({ cdc: true, schema: usersSchema, sql: database.sql });

        await writer.insert("users", { _id: "u_1", name: "Ada", version: 1 }, { allowExplicitId: true });
        await writer.patch("u_1", { name: "Ada Lovelace" });

        const shard = new AdminShard(stateFor(database.sql), { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(cdcRequest({ sinceSeq: 0 }));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { changes: { op: string }[]; cursor: number } }>();

        expect(body.result.changes.map((change) => change.op)).toStrictEqual(["insert", "update"]);
        expect(body.result.cursor).toBe(2);
    });

    it("returns an empty page that leaves the cursor untouched when the shard has no changelog", async () => {
        expect.assertions(2);

        database = createSqliteExec();
        runShardMigrations(database.sql, usersSchema); // CDC disabled — no __cdc_log table.

        const shard = new AdminShard(stateFor(database.sql), { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(cdcRequest({ sinceSeq: 7 }));
        const body = await response.json<{ result: { changes: unknown[]; cursor: number } }>();

        expect(body.result.changes).toStrictEqual([]);
        expect(body.result.cursor).toBe(7);
    });
});

/** Mirrors the codegen subclass: overrides runShardApplyCdc with a real writer. */
class ApplyShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override async runShardApplyCdc(args: RunShardApplyCdcArgs): Promise<RunShardApplyCdcResult> {
        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: usersSchema,
            sql: this.sql as SqlExec,
        });

        await applyCdcChanges(writer, args.changes);

        return { applied: args.changes.length };
    }
}

describe("shardDO admin applyCdc", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        runShardMigrations(database.sql, usersSchema);

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const applyRequest = (changes: unknown[]): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: { changes }, functionPath: ADMIN_FUNCTIONS.applyCdc }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    const rowCount = (): number => Number(database.raw(`SELECT COUNT(*) AS c FROM "users"`)[0]?.["c"] ?? 0);

    it("replays an insert + a delete through the writer", async () => {
        expect.assertions(3);

        const shard = new ApplyShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const seed = createShardContextDatabase({ schema: usersSchema, sql: database.sql });
        const doomedId = await seed.insert("users", { name: "doomed", version: 1 });

        const response = await shard.fetch(
            applyRequest([
                { doc: { _id: "u_keep", name: "Ada", version: 1 }, id: "u_keep", op: "insert", table: "users" },
                { id: doomedId, op: "delete", table: "users" },
            ]),
        );

        expect(response.status).toBe(200);

        const body = await response.json<{ result: RunShardApplyCdcResult }>();

        expect(body.result.applied).toBe(2);
        // The seeded row was deleted and the replayed row inserted — net one row.
        expect(rowCount()).toBe(1);
    });

    it("rejects a malformed changes payload (400)", async () => {
        expect.assertions(1);

        const shard = new ApplyShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(applyRequest([{ id: "x", op: "bogus", table: "users" }]));

        expect(response.status).toBe(400);
    });
});

/** Per-project count aggregate on `todos`, so a writer-routed delete must step the counter shadow table down. */
const todosByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    name: "byProject",
    on: "todos",
    op: "count",
};

/** A within-project rank on `todos`, so a writer-routed delete must also keep the rank shadow table consistent. */
const todosRankByDone: RankIndexDefinitionLike = {
    name: "byDone",
    on: "todos",
    partitionBy: ["projectId"],
    sortBy: [{ direction: "asc", field: "_creationTime" }],
};

const todosSchema: SchemaLike = {
    tables: {
        todos: {
            aggregateIndexes: [todosByProject],
            indexes: [],
            rankIndexes: [todosRankByDone],
            shape: {
                done: { kind: "boolean" },
                projectId: { kind: "string" },
                title: { kind: "string" },
            },
        },
    },
};

/**
 * Drives the `__cirrus_admin__:deleteRows` / `__cirrus_admin__:clearTable` ops
 * through a real schema-aware writer, mirroring the codegen-generated subclass'
 * `deleteRowThroughWriter` override. The base `runShardBulkDelete` owns the
 * bounded id-collection loop; this only supplies the per-row writer delete, so
 * the FTS / aggregate / rank shadow tables stay in sync exactly like a single
 * `writeRow` delete.
 */
class BulkDeleteShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override async deleteRowThroughWriter(_table: string, id: string): Promise<void> {
        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: todosSchema,
            sql: this.sql as SqlExec,
        });

        await writer.delete(id);
    }
}

describe("shardDO admin bulk delete", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        runShardMigrations(database.sql, todosSchema);

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const bulkRequest = (functionPath: string, args: Record<string, unknown>): Request => {
        const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };

        return new Request("https://shard.internal/rpc", { body: JSON.stringify({ args, functionPath }), headers, method: "POST" });
    };

    const rowCount = (): number => Number(database.raw(`SELECT COUNT(*) AS c FROM "todos"`)[0]?.["c"] ?? 0);

    /** Seed `count` todos in project `projectId`, returning the writer used (its reads hit the shadow tables). */
    const seedProject = async (writer: DatabaseWriterLike, projectId: string, count: number): Promise<void> => {
        // gitleaks:allow -- kingfisher false positive on a test-helper signature, no secret
        for (let index = 0; index < count; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes
            await writer.insert("todos", { done: false, projectId, title: `t${index.toString()}` });
        }
    };

    it("deletes only the rows matching a filter, leaving the rest", async () => {
        expect.assertions(4);

        const seed = createShardContextDatabase({ schema: todosSchema, sql: database.sql });

        await seedProject(seed, "p1", 3);
        await seedProject(seed, "p2", 2);

        const shard = new BulkDeleteShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(
            bulkRequest(ADMIN_FUNCTIONS.deleteRows, { filters: [{ column: "projectId", operator: "eq", value: "p1" }], table: "todos" }),
        );

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { deleted: number; hasMore: boolean } }>();

        expect(body.result).toEqual({ deleted: 3, hasMore: false });
        // p1's three rows are gone; p2's two survive.
        expect(rowCount()).toBe(2);
        await expect(seed.count("todos", { projectId: "p2" })).resolves.toBe(2);
    });

    it("keeps the aggregate and rank shadow tables consistent after a bulk delete", async () => {
        expect.assertions(3);

        const seed = createShardContextDatabase({ schema: todosSchema, sql: database.sql });

        await seedProject(seed, "p1", 4);
        await seedProject(seed, "p2", 1);

        const shard = new BulkDeleteShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(bulkRequest(ADMIN_FUNCTIONS.deleteRows, { filters: [{ column: "projectId", operator: "eq", value: "p1" }], table: "todos" }));

        // The count aggregate reads its counter shadow table — only correct if
        // every delete went THROUGH the writer (not raw SQL).
        await expect(seed.count("todos", { projectId: "p1" })).resolves.toBe(0);
        await expect(seed.count("todos", { projectId: "p2" })).resolves.toBe(1);

        // The rank shadow table for p1 is now empty: ranking the surviving p2
        // row returns position 0 within its own partition, proving p1's rank
        // rows were cleaned up rather than orphaned.
        const survivor = database.raw(`SELECT id FROM "todos" WHERE json_extract("__doc__", '$.projectId') = 'p2' LIMIT 1`)[0]?.["id"] as string;
        const key = rankKeyFromDoc(todosRankByDone, { _id: survivor, projectId: "p2" });

        await expect(seed.rankBefore!("todos", "byDone", { partitionKey: key.partitionKey, rowId: survivor, sortValues: key.sortValues })).resolves.toEqual({
            before: 0,
            total: 1,
        });
    });

    it("is bounded: caps deletes at `limit` and reports hasMore", async () => {
        expect.assertions(3);

        const seed = createShardContextDatabase({ schema: todosSchema, sql: database.sql });

        await seedProject(seed, "p1", 5);

        const shard = new BulkDeleteShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(bulkRequest(ADMIN_FUNCTIONS.deleteRows, { limit: 2, table: "todos" }));
        const body = await response.json<{ result: { deleted: number; hasMore: boolean } }>();

        expect(body.result.deleted).toBe(2);
        expect(body.result.hasMore).toBe(true);
        // Only the capped batch was removed; the rest remain for the next loop.
        expect(rowCount()).toBe(3);
    });

    it("clearTable empties the whole table through the writer", async () => {
        expect.assertions(3);

        const seed = createShardContextDatabase({ schema: todosSchema, sql: database.sql });

        await seedProject(seed, "p1", 3);
        await seedProject(seed, "p2", 2);

        const shard = new BulkDeleteShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(bulkRequest(ADMIN_FUNCTIONS.clearTable, { table: "todos" }));
        const body = await response.json<{ result: { deleted: number; hasMore: boolean } }>();

        expect(body.result).toEqual({ deleted: 5, hasMore: false });
        expect(rowCount()).toBe(0);
        // The counter shadow table dropped to zero for both projects.
        await expect(seed.count("todos", { projectId: "p1" })).resolves.toBe(0);
    });

    it("rejects deleteRows without a table (400)", async () => {
        expect.assertions(1);

        const shard = new BulkDeleteShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(bulkRequest(ADMIN_FUNCTIONS.deleteRows, {}));

        expect(response.status).toBe(400);
    });

    it("maps an unknown table to a 404", async () => {
        expect.assertions(1);

        const shard = new BulkDeleteShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(bulkRequest(ADMIN_FUNCTIONS.deleteRows, { table: "nope" }));

        expect(response.status).toBe(404);
    });

    it("base ShardDO rejects deleteRows as an unknown table (no override)", async () => {
        expect.assertions(2);

        class BareShard extends ShardDO {
            // eslint-disable-next-line class-methods-use-this -- override stub; the admin bulk-delete path never dispatches an RPC
            public override async handleRpc(): Promise<unknown> {
                return null;
            }
        }

        const seed = createShardContextDatabase({ schema: todosSchema, sql: database.sql });

        await seedProject(seed, "p1", 1);

        const shard = new BareShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(bulkRequest(ADMIN_FUNCTIONS.deleteRows, { table: "todos" }));

        // The id collection succeeds, but the base `deleteRowThroughWriter`
        // stub rejects the first row as an unknown table.
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "UNKNOWN_TABLE" } });
    });
});
