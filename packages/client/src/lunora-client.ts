import { stableStringify } from "../../../shared/stable-key";
import createInMemoryBookmarkStorage from "./bookmark";
import { applyDelta, isMutationDelta } from "./delta-merge";
import type { OptimisticUpdate } from "./local-store";
import { createLocalStore } from "./local-store";
import type { QueuedMutation } from "./offline-queue";
import { nextId, OfflineQueue, reportPersistenceError } from "./offline-queue";
import { queryCacheKey } from "./query-cache";
import type { ReconnectCalculator } from "./reconnect";
import { createReconnect } from "./reconnect";
import type { StreamHandle, StreamIterable } from "./stream";
import { createStream } from "./stream";
import type { SubscriptionCallback, SubscriptionError, SubscriptionErrorCallback, SubscriptionState } from "./subscription";
import { SubscriptionRegistry } from "./subscription";
import type {
    ArgsOf,
    AuthCapabilities,
    AuthImpersonation,
    AuthPage,
    AuthSession,
    AuthUser,
    BookmarkStorage,
    CachedQuery,
    ClientMessage,
    CronJobInfo,
    FunctionDescriptor,
    FunctionReference,
    GlobalFacetResult,
    GlobalFilterClause,
    GlobalTableInfo,
    GlobalTablePage,
    LunoraClientOptions,
    PersistenceAdapter,
    PersistenceErrorContext,
    QueryCacheAdapter,
    ReconnectOptions,
    ReturnOf,
    RpcResponseBody,
    ScheduleRecord,
    SchedulerStatus,
    ServerDataMessage,
    ServerErrorMessage,
    ServerMessage,
    ServerResumeMessage,
    ServerWhisperMessage,
    ShardTrafficResult,
    StorageListPage,
    StorageObject,
    Unsubscribe,
    User,
    VectorIndexSummary,
    VectorQueryMatch,
    WorkflowInstanceAction,
    WorkflowInstanceDetail,
    WorkflowInstancePage,
    WorkflowInstanceStatus,
} from "./types";

const RPC_PATH = "/_lunora/rpc";
const WS_PATH = "/_lunora/ws";

/** Build the `&amp;bucket=…` query fragment for a storage admin request, or `""` when no bucket is selected. */
const bucketQuery = (bucket?: string): string => (bucket === undefined || bucket === "" ? "" : `&bucket=${encodeURIComponent(bucket)}`);

/**
 * Keepalive frame sent on the heartbeat. MUST match the request payload the
 * server registers via `setWebSocketAutoResponse` (`@lunora/do`'s ShardDO
 * `WS_KEEPALIVE_PING`): the runtime answers it with `lunora-pong` WITHOUT
 * waking the Durable Object. The pong is a plain (non-JSON) string and is
 * silently dropped by `handleServerMessage`'s `JSON.parse` guard.
 */
const WS_KEEPALIVE_PING = "lunora-ping";

/** Default heartbeat cadence (ms) — see {@link LunoraClientOptions.heartbeatIntervalMs}. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Default WS connect timeout (ms) — see {@link LunoraClientOptions.connectTimeoutMs}. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Debounce window (ms) for durable read-cache writes (Pillar 2). A burst of
 * deltas on one subscription coalesces into a single `put` per key after the
 * socket settles, keeping IndexedDB off the per-frame hot path.
 */
const QUERY_CACHE_DEBOUNCE_MS = 250;

/**
 * Maximum number of stream-start frames queued per connection while the
 * socket is (re)connecting. Past this cap, the oldest queued stream is
 * evicted (its consumer is failed with `STREAM_QUEUE_OVERFLOW`) so a stuck
 * reconnect can never grow the queue unbounded.
 */
const MAX_PENDING_STREAMS = 64;
const SHARD_TRAFFIC_PATH = "/_lunora/admin/shard-traffic";
const SCHEDULED_PATH = "/_lunora/admin/scheduled";
const SCHEDULED_STATUS_PATH = "/_lunora/admin/scheduled/status";
const SCHEDULED_WS_PATH = "/_lunora/admin/scheduled/ws";
const SCHEDULED_CANCEL_PATH = "/_lunora/admin/scheduled/cancel";
const SCHEDULED_DEAD_PATH = "/_lunora/admin/scheduled/dead";
const SCHEDULED_DEAD_RETRY_PATH = "/_lunora/admin/scheduled/dead/retry";
const SCHEDULED_DEAD_CANCEL_PATH = "/_lunora/admin/scheduled/dead/cancel";
const WORKFLOWS_INSTANCES_PATH = "/_lunora/admin/workflows/instances";
const WORKFLOWS_INSTANCE_PATH = "/_lunora/admin/workflows/instance";
const WORKFLOWS_STATUS_PATH = "/_lunora/admin/workflows/status";
const STORAGE_PATH = "/_lunora/admin/storage";
const STORAGE_URL_PATH = "/_lunora/admin/storage/url";
const STORAGE_BUCKETS_PATH = "/_lunora/admin/storage/buckets";
const FUNCTIONS_PATH = "/_lunora/admin/functions";
const CRON_JOBS_PATH = "/_lunora/admin/cron-jobs";
const CRON_JOBS_RUN_PATH = "/_lunora/admin/cron-jobs/run";
const OPENAPI_PATH = "/_lunora/admin/openapi";
const OPENRPC_PATH = "/_lunora/admin/openrpc";
const GLOBAL_TABLES_PATH = "/_lunora/admin/global/tables";
const GLOBAL_TABLE_PATH = "/_lunora/admin/global/table";
const GLOBAL_FACET_PATH = "/_lunora/admin/global/facet";
const VECTOR_INDEXES_PATH = "/_lunora/admin/vector/indexes";
const VECTOR_QUERY_PATH = "/_lunora/admin/vector/query";
const AUTH_USERS_PATH = "/_lunora/admin/auth/users";
const AUTH_SESSIONS_PATH = "/_lunora/admin/auth/sessions";
const AUTH_CREATE_USER_PATH = "/_lunora/admin/auth/users/create";
const AUTH_SET_ROLE_PATH = "/_lunora/admin/auth/users/role";
const AUTH_BAN_PATH = "/_lunora/admin/auth/users/ban";
const AUTH_UNBAN_PATH = "/_lunora/admin/auth/users/unban";
const AUTH_SET_PASSWORD_PATH = "/_lunora/admin/auth/users/password";
const AUTH_REMOVE_USER_PATH = "/_lunora/admin/auth/users/remove";
const AUTH_IMPERSONATE_PATH = "/_lunora/admin/auth/users/impersonate";
const AUTH_REVOKE_SESSION_PATH = "/_lunora/admin/auth/sessions/revoke";
const AUTH_REVOKE_SESSIONS_PATH = "/_lunora/admin/auth/sessions/revoke-all";
const AUTH_CAPABILITIES_PATH = "/_lunora/admin/auth/capabilities";
const AUTH_UPDATE_USER_PATH = "/_lunora/admin/auth/users/update";
const AUTH_ACCOUNTS_PATH = "/_lunora/admin/auth/accounts";
const AUTH_UNLINK_ACCOUNT_PATH = "/_lunora/admin/auth/accounts/unlink";
const AUTH_PASSKEYS_PATH = "/_lunora/admin/auth/passkeys";
const AUTH_DELETE_PASSKEY_PATH = "/_lunora/admin/auth/passkeys/delete";
const AUTH_DISABLE_2FA_PATH = "/_lunora/admin/auth/two-factor/disable";
const AUTH_ORGS_PATH = "/_lunora/admin/auth/organizations";
const AUTH_ORG_MEMBERS_PATH = "/_lunora/admin/auth/organizations/members";
const AUTH_ORG_INVITATIONS_PATH = "/_lunora/admin/auth/organizations/invitations";
const AUTH_REMOVE_MEMBER_PATH = "/_lunora/admin/auth/organizations/members/remove";
const AUTH_CANCEL_INVITATION_PATH = "/_lunora/admin/auth/organizations/invitations/cancel";

