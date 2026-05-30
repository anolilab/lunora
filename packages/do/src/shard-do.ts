import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { drizzle as drizzleDO, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import type { ExportRow, ImportShardResult } from "./admin-export-import.js";
import { parseExportShardArgs, parseImportShardArgs } from "./admin-export-import.js";
import type { SqlExec } from "./ctx-db.js";
import type { MigrationDirection, MigrationRunResult } from "./data-migration.js";
import { readMigrationStatus } from "./data-migration.js";
import type { DependencyTracker } from "./dependency-tracker.js";
import { createDependencyTracker } from "./dependency-tracker.js";
import { ADMIN_FUNCTION_PREFIX, ADMIN_FUNCTIONS, listTables, readTablePage } from "./introspect.js";
import type { ReactiveCacheOptions } from "./reactive-cache.js";
import { ReactiveCache, reactiveCacheKey } from "./reactive-cache.js";
import { ConflictError, type TransactionSqlLike } from "./transaction.js";
import type { MutationDelta, RpcRequest, SocketAttachment, SubscriptionEnvelope, SubscriptionQuery } from "./types.js";

/**
 * Minimal projection of `DurableObjectState` that the ShardDO base requires.
 * Declared structurally so unit tests can pass in plain object doubles
 * without depending on the workers runtime.
 *
 * NOTE on hibernation attachments: the Workers runtime exposes
 * `serializeAttachment(value)` and `deserializeAttachment()` as methods on
 * the **WebSocket itself**, not on the DO state. The mock-based test suite
 * historically modeled them on the state — that has been corrected; the
 * production code now matches the workerd shape.
 */
export interface ShardDOState {
    acceptWebSocket: (ws: WebSocket, tags?: string[]) => void;
    getWebSockets: (tag?: string) => WebSocket[];
    /** Optional pointer to the DO instance id so we can detect `__root__`. */
    id?: { name?: string };
    storage: {
        sql: {
            [key: string]: unknown;
            /**
             * Current size of the SQLite database in bytes. Backed by a real
             * getter on the runtime — read on every access.
             */
            readonly databaseSize?: number;
            /**
             * Run a SQL statement without parameters — used by the
             * transaction helper for BEGIN / COMMIT / ROLLBACK. The runtime
             * exposes this as `state.storage.sql.exec(...)`.
             */
            exec?: (query: string) => unknown;
        };
    };
}

/**
 * Subset of the Workers `WebSocket` interface that exposes the hibernation
 * attachment methods. We type these structurally so the unit tests can pass
 * a plain object that satisfies the same contract — the real runtime adds
 * them to every socket returned via the Hibernation API.
 *
 * Note: `WebSocket` in `@cloudflare/workers-types` already declares these
 * methods as required. We deliberately do NOT extend that type — at runtime
 * inside `workerd` they're always present, but the unit tests pass plain
 * `WebSocket`-shaped objects that may not have them. The intersection here
 * is informational; the runtime calls are guarded with optional chaining.
 */
export interface HibernatableWebSocket {
    deserializeAttachment?: () => unknown;
    serializeAttachment?: (value: unknown) => void;
}

/**
 * Result of re-running a subscription's query. `tables` is the set of tables
 * the query touched (discovered at runtime via the db adapter's `onRead`
 * hook) — the shard uses it to decide which writes should trigger a re-run.
 */
export interface SubscriptionOutcome {
    result: unknown;
    tables: Set<string>;
}

/**
 * Optional shard-level configuration passed through `super(state, env, …)`.
 * Reserved as a bag rather than positional args so subclasses don't break
 * when new knobs land. Today the only knob is the reactive cache; future
 * additions should keep the same shape (per-feature options object).
 */
export interface ShardDOOptions {
    /**
     * Enable the per-shard reactive query cache. When provided, the dispatch
     * path uses {@link ShardDO.runCachedQuery} to memoize query results by
     * `(functionPath, stable-stringified args)`. Omit to keep the legacy
     * behavior (every dispatch re-runs the handler).
     *
     * The cache is invisible to the WS subscription bridge: invalidations
     * land via the ctx-db write hooks (`@cirrus/do`'s `createShardCtxDb`
     * `cache` option) BEFORE the broadcast goes out, so subscribers that
     * re-run their queries in response always observe the post-write state.
     */
    reactiveCache?: ReactiveCacheOptions;
}

/** Arguments accepted by the `__cirrus_admin__:runMigration` admin RPC. */
export interface RunShardMigrationArgs {
    batchSize?: number;
    direction?: MigrationDirection;
    dryRun?: boolean;
    id: string;
    maxBatches?: number;
}

/** Arguments accepted by the `__cirrus_admin__:exportShard` admin RPC. */
export interface RunShardExportArgs {
    batchSize?: number;
    tables?: ReadonlyArray<string>;
}

/** Arguments accepted by the `__cirrus_admin__:importShard` admin RPC. */
export interface RunShardImportArgs {
    rows: ReadonlyArray<ExportRow>;
    startLine?: number;
}

/** Per-subscription memo used to suppress no-op pushes. */
interface SubscriptionMemo {
    lastJson: string;
    tables: Set<string>;
}

/**
 * Threshold at which a `__root__` DO triggers the size warning. 1 GiB —
 * exactly 10% of the 10 GiB per-DO SQLite ceiling, leaving plenty of runway
 * to plan a `.shardBy()` migration before the wall hits.
 */
export const ROOT_DO_SIZE_WARN_BYTES = 1_073_741_824;

/**
 * Reserved shard name for the fallback Durable Object that hosts every
 * table without an explicit `.shardBy()` or `.global()` modifier.
 */
export const ROOT_SHARD_NAME = "__root__";

/**
 * Base class for shard Durable Objects.
 *
 * Concrete subclasses implement {@link handleRpc} and may emit deltas via
 * {@link broadcastDelta}. Subscriptions are stored on each WebSocket via
 * `serializeAttachment` so they survive hibernation.
 */
export abstract class ShardDO {
    /**
     * Set once the very first `__root__` warning has been emitted. Static so
     * a hot DO cannot spam the log on every write; the v0.1 lifetime of a DO
     * exceeds any reasonable cooldown so a single warning is sufficient. The
     * test suite resets this via {@link resetRootSizeWarning} for isolation.
     */
    private static rootSizeWarned = false;

    /** Test-only: reset the static "warned once" flag. */
    public static resetRootSizeWarning(): void {
        ShardDO.rootSizeWarned = false;
    }

    protected state: ShardDOState;

    protected env: unknown;

    /**
     * Lazily-built drizzle handle over `state.storage`. Memoised so a single
     * DO instance reuses the same dialect across handler calls. The drizzle
     * DO driver only touches `storage.sql`, so test doubles only need to
     * supply that field — see {@link ShardDOState}.
     */
    private drizzleHandle: DrizzleSqliteDODatabase<Record<string, unknown>> | undefined;

    /**
     * Tracks BEGIN/COMMIT nesting so we can reject nested transactions —
     * SQLite-in-DO does not support them and the runtime would crash with
     * "cannot start a transaction within a transaction".
     */
    private transactionDepth: number = 0;

    /**
     * Per-request D1 Sessions API bookmark, read from the inbound
     * `x-d1-bookmark` header at the top of `fetch` and exposed to handlers
     * via {@link getInboundBookmark}. Cleared between requests so a stale
     * bookmark from a previous client never leaks into the next session.
     */
    private currentRequestBookmark: string | undefined;

    /**
     * Per-request D1 bookmark to echo on the outbound response. Handlers
     * call {@link setOutboundBookmark} after a global-table write so the
     * client can pin subsequent reads on the same replica.
     */
    private currentResponseBookmark: string | undefined;

    /**
     * Per-request userId forwarded from the runtime via the
     * `x-cirrus-userid` header. Surfaced to handlers via
     * {@link getCurrentUserId}. Cleared in the `finally` block of `fetch`
     * so a stale identity from a previous client never leaks into the
     * next request.
     */
    private currentRequestUserId: string | undefined;

    /**
     * Per-request identity envelope forwarded from the runtime via the
     * `x-cirrus-identity` JSON header. Stores claims like `email`,
     * `name`, or custom roles populated by `resolveIdentity` on the
     * worker. Surfaced to handlers via {@link getCurrentIdentity}.
     */
    private currentRequestIdentity: Record<string, unknown> | undefined;

    /**
     * Tables written during the in-flight RPC, accumulated by
     * {@link recordChangedTable}. Drained after `handleRpc` returns to drive
     * {@link refreshSubscriptions}. `null` when no write has happened yet so
     * the common read-only path allocates nothing.
     */
    private pendingChangedTables: Set<string> | null = null;

    /**
     * Last pushed result per `(socket, subId)`, keyed by socket. Lets
     * {@link refreshSubscriptions} skip re-running queries whose tables were
     * untouched and suppress pushes when the re-run result is unchanged. Held
     * in memory only — it does not survive hibernation, which is safe: a cold
     * memo simply forces one re-run and (at most) one redundant push.
     */
    private readonly subMemos = new WeakMap<WebSocket, Map<string, SubscriptionMemo>>();

    /**
     * Opt-in per-shard reactive query cache. When the subclass passes
     * `ReactiveCacheOptions` to `super(state, env, { reactiveCache: { … } })`
     * the cache is instantiated here and exposed to subclasses via
     * {@link runCachedQuery}; when omitted (today's default) it stays
     * undefined and the dispatch path runs with zero cache overhead.
     *
     * The cache is per-shard and in-memory only — it is lost on DO restart
     * and on workerd hibernation. That's fine: a cold shard simply re-runs
     * the query on the first call, just like it does today.
     */
    protected readonly reactiveCache: ReactiveCache | undefined;

    /**
     * Lifetime request counters surfaced by the `__cirrus_admin__:getMetrics`
     * RPC. In-memory only — they reset when the DO hibernates or restarts, which
     * is the right granularity for a "since this instance woke" health readout
     * (durable aggregation would be a separate, heavier feature).
     */
    private readonly metrics = { errors: 0, requests: 0, sinceMs: Date.now() };

    /**
     * In-flight dependency tracker for the currently-executing query. Set by
     * {@link runCachedQuery} so the ctx-db hooks (wired via `onRead`) can
     * stamp deps without threading the tracker explicitly through every
     * generated handler signature. Cleared in the `finally` of the same
     * call so a leaked tracker can never bleed into a sibling RPC.
     */
    private currentTracker: DependencyTracker | undefined;

    constructor(state: ShardDOState, env: unknown, options: ShardDOOptions = {}) {
        this.state = state;
        this.env = env;

        if (options.reactiveCache) {
            this.reactiveCache = new ReactiveCache(options.reactiveCache);
        }
    }

    /** SQLite handle scoped to this Durable Object. */
    protected get sql(): unknown {
        return this.state.storage.sql;
    }

    /**
     * Drizzle handle scoped to this Durable Object's SQLite storage. Use this
     * for typed queries against generated `sqliteTable` schemas. The handle
     * participates in {@link runInTransaction} via drizzle's own `transaction`
     * helper — there is no need to call `db.transaction(...)` directly from
     * subclasses; wrap your work in `runInTransaction` and use `this.db`
     * inside the handler instead.
     */
    protected get db(): DrizzleSqliteDODatabase<Record<string, unknown>> {
        if (this.drizzleHandle) {
            return this.drizzleHandle;
        }

        // The drizzle DO driver introspects `storage.sql` only; the structural
        // projection here matches what tests already supply.
        this.drizzleHandle = drizzleDO(this.state.storage as unknown as DurableObjectStorage, { logger: false });

        return this.drizzleHandle;
    }

    /**
     * Run `handler` inside a SQLite transaction. Commits if it resolves;
     * rolls back if it throws. The `ConflictError` re-throw lets the
     * runtime translate optimistic-concurrency failures into a 409 response.
     *
     * Nested calls are refused with a `CirrusError`-shaped object — SQLite
     * in Durable Objects does not support nested transactions, so we fail
     * loudly rather than silently flattening them.
     *
     * Drizzle queries issued via {@link db} inside the handler participate
     * in this transaction implicitly — drizzle and the BEGIN/COMMIT below
     * both write through the same `state.storage.sql` handle, so the tx
     * boundary is shared. Do **not** call `this.db.transaction(...)` from
     * inside a handler; that would attempt a nested SQLite transaction.
     *
     * Why raw BEGIN/COMMIT/ROLLBACK strings instead of `this.db.transaction(handler)`?
     * Two reasons, both verified against drizzle-orm 0.45.2's
     * `durable-sqlite/session.js`:
     *
     *   1. The DO driver does NOT issue BEGIN/COMMIT/ROLLBACK SQL — it
     *      delegates to `state.storage.transactionSync(callback)`, the
     *      DO platform's native transaction primitive. Swapping in
     *      `db.transaction()` would silently change the wire-level
     *      contract observed by tests and any tooling that intercepts
     *      `storage.sql`.
     *
     *   2. `transactionSync` invokes the callback synchronously and does
     *      not await its return value. Drizzle's `transaction()` matches
     *      that — it passes the tx handle through and then returns.
     *      Handing it an async handler would let the transaction commit
     *      before the handler resolves, breaking the `() => Promise<T> | T`
     *      contract.
     *
     * The raw-SQL approach below is async-safe and gives the
     * connection-scoped semantics SQLite-in-DO is designed for.
     */
    protected async runInTransaction<T>(handler: () => Promise<T> | T): Promise<T> {
        if (this.transactionDepth > 0) {
            throw Object.assign(new Error("nested transactions are not supported in SQLite-in-DO"), {
                name: "CirrusError",
                code: "NESTED_TRANSACTION",
                status: 500,
            });
        }

        const sqlHandle = this.state.storage.sql as TransactionSqlLike | undefined;

        if (!sqlHandle || typeof sqlHandle.exec !== "function") {
            throw Object.assign(new Error("storage.sql is not available on this ShardDO state"), {
                name: "CirrusError",
                code: "SQL_UNAVAILABLE",
                status: 500,
            });
        }

        this.transactionDepth = 1;
        sqlHandle.exec("BEGIN");

        try {
            const value = await handler();

            sqlHandle.exec("COMMIT");

            return value;
        } catch (error) {
            try {
                sqlHandle.exec("ROLLBACK");
            } catch {
                // The rollback itself may fail if the connection is in a
                // bad state — swallow it so the original error propagates.
            }

            throw error;
        } finally {
            this.transactionDepth = 0;
        }
    }

    /**
     * Worker-side fetch entry point. Handles WebSocket upgrades and the
     * shard-local RPC endpoint forwarded by `@cirrus/runtime`.
     */
    public async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (request.headers.get("Upgrade") === "websocket") {
            return this.handleWebSocketUpgrade(request);
        }

        if (url.pathname === "/rpc" && request.method === "POST") {
            let payload: RpcRequest;

            try {
                payload = (await request.json()) as RpcRequest;
            } catch {
                return jsonResponse({ error: { code: "BAD_REQUEST", message: "invalid JSON body" } }, 400);
            }

            // Reserved admin-introspection RPCs are intercepted before user
            // dispatch — they read raw SQLite directly rather than running a
            // registered function, and carry their own bearer-token gate.
            if (payload.functionPath.startsWith(ADMIN_FUNCTION_PREFIX)) {
                return this.handleAdminRpc(request, payload.functionPath, payload.args ?? {});
            }

            // Stash the inbound D1 bookmark and identity headers for the
            // duration of the handler call so getters return the right
            // values. Cleared on exit so the next request starts fresh.
            this.currentRequestBookmark = request.headers.get("x-d1-bookmark") ?? undefined;
            this.currentResponseBookmark = undefined;
            this.currentRequestUserId = request.headers.get("x-cirrus-userid") ?? undefined;
            this.currentRequestIdentity = parseIdentityHeader(request.headers.get("x-cirrus-identity"));

            this.metrics.requests += 1;

            try {
                const result = await this.handleRpc(payload.functionPath, payload.args ?? {});

                // Inspect the post-write size before responding. SQLite-in-DO
                // exposes `databaseSize` as a real getter; reading it is a
                // cheap stat call, not a full table scan.
                this.maybeWarnRootSize();

                // Snapshot the response before re-running subscriptions so the
                // bookmark captured by the handler is preserved verbatim.
                const response = jsonResponse({ result }, 200, this.currentResponseBookmark);

                await this.flushChangedTables();

                return response;
            } catch (error: unknown) {
                this.metrics.errors += 1;

                return this.errorToResponse(error);
            } finally {
                this.currentRequestBookmark = undefined;
                this.currentResponseBookmark = undefined;
                this.currentRequestUserId = undefined;
                this.currentRequestIdentity = undefined;
            }
        }

        return new Response("Not found", { status: 404 });
    }

    /**
     * Returns the D1 Sessions API bookmark forwarded by the client on this
     * request, or `undefined` when none was supplied. Handlers pass this
     * into `db.withSession(bookmark)` to opt into read-your-writes
     * consistency across replicas.
     */
    protected getInboundBookmark(): string | undefined {
        return this.currentRequestBookmark;
    }

    /**
     * Record the post-write D1 bookmark that should be echoed back to the
     * client on the outbound `x-d1-bookmark` header. Safe to call multiple
     * times — the last value wins; only the most recent write's bookmark
     * is meaningful for downstream read pinning.
     */
    protected setOutboundBookmark(bookmark: string | undefined): void {
        this.currentResponseBookmark = bookmark;
    }

    /**
     * The userId forwarded by the runtime's `resolveIdentity` hook for the
     * current request, or `undefined` when the request is anonymous. Use
     * this to populate `ctx.auth.userId` inside `buildCtx`.
     */
    protected getCurrentUserId(): string | undefined {
        return this.currentRequestUserId;
    }

    /**
     * Identity claims (email, name, roles, …) forwarded by the runtime's
     * `resolveIdentity` hook. Returns `undefined` for anonymous requests
     * or when no extra claims were attached. Use this to populate the
     * value returned by `ctx.auth.getIdentity()` inside `buildCtx`.
     */
    protected getCurrentIdentity(): Record<string, unknown> | undefined {
        return this.currentRequestIdentity;
    }

    /**
     * Emit a one-shot console warning when the `__root__` DO's SQLite file
     * crosses {@link ROOT_DO_SIZE_WARN_BYTES} (1 GiB = 10% of the per-DO
     * ceiling). We deliberately avoid throwing — apps should keep working;
     * the warning is the migration signal.
     */
    /**
     * Assemble the health snapshot served by `__cirrus_admin__:getMetrics`:
     * lifetime request/error counts since this instance woke, the live SQLite
     * size, and (when an opt-in reactive cache is configured) its hit/miss
     * stats. All cheap, in-memory reads — no table scans.
     */
    private collectMetrics(): {
        cache: null | { bytes: number; entries: number; evictions: number; hits: number; misses: number };
        databaseSize: null | number;
        errors: number;
        requests: number;
        shard: string;
        sinceMs: number;
        uptimeMs: number;
    } {
        const size = this.state.storage.sql?.databaseSize;

        return {
            cache: this.reactiveCache ? this.reactiveCache.stats() : null,
            databaseSize: typeof size === "number" ? size : null,
            errors: this.metrics.errors,
            requests: this.metrics.requests,
            shard: this.state.id?.name ?? ROOT_SHARD_NAME,
            sinceMs: this.metrics.sinceMs,
            uptimeMs: Date.now() - this.metrics.sinceMs,
        };
    }

    private maybeWarnRootSize(): void {
        if (ShardDO.rootSizeWarned) {
            return;
        }

        const idName = this.state.id?.name;

        if (idName !== ROOT_SHARD_NAME) {
            return;
        }

        const size = this.state.storage.sql?.databaseSize;

        if (typeof size !== "number" || size < ROOT_DO_SIZE_WARN_BYTES) {
            return;
        }

        ShardDO.rootSizeWarned = true;
        console.warn(
            `[@cirrus/do] __root__ Durable Object SQLite size is ${size} bytes (>= 1 GiB, 10% of the 10 GiB per-DO ceiling). Plan a \`.shardBy()\` migration before you hit the wall. See https://cirrus.dev/docs/concepts/sharding for guidance.`,
        );
    }

    /**
     * Map a thrown value to a JSON response. `ValidationError` from
     * `@cirrus/values` becomes a 400 with code `VALIDATION_ERROR`. A
     * `CirrusError` keeps its declared status/code. Everything else becomes
     * a 500 with code `RPC_FAILED`.
     */
    private errorToResponse(error: unknown): Response {
        // Structural duck-typing so this package does not need a runtime
        // dependency on `@cirrus/values` or `@cirrus/runtime`. The shapes
        // below are the public surface of those error types.
        if (error instanceof ConflictError) {
            return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
        }

        if (error && typeof error === "object" && (error as { name?: string }).name === "ValidationError") {
            const message = error instanceof Error ? error.message : "validation failed";

            return jsonResponse({ error: { code: "VALIDATION_ERROR", message } }, 400);
        }

        if (error && typeof error === "object" && (error as { name?: string }).name === "CirrusError") {
            const cirrusError = error as { code?: string; message?: string; status?: number };
            const status = typeof cirrusError.status === "number" ? cirrusError.status : 500;

            return jsonResponse({ error: { code: cirrusError.code ?? "INTERNAL", message: cirrusError.message ?? "internal error" } }, status);
        }

        const message = error instanceof Error ? error.message : "unknown error";

        return jsonResponse({ error: { code: "RPC_FAILED", message } }, 500);
    }

    /**
     * Serve a reserved admin-introspection RPC (`__cirrus_admin__:*`) for the
     * data browser. Gated by `env.CIRRUS_ADMIN_TOKEN`: introspection is
     * **disabled unless the token is configured**, and when it is, the request
     * must present a matching `Authorization: Bearer` header. The blast radius
     * is raw table contents, so the default is closed — unlike the WebSocket
     * upgrade gate, which defaults open for local dev.
     */
    private async handleAdminRpc(request: Request, functionPath: string, args: Record<string, unknown>): Promise<Response> {
        if (!this.isAdminAuthorized(request)) {
            return jsonResponse({ error: { code: "ADMIN_FORBIDDEN", message: "admin introspection is disabled or the bearer token is invalid" } }, 403);
        }

        const sql = this.state.storage.sql as unknown as SqlExec;

        try {
            if (functionPath === ADMIN_FUNCTIONS.listTables) {
                return jsonResponse({ result: listTables(sql) }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.getMetrics) {
                return jsonResponse({ result: this.collectMetrics() }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.readTablePage) {
                const page = readTablePage(sql, {
                    limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
                    offset: typeof args["offset"] === "number" ? args["offset"] : undefined,
                    table: typeof args["table"] === "string" ? args["table"] : "",
                });

                return jsonResponse({ result: page }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.migrationStatus) {
                const id = typeof args["id"] === "string" ? args["id"] : undefined;

                return jsonResponse({ result: { migrations: readMigrationStatus(sql, id) } }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.runMigration) {
                const result = await this.runShardDataMigration(parseRunMigrationArgs(args));

                // The migration rewrites rows through the writer, which records
                // the touched tables; flush so live subscribers re-run against
                // the new values. No-op on a dryRun (nothing was written).
                await this.flushChangedTables();

                return jsonResponse({ result }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.exportShard) {
                const parsed = parseExportShardArgs(args);

                // The export reads through the writer; producing a streaming
                // body would require coordinating with the worker's
                // `ReadableStream`. We instead materialize the rows here and
                // let the worker stitch shard responses into one NDJSON stream
                // — each shard's JSON envelope is small (bounded by
                // `batchSize` × tables) and the worker pipes them serially.
                const rows = await this.runShardExport({ batchSize: parsed.batchSize, tables: parsed.tables });

                return jsonResponse({ result: { rows } }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.importShard) {
                const parsed = parseImportShardArgs(args);
                const result = await this.runShardImport({ rows: parsed.rows, startLine: parsed.startLine });

                // The import inserts rows through the writer, which records
                // touched tables; flush so live subscribers re-run.
                await this.flushChangedTables();

                return jsonResponse({ result }, 200);
            }

            return jsonResponse({ error: { code: "UNKNOWN_ADMIN_OP", message: `unknown admin op: ${functionPath}` } }, 404);
        } catch (error: unknown) {
            return this.errorToResponse(error);
        }
    }

    /**
     * Run a data migration by id against this shard, returning the runner's
     * result. The base class can't reach the project's generated
     * `CIRRUS_MIGRATIONS` registry or build a schema-aware writer, so it reports
     * the migration as unknown; the codegen-generated subclass overrides this to
     * look the migration up and invoke `runDataMigration`.
     */
    protected runShardDataMigration(args: RunShardMigrationArgs): Promise<MigrationRunResult> {
        return Promise.reject(
            Object.assign(new Error(`data migration "${args.id}" is not registered`), { name: "CirrusError", code: "MIGRATION_NOT_FOUND", status: 404 }),
        );
    }

    /**
     * Export every row this shard owns across the requested tables (or every
     * shard-local user table when none are specified) as `{table, doc}` records.
     * Globals are not the DO's concern; the worker reads those from D1.
     *
     * The base class can't build a schema-aware writer without seeing the user's
     * `schema.ts`, so it returns an empty list; the codegen-generated subclass
     * overrides this with `exportShardRows(...)` against the live writer.
     */
    protected runShardExport(args: RunShardExportArgs): Promise<ExportRow[]> {
        void args;

        return Promise.resolve([]);
    }

    /**
     * Re-insert a batch of `{table, doc}` rows on this shard, returning the
     * per-table insert counts and a per-row error array. Schema-failed rows do
     * not abort the batch — they're surfaced in `errors` and the rest land.
     *
     * The base class can't build a writer; the codegen subclass overrides this
     * to call `importShardRows(...)` inside one transaction per batch.
     */
    protected runShardImport(args: RunShardImportArgs): Promise<ImportShardResult> {
        void args;

        return Promise.resolve({ conflicts: 0, errors: [], inserted: {} });
    }

    /**
     * Constant-time bearer check against `env.CIRRUS_ADMIN_TOKEN`. Returns
     * `false` (closed) when the token is unset so admin introspection is
     * opt-in rather than exposed by default.
     */
    private isAdminAuthorized(request: Request): boolean {
        const env = (this.env ?? {}) as { CIRRUS_ADMIN_TOKEN?: string };
        const token = env.CIRRUS_ADMIN_TOKEN;

        if (!token || token.length === 0) {
            return false;
        }

        const supplied = extractBearerToken(request.headers.get("authorization"));

        return supplied !== undefined && constantTimeEqual(supplied, token);
    }

    /**
     * Hibernation API: invoked by the runtime when a message arrives on a
     * hibernated socket. Subclasses can override this to intercept; the
     * default decodes a {@link SubscriptionEnvelope} and updates the registry.
     */
    public async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        let envelope: SubscriptionEnvelope;

        try {
            envelope = JSON.parse(text) as SubscriptionEnvelope;
        } catch {
            ws.send(JSON.stringify({ type: "error", message: "invalid envelope" }));

            return;
        }

        if (envelope.type === "subscribe" && envelope.query) {
            this.subscribe(ws, envelope.id, envelope.query);
            ws.send(JSON.stringify({ type: "ack", id: envelope.id }));

            // Seed the subscriber with the query's current result so the first
            // value arrives over the same channel as later updates. When the
            // subclass doesn't support re-execution (base default), this is a
            // no-op and the subscriber relies on its initial HTTP query.
            const { functionPath } = envelope.query;

            if (functionPath) {
                const outcome = await this.executeSubscription(functionPath, envelope.query.args ?? {});

                if (outcome) {
                    this.pushSubscriptionData(ws, envelope.id, outcome);
                }
            }

            return;
        }

        if (envelope.type === "unsubscribe") {
            this.unsubscribe(ws, envelope.id);
            ws.send(JSON.stringify({ type: "ack", id: envelope.id }));
        }
    }

    /**
     * Hibernation API: invoked on socket close. The runtime has already
     * closed the socket by the time we're called — calling `ws.close()`
     * again would throw "WebSocket has been closed" in the Workers runtime.
     */
    public async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        // Clear the attachment so a future reconnection starts clean.
        (ws as HibernatableWebSocket).serializeAttachment?.(undefined);

        void code;
        void reason;
        void wasClean;
    }

    /** Hibernation API: invoked on socket error. */
    public webSocketError(ws: WebSocket, error: unknown): void {
        // Subclasses can override with proper logging. Avoid throwing.
        void ws;
        void error;
    }

    /** Subclasses implement function dispatch. */
    public abstract handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown>;

    /**
     * Register a subscription on the given socket. Stored via
     * `ws.serializeAttachment` so it survives hibernation.
     */
    protected subscribe(ws: WebSocket, subId: string, query: SubscriptionQuery): void {
        const attachment = this.readAttachment(ws);

        attachment.subs[subId] = query;
        (ws as HibernatableWebSocket).serializeAttachment?.(attachment);
    }

    protected unsubscribe(ws: WebSocket, subId: string): void {
        const attachment = this.readAttachment(ws);

        delete attachment.subs[subId];
        (ws as HibernatableWebSocket).serializeAttachment?.(attachment);
        this.subMemos.get(ws)?.delete(subId);
    }

    /**
     * Decide whether a single subscription is interested in a mutation
     * delta. The default implementation checks the table name, then runs a
     * shallow-equality predicate over `query.args` against `delta.row`. A
     * subscription with no `args` matches every row in the table.
     *
     * Subclasses can override this to implement range queries, joins, or
     * full-text matching — anything more elaborate than equality. When
     * `delta.row` is undefined (delete events without row data) we fall back
     * to a broadcast so subscribers know to refetch; trying to filter
     * against missing data would silently drop legitimate notifications.
     */
    protected matchesSubscription(query: SubscriptionQuery, delta: MutationDelta): boolean {
        if (query.table !== delta.table) {
            return false;
        }

        const { args } = query;

        if (!args) {
            return true;
        }

        const { row } = delta;

        if (!row) {
            return true;
        }

        for (const [key, expected] of Object.entries(args)) {
            if (row[key] !== expected) {
                return false;
            }
        }

        return true;
    }

    /**
     * Broadcast a mutation delta to every subscriber whose registered query
     * targets the affected table _and_ matches its args. The wire payload
     * includes the per-socket subscription id, so we serialise once per
     * `(socket, sub)` pair — but the structural delta body itself is
     * identical, so we build a payload keyed by `subId` lazily.
     */
    protected broadcastDelta(delta: MutationDelta): void {
        const sockets = this.state.getWebSockets();
        // Pre-stringify the immutable portion. The only per-message variation
        // is `id`, which we splice in below — cheaper than calling
        // JSON.stringify(...) for every (socket, sub) pair.
        const deltaJson = JSON.stringify(delta);

        for (const ws of sockets) {
            const attachment = this.readAttachment(ws);

            for (const [subId, query] of Object.entries(attachment.subs)) {
                if (!this.matchesSubscription(query, delta)) {
                    continue;
                }

                try {
                    ws.send(`{"type":"delta","id":${JSON.stringify(subId)},"delta":${deltaJson}}`);
                } catch {
                    /* socket may have been closed mid-broadcast */
                }
            }
        }
    }

    /**
     * Re-run a subscription's query and return its current result alongside
     * the set of tables it read. The base class can't dispatch user functions,
     * so it returns `null` — the codegen-generated subclass overrides this to
     * run the handler from the project's function registry. Returning `null`
     * disables server re-execution and leaves the legacy {@link broadcastDelta}
     * path as the only live-update mechanism.
     */
    protected executeSubscription(functionPath: string, args: Record<string, unknown>): Promise<SubscriptionOutcome | null> {
        void functionPath;
        void args;

        return Promise.resolve(null);
    }

    /**
     * Wrap a query handler in the reactive cache. The subclass passes the
     * function path, parsed args, and a `run` callback that resolves to the
     * handler's return value. When the cache is configured we key by
     * `(functionPath, stable-stringified args)`, allocate a fresh dep
     * tracker, store it on `this.currentTracker` so `getCtxDbReadHook` reads
     * stamp into it, and restore the prior tracker in `finally`. When the
     * cache is absent we just call `run()` — same shape, zero overhead.
     *
     * Subclasses should ALSO pass `getCtxDbReadHook()` as the `onRead`
     * option on their `createShardCtxDb(...)` call so the tracker actually
     * collects deps. Without that wiring the cache will memoize results
     * with empty dep sets, so writes never invalidate them and stale
     * results stick around — the {@link ReactiveCache} class is contract-
     * neutral about who fills `deps`.
     */
    protected async runCachedQuery<R>(functionPath: string, args: Record<string, unknown>, run: () => Promise<R>): Promise<R> {
        if (!this.reactiveCache) {
            return run();
        }

        // Snapshot the in-flight tracker BEFORE allocating a fresh one, so
        // the `finally` restores it correctly. The previous implementation
        // allocated inside `reactiveCache.run(...)` before capturing
        // `previous` in a separate `withTracker` helper, so `previous`
        // captured the just-allocated tracker and the leftover never got
        // cleared — a stray read between requests would land in the wrong
        // dep set and corrupt the next cache miss.
        const previous = this.currentTracker;
        const tracker = createDependencyTracker();

        this.currentTracker = tracker;

        try {
            return await this.reactiveCache.run(reactiveCacheKey(functionPath, args), tracker.collect(), run);
        } finally {
            this.currentTracker = previous;
        }
    }

    /**
     * Returns an `onRead` callback suitable to hand to `createShardCtxDb`'s
     * `onRead` option. The returned function stamps the in-flight tracker (set
     * by {@link runCachedQuery}) when one exists and is a no-op otherwise — so
     * subclasses can wire this hook unconditionally without checking whether
     * the cache is enabled.
     */
    protected getCtxDbReadHook(): (table: string, idOrScan?: string) => void {
        return (table, idOrScan) => {
            this.currentTracker?.recordRead(table, idOrScan ?? "*scan");
        };
    }

    /**
     * Record that `table` was written during the current RPC. Wired into the
     * db adapter's `broadcast` callback by the generated subclass so that
     * {@link flushChangedTables} can re-run only the affected subscriptions.
     */
    protected recordChangedTable(table: string): void {
        this.pendingChangedTables ??= new Set<string>();
        this.pendingChangedTables.add(table);
    }

    /**
     * Drain the tables written during the in-flight RPC and re-run every
     * subscription that depends on one of them. Called after `handleRpc`
     * resolves. No-op when nothing was written.
     */
    private async flushChangedTables(): Promise<void> {
        const changed = this.pendingChangedTables;

        this.pendingChangedTables = null;

        if (!changed || changed.size === 0) {
            return;
        }

        // Subscriptions are established over the WS handshake, which doesn't
        // resolve identity — they're anonymous. Re-running their queries with
        // the *mutating* request's identity would leak that user's view to
        // every subscriber, so we drop the request identity before re-running.
        this.currentRequestUserId = undefined;
        this.currentRequestIdentity = undefined;

        await this.refreshSubscriptions(changed);
    }

    /**
     * For every live subscription whose query reads one of `changed`, re-run
     * the query and push a fresh `{ type: "data" }` frame when the result
     * differs from the last one sent. Subscriptions with no `functionPath`
     * (legacy delta-only) are left to {@link broadcastDelta}.
     */
    private async refreshSubscriptions(changed: Set<string>): Promise<void> {
        for (const ws of this.state.getWebSockets()) {
            const attachment = this.readAttachment(ws);

            for (const [subId, query] of Object.entries(attachment.subs)) {
                const { functionPath } = query;

                if (!functionPath) {
                    continue;
                }

                const memo = this.subMemos.get(ws)?.get(subId);

                // Skip when we already know this subscription's tables and none
                // of them changed. A missing memo means "unknown deps" — re-run
                // to be safe.
                if (memo && !setsIntersect(memo.tables, changed)) {
                    continue;
                }

                const outcome = await this.executeSubscription(functionPath, query.args ?? {});

                if (!outcome) {
                    continue;
                }

                this.pushSubscriptionData(ws, subId, outcome);
            }
        }
    }

    /**
     * Memoise `outcome` for `(ws, subId)` and push it to the socket, unless an
     * identical result was already sent. Always refreshes the memo's table set
     * so dependency tracking stays current even when the value is unchanged.
     */
    private pushSubscriptionData(ws: WebSocket, subId: string, outcome: SubscriptionOutcome): void {
        let memos = this.subMemos.get(ws);

        if (!memos) {
            memos = new Map<string, SubscriptionMemo>();
            this.subMemos.set(ws, memos);
        }

        const json = JSON.stringify(outcome.result ?? null);
        const existing = memos.get(subId);

        if (existing?.lastJson === json) {
            existing.tables = outcome.tables;

            return;
        }

        memos.set(subId, { lastJson: json, tables: outcome.tables });

        try {
            ws.send(`{"type":"data","id":${JSON.stringify(subId)},"data":${json}}`);
        } catch {
            /* socket may have been closed between checks */
        }
    }

    /**
     * Gate the upgrade request against two complementary controls:
     *
     *   1. Origin allowlist via `env.CIRRUS_ALLOWED_ORIGINS` (comma-separated).
     *      When unset, any origin is accepted — convenient for local dev,
     *      not suitable for production.
     *   2. Bearer token via `env.CIRRUS_WS_BEARER`. When set, the upgrade
     *      must present a matching token. We accept either an
     *      `Authorization: Bearer <token>` header (preferred) or a
     *      `?token=<token>` query parameter (the only escape hatch for
     *      browsers, which can't customise headers on the WebSocket
     *      constructor). The match runs in constant time to avoid leaking
     *      the token via response-timing differences.
     *
     * The `?token=` path is a real risk surface: the token ends up in
     * server logs, browser history, and `Referer` headers on any
     * subresource the upgrade page loads after the handshake. Use a
     * short-lived rotating token in production rather than a long-lived
     * secret.
     */
    private isUpgradeAllowed(request: Request): boolean {
        const env = (this.env ?? {}) as { CIRRUS_ALLOWED_ORIGINS?: string; CIRRUS_WS_BEARER?: string };
        const allowedOrigins = env.CIRRUS_ALLOWED_ORIGINS;

        if (allowedOrigins && allowedOrigins.trim() !== "") {
            const origin = request.headers.get("origin");

            if (!origin) {
                return false;
            }

            const list = allowedOrigins
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);

            if (!list.includes(origin)) {
                return false;
            }
        }

        const expectedBearer = env.CIRRUS_WS_BEARER;

        if (expectedBearer && expectedBearer.length > 0) {
            const url = new URL(request.url);
            const supplied = extractBearerToken(request.headers.get("authorization")) ?? url.searchParams.get("token");

            if (!supplied || !constantTimeEqual(supplied, expectedBearer)) {
                return false;
            }
        }

        return true;
    }

    private handleWebSocketUpgrade(request: Request): Response {
        if (!this.isUpgradeAllowed(request)) {
            return new Response("Forbidden", { status: 403 });
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        this.state.acceptWebSocket(server);
        (server as HibernatableWebSocket).serializeAttachment?.({ subs: {} } satisfies SocketAttachment);

        return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
    }

    private readAttachment(ws: WebSocket): SocketAttachment {
        const raw = (ws as HibernatableWebSocket).deserializeAttachment?.();

        if (raw && typeof raw === "object" && "subs" in raw && (raw as SocketAttachment).subs) {
            return raw as SocketAttachment;
        }

        return { subs: {} };
    }
}

/** True when `a` and `b` share at least one element. */
const setsIntersect = (a: Set<string>, b: Set<string>): boolean => {
    // Iterate the smaller set for fewer lookups.
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];

    for (const value of small) {
        if (large.has(value)) {
            return true;
        }
    }

    return false;
};

/**
 * Coerce the loosely-typed `runMigration` admin args into a typed shape.
 * `id` is required; `direction` defaults to `"up"` and only flips to `"down"`
 * on an exact match; numeric limits pass through when present.
 */
const parseRunMigrationArgs = (args: Record<string, unknown>): RunShardMigrationArgs => {
    const id = typeof args["id"] === "string" ? args["id"] : "";

    if (id.trim() === "") {
        throw Object.assign(new Error("runMigration: `id` is required"), { name: "CirrusError", code: "MIGRATION_ID_REQUIRED", status: 400 });
    }

    return {
        batchSize: typeof args["batchSize"] === "number" ? args["batchSize"] : undefined,
        direction: args["direction"] === "down" ? "down" : "up",
        dryRun: args["dryRun"] === true,
        id,
        maxBatches: typeof args["maxBatches"] === "number" ? args["maxBatches"] : undefined,
    };
};

const jsonResponse = (body: unknown, status = 200, bookmark?: string): Response => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (bookmark) {
        headers["x-d1-bookmark"] = bookmark;
    }

    return Response.json(body, { status, headers });
};

/**
 * Decode the JSON envelope shipped on the `x-cirrus-identity` header.
 * Malformed payloads collapse to `undefined` rather than throwing — the
 * shard should still serve requests whose identity claims didn't round-trip.
 */
const parseIdentityHeader = (raw: string | null): Record<string, unknown> | undefined => {
    if (!raw) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(raw) as unknown;

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // fall through to undefined
    }

    return undefined;
};

const extractBearerToken = (authorization: string | null): string | undefined => {
    if (!authorization) {
        return undefined;
    }

    const [scheme, ...rest] = authorization.split(" ");

    if (scheme?.toLowerCase() !== "bearer") {
        return undefined;
    }

    const value = rest.join(" ").trim();

    return value.length > 0 ? value : undefined;
};

/**
 * Constant-time string equality. Compares full length (capped at the longer
 * input) so a shorter candidate can't short-circuit the loop. The
 * `lengthDiff` term folds a length mismatch into the result so unequal-length
 * strings still take the same number of XOR ops as equal-length ones.
 */
const constantTimeEqual = (a: string, b: string): boolean => {
    const max = Math.max(a.length, b.length);
    let diff = a.length ^ b.length;

    for (let index = 0; index < max; index += 1) {
        // charCodeAt returns NaN past the end of the string; coerce to 0
        // so the XOR still folds into `diff` without poisoning it.
        const ca = index < a.length ? a.charCodeAt(index) : 0;
        const cb = index < b.length ? b.charCodeAt(index) : 0;

        diff |= ca ^ cb;
    }

    return diff === 0;
};
