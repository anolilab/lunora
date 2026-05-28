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

    private readonly reconnect: ReconnectCalculator;

    private readonly offlineQueue: OfflineQueue;

    private readonly subscriptions = new SubscriptionRegistry();

    private socket: WebSocket | null = null;

    private wsState: WSState = "idle";

    private authToken: string | null = null;

    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    private closed = false;

    private nextSubId = 0;

    /**
     * Unsubscribe ids that couldn't be sent over the current (closed/closing)
     * socket. Flushed once the socket re-opens, so the server doesn't keep
     * shipping deltas for callbacks the consumer has already discarded.
     */
    private pendingUnsubscribes: string[] = [];

    /**
     * Set the first time a WS connection has opened. Mutations are only
     * queued (rather than sent over HTTP) once we have evidence the client
     * is expected to be online via WS — otherwise mutations would hang the
     * first time they were called in an environment without subscriptions.
     */
    private wasEverConnected = false;

    public constructor(opts: CirrusClientOptions) {
        this.url = opts.url;
        this.wsUrl = opts.wsUrl ?? joinUrl(deriveWsUrl(opts.url), WS_PATH);
        this.fetchImpl = opts.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : (undefined as unknown as typeof fetch));
        this.WebSocketImpl = opts.WebSocket ?? (typeof WebSocket === "function" ? WebSocket : undefined);
        this.bookmark = opts.bookmarkStorage ?? createInMemoryBookmarkStorage();
        this.reconnect = createReconnect(opts.reconnect);
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
        // the resubscribe.
        const midReconnect = this.wsState === "connecting" && this.wasEverConnected;

        if ((this.wsState !== "open" && this.socket === null && this.shouldQueueOffline()) || midReconnect) {
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

        this.ensureSocket();
        this.sendSubscribeIfOpen(state);

        return () => {
            if (!state) {
                return;
            }

            state.callbacks.delete(cb);

            if (state.callbacks.size === 0) {
                const ok = this.send({ type: "unsubscribe", id: state.id });

                if (!ok) {
                    this.pendingUnsubscribes.push(state.id);
                }

                this.subscriptions.remove(state);
            }
        };
    }

    public close(): void {
        this.closed = true;

        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.socket) {
            try {
                this.socket.close();
            } catch {
                /* ignore */
            }

            this.socket = null;
        }

        this.wsState = "closed";
        this.offlineQueue.clear();
    }

    // --- Internals ----------------------------------------------------------

    private shouldQueueOffline(): boolean {
        // Only queue when we've previously been connected — i.e. the WS dropped.
        // Before the first connection, mutations should travel over HTTP so they
        // don't deadlock when no consumer has triggered a subscription yet.
        return this.WebSocketImpl !== undefined && this.wasEverConnected;
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

    private ensureSocket(): void {
        if (this.closed || this.wsState === "open" || this.wsState === "connecting" || this.WebSocketImpl === undefined) {
            return;
        }

        this.wsState = "connecting";

        const socket = new this.WebSocketImpl(this.wsUrl);

        this.socket = socket;

        socket.onopen = (): void => {
            this.wsState = "open";
            this.wasEverConnected = true;
            this.reconnect.reset();

            // Resubscribe everyone.
            this.subscriptions.markAllPendingAck();

            for (const state of this.subscriptions.all()) {
                this.sendSubscribeIfOpen(state);
            }

            // Flush any unsubscribes that piled up while the socket was down.
            if (this.pendingUnsubscribes.length > 0) {
                const pending = this.pendingUnsubscribes;

                this.pendingUnsubscribes = [];

                for (const id of pending) {
                    this.send({ type: "unsubscribe", id });
                }
            }

            this.flushOfflineQueue();
        };

        socket.onmessage = (event: MessageEvent): void => {
            this.handleServerMessage(event.data);
        };

        socket.onclose = (): void => {
            this.handleDisconnect();
        };

        socket.onerror = (): void => {
            // The runtime will follow up with onclose; just leave a breadcrumb.
        };
    }

    private handleDisconnect(): void {
        if (this.closed) {
            return;
        }

        this.socket = null;
        this.wsState = "idle";
        this.subscriptions.markAllPendingAck();

        if (this.WebSocketImpl === undefined) {
            return;
        }

        const delay = this.reconnect.next();

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.ensureSocket();
        }, delay);
    }

    private sendSubscribeIfOpen(state: SubscriptionState): void {
        if (this.wsState !== "open" || state.acked) {
            return;
        }

        // Extract `table` if codegen surfaced it on the ref. Until codegen
        // attaches table metadata we fall back to the function path itself.
        const table = (state.fn as FunctionReference & { __cirrusTable?: string }).__cirrusTable ?? state.fn.__cirrusRef;

        this.send({
            type: "subscribe",
            id: state.id,
            query: { table, args: state.args },
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
     * Best-effort send over the WS. Returns `true` when the message was
     * handed to the socket, `false` when the caller should queue it for the
     * next reconnect.
     */
    private send(message: ClientMessage): boolean {
        if (!this.socket || this.wsState !== "open") {
            return false;
        }

        try {
            this.socket.send(JSON.stringify(message));

            return true;
        } catch {
            /* socket may have closed between checks; reconnect will handle it */
            return false;
        }
    }

    private flushOfflineQueue(): void {
        const drained = this.offlineQueue.drain();

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
