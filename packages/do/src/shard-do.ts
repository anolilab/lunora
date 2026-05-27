import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { drizzle as drizzleDO, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

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

    constructor(state: ShardDOState, env: unknown) {
        this.state = state;
        this.env = env;
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

            // Stash the inbound D1 bookmark and identity headers for the
            // duration of the handler call so getters return the right
            // values. Cleared on exit so the next request starts fresh.
            this.currentRequestBookmark = request.headers.get("x-d1-bookmark") ?? undefined;
            this.currentResponseBookmark = undefined;
            this.currentRequestUserId = request.headers.get("x-cirrus-userid") ?? undefined;
            this.currentRequestIdentity = parseIdentityHeader(request.headers.get("x-cirrus-identity"));

            try {
                const result = await this.handleRpc(payload.functionPath, payload.args ?? {});

                // Inspect the post-write size before responding. SQLite-in-DO
                // exposes `databaseSize` as a real getter; reading it is a
                // cheap stat call, not a full table scan.
                this.maybeWarnRootSize();

                return jsonResponse({ result }, 200, this.currentResponseBookmark);
            } catch (error: unknown) {
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
            `[@cirrus/do] __root__ Durable Object SQLite size is ${size} bytes (>= 1 GiB, 10% of the 10 GiB per-DO ceiling). `
            + "Plan a `.shardBy()` migration before you hit the wall. See https://cirrus.dev/docs/concepts/sharding for guidance.",
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

    if (!scheme || scheme.toLowerCase() !== "bearer") {
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
