import createInMemoryBookmarkStorage from "./bookmark";
import { applyDelta, isMutationDelta } from "./delta-merge";
import type { OptimisticUpdate } from "./local-store";
import { createLocalStore } from "./local-store";
import type { QueuedMutation } from "./offline-queue";
import { OfflineQueue } from "./offline-queue";
import type { ReconnectCalculator } from "./reconnect";
import { createReconnect } from "./reconnect";
import type { StreamHandle, StreamIterable } from "./stream";
import { createStream } from "./stream";
import type { SubscriptionCallback, SubscriptionErrorCallback, SubscriptionState } from "./subscription";
import { SubscriptionRegistry } from "./subscription";
import type {
    ArgsOf,
    AuthCapabilities,
    AuthImpersonation,
    AuthPage,
    AuthSession,
    AuthUser,
    BookmarkStorage,
    CirrusClientOptions,
    ClientMessage,
    FunctionDescriptor,
    FunctionReference,
    GlobalTableInfo,
    GlobalTablePage,
    PersistenceAdapter,
    ReconnectOptions,
    ReturnOf,
    RpcResponseBody,
    ScheduleRecord,
    SchedulerStatus,
    ServerDataMessage,
    ServerErrorMessage,
    ServerMessage,
    StorageListPage,
    StorageObject,
    Unsubscribe,
    User,
} from "./types";

const RPC_PATH = "/_cirrus/rpc";
const WS_PATH = "/_cirrus/ws";

/**
 * Keepalive frame sent on the heartbeat. MUST match the request payload the
 * server registers via `setWebSocketAutoResponse` (`@cirrus/do`'s ShardDO
 * `WS_KEEPALIVE_PING`): the runtime answers it with `cirrus-pong` WITHOUT
 * waking the Durable Object. The pong is a plain (non-JSON) string and is
 * silently dropped by `handleServerMessage`'s `JSON.parse` guard.
 */
const WS_KEEPALIVE_PING = "cirrus-ping";

/** Default heartbeat cadence (ms) — see {@link CirrusClientOptions.heartbeatIntervalMs}. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Maximum number of stream-start frames queued per connection while the
 * socket is (re)connecting. Past this cap, the oldest queued stream is
 * evicted (its consumer is failed with `STREAM_QUEUE_OVERFLOW`) so a stuck
 * reconnect can never grow the queue unbounded.
 */
const MAX_PENDING_STREAMS = 64;
const SCHEDULED_PATH = "/_cirrus/admin/scheduled";
const SCHEDULED_STATUS_PATH = "/_cirrus/admin/scheduled/status";
const SCHEDULED_WS_PATH = "/_cirrus/admin/scheduled/ws";
const SCHEDULED_CANCEL_PATH = "/_cirrus/admin/scheduled/cancel";
const STORAGE_PATH = "/_cirrus/admin/storage";
const STORAGE_URL_PATH = "/_cirrus/admin/storage/url";
const FUNCTIONS_PATH = "/_cirrus/admin/functions";
const GLOBAL_TABLES_PATH = "/_cirrus/admin/global/tables";
const GLOBAL_TABLE_PATH = "/_cirrus/admin/global/table";
const AUTH_USERS_PATH = "/_cirrus/admin/auth/users";
const AUTH_SESSIONS_PATH = "/_cirrus/admin/auth/sessions";
const AUTH_CREATE_USER_PATH = "/_cirrus/admin/auth/users/create";
const AUTH_SET_ROLE_PATH = "/_cirrus/admin/auth/users/role";
const AUTH_BAN_PATH = "/_cirrus/admin/auth/users/ban";
const AUTH_UNBAN_PATH = "/_cirrus/admin/auth/users/unban";
const AUTH_SET_PASSWORD_PATH = "/_cirrus/admin/auth/users/password";
const AUTH_REMOVE_USER_PATH = "/_cirrus/admin/auth/users/remove";
const AUTH_IMPERSONATE_PATH = "/_cirrus/admin/auth/users/impersonate";
const AUTH_REVOKE_SESSION_PATH = "/_cirrus/admin/auth/sessions/revoke";
const AUTH_REVOKE_SESSIONS_PATH = "/_cirrus/admin/auth/sessions/revoke-all";
const AUTH_CAPABILITIES_PATH = "/_cirrus/admin/auth/capabilities";
const AUTH_UPDATE_USER_PATH = "/_cirrus/admin/auth/users/update";
const AUTH_ACCOUNTS_PATH = "/_cirrus/admin/auth/accounts";
const AUTH_UNLINK_ACCOUNT_PATH = "/_cirrus/admin/auth/accounts/unlink";
const AUTH_PASSKEYS_PATH = "/_cirrus/admin/auth/passkeys";
const AUTH_DELETE_PASSKEY_PATH = "/_cirrus/admin/auth/passkeys/delete";
const AUTH_DISABLE_2FA_PATH = "/_cirrus/admin/auth/two-factor/disable";
const AUTH_ORGS_PATH = "/_cirrus/admin/auth/organizations";
const AUTH_ORG_MEMBERS_PATH = "/_cirrus/admin/auth/organizations/members";
const AUTH_ORG_INVITATIONS_PATH = "/_cirrus/admin/auth/organizations/invitations";
const AUTH_REMOVE_MEMBER_PATH = "/_cirrus/admin/auth/organizations/members/remove";
const AUTH_CANCEL_INVITATION_PATH = "/_cirrus/admin/auth/organizations/invitations/cancel";

/**
 * Default better-auth session endpoint. The worker mounts better-auth at
 * `/api/auth` (see `@cirrus/auth`'s `DEFAULT_AUTH_BASE_PATH`); `get-session`
 * is the better-auth route that returns the current `{ user, session }` (or
 * `null` when signed out). Override the base via `CirrusClientOptions.authBasePath`.
 */
const DEFAULT_AUTH_BASE_PATH = "/api/auth";
const GET_SESSION_PATH = "/get-session";

type WSState = "idle" | "connecting" | "open" | "closed";

/**
 * Aggregate live-socket health across every shard connection, for a UI status
 * indicator. `idle` = no socket opened yet; `connecting` = at least one socket
 * is (re)connecting and none is open; `connected` = at least one socket is open;
 * `offline` = sockets exist but all are down (between reconnect attempts).
 */
type ConnectionStatus = "connected" | "connecting" | "idle" | "offline";

interface MutationCallOptions<TCurrent, TValue, TArgs> {
    optimistic?: (current: TCurrent | undefined) => TValue;

    /**
     * Convex-parity multi-query optimistic update. Receives an
     * `OptimisticLocalStore` over the live subscription cache plus the
     * mutation's args, so one mutation can patch many subscribed queries at
     * once; every write is rolled back atomically if the mutation fails.
     */
    optimisticUpdate?: OptimisticUpdate<TArgs>;
    shardKey?: string;
}

/**
 * Stable JSON stringify: keys are sorted at every object level so two
 * structurally-equal args records always serialise to the same string. Used to
 * match a mutation's `args` against subscription `args` when applying
 * optimistic updates.
 */
const compareEntryKeys = ([a]: [string, unknown], [b]: [string, unknown]): number => {
    if (a < b) {
        return -1;
    }

    return a > b ? 1 : 0;
};

const stableStringify = (value: unknown): string => {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>).toSorted(compareEntryKeys);

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
};

/**
 * One WebSocket per shard key. Subscriptions and the writes they observe must
 * land on the same Durable Object, so each distinct `shardKey` gets its own
 * socket connected to `?shard=&lt;key>` (the default shard uses no query param).
 * Reconnect backoff, offline-flush state, and the pending-unsubscribe buffer
 * are all per-connection so one shard dropping doesn't disturb the others.
 */
interface ShardConnection {
    /** Active keepalive interval while the socket is open; cleared on disconnect/close. */
    heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    /** Stream-start frames buffered while the socket was (re)connecting. Flushed on `open`. */
    pendingStreams?: ClientMessage[];
    pendingUnsubscribes: string[];
    reconnect: ReconnectCalculator;
    reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    /** `undefined` for the default shard (connects without a `shard` param). */
    readonly shardKey: string | undefined;
    socket: undefined | WebSocket;
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

/** A path with the non-empty entries of `params` appended as a query string (omitting `?` when none apply). */
const withQuery = (path: string, params: Record<string, number | string | undefined>): string => {
    const search = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
            search.set(key, String(value));
        }
    }

    const query = search.toString();

    return query === "" ? path : `${path}?${query}`;
};

/** Map a shard key to its connection-map key (the default shard uses `""`). */
const connectionKey = (shardKey: string | undefined): string => shardKey ?? "";

/**
 * Write an already-computed optimistic value `next` onto a single subscription
 * state and return its rollback closure. The shared write+rollback primitive
 * behind both the legacy per-call `optimistic` transform and `createLocalStore`'s
 * `setQuery`: it mutates `state.lastValue` in place (so live subscribers see the
 * value immediately) and binds `state`/`previous`/`version`/`next` into locals so
 * the rollback's version check and restore run synchronously, with no `await`
 * between read and write that could let a server delta sneak in unobserved.
 *
 * The rollback only restores when (a) no server delta has bumped `serverVersion`
 * past the apply point (the server is now closer to truth) and (b) our `next` is
 * still the live value (a later stacked optimistic write hasn't superseded it).
 */