/**
 * Default better-auth session endpoint. The worker mounts better-auth at
 * `/api/auth` (see `@lunora/auth`'s `DEFAULT_AUTH_BASE_PATH`); `get-session`
 * is the better-auth route that returns the current `{ user, session }` (or
 * `null` when signed out). Override the base via `LunoraClientOptions.authBasePath`.
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

/**
 * Per-call options for {@link LunoraClient.mutation} — the optimistic-update
 * machinery plus `shardKey`. Exported (at the end of this file) so the framework
 * adapters (`@lunora/react`, `/solid`, `/svelte`, `/vue`) can type their
 * `mutate(args, options?)` against one canonical definition instead of
 * re-declaring it.
 */
interface MutationCallOptions<TCurrent = unknown, TValue = unknown, TArgs = unknown> {
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
 * One WebSocket per shard key. Subscriptions and the writes they observe must
 * land on the same Durable Object, so each distinct `shardKey` gets its own
 * socket connected to `?shard=&lt;key>` (the default shard uses no query param).
 * Reconnect backoff, offline-flush state, and the pending-unsubscribe buffer
 * are all per-connection so one shard dropping doesn't disturb the others.
 */
interface ShardConnection {
    /**
     * Fail-fast timer armed while the socket is `connecting`; cleared on `open`.
     * If the handshake doesn't complete within `connectTimeoutMs` (a hung proxy /
     * cold worker that never upgrades) it force-closes the socket and routes
     * through the normal disconnect/reconnect path, instead of leaving the live
     * channel silently stuck on the browser's much longer default WS timeout.
     */
    connectTimer: ReturnType<typeof setTimeout> | undefined;
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
 * Build a {@link SubscriptionError} from a subscription-scoped server `error`
 * frame. Pulls `code`/`message` off either the top-level fields or the nested
 * `error` envelope (the server uses both shapes), mirroring
 * {@link buildStreamError}, so an `onError` consumer can branch on a coded
 * rejection instead of only seeing the human message.
 */
const buildSubscriptionError = (message: ServerErrorMessage): SubscriptionError => {
    const errorEnvelope = message.error as { code?: unknown; message?: unknown } | undefined;
    const code = typeof errorEnvelope?.code === "string" ? errorEnvelope.code : undefined;
    const nestedMessage = typeof errorEnvelope?.message === "string" ? errorEnvelope.message : undefined;
    const messageText = (typeof message.message === "string" ? message.message : undefined) ?? nestedMessage ?? "subscription error";

    return { message: messageText, ...(code === undefined ? {} : { code }) };
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
 * Lunora browser/edge client. Talks RPC over HTTP and real-time deltas over
 * a single multiplexed WebSocket.
 *
 * Reconnect, offline queueing, and optimistic updates are all handled here;
 * see the package README for the wire protocol.
 */
class LunoraClient {
    public readonly url: string;

    public readonly wsUrl: string;

    private wsToken: string | undefined;

    /** Better-auth base path (trailing slash stripped) for the `get-session` lookup. */
    private readonly authBasePath: string;

    private readonly fetchImpl: typeof fetch | undefined;

    private readonly WebSocketImpl: typeof WebSocket | undefined;

    private readonly bookmark: BookmarkStorage;

    private readonly reconnectOptions: ReconnectOptions | undefined;

    /** WS connect timeout (ms); `0` disables it. See {@link LunoraClientOptions.connectTimeoutMs}. */
    private readonly connectTimeoutMs: number;
    /** Keepalive cadence (ms); `0` disables the heartbeat. See {@link LunoraClientOptions.heartbeatIntervalMs}. */
    private readonly heartbeatIntervalMs: number;

    private readonly offlineQueue: OfflineQueue;

    private readonly onPersistenceError: ((context: PersistenceErrorContext) => void) | undefined;

    private readonly persistence: PersistenceAdapter | undefined;

    /** Durable read cache (Pillar 2); `undefined` when `queryCache` is omitted or `false`. */
    private readonly queryCache: QueryCacheAdapter | undefined;

    /**
     * Values restored from the `queryCache` at construction, keyed by the
     * read-cache key, awaiting the `subscribe()` that will consume them. A
     * key is consumed (deleted) the first time its subscription is created, so
     * the cache only ever seeds the initial value — live frames take over after.
     */
    private readonly hydratedQueryCache = new Map<string, CachedQuery>();

    /**
     * Coalesced read-cache writes: the latest value per key, flushed to
     * the `queryCache` on a short debounce so a burst of deltas persists once.
     */
    private readonly pendingCacheWrites = new Map<string, CachedQuery>();

    private cacheFlushTimer: ReturnType<typeof setTimeout> | undefined;

    private readonly subscriptions = new SubscriptionRegistry();

    /** One {@link ShardConnection} per shard key (keyed by `shardKey ?? ""`). */
    private readonly connections = new Map<string, ShardConnection>();

    /** Default `connect`-envelope context applied to a shard with no explicit override. */
    private readonly defaultConnectionContext: Record<string, unknown> | undefined;

    /**
     * Per-shard `connect`-envelope context registered via `setConnectionContext`
     * (keyed by `shardKey ?? ""`), overriding `defaultConnectionContext`. Sent
     * on every socket open so it replays across reconnects, and forwarded to the
     * server's `onConnect`/`onDisconnect` lifecycle hooks. This holds only the
     * imperative (last-writer-wins) override; refcounted holders registered via
     * `acquireConnectionContext` live in `connectionContextHolders` and take
     * precedence — see `effectiveConnectionContext`.
     */
    private readonly connectionContexts = new Map<string, Record<string, unknown>>();

    /**
     * Per-shard stack of refcounted connection-context holders (keyed by
     * `shardKey ?? ""`), registered via `acquireConnectionContext`. Each holder
     * is an opaque token carrying its `context`; the most-recently acquired
     * holder wins (last-writer-wins among live holders), and the context is only
     * cleared for a shard once its last holder releases — so two concurrently
     * mounted presence hooks on the same shard can't stomp each other's context
     * on cleanup. A holder is identified by reference identity so a release
     * removes exactly the right one regardless of stack position.
     */
    private readonly connectionContextHolders = new Map<string, { context: Record<string, unknown> }[]>();

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

    /** Subscribers notified when the server drops a socket for an expired token (see `onTokenExpired`). */
    private readonly tokenExpiredListeners = new Set<() => void>();

    /**
     * Whisper-topic handlers, keyed by `connectionKey(shardKey)` → topic → set
     * of callbacks. Membership doubles as the resubscribe set replayed on every
     * (re)connect so a topic survives a socket bounce.
     */
    private readonly whisperHandlers = new Map<string, Map<string, Set<(data: unknown, from?: string) => void>>>();

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

    public constructor(options: LunoraClientOptions) {
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
        this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.defaultConnectionContext = options.connectionContext;
        this.persistence = options.persistence;
        this.queryCache = options.queryCache === false ? undefined : options.queryCache;
        this.onPersistenceError = options.offlineQueue?.onPersistenceError;
        this.offlineQueue = new OfflineQueue(options.offlineQueue, options.persistence);

        if (this.persistence) {
            // Deferred to a microtask so the constructor itself stays
            // synchronous; hydration then opens sockets for any restored writes
            // so they flush once the WS connects.
            queueMicrotask((): void => {
                this.hydratePersistedQueue().catch(() => undefined);
            });
        }

        if (this.queryCache) {
            // Load the durable read cache into `hydratedQueryCache` so the first
            // `subscribe()` for each key seeds its value before any socket opens.
            // Best-effort and identity-gated at seed time.
            queueMicrotask((): void => {
                this.hydrateQueryCache().catch(() => undefined);
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
     * the token changes (that's what `@lunora/react`'s `useAuth` does).
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

    /**
     * Register (or clear, with `undefined`) the app context sent in the `connect`
     * envelope for a shard's socket, overriding the client-wide
     * {@link LunoraClientOptions.connectionContext}. The server forwards it to the
     * `onConnect`/`onDisconnect` lifecycle hooks as `event.context` — e.g.
     * `@lunora/react`'s `usePresence` registers `{ roomId, sessionId }` so the
     * presence row is removed the instant the socket drops, with no TTL lag.
     *
     * Stored per shard and replayed on every (re)connect. When a socket for the
     * shard is already open, a fresh `connect` envelope is sent immediately so the
     * server sees the new context without waiting for a reconnect.
     */
    public setConnectionContext(context: Record<string, unknown> | undefined, options: { shardKey?: string } = {}): void {
        const key = connectionKey(options.shardKey);

        if (context === undefined) {
            this.connectionContexts.delete(key);
        } else {
            this.connectionContexts.set(key, context);
        }

        this.refreshConnectionContext(key);
    }

    /**
     * Refcounted variant of {@link setConnectionContext}: register a connection
     * `context` for a shard and get back a release function. Unlike the imperative
     * setter, the context is only cleared once the *last* acquired holder releases
     * it — so two components (e.g. two mounted `usePresence` hooks) on the same
     * shard no longer clobber each other's context when one of them unmounts. The
     * most-recently acquired live holder wins (last-writer-wins), and releasing
     * the top holder falls back to the previous one rather than clearing.
     *
     * With a single holder the behaviour is identical to a
     * `setConnectionContext(context)` / `setConnectionContext(undefined)` pair.
     * Releasing more than once is a no-op (the holder is matched by reference, so
     * a double release can't drop a different holder).
     */
    public acquireConnectionContext(context: Record<string, unknown>, options: { shardKey?: string } = {}): Unsubscribe {
        const key = connectionKey(options.shardKey);
        const holder = { context };
        const holders = this.connectionContextHolders.get(key);

        if (holders) {
            holders.push(holder);
        } else {
            this.connectionContextHolders.set(key, [holder]);
        }

        this.refreshConnectionContext(key);

        let released = false;

        return () => {
            if (released) {
                return;
            }

            released = true;

            const live = this.connectionContextHolders.get(key);

            if (!live) {
                return;
            }

            const index = live.indexOf(holder);

            if (index !== -1) {
                live.splice(index, 1);
            }

            if (live.length === 0) {
                this.connectionContextHolders.delete(key);
            }

            this.refreshConnectionContext(key);
        };
    }

    // --- Whispering ---------------------------------------------------------

    /**
     * Join a whisper `topic` and receive every ephemeral message other members
     * broadcast to it on the same shard (typing indicators, live cursors,
     * presence pings). Whispers never touch the server's durable state — there's
     * no query, no row, no CDC entry. Returns an unsubscribe function; the topic
     * is left on the server once its last local handler unsubscribes.
     *
     * `handler` receives the raw `data` and the sender's verified `from` user id
     * (omitted for an anonymous sender). The topic is scoped to `options.shardKey`
     * (the default shard when omitted) — use the same shard you target with the
     * matching queries/mutations so members land on the same Durable Object.
     *
     * Security: whisper topics are NOT access-controlled beyond the shard
     * boundary — any client that can open a socket to the shard can join, read,
     * and inject on any topic name. `from` is server-stamped and unforgeable, but
     * do not put data on a whisper topic that some shard members shouldn't see,
     * and don't trust a whisper's `data` as authorization. Use a query/mutation
     * (with RLS) for anything privileged; whispers are for transient awareness.
     */
    public whisperSubscribe(topic: string, handler: (data: unknown, from?: string) => void, options: { shardKey?: string } = {}): Unsubscribe {
        const key = connectionKey(options.shardKey);
        let byTopic = this.whisperHandlers.get(key);

        if (!byTopic) {
            byTopic = new Map();
            this.whisperHandlers.set(key, byTopic);
        }

        let handlers = byTopic.get(topic);
        const first = handlers === undefined;

        if (!handlers) {
            handlers = new Set();
            byTopic.set(topic, handlers);
        }

        handlers.add(handler);

        this.ensureSocket(options.shardKey);

        // Only the first local handler for a topic sends the server join — later
        // handlers piggyback on the existing membership.
        if (first) {
            const conn = this.getConnection(options.shardKey);

            if (conn) {
                sendOn(conn, { topic, type: "whisper_subscribe" });
            }
        }

        return () => {
            const stillByTopic = this.whisperHandlers.get(key);
            const stillHandlers = stillByTopic?.get(topic);

            if (!stillHandlers?.delete(handler) || stillHandlers.size > 0) {
                return;
            }

            // Last handler for this topic on this shard: leave the topic and
            // prune the empty maps so the resubscribe set stays accurate.
            stillByTopic?.delete(topic);

            if (stillByTopic?.size === 0) {
                this.whisperHandlers.delete(key);
            }

            const conn = this.getConnection(options.shardKey);

            if (conn) {
                sendOn(conn, { topic, type: "whisper_unsubscribe" });
            }
        };
    }

    /**
     * Broadcast an ephemeral `data` payload to the other members of a whisper
     * `topic` on `options.shardKey`'s shard. Fire-and-forget: the frame is
     * dropped when the shard socket isn't open (whispers are transient, never
     * queued), and the server silently drops it if the sender exceeds its
     * whisper rate budget. The sender never receives its own whisper. Omitting
     * `data` delivers JSON `null` to receivers (not `undefined`).
     */
    public whisper(topic: string, data?: unknown, options: { shardKey?: string } = {}): void {
        this.ensureSocket(options.shardKey);

        const conn = this.getConnection(options.shardKey);

        if (conn) {
            sendOn(conn, { data, topic, type: "whisper" });
        }
    }

    /**
     * Subscribe to token-expiry events: invoked whenever the server drops a
     * shard socket because the connection's credential lapsed (close code
     * `4001`). The client already reconnects automatically (re-resolving
     * identity from the cookie/token in effect); use this to refresh a
     * short-lived token first — e.g. call {@link setWsToken} / {@link setAuthToken}
     * with a freshly minted one. Returns an unsubscribe function.
     */
    public onTokenExpired(listener: () => void): Unsubscribe {
        this.tokenExpiredListeners.add(listener);

        return () => {
            this.tokenExpiredListeners.delete(listener);
        };
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
            throw new Error("LunoraClient is closed");
        }

        return (await this.rpc(function_.__lunoraRef, args as Record<string, unknown>, options.shardKey, { attachBookmark: true })) as ReturnOf<F>;
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
            throw new Error("LunoraClient is closed");
        }

        const argsRecord = args as Record<string, unknown>;

        // One stable idempotency key per logical mutation, shared by the direct
        // send and any offline-queue replay of this write (the entry reuses it as
        // its `id`). Lets the server dedup a replayed-but-already-committed write.
        const mutationId = nextId();

        // Apply optimistic updates to any subscriber listening on this fn. The
        // legacy per-call `optimistic` transform patches the matching (fn, args,
        // shard) subscriptions; the Convex-parity `optimisticUpdate` callback can
        // patch many subscribed queries at once via a localStore. Both funnel into
        // the same LIFO rollback list (unwound on settle/error).
        const optimisticRollbacks = this.applyOptimisticUpdates(function_.__lunoraRef, argsRecord, options.shardKey, options.optimistic);

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
                    functionPath: function_.__lunoraRef,
                    // Reuse the call's idempotency key as the queue id so the
                    // replay carries the same `x-lunora-mutation-id` the server
                    // dedups on.
                    id: mutationId,
                    // Persist the stamp alongside the record so a hydrated write
                    // can only replay under the identity that queued it.
                    identity: issuingIdentity,
                    reject: (error) => {
                        // Drop this write's identity stamp on any rejection
                        // (overflow eviction, identity change, close) so the
                        // `queuedIdentities` map can't leak entries for writes
                        // the queue has already discarded — `mutationId` is the
                        // entry's stable id, reused as its queue id.
                        this.queuedIdentities.delete(mutationId);

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
            return (await this.rpc(function_.__lunoraRef, argsRecord, options.shardKey, { captureBookmark: true, mutationId })) as ReturnOf<F>;
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
            throw new Error("LunoraClient is closed");
        }

        return (await this.rpc(function_.__lunoraRef, args as Record<string, unknown>, options.shardKey)) as ReturnOf<F>;
    }

    // --- Advisor admin ------------------------------------------------------

    /**
     * Read the cross-shard request distribution for a `.shardBy(...)` table —
     * the feed the studio's `hot_shard` advisor lint consumes. Hits the
     * admin-gated `POST /_lunora/admin/shard-traffic` endpoint, which fans the
     * cheap per-shard `getMetrics` read out across every live shard and returns
     * each shard's `{ shardKey, requests }` total (a failed shard surfaces with
     * `requests: 0`). Requires the worker to be built with a `queryCoordinator`
     * and `adminToken`, and this client's auth token to match; defaults any
     * absent field so an older worker yields an empty-but-valid shape.
     */
    public async shardTraffic(table: string): Promise<ShardTrafficResult> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(SHARD_TRAFFIC_PATH, "POST", { table })) as Partial<ShardTrafficResult>;

        return { failed: body.failed ?? 0, ok: body.ok ?? 0, shards: body.shards ?? [] };
    }

    // --- Scheduler admin ----------------------------------------------------

    /**
     * List the functions queued via `runAfter` / `runAt`, soonest-due last
     * (the worker returns them in storage order). Hits the admin-gated
     * `/_lunora/admin/scheduled` endpoint, so the worker must be built with a
     * `schedulerDO` namespace and `adminToken`, and this client's auth token
     * must match. Powers `@lunora/studio`'s scheduled-jobs panel.
     */
    public async listScheduledJobs(): Promise<ScheduleRecord[]> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(SCHEDULED_PATH, "GET")) as { records?: ScheduleRecord[] };

        return body.records ?? [];
    }

