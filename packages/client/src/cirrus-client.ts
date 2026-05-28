import { createInMemoryBookmarkStorage } from "./bookmark.js";
import { OfflineQueue } from "./offline-queue.js";
import { createReconnect, type ReconnectCalculator } from "./reconnect.js";
import { type SubscriptionCallback, SubscriptionRegistry, type SubscriptionState } from "./subscription.js";
import type {
    ArgsOf,
    BookmarkStorage,
    CirrusClientOptions,
    ClientMessage,
    FunctionReference,
    ReconnectOptions,
    ReturnOf,
    RpcResponseBody,
    ServerMessage,
    Unsubscribe,
} from "./types.js";

const RPC_PATH = "/_cirrus/rpc";
const WS_PATH = "/_cirrus/ws";

type WSState = "idle" | "connecting" | "open" | "closed";

interface MutationCallOptions<TCurrent, TValue> {
    optimistic?: (current: TCurrent | undefined) => TValue;
    shardKey?: string;
}

/**
 * One WebSocket per shard key. Subscriptions and the writes they observe must
 * land on the same Durable Object, so each distinct `shardKey` gets its own
 * socket connected to `?shard=<key>` (the default shard uses no query param).
 * Reconnect backoff, offline-flush state, and the pending-unsubscribe buffer
 * are all per-connection so one shard dropping doesn't disturb the others.
 */
interface ShardConnection {
    pendingUnsubscribes: string[];
    reconnect: ReconnectCalculator;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    /** `undefined` for the default shard (connects without a `shard` param). */
    readonly shardKey: string | undefined;
    socket: WebSocket | null;
    wasEverConnected: boolean;
    wsState: WSState;
}

const deriveWsUrl = (url: string): string => {
    if (url.startsWith("https://")) {
        return `wss://${url.slice("https://".length)}`;
    }

    if (url.startsWith("http://")) {
        return `ws://${url.slice("http://".length)}`;
    }

    return url;
};

const joinUrl = (base: string, path: string): string => {
    const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;

    return `${trimmed}${path}`;
};

/**
 * Cirrus browser/edge client. Talks RPC over HTTP and real-time deltas over
 * a single multiplexed WebSocket.
 *
 * Reconnect, offline queueing, and optimistic updates are all handled here;
 * see the package README for the wire protocol.
 */
export class CirrusClient {
    public readonly url: string;

    public readonly wsUrl: string;

    private readonly fetchImpl: typeof fetch;

    private readonly WebSocketImpl: typeof WebSocket | undefined;

    private readonly bookmark: BookmarkStorage;

    private readonly reconnectOptions: ReconnectOptions | undefined;

    private readonly offlineQueue: OfflineQueue;

    private readonly subscriptions = new SubscriptionRegistry();

    /** One {@link ShardConnection} per shard key (keyed by `shardKey ?? ""`). */
    private readonly connections = new Map<string, ShardConnection>();

    private authToken: string | null = null;

    private closed = false;

    private nextSubId = 0;