const writeOptimisticToState = (state: SubscriptionState, next: unknown): (() => void) => {
    const previous = state.lastValue;
    const versionAtApply = state.serverVersion;

    // Intentionally mutate the shared subscription state in place so live
    // subscribers observe the optimistic value immediately.
    // eslint-disable-next-line no-param-reassign -- optimistic update mutates the shared subscription state
    state.lastValue = next;

    for (const callback of state.callbacks) {
        try {
            callback(next);
        } catch {
            /* user callback threw — ignore */
        }
    }

    return () => {
        // If a server-pushed delta has bumped serverVersion since we applied
        // the optimistic update, the server has given us newer-than-`previous`
        // data — don't roll back, the current value is closer to truth.
        if (state.serverVersion > versionAtApply) {
            return;
        }

        // If another optimistic write has since stacked on this same
        // subscription (so `lastValue` is no longer the value WE set), restoring
        // our captured `previous` would clobber that newer still-pending value.
        // Only roll back when our value is still the live one.
        if (state.lastValue !== next) {
            return;
        }

        // eslint-disable-next-line no-param-reassign -- rollback restores the shared subscription state
        state.lastValue = previous;

        for (const callback of state.callbacks) {
            try {
                callback(previous);
            } catch {
                /* user callback threw — ignore */
            }
        }
    };
};

/**
 * Apply one optimistic transform to a single subscription state and return its
 * rollback closure (or `undefined` if the optimistic callback threw, in which
 * case the state is left untouched). Computes the next value, then delegates the
 * value-write and rollback to {@link writeOptimisticToState}.
 */
const applyOptimisticToState = (state: SubscriptionState, optimistic: (current: unknown) => unknown): (() => void) | undefined => {
    let next: unknown;

    try {
        next = optimistic(state.lastValue);
    } catch {
        return undefined;
    }

    return writeOptimisticToState(state, next);
};

/**
 * Build a coded `Error` from a stream-scoped server `error` frame. Pulls the
 * `code`/`message` off either the top-level fields or the nested `error`
 * envelope (the server uses both shapes), falling back to "stream error".
 */
const buildStreamError = (message: ServerErrorMessage): Error => {
    const errorEnvelope = message.error as { code?: unknown; message?: unknown } | undefined;
    const code = typeof errorEnvelope?.code === "string" ? errorEnvelope.code : undefined;
    const nestedMessage = typeof errorEnvelope?.message === "string" ? errorEnvelope.message : undefined;
    const messageText = (typeof message.message === "string" ? message.message : undefined) ?? nestedMessage ?? "stream error";

    return Object.assign(new Error(messageText), code === undefined ? undefined : { code });
};

/**
 * Shared one-shot decoder for binary WS frames. `TextDecoder` is stateless for a
 * single `decode()` call, so a module-level singleton avoids allocating a fresh
 * decoder per inbound binary frame.
 */
const sharedDecoder = new TextDecoder();

/** Decode a raw WS frame (string or binary) into text, or `undefined` if unsupported. */
const decodeServerFrame = (raw: unknown): string | undefined => {
    if (typeof raw === "string") {
        return raw;
    }

    if (raw instanceof ArrayBuffer) {
        return sharedDecoder.decode(raw);
    }

    return undefined;
};

/**
 * Best-effort send over a shard's WS. Returns `true` when the message was
 * handed to the socket, `false` when the caller should queue it for the
 * next reconnect.
 */
const sendOn = (conn: ShardConnection, message: ClientMessage): boolean => {
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
};

/**
 * Cirrus browser/edge client. Talks RPC over HTTP and real-time deltas over
 * a single multiplexed WebSocket.
 *
 * Reconnect, offline queueing, and optimistic updates are all handled here;
 * see the package README for the wire protocol.
 */
class CirrusClient {
    public readonly url: string;

    public readonly wsUrl: string;

    private wsToken: string | undefined;

    /** Better-auth base path (trailing slash stripped) for the `get-session` lookup. */
    private readonly authBasePath: string;

    private readonly fetchImpl: typeof fetch | undefined;

    private readonly WebSocketImpl: typeof WebSocket | undefined;

    private readonly bookmark: BookmarkStorage;

    private readonly reconnectOptions: ReconnectOptions | undefined;

    /** Keepalive cadence (ms); `0` disables the heartbeat. See {@link CirrusClientOptions.heartbeatIntervalMs}. */
    private readonly heartbeatIntervalMs: number;

    private readonly offlineQueue: OfflineQueue;

    private readonly persistence: PersistenceAdapter | undefined;

    private readonly subscriptions = new SubscriptionRegistry();

    /** One {@link ShardConnection} per shard key (keyed by `shardKey ?? ""`). */
    private readonly connections = new Map<string, ShardConnection>();

    // `null` is the public sentinel for "signed out" across getAuthToken /
    // setAuthToken / onAuthTokenChange — part of the exported API contract.
    // eslint-disable-next-line unicorn/no-null -- public auth-token contract sentinel
    private authToken: string | null = null;

    /**
     * Identity stamp recorded against each queued offline mutation, keyed by
     * the queue-assigned mutation id. Captured at enqueue from the auth token
     * in effect at the time, and re-checked at flush so a queued write can
     * never replay under a different identity than the one that issued it.
     * See `identityFingerprint` for the fingerprint shape.
     */
    private readonly queuedIdentities = new Map<string, string | null>();

    private closed = false;

    /** Subscribers to auth-token changes (see `onAuthTokenChange`). */
    private readonly authTokenListeners = new Set<(token: string | null) => void>();

    /** Subscribers to aggregate connection-status changes (see `onConnectionStatus`). */
    private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();

    /** Last status broadcast, so we only notify listeners on an actual change. */
    private lastStatus: ConnectionStatus = "idle";

    private nextSubId = 0;

    private nextStreamId = 0;

    /**
     * In-flight client-side stream readers, keyed by the stream id sent on the
     * wire. The handle drives the underlying iterator queue and `shardKey`
     * tells us which socket to push the cancel frame onto when the consumer
     * calls `.cancel()` or the iterator is garbage-collected.
     */
    private readonly streams = new Map<string, { handle: StreamHandle; shardKey: string | undefined }>();

    public constructor(options: CirrusClientOptions) {
        this.url = options.url;
        this.wsUrl = options.wsUrl ?? joinUrl(deriveWsUrl(options.url), WS_PATH);
        this.wsToken = options.wsToken;
        const authBase = options.authBasePath ?? DEFAULT_AUTH_BASE_PATH;

        this.authBasePath = authBase.endsWith("/") ? authBase.slice(0, -1) : authBase;
        this.fetchImpl = options.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
        this.WebSocketImpl = options.WebSocket ?? (typeof WebSocket === "function" ? WebSocket : undefined);
        this.bookmark = options.bookmarkStorage ?? createInMemoryBookmarkStorage();
        this.reconnectOptions = options.reconnect;
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.persistence = options.persistence;
        this.offlineQueue = new OfflineQueue(options.offlineQueue, options.persistence);

        if (this.persistence) {
            // Deferred to a microtask so the constructor itself stays
            // synchronous; hydration then opens sockets for any restored writes
            // so they flush once the WS connects.
            queueMicrotask((): void => {
                this.hydratePersistedQueue().catch(() => undefined);
            });
        }
    }

    // --- Auth helpers -------------------------------------------------------

    /**
     * Set (or clear) the bearer token sent on every HTTP RPC. Notifies any
     * {@link onAuthTokenChange} listeners so React hooks like `useAuth` stay in
     * sync across all mounted instances.
     *
     * Does NOT update the WebSocket auth — the WS token is fixed at upgrade
     * time and lives in the URL. To refresh live WS auth, call
     * {@link setWsToken} explicitly, which closes existing shard sockets to
     * force a reconnect with the new credential.
     */
    public setAuthToken(token: string | null): void {
        if (this.authToken === token) {
            return;
        }

        this.authToken = token;

        // Identity changed — drain and reject any in-memory offline writes
        // queued under the previous identity so they can never replay as the
        // new user. (Flush also re-checks each item's stamp; this is the eager
        // path so a token swap doesn't leave another user's writes lingering.)
        this.rejectQueuedForIdentityChange();

        for (const listener of this.authTokenListeners) {
            try {
                listener(token);
            } catch {
                /* listener threw — ignore */
            }
        }
    }

    public getAuthToken(): string | null {
        return this.authToken;
    }

    /**
     * Subscribe to auth-token changes. Returns an unsubscribe function. The
     * listener is NOT invoked on registration — use {@link getAuthToken} for
     * the current value.
     */
    public onAuthTokenChange(listener: (token: string | null) => void): Unsubscribe {
        this.authTokenListeners.add(listener);

        return () => {
            this.authTokenListeners.delete(listener);
        };
    }