    /**
     * Read the app-level workpool backlog that powers `@lunora/studio`'s SLO
     * view: per-pool `{ name, queued, inFlight, maxConcurrency }` plus the
     * app-wide `backlog` (total queued) and `inFlight` (total held slots) sums.
     * Hits the admin-gated `GET /_lunora/admin/scheduled/status` endpoint, so the
     * same preconditions as {@link listScheduledJobs} apply (a `schedulerDO`
     * namespace + `adminToken` on the worker and a matching auth token here).
     * Defaults any absent field so an older worker still yields a valid shape.
     */
    public async schedulerStatus(): Promise<SchedulerStatus> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
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
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(SCHEDULED_CANCEL_PATH, "POST", { id })) as { cancelled?: boolean };

        return { cancelled: body.cancelled === true };
    }

    /**
     * List the dead-letter jobs: schedules that exhausted their retry budget
     * and were parked instead of dropped. These never appear in
     * {@link listScheduledJobs} (their live header is gone), so this is the only
     * way the studio surfaces a permanently-failed job. Hits the admin-gated
     * `GET /_lunora/admin/scheduled/dead`; same preconditions as
     * {@link listScheduledJobs}. Powers `@lunora/studio`'s dead-letter panel.
     */
    public async listDeadJobs(): Promise<ScheduleRecord[]> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(SCHEDULED_DEAD_PATH, "GET")) as { records?: ScheduleRecord[] };

        return body.records ?? [];
    }

    /**
     * Resurrect a dead-letter job by id: it re-enters the schedule with a fresh
     * retry budget and fires on the next drain. Returns whether a parked record
     * matched. Hits the admin-gated `POST /_lunora/admin/scheduled/dead/retry`.
     */
    public async retryDeadJob(id: string): Promise<{ retried: boolean }> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(SCHEDULED_DEAD_RETRY_PATH, "POST", { id })) as { retried?: boolean };

        return { retried: body.retried === true };
    }

    /**
     * Permanently drop a dead-letter job by id (the operator has decided not to
     * recover it). Returns whether a parked record was removed. Hits the
     * admin-gated `POST /_lunora/admin/scheduled/dead/cancel`.
     */
    public async removeDeadJob(id: string): Promise<{ removed: boolean }> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(SCHEDULED_DEAD_CANCEL_PATH, "POST", { id })) as { removed?: boolean };

        return { removed: body.removed === true };
    }

    /**
     * List a workflow's instances via the admin Workflows proxy
     * (`/_lunora/admin/workflows/instances`) — the Cloudflare control-plane data
     * the `Workflow` binding can't expose. Requires the worker to be built with a
     * `workflowsClient` (Cloudflare account id + API token); otherwise the proxy
     * responds 501 and this rejects. `name` is the deployed workflow name.
     */
    public async listWorkflowInstances(options: {
        name: string;
        page?: number;
        perPage?: number;
        status?: WorkflowInstanceStatus;
    }): Promise<WorkflowInstancePage> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const query = new URLSearchParams({ name: options.name });

        if (options.status !== undefined) {
            query.set("status", options.status);
        }

        if (options.page !== undefined) {
            query.set("page", String(options.page));
        }

        if (options.perPage !== undefined) {
            query.set("perPage", String(options.perPage));
        }

        const body = (await this.adminFetch(`${WORKFLOWS_INSTANCES_PATH}?${query.toString()}`, "GET")) as Partial<WorkflowInstancePage>;

        return {
            configured: body.configured,
            instances: body.instances ?? [],
            page: body.page ?? 1,
            perPage: body.perPage ?? options.perPage ?? 0,
            totalCount: body.totalCount,
        };
    }

    /** Read one workflow instance with its step timeline (`/_lunora/admin/workflows/instance`). */
    public async getWorkflowInstance(options: { id: string; name: string }): Promise<WorkflowInstanceDetail> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const query = new URLSearchParams({ id: options.id, name: options.name });
        const body = (await this.adminFetch(`${WORKFLOWS_INSTANCE_PATH}?${query.toString()}`, "GET")) as Partial<WorkflowInstanceDetail>;

        return {
            createdOn: body.createdOn,
            endedOn: body.endedOn,
            error: body.error,
            id: body.id ?? options.id,
            output: body.output,
            params: body.params,
            startedOn: body.startedOn,
            status: body.status ?? "unknown",
            steps: body.steps ?? [],
        };
    }

    /** Pause / resume / terminate a workflow instance (`/_lunora/admin/workflows/status`). Needs an Edit-scoped Cloudflare token. */
    public async setWorkflowInstanceStatus(options: { action: WorkflowInstanceAction; id: string; name: string }): Promise<{ status: WorkflowInstanceStatus }> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(WORKFLOWS_STATUS_PATH, "POST", { action: options.action, id: options.id, name: options.name })) as {
            status?: WorkflowInstanceStatus;
        };

        return { status: body.status ?? "unknown" };
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
            throw new Error("LunoraClient is closed");
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
     * their kinds. Hits the admin-gated `GET /_lunora/admin/functions` endpoint —
     * the worker must be built with a `functions` registry and `adminToken`, and
     * this client's auth token must match. Powers `@lunora/studio`'s function
     * runner auto-discovery.
     */
    public async listFunctions(): Promise<FunctionDescriptor[]> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(FUNCTIONS_PATH, "GET")) as { functions?: FunctionDescriptor[] };

        return body.functions ?? [];
    }

    /**
     * List the code-defined cron triggers (the `cronJobs()` map injected on the
     * worker), each flattened to its firing `cron` expression. Hits the
     * admin-gated `GET /_lunora/admin/cron-jobs` endpoint — the worker must be
     * built with a `cronJobs` map and `adminToken`, and this client's auth token
     * must match. These are static (Cloudflare exposes no runtime cron
     * introspection), so the studio renders them read-only alongside the dynamic
     * scheduler jobs.
     */
    public async getCronJobs(): Promise<CronJobInfo[]> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(CRON_JOBS_PATH, "GET")) as { jobs?: CronJobInfo[] };

        return body.jobs ?? [];
    }

    /**
     * Manually fire one code-defined cron job by name — the same dispatch the
     * scheduled trigger runs (dispatch the function, or start the durable
     * workflow), on demand. Hits the admin-gated `POST /_lunora/admin/cron-jobs/run`
     * endpoint; the worker must be built with a `cronJobs` map and `adminToken`,
     * and this client's auth token must match. Resolves when the job has run (a
     * function job's shard response is 2xx, or the workflow instance was created)
     * and rejects with the dispatch error otherwise.
     */
    public async runCronJob(name: string): Promise<{ name: string; ran: boolean }> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(CRON_JOBS_RUN_PATH, "POST", { name })) as { name?: string; ran?: boolean };

        return { name: body.name ?? name, ran: body.ran === true };
    }

    /**
     * Fetch the generated OpenAPI 3.1 document. Hits the admin-gated
     * `GET /_lunora/admin/openapi` endpoint — the worker must be built with an
     * `openApiSpec` and `adminToken`, and this client's auth token must match.
     * Powers `@lunora/studio`'s API-reference (Scalar) view. When the worker has
     * no spec wired, the endpoint still resolves with an empty-but-valid OpenAPI
     * document (no `paths`), so callers can render a "not configured" state.
     */
    public async fetchOpenApi(): Promise<Record<string, unknown>> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        return (await this.adminFetch(OPENAPI_PATH, "GET")) as Record<string, unknown>;
    }

    /**
     * Fetch the generated OpenRPC 1.x document. Hits the admin-gated
     * `GET /_lunora/admin/openrpc` endpoint — the worker must be built with an
     * `openRpcSpec` and `adminToken`, and this client's auth token must match.
     * OpenRPC is the RPC-native spec (a `methods` array over the JSON-RPC-shaped
     * `POST /_lunora/rpc` transport); it documents the RPC functions only.
     * Powers `@lunora/studio`'s OpenRPC API-reference view. When the worker has
     * no spec wired, the endpoint still resolves with an empty-but-valid OpenRPC
     * document (no `methods`), so callers can render a "not configured" state.
     */
    public async fetchOpenRpc(): Promise<Record<string, unknown>> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        return (await this.adminFetch(OPENRPC_PATH, "GET")) as Record<string, unknown>;
    }

    // --- Storage admin ------------------------------------------------------

    /**
     * List objects in the storage bucket, optionally under a `prefix` and from a
     * pagination `cursor`. Hits the admin-gated `GET /_lunora/admin/storage`
     * endpoint — the worker must be built with a `storageList` function and
     * `adminToken`, and this client's auth token must match. Powers
     * `@lunora/studio`'s file browser.
     */
    public async listStorageObjects(options: { bucket?: string; cursor?: string; limit?: number; prefix?: string } = {}): Promise<StorageListPage> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
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

        if (options.bucket !== undefined && options.bucket !== "") {
            params.set("bucket", options.bucket);
        }

        const query = params.toString();
        const path = query === "" ? STORAGE_PATH : `${STORAGE_PATH}?${query}`;
        const body = (await this.adminFetch(path, "GET")) as { cursor?: string; objects?: StorageObject[] };

        return { cursor: body.cursor, objects: body.objects ?? [] };
    }

    /**
     * Delete one object from the storage bucket by key. Hits the admin-gated
     * `DELETE /_lunora/admin/storage?key=…` endpoint — the worker must be built
     * with a `storageDelete` function and `adminToken`. Powers the studio file
     * browser's per-row delete; resolves `{ deleted, key }`.
     */
    public async deleteStorageObject(key: string, options?: { bucket?: string }): Promise<{ deleted: boolean; key: string }> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const path = `${STORAGE_PATH}?key=${encodeURIComponent(key)}${bucketQuery(options?.bucket)}`;
        const body = (await this.adminFetch(path, "DELETE")) as { deleted?: boolean; key?: string };

        return { deleted: body.deleted ?? true, key: body.key ?? key };
    }

    /**
     * List the storage bucket names the worker exposes, for the studio file
     * browser's bucket picker. Hits the admin-gated
     * `GET /_lunora/admin/storage/buckets` endpoint — always resolves (an empty
     * array when the worker configures no `storageBuckets`, i.e. single-bucket).
     */
    public async listStorageBuckets(): Promise<string[]> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(STORAGE_BUCKETS_PATH, "GET")) as { buckets?: string[] };

        return body.buckets ?? [];
    }

    /**
     * Upload one object to the storage bucket. Hits the admin-gated
     * `PUT /_lunora/admin/storage?key=…` endpoint with the raw body and an
     * optional `contentType` header — the worker must be built with a
     * `storageUpload` function and `adminToken`. Powers the studio file
     * browser's upload control; resolves `{ etag?, key }`.
     */
    public async uploadStorageObject(options: {
        body: ArrayBuffer | Blob;
        bucket?: string;
        contentType?: string;
        key: string;
    }): Promise<{ etag?: string; key: string }> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const path = `${STORAGE_PATH}?key=${encodeURIComponent(options.key)}${bucketQuery(options.bucket)}`;
        const body = (await this.adminFetch(path, "PUT", options.body, options.contentType)) as { etag?: string; key?: string };

        return { etag: body.etag, key: body.key ?? options.key };
    }

    /**
     * Build a (signed or public) URL for one object. Hits the admin-gated
     * `GET /_lunora/admin/storage/url?key=…` endpoint — the worker must be built
     * with a `storageSignedUrl` function and `adminToken`. Powers the studio
     * file browser's copy-URL action; resolves the URL string.
     *
     * `options.expiresInSeconds` requests a share-link lifetime, which is
     * validated/clamped server-side. The options object mirrors the worker's
     * `StorageSignedUrlFunction` options (a `password` / download-limit are noted
     * as future fields there).
     */
    public async signedStorageUrl(key: string, options?: { bucket?: string; expiresInSeconds?: number }): Promise<string> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const expiresInSeconds = options?.expiresInSeconds;
        const expiryQuery = expiresInSeconds === undefined ? "" : `&expiresIn=${encodeURIComponent(expiresInSeconds.toString())}`;
        const path = `${STORAGE_URL_PATH}?key=${encodeURIComponent(key)}${expiryQuery}${bucketQuery(options?.bucket)}`;
        const body = (await this.adminFetch(path, "GET")) as { url?: string };

        if (typeof body.url !== "string") {
            throw new TypeError("LunoraClient: storage URL endpoint returned no `url`");
        }

        return body.url;
    }

    // --- Global (D1) tables admin -------------------------------------------

    /**
     * List the `.global()` (D1-backed) tables with their row counts. Hits the
     * admin-gated `GET /_lunora/admin/global/tables` endpoint — the worker must
     * be built with a `globalIntrospector` and `adminToken`. Powers the data
     * browser's global mode.
     */
    public async listGlobalTables(): Promise<GlobalTableInfo[]> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        return (await this.adminFetch(GLOBAL_TABLES_PATH, "GET")) as GlobalTableInfo[];
    }

    /**
     * Read a page of rows from one `.global()` table. `filters` AND-narrows the
     * page to rows matching each `column = value` eq constraint — the drill-down a
     * facet-value click applies; the array is JSON-encoded into the `filters`
     * query param and the values are bound server-side.
     */
    public async readGlobalTablePage(options: { filters?: GlobalFilterClause[]; limit?: number; offset?: number; table: string }): Promise<GlobalTablePage> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const params = new URLSearchParams({ table: options.table });

        if (options.limit !== undefined) {
            params.set("limit", String(options.limit));
        }

        if (options.offset !== undefined) {
            params.set("offset", String(options.offset));
        }

        if (options.filters !== undefined && options.filters.length > 0) {
            params.set("filters", JSON.stringify(options.filters));
        }

        return (await this.adminFetch(`${GLOBAL_TABLE_PATH}?${params.toString()}`, "GET")) as GlobalTablePage;
    }

    /**
     * Summarise the distinct values of one column in a `.global()` table over the
     * active view (the same eq `filters` the browser is previewing) — the global
     * twin of the shard browser's facet. Hits the admin-gated
     * `GET /_lunora/admin/global/facet` endpoint; `column` is validated + bound
     * server-side. Powers the global data browser's facet sidebar.
     */
    public async facetGlobalColumn(options: { column: string; filters?: GlobalFilterClause[]; limit?: number; table: string }): Promise<GlobalFacetResult> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const params = new URLSearchParams({ column: options.column, table: options.table });

        if (options.limit !== undefined) {
            params.set("limit", String(options.limit));
        }

        if (options.filters !== undefined && options.filters.length > 0) {
            params.set("filters", JSON.stringify(options.filters));
        }

        return (await this.adminFetch(`${GLOBAL_FACET_PATH}?${params.toString()}`, "GET")) as GlobalFacetResult;
    }

    // --- Vector indexes admin -----------------------------------------------

    /**
     * List the schema's Vectorize indexes with their declared shape (table,
     * field, dimensions, metric, metadata) and live stats (vector count,
     * processing watermark) when the binding is reachable. Hits the admin-gated
     * `GET /_lunora/admin/vector/indexes` endpoint — the worker must be built
     * with a `vectorIntrospector` and `adminToken`. Powers the studio's vector
     * browser. Vectorize can't enumerate indexes at runtime, so this list comes
     * from the generated `LUNORA_VECTOR_INDEXES` registry.
     */
    public async listVectorIndexes(): Promise<VectorIndexSummary[]> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(VECTOR_INDEXES_PATH, "GET")) as { indexes?: VectorIndexSummary[] };

        return body.indexes ?? [];
    }

    /**
     * Run a nearest-neighbour similarity query against one vector index: the
     * worker embeds `text` via the index's embedder and returns the top matches.
     * Hits the admin-gated `POST /_lunora/admin/vector/query` endpoint. Throws
     * `VECTOR_QUERY_UNSUPPORTED` when the worker's introspector has no embedder
     * wired (the index lists read-only).
     */
    public async queryVectorIndex(options: { name: string; text: string; topK?: number }): Promise<VectorQueryMatch[]> {
        if (this.closed) {
            throw new Error("LunoraClient is closed");
        }

        const body = (await this.adminFetch(VECTOR_QUERY_PATH, "POST", options)) as { matches?: VectorQueryMatch[] };

        return body.matches ?? [];
    }

    // --- Auth admin ---------------------------------------------------------

    /**
     * List authenticated users, paged and optionally searched / filtered / sorted.
     * Hits the admin-gated `GET /_lunora/admin/auth/users` endpoint — the worker
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
            throw new Error("LunoraClient is closed");
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
     * Create a user. Hits the admin-gated `POST /_lunora/admin/auth/users/create`
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
            throw new Error("LunoraClient is closed");
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
            throw new Error("LunoraClient is closed");
        }

        const argsRecord = (args ?? {}) as Record<string, unknown>;
        const key = SubscriptionRegistry.key(function_.__lunoraRef, argsRecord, options.shardKey);

        let state = this.subscriptions.get(key);
        const subscriptionCallback = callback as SubscriptionCallback;
        const errorCallback = options.onError;

        if (!state) {
            this.nextSubId += 1;
            const id = `sub_${this.nextSubId.toString()}`;
            const argsKey = stableStringify(argsRecord);
            const cached = this.takeHydratedCache(function_.__lunoraRef, argsKey, options.shardKey);

            state = {
                acked: false,
                args: argsRecord,
                argsKey,
                callbacks: new Set<SubscriptionCallback>(),
                errorCallbacks: new Set<SubscriptionErrorCallback>(),
                fn: function_,
                id,
                lastValue: cached?.value,
                serverCursor: cached?.serverCursor,
                serverVersion: 0,
                shardKey: options.shardKey,
                ...(cached?.serverEpoch === undefined ? {} : { serverEpoch: cached.serverEpoch }),
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
            throw new Error("LunoraClient is closed");
        }

        if (this.WebSocketImpl === undefined) {
            throw new Error("LunoraClient: streams require a WebSocket implementation");
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
            query: { args: argsRecord, functionPath: function_.__lunoraRef, shardKey },
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
            stream.handle.fail(Object.assign(new Error("LunoraClient closed"), { code: "CLIENT_CLOSED" }));
        }

        this.streams.clear();

        for (const conn of this.connections.values()) {
            if (conn.reconnectTimer !== undefined) {
                clearTimeout(conn.reconnectTimer);
                conn.reconnectTimer = undefined;
            }

            if (conn.connectTimer !== undefined) {
                clearTimeout(conn.connectTimer);
                conn.connectTimer = undefined;
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

        // Persist any debounced read-cache writes still pending so the last
        // values survive the reload, then drop the timer.
        if (this.cacheFlushTimer !== undefined) {
            clearTimeout(this.cacheFlushTimer);
            this.cacheFlushTimer = undefined;
        }

        if (this.pendingCacheWrites.size > 0) {
            this.flushQueryCacheWrites().catch(() => undefined);
        }

        // Release client-held listener registries so callback closures (React
        // state setters, framework refs, user data) don't outlive the client.
        // The client is terminal after close(), so nothing should fire these.
        this.authTokenListeners.clear();
        this.statusListeners.clear();
        this.tokenExpiredListeners.clear();
        this.whisperHandlers.clear();
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

    /**
     * Load every cached query into {@link hydratedQueryCache} so the next
     * `subscribe()` for each key seeds its initial value off disk. A
     * subscription created before this resolves simply misses the cache (it
     * gets a live snapshot as before); the gate at seed time also drops any
     * entry whose stamped identity no longer matches the current one.
     */
    private async hydrateQueryCache(): Promise<void> {
        if (!this.queryCache) {
            return;
        }

        try {
            const entries = await this.queryCache.load();

            for (const { key, ...entry } of entries) {
                this.hydratedQueryCache.set(key, entry);
            }
        } catch {
            /* durable store unavailable — boot without restored reads */
        }
    }

    /**
     * Consume the hydrated read-cache entry for a key (if any), gated on
     * identity. The entry is removed whether or not it matches — the cache only
     * ever seeds a subscription's first value. A mismatch (the cache was written
     * under a different identity) yields `undefined` so a signed-out cache never
     * leaks into a new session.
     */

    private takeHydratedCache(functionPath: string, argsKey: string, shardKey?: string): CachedQuery | undefined {
        const key = queryCacheKey(functionPath, argsKey, shardKey);
        const entry = this.hydratedQueryCache.get(key);

        if (entry === undefined) {
            return undefined;
        }

        this.hydratedQueryCache.delete(key);

        return entry.identity === this.identityFingerprint() ? entry : undefined;
    }

    /**
     * Queue a coalesced read-cache write for a subscription's current value.
     * Latest-wins per key; flushed on a short debounce so a delta burst writes
     * once. No-op when the read cache is disabled or the value is undefined
     * (nothing to render offline).
     */
    private persistQueryValue(state: SubscriptionState): void {
        if (!this.queryCache || state.lastValue === undefined) {
            return;
        }

        const key = queryCacheKey(state.fn.__lunoraRef, state.argsKey, state.shardKey);

        this.pendingCacheWrites.set(key, {
            identity: this.identityFingerprint(),
            serverCursor: state.serverCursor,
            ts: Date.now(),
            value: state.lastValue,
            ...(state.serverEpoch === undefined ? {} : { serverEpoch: state.serverEpoch }),
        });

        this.cacheFlushTimer ??= setTimeout(() => {
            this.flushQueryCacheWrites().catch(() => undefined);
        }, QUERY_CACHE_DEBOUNCE_MS);
    }

    /** Drain {@link pendingCacheWrites} to the durable store. */
    private async flushQueryCacheWrites(): Promise<void> {
        this.cacheFlushTimer = undefined;

        const { queryCache } = this;

        if (!queryCache) {
            this.pendingCacheWrites.clear();

            return;
        }

        const batch = [...this.pendingCacheWrites.entries()];

        this.pendingCacheWrites.clear();

        // Writes are independent; fire them together and swallow individual
        // failures (a quota error on one key must not drop the others).
        await Promise.allSettled(batch.map(([key, entry]) => queryCache.put(key, entry)));
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
            if (state.fn.__lunoraRef !== functionRef || state.shardKey !== mutationShardKey || state.argsKey !== mutationArgsKey) {
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
                connectTimer: undefined,
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

    /**
     * Build the outbound RPC headers: JSON content type, optional bearer auth,
     * the optional mutation-replay idempotency key, and the D1 read-your-writes
     * bookmark when the caller opted into `attachBookmark`. The mutation id
     * rides both the direct send and any offline-queue replay of the same write,
     * so a mutation the server already committed returns its cached result
     * instead of running twice.
     */
    private rpcRequestHeaders(flags: { attachBookmark?: boolean; mutationId?: string }): Record<string, string> {
        const headers: Record<string, string> = { "content-type": "application/json" };

        if (this.authToken) {
            headers["authorization"] = `Bearer ${this.authToken}`;
        }

        if (flags.mutationId) {
            headers["x-lunora-mutation-id"] = flags.mutationId;
        }

        if (flags.attachBookmark) {
            const bookmark = this.bookmark.get();

            if (bookmark) {
                headers["x-d1-bookmark"] = bookmark;
            }
        }

        return headers;
    }

    private async rpc(
        functionPath: string,
        args: Record<string, unknown>,
        shardKey: string | undefined,
        flags: { attachBookmark?: boolean; captureBookmark?: boolean; mutationId?: string } = {},
    ): Promise<unknown> {
        if (!this.fetchImpl) {
            throw new Error("LunoraClient: no `fetch` implementation available");
        }

        const headers = this.rpcRequestHeaders(flags);

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

            throw new Error(`LunoraClient: response was not JSON (status ${response.status.toString()}${statusText})`);
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

            throw new Error(`LunoraClient: request failed (status ${response.status.toString()}${statusText})`);
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
            throw new Error("LunoraClient: no `fetch` implementation available");
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

            throw new Error(`LunoraClient: response was not JSON (status ${response.status.toString()}${statusText})`);
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

            throw new Error(`LunoraClient: admin request failed (status ${response.status.toString()}${statusText})`);
        }

        return body;
    }

    /**
     * Resolve the effective connection context for a shard: the most-recently
     * acquired refcounted holder ({@link acquireConnectionContext}) wins, falling
     * back to the imperative {@link setConnectionContext} override, then the
     * client-wide default. Returns `undefined` when none apply.
     */
    private effectiveConnectionContext(key: string): Record<string, unknown> | undefined {
        const holders = this.connectionContextHolders.get(key);

        if (holders && holders.length > 0) {
            return holders[holders.length - 1]?.context;
        }

        return this.connectionContexts.get(key) ?? this.defaultConnectionContext;
    }

    /** Re-send the `connect` envelope for a shard whose effective context just changed (if its socket is open). */
    private refreshConnectionContext(key: string): void {
        const conn = this.connections.get(key);

        if (conn?.wsState === "open") {
            this.sendConnectEnvelope(conn);
        }
    }

    /**
     * Send the one-shot `connect` envelope on an open shard socket. Always sent
     * once per socket open, so the server's `onConnect` hooks fire symmetrically
     * with `onDisconnect` (which the DO dispatches unconditionally at close for
     * every lifecycle-aware socket). The DO no-ops cheaply when no `onConnect`
     * hooks are registered, so the single frame costs nothing in the common case.
     *
     * The shard's registered context (or the client-wide default) rides along
     * when one is set — the DO records it on the attachment for replay to
     * `onDisconnect`. A socket with no registered context still announces itself;
     * the envelope simply omits `context`, which is optional on the wire.
     * Register a context — e.g. `setConnectionContext({})` — to attach app state
     * to the lifecycle dispatch.
     */
    private sendConnectEnvelope(conn: ShardConnection): void {
        const context = this.effectiveConnectionContext(connectionKey(conn.shardKey));

        sendOn(conn, {
            id: "connect",
            type: "connect",
            ...(context === undefined ? {} : { context }),
        });
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

        // Fail-fast connect timeout: if the handshake doesn't reach `open` within
        // `connectTimeoutMs` (a hung proxy / cold worker that never upgrades),
        // force-close the socket so `close` → `handleDisconnect` arms the normal
        // reconnect/backoff and surfaces `offline` — instead of the live channel
        // hanging on the browser's much longer default. Cleared on `open`/disconnect.
        if (this.connectTimeoutMs > 0) {
            conn.connectTimer = setTimeout(() => {
                conn.connectTimer = undefined;

                // Only act if still connecting (open/close already cleared this).
                if (conn.wsState !== "connecting") {
                    return;
                }

                try {
                    socket.close();
                } catch {
                    /* a stuck socket may throw on close — the disconnect below still arms reconnect */
                }

                this.handleDisconnect(conn);
            }, this.connectTimeoutMs);
        }

        socket.addEventListener("open", (): void => {
            if (conn.connectTimer !== undefined) {
                clearTimeout(conn.connectTimer);
                conn.connectTimer = undefined;
            }

            conn.wsState = "open";
            conn.wasEverConnected = true;
            conn.reconnect.reset();
            this.emitConnectionStatus();

            // Announce the connection (and its app context) before resubscribing,
            // so the server's `onConnect` hooks run with context in place and the
            // context is recorded for replay to `onDisconnect` at close.
            this.sendConnectEnvelope(conn);

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

            // Rejoin every whisper topic registered for this shard so ephemeral
            // channels survive a socket bounce.
            const byTopic = this.whisperHandlers.get(connectionKey(shardKey));

            if (byTopic) {
                for (const topic of byTopic.keys()) {
                    sendOn(conn, { topic, type: "whisper_subscribe" });
                }
            }

            this.flushOfflineQueue(shardKey).catch(() => undefined);

            this.startHeartbeat(conn);
        });

        socket.addEventListener("message", (event: MessageEvent): void => {
            this.handleServerMessage(event.data, shardKey);
        });

        socket.addEventListener("close", (event?: { code?: number }): void => {
            // Close code 4001 is the server's `token_expired` signal: notify
            // listeners so the app can refresh its credential before the
            // (always-armed) reconnect re-resolves identity. The event is
            // optional — some WS doubles fire `close` without one.
            if (event?.code === 4001) {
                this.notifyTokenExpired();
            }

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

        // Cancel the fail-fast connect timer: a `close`/`error` reached us before
        // (or because of) the timeout, so the reconnect path below owns recovery.
        if (conn.connectTimer !== undefined) {
            clearTimeout(conn.connectTimer);
            conn.connectTimer = undefined;
        }

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
        // surfaced a distinct `__lunoraTable`.
        const table = (state.fn as FunctionReference & { __lunoraTable?: string }).__lunoraTable ?? state.fn.__lunoraRef;

        sendOn(conn, {
            id: state.id,
            // `sinceSeq` rides along when we hold a persisted cursor for this
            // sub (a hydrated read or an earlier frame), so the server can
            // resume instead of re-snapshotting. Omitted on a cold sub.
            query: {
                args: state.args,
                functionPath: state.fn.__lunoraRef,
                table,
                ...(state.serverCursor === undefined ? {} : { sinceSeq: state.serverCursor }),
                ...(state.serverEpoch === undefined ? {} : { sinceEpoch: state.serverEpoch }),
            },
            type: "subscribe",
        });
    }

    private handleServerMessage(raw: unknown, shardKey?: string): void {
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
            case "resume": {
                this.handleResumeMessage(message);

                break;
            }
            case "whisper": {
                this.dispatchWhisper(message, shardKey);

                break;
            }
            default: {
                break;
            }
        }
    }

    private handleErrorMessage(message: ServerErrorMessage): void {
        // Token-expiry rejection (sent just before the server closes the socket
        // with code 4001). Surface it to listeners; the close handler also fires
        // and arms the reconnect, so nothing else to do here.
        const errorCode = (message.error as { code?: unknown } | undefined)?.code;

        if (errorCode === "TOKEN_EXPIRED") {
            this.notifyTokenExpired();

            return;
        }

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
            const error = buildSubscriptionError(message);

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

        // Advance the resume cursor + epoch when the frame carries them
        // (CDC-enabled shard); replayed as `sinceSeq` / `sinceEpoch` on the
        // next reconnect.
        if (message.cursor !== undefined) {
            state.serverCursor = message.cursor;
        }

        if (message.epoch !== undefined) {
            state.serverEpoch = message.epoch;
        }

        // Persist the new value to the durable read cache (debounced).
        this.persistQueryValue(state);

        for (const callback of state.callbacks) {
            try {
                callback(payload);
            } catch {
                /* user callback threw — ignore */
            }
        }
    }

    /**
     * Handle a `resume` frame (Pillar 1b): the server proved nothing the
     * subscription reads changed since our `sinceSeq`, so the cached value is
     * still current. We keep `lastValue` as-is, mark the sub acked, and advance
     * the cursor (re-persisting so the next reconnect resumes from the newer
     * watermark). No callback fires — the value didn't change, and `subscribe()`
     * already replayed the cached value to every consumer synchronously.
     */
    private handleResumeMessage(message: ServerResumeMessage): void {
        const state = this.subscriptions.getById(message.id);

        if (!state) {
            return;
        }

        state.acked = true;

        if ((message.cursor !== undefined && message.cursor !== state.serverCursor) || (message.epoch !== undefined && message.epoch !== state.serverEpoch)) {
            if (message.cursor !== undefined) {
                state.serverCursor = message.cursor;
            }

            if (message.epoch !== undefined) {
                state.serverEpoch = message.epoch;
            }

            this.persistQueryValue(state);
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

    /** Route an inbound whisper to the topic's handlers on the originating shard. */
    private dispatchWhisper(message: ServerWhisperMessage, shardKey?: string): void {
        const handlers = this.whisperHandlers.get(connectionKey(shardKey))?.get(message.topic);

        if (!handlers) {
            return;
        }

        for (const handler of handlers) {
            try {
                handler(message.data, message.from);
            } catch {
                /* user callback threw — ignore */
            }
        }
    }

    /** Notify every {@link onTokenExpired} listener (best-effort, listener throws swallowed). */
    private notifyTokenExpired(): void {
        for (const listener of this.tokenExpiredListeners) {
            try {
                listener();
            } catch {
                /* listener threw — ignore */
            }
        }
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
            this.persistence?.remove(id).catch((error: unknown) => {
                reportPersistenceError(this.onPersistenceError, "remove", error, id);
            });
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

        this.clearQueryCacheForIdentityChange();
    }

    /**
     * Drop the durable read cache on an identity change so a cached value stamped
     * under the previous identity can never hydrate into a new session. Clears
     * the in-flight write batch and the not-yet-consumed hydrated entries too;
     * the durable `clear()` is best-effort.
     */
    private clearQueryCacheForIdentityChange(): void {
        if (this.cacheFlushTimer !== undefined) {
            clearTimeout(this.cacheFlushTimer);
            this.cacheFlushTimer = undefined;
        }

        this.pendingCacheWrites.clear();
        this.hydratedQueryCache.clear();
        this.queryCache?.clear().catch(() => undefined);
    }

    private async flushOfflineQueue(shardKey: string | undefined): Promise<void> {
        const key = connectionKey(shardKey);
        const drained = this.offlineQueue.drain((item) => connectionKey(item.shardKey) === key);

        // Sequential replay — parallel `.then()` chains would race and break
        // the FIFO ordering callers rely on, particularly when replayed
        // mutations depend on each other.
        for (let index = 0; index < drained.length; index += 1) {
            const item = drained[index];

            if (!item) {
                continue;
            }

            // Re-read the live identity *per item*, at the point of sending,
            // rather than once at flush start. A `setAuthToken` / token rotation
            // during the `await this.rpc(...)` below changes the identity
            // mid-flush; items already drained into `drained` have left the queue
            // and so escape the eager `rejectQueuedForIdentityChange` drain — so
            // the only place left to re-gate them is here. Capturing once would
            // let a write enqueued under user A replay against the loop's
            // start-of-flush identity even after the session rotated to user B.
            const currentIdentity = this.identityFingerprint();
            // Identity guard: a write stamped under one identity must never
            // replay under another. The live `queuedIdentities` map is the
            // source of truth for the current session; a hydrated write whose id
            // isn't in the map falls back to the stamp persisted with the record
            // (`item.identity`), so a reload can no longer replay another user's
            // queued writes. Only legacy records (persisted before stamps were
            // durable — `item.identity === undefined`) replay under whatever
            // identity is current, matching the prior ambient behaviour.
            // Mismatches are rejected, not silently dropped, so awaiting callers
            // see a deterministic failure.
            //
            // `Map.get` returns `undefined` for unstamped/hydrated ids and
            // `item.identity` is `undefined` for legacy records; a persisted
            // `null` (queued while signed out) is a real value that must not be
            // collapsed into `undefined` — hence the explicit `=== undefined`
            // check rather than `??`.
            const liveStamp = item.id === undefined ? undefined : this.queuedIdentities.get(item.id);
            const stamped = liveStamp === undefined ? item.identity : liveStamp;

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
                // Replay under the write's stable id so the server dedups a
                // mutation it already committed (e.g. the response was lost on the
                // first send) — exactly-once rather than at-least-once.
                // eslint-disable-next-line no-await-in-loop -- sequential replay preserves the FIFO order callers depend on (see above)
                const value = await this.rpc(item.functionPath, item.args, item.shardKey, { captureBookmark: true, mutationId: item.id });

                this.unpersist(item.id);
                item.resolve(value);
            } catch (error) {
                // Only a *coded* error means the server reached a verdict on a
                // mutation it received: replaying would re-trigger the same
                // failure (a poison-message loop), so drop it. Transport/transient
                // failures — offline mid-replay, a 5xx, a non-JSON body — carry no
                // code and may mean the write never committed; dropping one here
                // would silently lose a durable write the queue exists to protect.
                if ((error as { code?: string }).code !== undefined) {
                    this.unpersist(item.id);
                    item.reject(error);

                    continue;
                }

                // Stop the flush and re-queue this write and every unreplayed one
                // (still in durable storage) in FIFO order. Their callers stay
                // pending; the next reconnect retries them. The identity guard
                // still applies on retry via each record's persisted stamp.
                this.offlineQueue.requeue(drained.slice(index));

                return;
            }
        }
    }
}

export { LunoraClient };
export type { ConnectionStatus, MutationCallOptions };
