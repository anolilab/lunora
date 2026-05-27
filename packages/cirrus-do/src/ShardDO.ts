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

            // Stash the inbound D1 bookmark for the duration of the handler
            // call so `getInboundBookmark()` returns the right value. Clear
            // it on exit so the next request starts fresh.
            this.currentRequestBookmark = request.headers.get("x-d1-bookmark") ?? undefined;
            this.currentResponseBookmark = undefined;

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
     * Validate the upgrade request's `Origin` header against the allowlist
     * declared by `env.CIRRUS_ALLOWED_ORIGINS` (comma-separated). If unset,
     * any origin is allowed — convenient for local dev but obviously not
     * suitable for production traffic.
     *
     * TODO(v0.2): require a signed bearer token alongside origin matching.
     */
    private isOriginAllowed(request: Request): boolean {
        const allowed = (this.env as { CIRRUS_ALLOWED_ORIGINS?: string })?.CIRRUS_ALLOWED_ORIGINS;

        if (!allowed || allowed.trim() === "") {
            return true;
        }

        const origin = request.headers.get("origin");

        if (!origin) {
            return false;
        }

        const list = allowed
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);

        return list.includes(origin);
    }

    private handleWebSocketUpgrade(request: Request): Response {
        if (!this.isOriginAllowed(request)) {
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