    /**
     * Fetch the currently authenticated user from better-auth's `get-session`
     * endpoint, returning the `user` record or `null` when signed out. Sends
     * the stored bearer token (if any) and `credentials: "include"` so a
     * cookie-session is also honoured. A network/parse failure or a non-OK
     * response resolves to `null` rather than throwing — callers treat "couldn't
     * resolve identity" as "signed out".
     *
     * Framework-agnostic: pair it with {@link onAuthTokenChange} to refetch when
     * the token changes (that's what `@cirrus/react`'s `useAuth` does).
     */
    public async getCurrentUser(): Promise<User | null> {
        if (this.closed || !this.fetchImpl) {
            // eslint-disable-next-line unicorn/no-null -- signed-out / unavailable sentinel matches the User | null contract
            return null;
        }

        const headers: Record<string, string> = {};

        if (this.authToken) {
            headers["authorization"] = `Bearer ${this.authToken}`;
        }

        try {
            const response = await this.fetchImpl(joinUrl(this.url, `${this.authBasePath}${GET_SESSION_PATH}`), {
                credentials: "include",
                headers,
                method: "GET",
            });

            if (!response.ok) {
                // eslint-disable-next-line unicorn/no-null -- non-OK (e.g. 401) means signed out
                return null;
            }

            // better-auth returns `{ user, session }` when authenticated and
            // `null` (or an empty body) when not. Narrow defensively.
            const body: { user?: User } | null = await response.json();

            // eslint-disable-next-line unicorn/no-null -- explicit signed-out sentinel
            return body?.user ?? null;
        } catch {
            // eslint-disable-next-line unicorn/no-null -- network/parse failure ⇒ treat as signed out
            return null;
        }
    }

    /**
     * Replace the token appended to WS upgrade URLs as `?token=…` and close
     * every open shard socket so the reconnect picks up the new value. Call
     * this whenever the user's WS credential changes (rotating the admin token
     * in the studio, switching workspaces, etc.). Bearer tokens for HTTP
     * RPC are independent — see {@link setAuthToken}.
     */
    public setWsToken(token: string | undefined): void {
        if (this.wsToken === token) {
            return;
        }

        this.wsToken = token;

        // Close every open/connecting socket so the reconnect uses the new
        // token. `handleDisconnect` (registered as the `close` handler) will
        // schedule the retry. Don't tear down the connection record itself —
        // pending subscriptions/streams need to ride the next socket.
        for (const conn of this.connections.values()) {
            if (conn.socket) {
                try {
                    conn.socket.close();
                } catch {
                    /* ignore */
                }
            }
        }
    }

    // --- Connection status --------------------------------------------------

    /**
     * Current aggregate live-socket status across all shard connections. See
     * {@link ConnectionStatus}.
     */
    public connectionStatus(): ConnectionStatus {
        return this.computeStatus();
    }

    /**
     * Subscribe to aggregate connection-status changes. Invokes `listener`
     * immediately with the current status, then on every transition. Returns an
     * unsubscribe function.
     */
    public onConnectionStatus(listener: (status: ConnectionStatus) => void): Unsubscribe {
        this.statusListeners.add(listener);
        listener(this.computeStatus());

        return () => {
            this.statusListeners.delete(listener);
        };
    }

    // --- RPC ---------------------------------------------------------------

