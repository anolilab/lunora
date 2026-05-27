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
    storage: {
        sql: {
            /**
             * Current size of the SQLite database in bytes. Backed by a real
             * getter on the runtime — read on every access.
             */
            readonly databaseSize?: number;
            [key: string]: unknown;
        };
    };
    acceptWebSocket: (ws: WebSocket, tags?: string[]) => void;
    getWebSockets: (tag?: string) => WebSocket[];
    /** Optional pointer to the DO instance id so we can detect `__root__`. */
    id?: { name?: string };
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
    serializeAttachment?: (value: unknown) => void;
    deserializeAttachment?: () => unknown;
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

    constructor(state: ShardDOState, env: unknown) {
        this.state = state;
        this.env = env;
    }

    /** SQLite handle scoped to this Durable Object. */
    protected get sql(): unknown {
        return this.state.storage.sql;
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

            try {
                const result = await this.handleRpc(payload.functionPath, payload.args ?? {});

                // Inspect the post-write size before responding. SQLite-in-DO
                // exposes `databaseSize` as a real getter; reading it is a
                // cheap stat call, not a full table scan.
                this.maybeWarnRootSize();

                return jsonResponse({ result });
            } catch (error: unknown) {
                return this.errorToResponse(error);
            }
        }

        return new Response("Not found", { status: 404 });
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
            `[@cirrus/do] __root__ Durable Object SQLite size is ${size} bytes (>= 1 GiB, 10% of the 10 GiB per-DO ceiling). ` +
                "Plan a `.shardBy()` migration before you hit the wall. See https://cirrus.dev/docs/concepts/sharding for guidance.",
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

            return;
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
     * Broadcast a mutation delta to every subscriber whose registered query
     * targets the affected table. The wire payload includes the per-socket
     * subscription id, so we serialise once per `(socket, sub)` pair — but
     * the structural delta body itself is identical, so we build a payload
     * keyed by `subId` lazily.
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
                if (query.table !== delta.table) {
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

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