    public constructor(opts: CirrusClientOptions) {
        this.url = opts.url;
        this.wsUrl = opts.wsUrl ?? joinUrl(deriveWsUrl(opts.url), WS_PATH);
        this.fetchImpl = opts.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : (undefined as unknown as typeof fetch));
        this.WebSocketImpl = opts.WebSocket ?? (typeof WebSocket === "function" ? WebSocket : undefined);
        this.bookmark = opts.bookmarkStorage ?? createInMemoryBookmarkStorage();
        this.reconnectOptions = opts.reconnect;
        this.offlineQueue = new OfflineQueue(opts.offlineQueue);
    }

    // --- Auth helpers -------------------------------------------------------

    public setAuthToken(token: string | null): void {
        this.authToken = token;
    }

    public getAuthToken(): string | null {
        return this.authToken;
    }

    // --- RPC ---------------------------------------------------------------

    public async query<F extends FunctionReference>(fn: F, args: ArgsOf<F>, opts: { shardKey?: string } = {}): Promise<ReturnOf<F>> {
        return (await this.rpc(fn.__cirrusRef, args as Record<string, unknown>, opts.shardKey, { attachBookmark: true })) as ReturnOf<F>;
    }

    public async mutation<F extends FunctionReference>(fn: F, args: ArgsOf<F>, opts: MutationCallOptions<unknown, ReturnOf<F>> = {}): Promise<ReturnOf<F>> {
        const argsRecord = args as Record<string, unknown>;

        // Apply optimistic updates to any subscriber listening on this fn.
        const optimisticRollbacks: Array<() => void> = [];

        if (opts.optimistic) {
            for (const state of this.subscriptions.all()) {
                if (state.fn.__cirrusRef !== fn.__cirrusRef) {
                    continue;
                }

                const previous = state.lastValue;
                const versionAtApply = state.serverVersion;
                let next: unknown;

                try {
                    next = opts.optimistic(previous);
                } catch {
                    continue;
                }

                state.lastValue = next;

                for (const callback of state.callbacks) {
                    callback(next);
                }

                optimisticRollbacks.push(() => {
                    // If a server-pushed delta has bumped serverVersion since
                    // we applied the optimistic update, the server has given
                    // us newer-than-`previous` data — don't roll back, the
                    // current value is closer to truth.
                    if (state.serverVersion > versionAtApply) {
                        return;
                    }

                    state.lastValue = previous;

                    for (const callback of state.callbacks) {
                        callback(previous);
                    }
                });
            }
        }

        // Queue while offline (only mutations — queries fail fast). We also
        // queue when we're mid-reconnect (wsState === "connecting") provided
        // we've been connected before — otherwise the mutation would race
        // the resubscribe. State is scoped to the mutation's own shard so a
        // dropped shard only queues writes destined for it.
        const conn = this.getConnection(opts.shardKey);
        const wsState: WSState = conn?.wsState ?? "idle";
        const hasSocket = conn?.socket != null;
        const wasEverConnected = conn?.wasEverConnected ?? false;
        const shouldQueueOffline = this.WebSocketImpl !== undefined && wasEverConnected;
        const midReconnect = wsState === "connecting" && wasEverConnected;

        if ((wsState !== "open" && !hasSocket && shouldQueueOffline) || midReconnect) {
            return new Promise<ReturnOf<F>>((resolve, reject) => {
                this.offlineQueue.enqueue<ReturnOf<F>>({
                    functionPath: fn.__cirrusRef,
                    args: argsRecord,
                    shardKey: opts.shardKey,
                    resolve,
                    reject: (error) => {
                        for (const rollback of optimisticRollbacks) {
                            rollback();
                        }

                        reject(error);
                    },
                });
            });
        }

        try {
            return (await this.rpc(fn.__cirrusRef, argsRecord, opts.shardKey, { captureBookmark: true })) as ReturnOf<F>;
        } catch (error) {
            for (const rollback of optimisticRollbacks) {
                rollback();
            }

            throw error;
        }
    }

    public async action<F extends FunctionReference>(fn: F, args: ArgsOf<F>, opts: { shardKey?: string } = {}): Promise<ReturnOf<F>> {
        return (await this.rpc(fn.__cirrusRef, args as Record<string, unknown>, opts.shardKey)) as ReturnOf<F>;
    }

    // --- Subscriptions ------------------------------------------------------

    public subscribe<F extends FunctionReference>(
        fn: F,
        args: ArgsOf<F>,
        callback: (data: ReturnOf<F>) => void,
        opts: { shardKey?: string } = {},
    ): Unsubscribe {
        const argsRecord = (args ?? {}) as Record<string, unknown>;
        const key = this.subscriptions.key(fn.__cirrusRef, argsRecord, opts.shardKey);

        let state = this.subscriptions.get(key);
        const cb = callback as SubscriptionCallback;

        if (!state) {
            this.nextSubId += 1;
            const id = `sub_${this.nextSubId}`;

            state = {
                id,
                fn,
                args: argsRecord,
                shardKey: opts.shardKey,
                callbacks: new Set<SubscriptionCallback>(),
                lastValue: undefined,
                acked: false,
                serverVersion: 0,
            };
            this.subscriptions.add(state);
        }

        state.callbacks.add(cb);

        // Replay last value to new subscriber synchronously if available.
        if (state.lastValue !== undefined) {
            try {
                cb(state.lastValue);
            } catch {
                /* user callback threw — ignore */
            }
        }

        this.ensureSocket(opts.shardKey);
        this.sendSubscribeIfOpen(state);

        return () => {
            if (!state) {
                return;
            }

            state.callbacks.delete(cb);

            if (state.callbacks.size === 0) {
                const conn = this.getConnection(state.shardKey);
                const ok = conn ? this.sendOn(conn, { type: "unsubscribe", id: state.id }) : false;

                if (!ok && conn) {
                    conn.pendingUnsubscribes.push(state.id);
                }

                this.subscriptions.remove(state);
            }
        };
    }

    public close(): void {
        this.closed = true;

        for (const conn of this.connections.values()) {
            if (conn.reconnectTimer !== null) {
                clearTimeout(conn.reconnectTimer);
                conn.reconnectTimer = null;
            }

            if (conn.socket) {
                try {
                    conn.socket.close();
                } catch {
                    /* ignore */
                }

                conn.socket = null;
            }

            conn.wsState = "closed";
        }

        this.offlineQueue.clear();
    }

    // --- Internals ----------------------------------------------------------

    private connectionKey(shardKey: string | undefined): string {
        return shardKey ?? "";
    }

    private getConnection(shardKey: string | undefined): ShardConnection | undefined {
        return this.connections.get(this.connectionKey(shardKey));
    }

    private getOrCreateConnection(shardKey: string | undefined): ShardConnection {
        const key = this.connectionKey(shardKey);
        let conn = this.connections.get(key);

        if (!conn) {
            conn = {
                pendingUnsubscribes: [],
                reconnect: createReconnect(this.reconnectOptions),
                reconnectTimer: null,
                shardKey,
                socket: null,
                wasEverConnected: false,
                wsState: "idle",
            };
            this.connections.set(key, conn);
        }

        return conn;
    }

    private wsUrlFor(shardKey: string | undefined): string {
        if (shardKey === undefined) {
            return this.wsUrl;
        }

        const separator = this.wsUrl.includes("?") ? "&" : "?";

        return `${this.wsUrl}${separator}shard=${encodeURIComponent(shardKey)}`;
    }

    private async rpc(
        functionPath: string,
        args: Record<string, unknown>,
        shardKey: string | undefined,
        flags: { attachBookmark?: boolean; captureBookmark?: boolean } = {},
    ): Promise<unknown> {
        if (!this.fetchImpl) {
            throw new Error("CirrusClient: no `fetch` implementation available");
        }

        const headers: Record<string, string> = { "content-type": "application/json" };

        if (this.authToken) {
            headers["authorization"] = `Bearer ${this.authToken}`;
        }

        if (flags.attachBookmark) {
            const bookmark = this.bookmark.get();

            if (bookmark) {
                headers["x-d1-bookmark"] = bookmark;
            }
        }

        const response = await this.fetchImpl(joinUrl(this.url, RPC_PATH), {
            method: "POST",
            headers,
            body: JSON.stringify({ functionPath, args, shardKey }),
        });

        if (flags.captureBookmark) {
            const value = response.headers.get("x-d1-bookmark");

            if (value) {
                this.bookmark.set(value);
            }
        }

        let body: RpcResponseBody;

        try {
            body = (await response.json()) as RpcResponseBody;
        } catch {
            throw new Error(`CirrusClient: response was not JSON (status ${response.status})`);
        }

        if ("error" in body) {
            const error = new Error(body.error.message);

            (error as Error & { code?: string }).code = body.error.code;
            throw error;
        }

        return body.result;
    }

    private ensureSocket(shardKey: string | undefined): void {
        if (this.closed || this.WebSocketImpl === undefined) {
            return;
        }

        const conn = this.getOrCreateConnection(shardKey);

        if (conn.wsState === "open" || conn.wsState === "connecting") {
            return;
        }

        conn.wsState = "connecting";

        const socket = new this.WebSocketImpl(this.wsUrlFor(shardKey));

        conn.socket = socket;

        socket.addEventListener('open', (): void => {
            conn.wsState = "open";
            conn.wasEverConnected = true;
            conn.reconnect.reset();

            // Resubscribe everyone bound to this shard.
            this.markShardPendingAck(shardKey);

            for (const state of this.subscriptions.all()) {
                if (this.connectionKey(state.shardKey) === this.connectionKey(shardKey)) {
                    this.sendSubscribeIfOpen(state);
                }
            }

            // Flush any unsubscribes that piled up while the socket was down.
            if (conn.pendingUnsubscribes.length > 0) {
                const pending = conn.pendingUnsubscribes;

                conn.pendingUnsubscribes = [];

                for (const id of pending) {
                    this.sendOn(conn, { type: "unsubscribe", id });
                }
            }

            this.flushOfflineQueue(shardKey);
        });

        socket.onmessage = (event: MessageEvent): void => {
            this.handleServerMessage(event.data);
        };

        socket.addEventListener('close', (): void => {
            this.handleDisconnect(conn);
        });

        socket.onerror = (): void => {
            // The runtime will follow up with onclose; just leave a breadcrumb.
        };
    }

    private handleDisconnect(conn: ShardConnection): void {
        if (this.closed) {
            return;
        }

        conn.socket = null;
        conn.wsState = "idle";
        this.markShardPendingAck(conn.shardKey);

        if (this.WebSocketImpl === undefined) {
            return;
        }

        const delay = conn.reconnect.next();

        conn.reconnectTimer = setTimeout(() => {
            conn.reconnectTimer = null;
            this.ensureSocket(conn.shardKey);
        }, delay);
    }

    /** Mark every subscription bound to `shardKey` as needing a fresh ack. */
    private markShardPendingAck(shardKey: string | undefined): void {
        const key = this.connectionKey(shardKey);

        for (const state of this.subscriptions.all()) {
            if (this.connectionKey(state.shardKey) === key) {
                state.acked = false;
            }
        }
    }

    private sendSubscribeIfOpen(state: SubscriptionState): void {
        const conn = this.getConnection(state.shardKey);

        if (conn?.wsState !== "open" || state.acked) {
            return;
        }

        // `table` keeps the legacy raw-delta fan-out working; `functionPath`
        // drives server-side re-execution. They're the same ref unless codegen
        // surfaced a distinct `__cirrusTable`.
        const table = (state.fn as FunctionReference & { __cirrusTable?: string }).__cirrusTable ?? state.fn.__cirrusRef;

        this.sendOn(conn, {
            type: "subscribe",
            id: state.id,
            query: { table, functionPath: state.fn.__cirrusRef, args: state.args },
        });
    }

    private handleServerMessage(raw: unknown): void {
        const text = typeof raw === "string" ? raw : raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : null;

        if (text === null) {
            return;
        }

        let message: ServerMessage;

        try {
            message = JSON.parse(text) as ServerMessage;
        } catch {
            return;
        }

        if (message.type === "ack") {
            const state = this.subscriptions.getById(message.id);

            if (state) {
                state.acked = true;
            }

            return;
        }

        if (message.type === "data" || message.type === "delta") {
            const { id } = message;
            const state = id ? this.subscriptions.getById(id) : undefined;

            if (!state) {
                return;
            }

            const payload = "data" in message && message.data !== undefined ? message.data : message.delta;

            state.lastValue = payload;
            state.serverVersion += 1;

            for (const callback of state.callbacks) {
                try {
                    callback(payload);
                } catch {
                    /* user callback threw — ignore */
                }
            }

            return;
        }

        if (message.type === "complete") {
            const state = this.subscriptions.getById(message.id);

            if (state) {
                this.subscriptions.remove(state);
            }
        }
    }

    /**
     * Best-effort send over a shard's WS. Returns `true` when the message was
     * handed to the socket, `false` when the caller should queue it for the
     * next reconnect.
     */
    private sendOn(conn: ShardConnection, message: ClientMessage): boolean {
        if (!conn.socket || conn.wsState !== "open") {
            return false;
        }

        try {
            conn.socket.send(JSON.stringify(message));

            return true;
        } catch {
            /* socket may have closed between checks; reconnect will handle it */
            return false;
        }
    }

    private flushOfflineQueue(shardKey: string | undefined): void {
        const key = this.connectionKey(shardKey);
        const drained = this.offlineQueue.drain((item) => this.connectionKey(item.shardKey) === key);

        for (const item of drained) {
            this.rpc(item.functionPath, item.args, item.shardKey, { captureBookmark: true }).then(
                (value) => {
                    item.resolve(value);
                },
                (error) => {
                    item.reject(error);
                },
            );
        }
    }
}