    public async query<F extends FunctionReference>(function_: F, args: ArgsOf<F>, options: { shardKey?: string } = {}): Promise<ReturnOf<F>> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        return (await this.rpc(function_.__cirrusRef, args as Record<string, unknown>, options.shardKey, { attachBookmark: true })) as ReturnOf<F>;
    }

    /**
     * Invoke a mutation. Errors propagate as rejections.
     *
     * Offline-queue semantics: a mutation is queued (and replayed on reconnect)
     * only when the targeted shard's socket was open at least once already
     * (`wasEverConnected`), so the registry / resubscribe handshake has run.
     * Mutations issued before the very first WS connect to a shard fail fast.
     * Opt into queueing-before-first-connect via
     * `OfflineQueueOptions.queueBeforeFirstConnect`.
     */
    public async mutation<F extends FunctionReference>(
        function_: F,
        args: ArgsOf<F>,
        options: MutationCallOptions<unknown, unknown, ArgsOf<F>> = {},
    ): Promise<ReturnOf<F>> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const argsRecord = args as Record<string, unknown>;

        // Apply optimistic updates to any subscriber listening on this fn. The
        // legacy per-call `optimistic` transform patches the matching (fn, args,
        // shard) subscriptions; the Convex-parity `optimisticUpdate` callback can
        // patch many subscribed queries at once via a localStore. Both funnel into
        // the same LIFO rollback list (unwound on settle/error).
        const optimisticRollbacks = this.applyOptimisticUpdates(function_.__cirrusRef, argsRecord, options.shardKey, options.optimistic);

        if (options.optimisticUpdate) {
            this.applyOptimisticUpdate(options.optimisticUpdate, args, options.shardKey, optimisticRollbacks);
        }

        // Queue while offline (only mutations — queries fail fast). We also
        // queue when we're mid-reconnect (wsState === "connecting") provided
        // we've been connected before — otherwise the mutation would race
        // the resubscribe. State is scoped to the mutation's own shard so a
        // dropped shard only queues writes destined for it.
        const conn = this.getConnection(options.shardKey);
        const wsState: WSState = conn?.wsState ?? "idle";
        const hasSocket = conn?.socket !== undefined;
        const wasEverConnected = conn?.wasEverConnected ?? false;
        const { queueBeforeFirstConnect } = this.offlineQueue;
        const connectedGate = wasEverConnected || queueBeforeFirstConnect;
        const shouldQueueOffline = this.WebSocketImpl !== undefined && connectedGate;
        const midReconnect = wsState === "connecting" && connectedGate;

        if ((wsState !== "open" && !hasSocket && shouldQueueOffline) || midReconnect) {
            // Bind the issuing identity at enqueue time so the write can only
            // replay under the same identity (see flushOfflineQueue).
            const issuingIdentity = this.identityFingerprint();

            return new Promise<ReturnOf<F>>((resolve, reject) => {
                const entry: QueuedMutation<ReturnOf<F>> = {
                    args: argsRecord,
                    functionPath: function_.__cirrusRef,
                    reject: (error) => {
                        // LIFO: roll back most-recent optimistic write first so a
                        // stacked update on the same subscription restores the
                        // immediately-prior value rather than clobbering a newer
                        // still-pending optimistic value with a stale snapshot.
                        for (let index = optimisticRollbacks.length - 1; index >= 0; index -= 1) {
                            optimisticRollbacks[index]?.();
                        }

                        reject(error instanceof Error ? error : new Error(String(error)));
                    },
                    resolve,
                    shardKey: options.shardKey,
                };

                this.offlineQueue.enqueue<ReturnOf<F>>(entry);

                // `enqueue` assigns `entry.id` when absent; stamp the captured
                // identity against it for the flush-time check.
                if (entry.id !== undefined) {
                    this.queuedIdentities.set(entry.id, issuingIdentity);
                }
            });
        }

        try {
            return (await this.rpc(function_.__cirrusRef, argsRecord, options.shardKey, { captureBookmark: true })) as ReturnOf<F>;
        } catch (error) {
            // LIFO: see the offline-queue reject path above. Roll back the
            // most-recent optimistic write first so stacked updates on the same
            // subscription don't restore a stale captured snapshot.
            for (let index = optimisticRollbacks.length - 1; index >= 0; index -= 1) {
                optimisticRollbacks[index]?.();
            }

            throw error;
        }
    }

    public async action<F extends FunctionReference>(function_: F, args: ArgsOf<F>, options: { shardKey?: string } = {}): Promise<ReturnOf<F>> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        return (await this.rpc(function_.__cirrusRef, args as Record<string, unknown>, options.shardKey)) as ReturnOf<F>;
    }

    // --- Scheduler admin ----------------------------------------------------

    /**
     * List the functions queued via `runAfter` / `runAt`, soonest-due last
     * (the worker returns them in storage order). Hits the admin-gated
     * `/_cirrus/admin/scheduled` endpoint, so the worker must be built with a
     * `schedulerDO` namespace and `adminToken`, and this client's auth token
     * must match. Powers `@cirrus/studio`'s scheduled-jobs panel.
     */
    public async listScheduledJobs(): Promise<ScheduleRecord[]> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const body = (await this.adminFetch(SCHEDULED_PATH, "GET")) as { records?: ScheduleRecord[] };

        return body.records ?? [];
    }

    /**
     * Read the app-level workpool backlog that powers `@cirrus/studio`'s SLO
     * view: per-pool `{ name, queued, inFlight, maxConcurrency }` plus the
     * app-wide `backlog` (total queued) and `inFlight` (total held slots) sums.
     * Hits the admin-gated `GET /_cirrus/admin/scheduled/status` endpoint, so the
     * same preconditions as {@link listScheduledJobs} apply (a `schedulerDO`
     * namespace + `adminToken` on the worker and a matching auth token here).
     * Defaults any absent field so an older worker still yields a valid shape.
     */
    public async schedulerStatus(): Promise<SchedulerStatus> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const body = (await this.adminFetch(SCHEDULED_STATUS_PATH, "GET")) as Partial<SchedulerStatus>;

        return {
            backlog: body.backlog ?? 0,
            inFlight: body.inFlight ?? 0,
            pools: body.pools ?? [],
        };
    }

    /** Cancel a pending scheduled job by id. Returns whether a job was removed. */
    public async cancelScheduledJob(id: string): Promise<{ cancelled: boolean }> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const body = (await this.adminFetch(SCHEDULED_CANCEL_PATH, "POST", { id })) as { cancelled?: boolean };

        return { cancelled: body.cancelled === true };
    }

    /**
     * Subscribe to the live scheduled-jobs list over the SchedulerDO's admin
     * WebSocket. `onJobs` fires with the full list on connect and on every
     * change (schedule / cancel / alarm-fire). Reconnects with the client's
     * configured backoff. Requires `wsToken` to be set to the admin token (the
     * browser can't send an `Authorization` header on a WS). Returns an
     * unsubscribe function that closes the socket and stops reconnecting.
     */
    public subscribeScheduledJobs(onJobs: (jobs: ScheduleRecord[]) => void): Unsubscribe {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        if (this.WebSocketImpl === undefined) {
            return () => undefined;
        }

        const base = joinUrl(deriveWsUrl(this.url), SCHEDULED_WS_PATH);
        const reconnect = createReconnect(this.reconnectOptions);

        let socket: undefined | WebSocket;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let closed = false;

        const connect = (): void => {
            if (closed || this.WebSocketImpl === undefined) {
                return;
            }

            // Read `this.wsToken` at connect time (not once at subscribe time) so a
            // post-subscribe `setWsToken()` rotation is picked up on the next
            // reconnect attempt instead of looping forever with a stale token the
            // admin gate rejects.
            const url = this.wsToken === undefined ? base : `${base}?token=${encodeURIComponent(this.wsToken)}`;

            socket = new this.WebSocketImpl(url);

            socket.addEventListener("open", () => {
                reconnect.reset();
            });

            socket.addEventListener("message", (event: MessageEvent) => {
                try {
                    const message = JSON.parse(typeof event.data === "string" ? event.data : "") as { records?: ScheduleRecord[]; type?: string };

                    if (message.type === "jobs" && Array.isArray(message.records)) {
                        onJobs(message.records);
                    }
                } catch {
                    /* a non-JSON frame — ignore */
                }
            });

            socket.addEventListener("close", () => {
                socket = undefined;

                if (!closed) {
                    timer = setTimeout(connect, reconnect.next());
                }
            });

            socket.addEventListener("error", () => {
                /* the runtime follows up with close; reconnect handles it there */
            });
        };

        connect();

        return () => {
            closed = true;

            if (timer !== undefined) {
                clearTimeout(timer);
            }

            socket?.close();
        };
    }

    // --- Functions admin ----------------------------------------------------

    /**
     * List the registered public functions (queries / mutations / actions) with
     * their kinds. Hits the admin-gated `GET /_cirrus/admin/functions` endpoint —
     * the worker must be built with a `functions` registry and `adminToken`, and
     * this client's auth token must match. Powers `@cirrus/studio`'s function
     * runner auto-discovery.
     */
    public async listFunctions(): Promise<FunctionDescriptor[]> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const body = (await this.adminFetch(FUNCTIONS_PATH, "GET")) as { functions?: FunctionDescriptor[] };

        return body.functions ?? [];
    }

    // --- Storage admin ------------------------------------------------------

    /**
     * List objects in the storage bucket, optionally under a `prefix` and from a
     * pagination `cursor`. Hits the admin-gated `GET /_cirrus/admin/storage`
     * endpoint — the worker must be built with a `storageList` function and
     * `adminToken`, and this client's auth token must match. Powers
     * `@cirrus/studio`'s file browser.
     */
    public async listStorageObjects(options: { cursor?: string; limit?: number; prefix?: string } = {}): Promise<StorageListPage> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const params = new URLSearchParams();

        if (options.prefix !== undefined && options.prefix !== "") {
            params.set("prefix", options.prefix);
        }

        if (options.cursor !== undefined && options.cursor !== "") {
            params.set("cursor", options.cursor);
        }

        if (options.limit !== undefined) {
            params.set("limit", String(options.limit));
        }

        const query = params.toString();
        const path = query === "" ? STORAGE_PATH : `${STORAGE_PATH}?${query}`;
        const body = (await this.adminFetch(path, "GET")) as { cursor?: string; objects?: StorageObject[] };

        return { cursor: body.cursor, objects: body.objects ?? [] };
    }

    /**
     * Delete one object from the storage bucket by key. Hits the admin-gated
     * `DELETE /_cirrus/admin/storage?key=…` endpoint — the worker must be built
     * with a `storageDelete` function and `adminToken`. Powers the studio file
     * browser's per-row delete; resolves `{ deleted, key }`.
     */
    public async deleteStorageObject(key: string): Promise<{ deleted: boolean; key: string }> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const path = `${STORAGE_PATH}?key=${encodeURIComponent(key)}`;
        const body = (await this.adminFetch(path, "DELETE")) as { deleted?: boolean; key?: string };

        return { deleted: body.deleted ?? true, key: body.key ?? key };
    }

    /**
     * Upload one object to the storage bucket. Hits the admin-gated
     * `PUT /_cirrus/admin/storage?key=…` endpoint with the raw body and an
     * optional `contentType` header — the worker must be built with a
     * `storageUpload` function and `adminToken`. Powers the studio file
     * browser's upload control; resolves `{ etag?, key }`.
     */
    public async uploadStorageObject(options: { body: ArrayBuffer | Blob; contentType?: string; key: string }): Promise<{ etag?: string; key: string }> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const path = `${STORAGE_PATH}?key=${encodeURIComponent(options.key)}`;
        const body = (await this.adminFetch(path, "PUT", options.body, options.contentType)) as { etag?: string; key?: string };

        return { etag: body.etag, key: body.key ?? options.key };
    }

    /**
     * Build a (signed or public) URL for one object. Hits the admin-gated
     * `GET /_cirrus/admin/storage/url?key=…` endpoint — the worker must be built
     * with a `storageSignedUrl` function and `adminToken`. Powers the studio
     * file browser's copy-URL action; resolves the URL string. An optional
     * `expiresInSeconds` requests a share-link lifetime (the host clamps it).
     */
    public async signedStorageUrl(key: string, expiresInSeconds?: number): Promise<string> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const expiryQuery = expiresInSeconds === undefined ? "" : `&expiresIn=${encodeURIComponent(expiresInSeconds.toString())}`;
        const path = `${STORAGE_URL_PATH}?key=${encodeURIComponent(key)}${expiryQuery}`;
        const body = (await this.adminFetch(path, "GET")) as { url?: string };

        if (typeof body.url !== "string") {
            throw new TypeError("CirrusClient: storage URL endpoint returned no `url`");
        }

        return body.url;
    }

    // --- Global (D1) tables admin -------------------------------------------

    /**
     * List the `.global()` (D1-backed) tables with their row counts. Hits the
     * admin-gated `GET /_cirrus/admin/global/tables` endpoint — the worker must
     * be built with a `globalIntrospector` and `adminToken`. Powers the data
     * browser's global mode.
     */
    public async listGlobalTables(): Promise<GlobalTableInfo[]> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        return (await this.adminFetch(GLOBAL_TABLES_PATH, "GET")) as GlobalTableInfo[];
    }

    /** Read a page of rows from one `.global()` table. */
    public async readGlobalTablePage(options: { limit?: number; offset?: number; table: string }): Promise<GlobalTablePage> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const params = new URLSearchParams({ table: options.table });

        if (options.limit !== undefined) {
            params.set("limit", String(options.limit));
        }

        if (options.offset !== undefined) {
            params.set("offset", String(options.offset));
        }

        return (await this.adminFetch(`${GLOBAL_TABLE_PATH}?${params.toString()}`, "GET")) as GlobalTablePage;
    }

    // --- Auth admin ---------------------------------------------------------

    /**
     * List authenticated users, paged and optionally searched / filtered / sorted.
     * Hits the admin-gated `GET /_cirrus/admin/auth/users` endpoint — the worker
     * must be built with an `authAdmin` and `adminToken`. Powers the studio's
     * users dashboard.
     */
    public async listAuthUsers(
        options: {
            filterField?: string;
            filterValue?: string;
            limit?: number;
            offset?: number;
            search?: string;
            searchField?: string;
            sortBy?: string;
            sortDirection?: "asc" | "desc";
        } = {},
    ): Promise<AuthPage<AuthUser>> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const path = withQuery(AUTH_USERS_PATH, {
            filterField: options.filterField,
            filterValue: options.filterValue,
            limit: options.limit,
            offset: options.offset,
            search: options.search,
            searchField: options.searchField,
            sortBy: options.sortBy,
            sortDirection: options.sortDirection,
        });

        return (await this.adminFetch(path, "GET")) as AuthPage<AuthUser>;
    }

    /**
     * Create a user. Hits the admin-gated `POST /_cirrus/admin/auth/users/create`
     * endpoint (requires the worker's `authAdmin` to implement `createUser`).
     * `data` carries any app-defined `user.additionalFields`.
     */
    public async createAuthUser(input: {
        data?: Record<string, unknown>;
        email: string;
        name: string;
        password?: string;
        role?: string | string[];
    }): Promise<AuthUser> {
        return (await this.adminFetch(AUTH_CREATE_USER_PATH, "POST", input)) as AuthUser;
    }

    /** Set a user's role (string, or array joined comma-wise server-side). */
    public async setAuthUserRole(input: { role: string | string[]; userId: string }): Promise<AuthUser> {
        return (await this.adminFetch(AUTH_SET_ROLE_PATH, "POST", input)) as AuthUser;
    }

    /** Ban a user. `expiresInSeconds` sets a temporary ban; omit it for a permanent one. Revokes the user's live sessions. */
    public async banAuthUser(input: { expiresInSeconds?: number; reason?: string; userId: string }): Promise<AuthUser> {
        return (await this.adminFetch(AUTH_BAN_PATH, "POST", input)) as AuthUser;
    }

    /** Lift a user's ban. */
    public async unbanAuthUser(input: { userId: string }): Promise<AuthUser> {
        return (await this.adminFetch(AUTH_UNBAN_PATH, "POST", input)) as AuthUser;
    }

    /** Set a user's password (admin override — no current-password challenge). */
    public async setAuthUserPassword(input: { newPassword: string; userId: string }): Promise<void> {
        await this.adminFetch(AUTH_SET_PASSWORD_PATH, "POST", input);
    }

    /** Permanently delete a user and revoke their sessions. */
    public async removeAuthUser(input: { userId: string }): Promise<void> {
        await this.adminFetch(AUTH_REMOVE_USER_PATH, "POST", input);
    }

    /**
     * Mint an impersonation session for a user, returning its bearer `token`.
     * The caller is responsible for using the token (e.g. setting the session
     * cookie); the server performs no cookie round-trip.
     */
    public async impersonateAuthUser(input: { userId: string }): Promise<AuthImpersonation> {
        return (await this.adminFetch(AUTH_IMPERSONATE_PATH, "POST", input)) as AuthImpersonation;
    }

    /** Revoke a single session by its id (force sign-out of one device). */
    public async revokeAuthSession(input: { sessionId: string }): Promise<void> {
        await this.adminFetch(AUTH_REVOKE_SESSION_PATH, "POST", input);
    }

    /** Revoke every session for a user (force sign-out everywhere). */
    public async revokeAuthUserSessions(input: { userId: string }): Promise<void> {
        await this.adminFetch(AUTH_REVOKE_SESSIONS_PATH, "POST", input);
    }

    /**
     * Report which auth dashboard surfaces are available — derived server-side
     * from the enabled better-auth plugins. The studio renders only the panels
     * whose capability is `true`.
     */
    public async getAuthCapabilities(): Promise<AuthCapabilities> {
        return (await this.adminFetch(AUTH_CAPABILITIES_PATH, "GET")) as AuthCapabilities;
    }

    /** Update a user's fields (name/email/app-defined `additionalFields`). */
    public async updateAuthUser(input: { data: Record<string, unknown>; userId: string }): Promise<AuthUser> {
        return (await this.adminFetch(AUTH_UPDATE_USER_PATH, "POST", input)) as AuthUser;
    }

    /** List a user's linked accounts (credential / OAuth providers). Token material is stripped server-side. */
    public async listAuthAccounts(input: { userId: string }): Promise<Record<string, unknown>[]> {
        return (await this.adminFetch(withQuery(AUTH_ACCOUNTS_PATH, { userId: input.userId }), "GET")) as Record<string, unknown>[];
    }

    /** Unlink a linked account from a user. */
    public async unlinkAuthAccount(input: { accountId: string; userId: string }): Promise<void> {
        await this.adminFetch(AUTH_UNLINK_ACCOUNT_PATH, "POST", input);
    }

    /** List a user's registered passkeys (requires the passkey plugin). */
    public async listAuthPasskeys(input: { userId: string }): Promise<Record<string, unknown>[]> {
        return (await this.adminFetch(withQuery(AUTH_PASSKEYS_PATH, { userId: input.userId }), "GET")) as Record<string, unknown>[];
    }

    /** Delete a passkey by id (requires the passkey plugin). */
    public async deleteAuthPasskey(input: { passkeyId: string }): Promise<void> {
        await this.adminFetch(AUTH_DELETE_PASSKEY_PATH, "POST", input);
    }

    /** Disable two-factor auth for a user (requires the two-factor plugin). */
    public async disableAuthTwoFactor(input: { userId: string }): Promise<void> {
        await this.adminFetch(AUTH_DISABLE_2FA_PATH, "POST", input);
    }

    /** List organizations, paged (requires the organization plugin). */
    public async listAuthOrganizations(options: { limit?: number; offset?: number } = {}): Promise<AuthPage<Record<string, unknown>>> {
        return (await this.adminFetch(withQuery(AUTH_ORGS_PATH, { limit: options.limit, offset: options.offset }), "GET")) as AuthPage<Record<string, unknown>>;
    }

    /** List the members of an organization (requires the organization plugin). */
    public async listAuthOrgMembers(input: { limit?: number; offset?: number; organizationId: string }): Promise<AuthPage<Record<string, unknown>>> {
        const path = withQuery(AUTH_ORG_MEMBERS_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

        return (await this.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
    }

    /** List an organization's pending invitations (requires the organization plugin). */
    public async listAuthOrgInvitations(input: { limit?: number; offset?: number; organizationId: string }): Promise<AuthPage<Record<string, unknown>>> {
        const path = withQuery(AUTH_ORG_INVITATIONS_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

        return (await this.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
    }

    /** Remove a member from an organization. */
    public async removeAuthOrgMember(input: { memberId: string }): Promise<void> {
        await this.adminFetch(AUTH_REMOVE_MEMBER_PATH, "POST", input);
    }

    /** Cancel a pending organization invitation. */
    public async cancelAuthOrgInvitation(input: { invitationId: string }): Promise<void> {
        await this.adminFetch(AUTH_CANCEL_INVITATION_PATH, "POST", input);
    }

    /** List auth sessions, paged and optionally filtered to one user. */
    public async listAuthSessions(options: { limit?: number; offset?: number; userId?: string } = {}): Promise<AuthPage<AuthSession>> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const params = new URLSearchParams();

        if (options.userId !== undefined && options.userId !== "") {
            params.set("userId", options.userId);
        }

        if (options.limit !== undefined) {
            params.set("limit", String(options.limit));
        }

        if (options.offset !== undefined) {
            params.set("offset", String(options.offset));
        }

        const query = params.toString();

        return (await this.adminFetch(query === "" ? AUTH_SESSIONS_PATH : `${AUTH_SESSIONS_PATH}?${query}`, "GET")) as AuthPage<AuthSession>;
    }

    // --- Subscriptions ------------------------------------------------------

    public subscribe<F extends FunctionReference>(
        function_: F,
        args: ArgsOf<F>,
        callback: (data: ReturnOf<F>) => void,
        options: { onError?: SubscriptionErrorCallback; shardKey?: string } = {},
    ): Unsubscribe {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        const argsRecord = (args ?? {}) as Record<string, unknown>;
        const key = SubscriptionRegistry.key(function_.__cirrusRef, argsRecord, options.shardKey);

        let state = this.subscriptions.get(key);
        const subscriptionCallback = callback as SubscriptionCallback;
        const errorCallback = options.onError;

        if (!state) {
            this.nextSubId += 1;
            const id = `sub_${this.nextSubId.toString()}`;

            state = {
                acked: false,
                args: argsRecord,
                argsKey: stableStringify(argsRecord),
                callbacks: new Set<SubscriptionCallback>(),
                errorCallbacks: new Set<SubscriptionErrorCallback>(),
                fn: function_,
                id,
                lastValue: undefined,
                serverVersion: 0,
                shardKey: options.shardKey,
            };
            this.subscriptions.add(state);
        }

        state.callbacks.add(subscriptionCallback);

        if (errorCallback) {
            state.errorCallbacks.add(errorCallback);
        }

        // Replay last value to new subscriber synchronously if available.
        if (state.lastValue !== undefined) {
            try {
                subscriptionCallback(state.lastValue);
            } catch {
                /* user callback threw — ignore */
            }
        }

        this.ensureSocket(options.shardKey);
        this.sendSubscribeIfOpen(state);

        const subscriptionState = state;

        return () => {
            subscriptionState.callbacks.delete(subscriptionCallback);

            if (errorCallback) {
                subscriptionState.errorCallbacks.delete(errorCallback);
            }

            if (subscriptionState.callbacks.size === 0) {
                const conn = this.getConnection(subscriptionState.shardKey);
                const ok = conn ? sendOn(conn, { id: subscriptionState.id, type: "unsubscribe" }) : false;

                if (!ok && conn) {
                    conn.pendingUnsubscribes.push(subscriptionState.id);
                }

                this.subscriptions.remove(subscriptionState);
            }
        };
    }

    /**
     * Open a streaming query. The function reference must be a
     * `kind:"stream"` registration (built with `c.query.input(...).stream(...)`);
     * the type constraint catches accidental use of a query/mutation/action
     * reference at compile time. The returned iterable yields one element per
     * chunk frame the server pushes, terminating when the server sends
     * `complete` or the consumer calls `.cancel()`. Errors arrive as a
     * rejection on the next `next()`.
     *
     * Streams ride the same WS as subscriptions and share the unsubscribe
     * channel: cancelling sends `{type:"unsubscribe", id}` with the stream id,
     * which the DO recognises as an abort signal for the in-flight iterator.
     *
     * Stream-start frames buffered while the socket is (re)connecting are
     * capped at {@link MAX_PENDING_STREAMS} per connection — overflowing the
     * cap drops the oldest queued frame (and fails its consumer) so a stuck
     * reconnect can't OOM the page.
     */
    public stream<F extends FunctionReference<"stream">>(
        function_: F,
        args: ArgsOf<F>,
        options: { maxBuffer?: number; shardKey?: string } = {},
    ): StreamIterable<ReturnOf<F>> {
        if (this.closed) {
            throw new Error("CirrusClient is closed");
        }

        if (this.WebSocketImpl === undefined) {
            throw new Error("CirrusClient: streams require a WebSocket implementation");
        }

        this.nextStreamId += 1;
        const id = `stream_${this.nextStreamId.toString()}`;
        const { shardKey } = options;
        const argsRecord = (args ?? {}) as Record<string, unknown>;

        const { handle, iterable } = createStream<ReturnOf<F>>({
            maxBuffer: options.maxBuffer,
            onCancel: () => {
                // Send the cancel frame on the matching connection (if any).
                // If the socket is down we drop the cancel: the DO has already
                // lost its handle on close, so there's nothing to abort.
                const conn = this.getConnection(shardKey);

                if (conn) {
                    sendOn(conn, { id, type: "unsubscribe" });
                }

                this.streams.delete(id);
            },
        });

        // Record before sending so an immediate ack/chunk reaching the dispatch
        // path before we return finds its target.
        this.streams.set(id, { handle: handle as StreamHandle, shardKey });

        this.ensureSocket(shardKey);

        const conn = this.getConnection(shardKey);
        const message: ClientMessage = {
            id,
            query: { args: argsRecord, functionPath: function_.__cirrusRef, shardKey },
            type: "stream",
        };

        // Fast path: socket is open, try to send immediately. `sendOn` can still
        // return `false` if the socket closed between the `wsState` check and the
        // `.send()` call (or `.send()` threw) — in that race the frame was never
        // delivered, so fall through to the bounded pending-queue path below so it
        // rides the next reconnect instead of leaking a forever-hanging consumer.
        const sentImmediately = conn?.wsState === "open" && sendOn(conn, message);

        if (!sentImmediately && conn) {
            // Defer the send to the open handler — the existing pending logic
            // is for unsubscribes, so stash the stream-start frame separately.
            conn.pendingStreams = conn.pendingStreams ?? [];

            // Bounded queue: an unreachable server would otherwise let
            // `pendingStreams` grow without limit if the caller keeps opening
            // streams. Drop the oldest (also failing its consumer) so the
            // newest request always wins.
            while (conn.pendingStreams.length >= MAX_PENDING_STREAMS) {
                const dropped = conn.pendingStreams.shift();
                const droppedId = (dropped as { id?: string } | undefined)?.id;
                const droppedStream = droppedId ? this.streams.get(droppedId) : undefined;

                if (droppedStream) {
                    droppedStream.handle.fail(
                        Object.assign(new Error("stream-start frame evicted while socket was unreachable"), { code: "STREAM_QUEUE_OVERFLOW" }),
                    );
                    this.streams.delete(droppedId as string);
                }
            }

            conn.pendingStreams.push(message);
        }

        return iterable;
    }

    public close(): void {
        this.closed = true;

        // Fail any in-flight streams so consumers see a deterministic
        // termination instead of an iterator that hangs forever after the
        // underlying socket goes away.
        for (const stream of this.streams.values()) {
            stream.handle.fail(Object.assign(new Error("CirrusClient closed"), { code: "CLIENT_CLOSED" }));
        }

        this.streams.clear();

        for (const conn of this.connections.values()) {
            if (conn.reconnectTimer !== undefined) {
                clearTimeout(conn.reconnectTimer);
                conn.reconnectTimer = undefined;
            }

            this.stopHeartbeat(conn);

            if (conn.socket) {
                try {
                    conn.socket.close();
                } catch {
                    /* ignore */
                }

                conn.socket = undefined;
            }

            conn.wsState = "closed";
        }

        this.offlineQueue.clear();
        this.queuedIdentities.clear();
    }

    // --- Internals ----------------------------------------------------------

    /**
     * Restore offline mutations persisted in a prior session and open a socket
     * for each shard they target so they flush once the WS reconnects. Failures
     * are swallowed — a broken durable store must not stop the client booting.
     */
    private async hydratePersistedQueue(): Promise<void> {
        try {
            const shardKeys = await this.offlineQueue.hydrate();

            for (const shardKey of shardKeys) {
                this.ensureSocket(shardKey);
            }
        } catch {
            /* durable store unavailable — boot without restored writes */
        }
    }

    /** Derive the aggregate status from the per-shard socket states. */
    private computeStatus(): ConnectionStatus {
        const conns = [...this.connections.values()];

        if (conns.length === 0) {
            return "idle";
        }

        if (conns.some((conn) => conn.wsState === "open")) {
            return "connected";
        }

        if (conns.some((conn) => conn.wsState === "connecting")) {
            return "connecting";
        }

        // Sockets exist but none is open or actively connecting — i.e. all are
        // down between reconnect attempts.
        return "offline";
    }

    /** Recompute the aggregate status and notify listeners if it changed. */
    private emitConnectionStatus(): void {
        const next = this.computeStatus();

        if (next === this.lastStatus) {
            return;
        }

        this.lastStatus = next;

        for (const listener of this.statusListeners) {
            try {
                listener(next);
            } catch {
                /* listener threw — ignore */
            }
        }
    }

    /**
     * Apply an optimistic update to every subscription that matches the
     * mutation's function ref, shard key, and args, returning the rollback
     * callbacks to invoke if the mutation later fails. Scoping to the same
     * (fn, shardKey, args) keeps one user's mutation from clobbering another
     * subscriber's value on the same function (e.g. two users on different rooms).
     */
    private applyOptimisticUpdates(
        functionRef: string,
        argsRecord: Record<string, unknown>,
        mutationShardKey: string | undefined,
        optimistic: ((current: unknown) => unknown) | undefined,
    ): (() => void)[] {
        const optimisticRollbacks: (() => void)[] = [];

        if (!optimistic) {
            return optimisticRollbacks;
        }

        const mutationArgsKey = stableStringify(argsRecord);

        for (const state of this.subscriptions.all()) {
            if (state.fn.__cirrusRef !== functionRef || state.shardKey !== mutationShardKey || state.argsKey !== mutationArgsKey) {
                continue;
            }

            const rollback = applyOptimisticToState(state, optimistic);

            if (rollback) {
                optimisticRollbacks.push(rollback);
            }
        }

        return optimisticRollbacks;
    }

    /**
     * Run a Convex-parity `optimisticUpdate` callback against a localStore bound
     * to the live subscription registry, appending each `setQuery` write's
     * rollback to `optimisticRollbacks` (the same LIFO list the legacy path uses,
     * unwound on settle/error). A throwing callback unwinds its own partial
     * writes — LIFO over just the rollbacks it produced — and is swallowed, so a
     * buggy optimistic update can never fail the mutation or leave a partial
     * patch live, mirroring the legacy transform's throw handling.
     */
    private applyOptimisticUpdate<F extends FunctionReference>(
        optimisticUpdate: OptimisticUpdate<ArgsOf<F>>,
        args: ArgsOf<F>,
        shardKey: string | undefined,
        optimisticRollbacks: (() => void)[],
    ): void {
        const { rollbacks, store } = createLocalStore(this.subscriptions, shardKey, writeOptimisticToState, stableStringify);

        try {
            optimisticUpdate(store, args);
        } catch {
            // Unwind only this callback's own writes, most-recent first, so a
            // throwing localStore update leaves the cache as it found it.
            for (let index = rollbacks.length - 1; index >= 0; index -= 1) {
                rollbacks[index]?.();
            }

            return;
        }

        optimisticRollbacks.push(...rollbacks);
    }

    private getConnection(shardKey: string | undefined): ShardConnection | undefined {
        return this.connections.get(connectionKey(shardKey));
    }

    private getOrCreateConnection(shardKey: string | undefined): ShardConnection {
        const key = connectionKey(shardKey);
        let conn = this.connections.get(key);

        if (!conn) {
            conn = {
                heartbeatTimer: undefined,
                pendingUnsubscribes: [],
                reconnect: createReconnect(this.reconnectOptions),
                reconnectTimer: undefined,
                shardKey,
                socket: undefined,
                wasEverConnected: false,
                wsState: "idle",
            };
            this.connections.set(key, conn);
        }

        return conn;
    }

    private wsUrlFor(shardKey: string | undefined): string {
        const params: string[] = [];

        if (shardKey !== undefined) {
            params.push(`shard=${encodeURIComponent(shardKey)}`);
        }

        if (this.wsToken !== undefined) {
            params.push(`token=${encodeURIComponent(this.wsToken)}`);
        }

        if (params.length === 0) {
            return this.wsUrl;
        }

        const separator = this.wsUrl.includes("?") ? "&" : "?";

        return `${this.wsUrl}${separator}${params.join("&")}`;
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
            body: JSON.stringify({ args, functionPath, shardKey }),
            headers,
            method: "POST",
        });

        if (flags.captureBookmark) {
            const value = response.headers.get("x-d1-bookmark");

            if (value) {
                this.bookmark.set(value);
            }
        }

        let body: RpcResponseBody;

        try {
            body = await response.json();
        } catch {
            const statusText = response.statusText ? ` ${response.statusText}` : "";

            throw new Error(`CirrusClient: response was not JSON (status ${response.status.toString()}${statusText})`);
        }

        if ("error" in body) {
            const error = new Error(body.error.message);

            (error as Error & { code?: string }).code = body.error.code;
            throw error;
        }

        // A non-2xx response whose body parsed as JSON but carried no `error`
        // envelope would otherwise be treated as a successful result. Surface the
        // HTTP status so callers get an actionable error instead.
        if (!response.ok) {
            const statusText = response.statusText ? ` ${response.statusText}` : "";

            throw new Error(`CirrusClient: request failed (status ${response.status.toString()}${statusText})`);
        }

        return body.result;
    }

    /**
     * Authenticated request to a non-RPC admin endpoint (the scheduler list /
     * cancel routes). Attaches the bearer token, parses JSON, and surfaces the
     * worker's `{ error: { code, message } }` envelope as a coded `Error` —
     * mirroring {@link rpc} so callers see the same failure shape.
     */
    private async adminFetch(
        path: string,
        method: "DELETE" | "GET" | "POST" | "PUT",
        payload?: ArrayBuffer | Blob | Record<string, unknown>,
        contentType?: string,
    ): Promise<unknown> {
        if (!this.fetchImpl) {
            throw new Error("CirrusClient: no `fetch` implementation available");
        }

        const headers: Record<string, string> = {};

        if (this.authToken) {
            headers["authorization"] = `Bearer ${this.authToken}`;
        }

        // A raw binary payload (storage upload) rides as-is with the caller's
        // content-type; a plain-object payload is JSON-encoded. `undefined`
        // sends no body at all (GET/DELETE without a payload).
        const isBinary = payload instanceof ArrayBuffer || payload instanceof Blob;
        let requestBody: ArrayBuffer | Blob | string | undefined;

        if (payload === undefined) {
            requestBody = undefined;
        } else if (isBinary) {
            requestBody = payload;

            if (contentType !== undefined) {
                headers["content-type"] = contentType;
            }
        } else {
            requestBody = JSON.stringify(payload);
            headers["content-type"] = "application/json";
        }

        const response = await this.fetchImpl(joinUrl(this.url, path), {
            body: requestBody,
            headers,
            method,
        });

        let body: unknown;

        try {
            body = await response.json();
        } catch {
            const statusText = response.statusText ? ` ${response.statusText}` : "";

            throw new Error(`CirrusClient: response was not JSON (status ${response.status.toString()}${statusText})`);
        }

        // Untrusted server payload: narrow before inspecting for an error envelope.
        if (typeof body === "object" && body !== null && "error" in body) {
            const envelope = body.error as { code?: string; message?: string };
            const error = new Error(envelope.message ?? "admin request failed");

            (error as Error & { code?: string }).code = envelope.code;
            throw error;
        }

        // A non-2xx response with a JSON body but no `error` envelope would
        // otherwise be returned as a successful payload. Surface the HTTP status.
        if (!response.ok) {
            const statusText = response.statusText ? ` ${response.statusText}` : "";

            throw new Error(`CirrusClient: admin request failed (status ${response.status.toString()}${statusText})`);
        }

        return body;
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
        this.emitConnectionStatus();

        const socket = new this.WebSocketImpl(this.wsUrlFor(shardKey));

        conn.socket = socket;

        socket.addEventListener("open", (): void => {
            conn.wsState = "open";
            conn.wasEverConnected = true;
            conn.reconnect.reset();
            this.emitConnectionStatus();

            // Resubscribe everyone bound to this shard.
            this.markShardPendingAck(shardKey);

            for (const state of this.subscriptions.all()) {
                if (connectionKey(state.shardKey) === connectionKey(shardKey)) {
                    this.sendSubscribeIfOpen(state);
                }
            }

            // Flush any unsubscribes that piled up while the socket was down.
            if (conn.pendingUnsubscribes.length > 0) {
                const pending = conn.pendingUnsubscribes;

                conn.pendingUnsubscribes = [];

                for (const id of pending) {
                    sendOn(conn, { id, type: "unsubscribe" });
                }
            }

            // Flush stream-start frames queued while we were (re)connecting.
            // Reconnect-after-close: in-flight streams have already torn down
            // on the server, so the only entries here are brand-new ones that
            // raced the connect.
            if (conn.pendingStreams && conn.pendingStreams.length > 0) {
                const pending = conn.pendingStreams;

                conn.pendingStreams = [];

                for (const message of pending) {
                    sendOn(conn, message);
                }
            }

            this.flushOfflineQueue(shardKey).catch(() => undefined);

            this.startHeartbeat(conn);
        });

        socket.addEventListener("message", (event: MessageEvent): void => {
            this.handleServerMessage(event.data);
        });

        socket.addEventListener("close", (): void => {
            this.handleDisconnect(conn);
        });

        socket.addEventListener("error", (): void => {
            // Some WebSocket implementations (notably misbehaving proxies and
            // certain test doubles) fire `error` without a follow-up `close`.
            // Treat error in `connecting`/`open` as a disconnect ourselves to
            // make sure the reconnect timer always arms; `handleDisconnect` is
            // idempotent via the `wsState === "idle"` checks downstream.
            if (conn.wsState === "connecting" || conn.wsState === "open") {
                this.handleDisconnect(conn);
            }
        });
    }

    private handleDisconnect(conn: ShardConnection): void {
        if (this.closed) {
            return;
        }

        // Idempotent: if a prior `error`/`close` already tore down the socket,
        // a second invocation must not re-arm the reconnect timer.
        if (conn.wsState === "idle" || conn.wsState === "closed") {
            return;
        }

        // Intentional mutation of the shared, long-lived connection record so
        // the open/close/error handlers all observe the same state machine.
        /* eslint-disable no-param-reassign -- mutate the shared ShardConnection state machine in place */
        this.stopHeartbeat(conn);
        conn.socket = undefined;
        conn.wsState = "idle";
        this.emitConnectionStatus();
        this.markShardPendingAck(conn.shardKey);

        if (this.WebSocketImpl === undefined) {
            return;
        }

        const delay = conn.reconnect.next();

        conn.reconnectTimer = setTimeout(() => {
            conn.reconnectTimer = undefined;
            this.ensureSocket(conn.shardKey);
        }, delay);
        /* eslint-enable no-param-reassign */
    }

    /**
     * Begin the keepalive heartbeat on an open connection. Each tick sends a
     * {@link WS_KEEPALIVE_PING} text frame the server answers from its
     * hibernation auto-response without waking the DO. A no-op when the
     * heartbeat is disabled (an interval of zero or less); idempotent — any
     * existing timer is cleared first so a reconnect can't leak intervals.
     */
    private startHeartbeat(conn: ShardConnection): void {
        this.stopHeartbeat(conn);

        if (this.heartbeatIntervalMs <= 0) {
            return;
        }

        // eslint-disable-next-line no-param-reassign -- store the timer on the shared connection record so stopHeartbeat can clear it
        conn.heartbeatTimer = setInterval(() => {
            if (conn.wsState !== "open" || !conn.socket) {
                return;
            }

            try {
                conn.socket.send(WS_KEEPALIVE_PING);
            } catch {
                // A send race against a closing socket is harmless — the close
                // handler will tear the heartbeat down.
            }
        }, this.heartbeatIntervalMs);
    }

    /** Clear a connection's keepalive timer, if any. Safe to call repeatedly. */
    // eslint-disable-next-line class-methods-use-this -- cohesive connection helper; pairs with startHeartbeat
    private stopHeartbeat(conn: ShardConnection): void {
        if (conn.heartbeatTimer !== undefined) {
            clearInterval(conn.heartbeatTimer);
            // eslint-disable-next-line no-param-reassign -- mutate the shared connection record to release the timer
            conn.heartbeatTimer = undefined;
        }
    }

    /** Mark every subscription bound to `shardKey` as needing a fresh ack. */
    private markShardPendingAck(shardKey: string | undefined): void {
        const key = connectionKey(shardKey);

        for (const state of this.subscriptions.all()) {
            if (connectionKey(state.shardKey) === key) {
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

        sendOn(conn, {
            id: state.id,
            query: { args: state.args, functionPath: state.fn.__cirrusRef, table },
            type: "subscribe",
        });
    }

    private handleServerMessage(raw: unknown): void {
        const text = decodeServerFrame(raw);

        if (text === undefined) {
            return;
        }

        let message: ServerMessage;

        try {
            message = JSON.parse(text) as ServerMessage;
        } catch {
            return;
        }

        switch (message.type) {
            case "ack": {
                const state = this.subscriptions.getById(message.id);

                if (state) {
                    state.acked = true;
                }

                return;
            }
            case "chunk": {
                const { data, id } = message;
                const stream = this.streams.get(id);

                stream?.handle.push(data);

                return;
            }
            case "complete": {
                this.handleCompleteMessage(message.id);

                return;
            }
            case "data":
            case "delta": {
                this.handleDataMessage(message);

                return;
            }
            case "error": {
                this.handleErrorMessage(message);

                break;
            }
            default: {
                break;
            }
        }
    }

    private handleErrorMessage(message: ServerErrorMessage): void {
        // Stream-scoped errors arrive on the same `error` envelope as
        // subscription errors; dispatch by id-prefix lookup.
        const { id } = message;
        const stream = id === undefined ? undefined : this.streams.get(id);

        if (stream && id !== undefined) {
            stream.handle.fail(buildStreamError(message));
            this.streams.delete(id);

            return;
        }

        // A subscription-scoped rejection (e.g. an admin subscription on a
        // socket that didn't clear the admin gate). Surface it to the
        // subscriber's onError so the UI can react instead of silently
        // never receiving data; the registration is left in place so a
        // later reconnect with proper credentials can still succeed.
        const state = id === undefined ? undefined : this.subscriptions.getById(id);

        if (state) {
            const error = { message: typeof message.message === "string" ? message.message : "subscription error" };

            for (const errorCallback of state.errorCallbacks) {
                try {
                    errorCallback(error);
                } catch {
                    /* user callback threw — ignore */
                }
            }
        }
    }

    private handleDataMessage(message: ServerDataMessage): void {
        const { id } = message;
        const state = id ? this.subscriptions.getById(id) : undefined;

        if (!state) {
            return;
        }

        const payload = this.resolveDataPayload(message, state);

        state.lastValue = payload;
        state.serverVersion += 1;

        for (const callback of state.callbacks) {
            try {
                callback(payload);
            } catch {
                /* user callback threw — ignore */
            }
        }
    }

    /**
     * Resolve the value to publish for a `data`/`delta` frame.
     *
     * A `data` frame is an authoritative snapshot (the server re-execution path)
     * and always replaces the cached value wholesale. A `delta` frame carrying a
     * structured `MutationDelta` (the `broadcastDelta` row-change path) is
     * merged incrementally into the cached list — preserving order, no dup/loss —
     * so each subscription (including every paginated page) updates by delta
     * rather than a full re-send. We fall back to full replacement when the
     * delta isn't a recognisable row change, when there's no cached value yet,
     * or when it can't be applied cleanly against the current cached shape.
     */
    // eslint-disable-next-line class-methods-use-this -- instance method for symmetry with the other message handlers; reads no shared client state
    private resolveDataPayload(message: ServerDataMessage, state: SubscriptionState): unknown {
        if ("data" in message && message.data !== undefined) {
            return message.data;
        }

        const { delta } = message;

        if (isMutationDelta(delta) && state.lastValue !== undefined) {
            const merged = applyDelta(state.lastValue, delta);

            if (merged !== undefined) {
                return merged;
            }
        }

        // Opaque delta payload (e.g. a full result the server sent verbatim), no
        // cached base to merge into, or an unmergeable shape: replace wholesale,
        // preserving the historical behaviour. The next snapshot reconciles.
        return delta;
    }

    private handleCompleteMessage(id: string): void {
        // Streams complete normally — close the iterator. Subscriptions
        // can also receive `complete` (cancelled server-side); remove them
        // from the registry. The two id-spaces don't overlap (`sub_*` vs
        // `stream_*`) so the two lookups are mutually exclusive.
        const stream = this.streams.get(id);

        if (stream) {
            stream.handle.complete();
            this.streams.delete(id);

            return;
        }

        const state = this.subscriptions.getById(id);

        if (state) {
            this.subscriptions.remove(state);
        }
    }

    private unpersist(id: string | undefined): void {
        if (id) {
            this.persistence?.remove(id).catch(() => undefined);
        }
    }

    /**
     * Stable, non-reversible fingerprint of the current auth identity used to
     * stamp queued offline writes. `null` (signed out) is its own identity and
     * never matches a bearer-token fingerprint. The raw token is never stored;
     * a length-prefixed FNV-1a hash is enough to detect an identity *change*
     * without keeping the credential around in the queue map.
     */
    // `null` is the distinct "signed out" identity (separate from `undefined`,
    // which means "not stamped / hydrated"); the two must not be conflated.
    private identityFingerprint(): string | null {
        const token = this.authToken;

        if (token === null) {
            // eslint-disable-next-line unicorn/no-null -- signed-out identity sentinel, distinct from undefined
            return null;
        }

        let hash = 0x81_1c_9d_c5;

        for (let index = 0; index < token.length; index += 1) {
            // FNV-1a hash: bitwise XOR and the final `>>> 0` to a uint32 are the
            // algorithm; charCodeAt (not codePointAt) keeps the digest stable for
            // surrogate pairs, so the fingerprint never changes shape.
            // eslint-disable-next-line no-bitwise, unicorn/prefer-code-point -- FNV-1a hash requires charCode XOR
            hash ^= token.charCodeAt(index);
            hash = Math.imul(hash, 0x01_00_01_93);
        }

        // eslint-disable-next-line no-bitwise -- coerce the FNV-1a accumulator to an unsigned 32-bit integer
        return `${token.length.toString(36)}:${(hash >>> 0).toString(36)}`;
    }

    /**
     * Drain every in-memory offline write and reject it because the auth
     * identity changed. Durable entries are also dropped from persistence so a
     * later `hydrate` can't resurrect another user's writes. Stamps are cleared
     * alongside. Persisted entries restored without a live awaiter still get
     * unpersisted here.
     */
    private rejectQueuedForIdentityChange(): void {
        const drained = this.offlineQueue.drain();

        for (const item of drained) {
            this.queuedIdentities.delete(item.id ?? "");
            this.unpersist(item.id);

            const error = new Error("offline mutation discarded: auth identity changed before replay");

            (error as Error & { code?: string }).code = "OFFLINE_IDENTITY_CHANGED";
            item.reject(error);
        }
    }

    private async flushOfflineQueue(shardKey: string | undefined): Promise<void> {
        const key = connectionKey(shardKey);
        const drained = this.offlineQueue.drain((item) => connectionKey(item.shardKey) === key);
        const currentIdentity = this.identityFingerprint();

        // Sequential replay — parallel `.then()` chains would race and break
        // the FIFO ordering callers rely on, particularly when replayed
        // mutations depend on each other.
        for (const item of drained) {
            // Identity guard: a write stamped under one identity must never
            // replay under another (an unstamped/hydrated write — `undefined` —
            // replays under whatever identity is current, matching the prior
            // ambient behaviour for restored sessions). Mismatches are rejected,
            // not silently dropped, so awaiting callers see a deterministic
            // failure.
            const stamped = item.id === undefined ? undefined : this.queuedIdentities.get(item.id);

            if (stamped !== undefined && stamped !== currentIdentity) {
                this.queuedIdentities.delete(item.id ?? "");
                this.unpersist(item.id);

                const error = new Error("offline mutation skipped: auth identity changed before replay");

                (error as Error & { code?: string }).code = "OFFLINE_IDENTITY_CHANGED";
                item.reject(error);

                continue;
            }

            this.queuedIdentities.delete(item.id ?? "");

            try {
                // eslint-disable-next-line no-await-in-loop -- sequential replay preserves the FIFO order callers depend on (see above)
                const value = await this.rpc(item.functionPath, item.args, item.shardKey, { captureBookmark: true });

                this.unpersist(item.id);
                item.resolve(value);
            } catch (error) {
                // Remove on rejection too: the server reached a verdict, so
                // replaying again would only re-trigger the same failure
                // (a poison-message loop). At-least-once, not exactly-once.
                this.unpersist(item.id);
                item.reject(error);
            }
        }
    }
}

export { CirrusClient };
export type { ConnectionStatus };
