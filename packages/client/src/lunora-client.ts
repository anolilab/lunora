import { LunoraError } from "@lunora/errors";

import { MAX_BATCH_ENTRIES } from "../../../shared/batch-wire";
import { collectPages } from "../../../shared/collect-pages";
import { evictOldestEntry } from "../../../shared/evict-oldest";
import { PAGE_DELTA_CAPABILITY } from "../../../shared/page-result";
import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import { stableWireKey } from "../../../shared/wire-key";
import createInMemoryBookmarkStorage from "./bookmark";
import type { ClientQueryRef } from "./client-query-store";
import { ClientQueryStore } from "./client-query-store";
import { TabCoordinator } from "./cross-tab";
import { applyDelta, isMutationDelta } from "./delta-merge";
import type { LunoraErrorCode } from "./errors";
import { TransportError } from "./errors";
import { httpStream } from "./http-stream";
import Listeners from "./listeners";
import type { OptimisticUpdate } from "./local-store";
import { createLocalStore } from "./local-store";
import type { QueuedMutation } from "./offline-queue";
import { nextId, OfflineQueue, reportPersistenceError } from "./offline-queue";
import type { OptimisticLayerHandle } from "./optimistic-layers";
import { applyOptimisticLayer, dropConfirmedLayers, foldOptimistic, notifySubscription } from "./optimistic-layers";
import isStaleVersion from "./persisted-version";
import { resolvePersistenceAdapter } from "./persistence";
import { queryCacheKey, resolveQueryCacheAdapter } from "./query-cache";
import type { ReconnectCalculator } from "./reconnect";
import { createReconnect } from "./reconnect";
import {
    isTransientReplayFailure,
    MAX_BATCH_BODY_BYTES,
    replayRetryDelayMs,
    retryAfterData,
    TRANSIENT_REPLAY_ERROR_CODES,
    unparseableResponseError,
    utf8ByteLength,
} from "./replay";
import createSnapshotPrecondition from "./snapshot-precondition";
import type { StreamHandle, StreamIterable } from "./stream";
import { createStream } from "./stream";
import type { SubscriptionCallback, SubscriptionError, SubscriptionErrorCallback, SubscriptionState } from "./subscription";
import { SubscriptionRegistry } from "./subscription";
import type {
    ArgsOf,
    AuthCapabilities,
    AuthConfigInfo,
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
    HttpStreamArgsOf,
    HttpStreamChunkOf,
    HttpStreamRef,
    KvKeyListResult,
    KvNamespaceSummary,
    KvValueResult,
    LunoraClientOptions,
    OutboxSink,
    PersistenceAdapter,
    PersistenceErrorContext,
    PipelineLogPage,
    PipelineLogQuery,
    QueryCacheAdapter,
    ReconnectOptions,
    ReturnOf,
    RowOp,
    RpcResponseBody,
    ScheduleRecord,
    SchedulerStatus,
    ServerDataMessage,
    ServerErrorMessage,
    ServerMessage,
    ServerPokeEndMessage,
    ServerPokePartMessage,
    ServerPokeStartMessage,
    ServerResumeMessage,
    ServerSettledMessage,
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
    WsTokenProvider,
} from "./types";

const RPC_PATH = "/_lunora/rpc";
const RPC_BATCH_PATH = "/_lunora/rpc-batch";
const WS_PATH = "/_lunora/ws";

/** Build the `&bucket=…` query fragment for a storage admin request, or `""` when no bucket is selected. */
const bucketQuery = (bucket?: string): string => (bucket === undefined || bucket === "" ? "" : `&bucket=${encodeURIComponent(bucket)}`);

/**
 * Unwind a LIFO stack of optimistic-update rollbacks, most-recent first, so a
 * stacked update on the same subscription restores the immediately-prior value
 * rather than clobbering a newer still-pending optimistic value.
 */
const rollbackOptimistic = (optimisticRollbacks: (() => void)[]): void => {
    for (let index = optimisticRollbacks.length - 1; index >= 0; index -= 1) {
        optimisticRollbacks[index]?.();
    }
};

/**
 * Sentinel returned by `resolveDataPayload` for a frame the client RECOGNISED as
 * a row delta but could not merge. Distinct from any real payload (a symbol can
 * never come off the wire), so the caller can re-snapshot instead of publishing
 * the raw `{ key, op, table, row }` envelope as the query's value.
 */
const UNMERGEABLE_DELTA = Symbol("lunora.unmergeableDelta");

/** Apply a shape's buffered row-ops to its keyed view in order: a delete removes the key, an upsert sets it (a value-less upsert is skipped — membership-only signal). */
const applyRowOpsToView = (rows: Map<string, Record<string, unknown>>, ops: RowOp[]): void => {
    for (const op of ops) {
        if (op.op === "delete") {
            rows.delete(op.key);
        } else if (op.value !== undefined) {
            rows.set(op.key, op.value);
        }
    }
};

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
 * How long a socket must stay open before its reconnect backoff is reset.
 *
 * Comfortably longer than a credential rejection takes: the server accepts the
 * upgrade, reads the credential on the first frame, then sends `TOKEN_EXPIRED`
 * and closes 4001 — all within a round trip. Anything still open after this has
 * demonstrably been accepted.
 */
const SOCKET_STABLE_MS = 5000;

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
const LOG_ARCHIVE_PATH = "/_lunora/admin/logs/archive";
const KV_NAMESPACES_PATH = "/_lunora/admin/kv/namespaces";
const KV_KEYS_PATH = "/_lunora/admin/kv/keys";
const KV_VALUE_PATH = "/_lunora/admin/kv/value";
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
const AUTH_CONFIG_PATH = "/_lunora/admin/auth/config";
const AUTH_CREATE_ORG_PATH = "/_lunora/admin/auth/organizations/create";
const AUTH_UPDATE_ORG_PATH = "/_lunora/admin/auth/organizations/update";
const AUTH_REMOVE_ORG_PATH = "/_lunora/admin/auth/organizations/remove";
const AUTH_ADD_MEMBER_PATH = "/_lunora/admin/auth/organizations/members/add";
const AUTH_INVITE_MEMBER_PATH = "/_lunora/admin/auth/organizations/members/invite";
const AUTH_MEMBER_ROLE_PATH = "/_lunora/admin/auth/organizations/members/role";
const AUTH_ORG_TEAMS_PATH = "/_lunora/admin/auth/organizations/teams";
const AUTH_CREATE_TEAM_PATH = "/_lunora/admin/auth/organizations/teams/create";
const AUTH_UPDATE_TEAM_PATH = "/_lunora/admin/auth/organizations/teams/update";
const AUTH_REMOVE_TEAM_PATH = "/_lunora/admin/auth/organizations/teams/remove";
const AUTH_ORG_TEAM_MEMBERS_PATH = "/_lunora/admin/auth/organizations/teams/members";
const AUTH_ADD_TEAM_MEMBER_PATH = "/_lunora/admin/auth/organizations/teams/members/add";
const AUTH_REMOVE_TEAM_MEMBER_PATH = "/_lunora/admin/auth/organizations/teams/members/remove";
const AUTH_ORG_ROLES_PATH = "/_lunora/admin/auth/organizations/roles";
const AUTH_CREATE_ROLE_PATH = "/_lunora/admin/auth/organizations/roles/create";
const AUTH_UPDATE_ROLE_PATH = "/_lunora/admin/auth/organizations/roles/update";
const AUTH_REMOVE_ROLE_PATH = "/_lunora/admin/auth/organizations/roles/remove";

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

/** One shard's socket + watermark state in a {@link LunoraClient.debug} snapshot. */
interface ClientDebugShard {
    /**
     * Highest custom-mutator watermark the server has echoed for this client on this
     * shard. A write whose `clientSeq` is above this has been sent but not confirmed
     * — the first thing to check when an optimistic overlay won't clear.
     */
    confirmedMutationWatermark: number;
    /** Whether a `WebSocket` object currently exists (distinct from it being open). */
    hasSocket: boolean;
    /** `undefined` for the default (unsharded) connection. */
    shardKey: string | undefined;

    /** Whether this shard's socket has ever completed a handshake — gates offline queueing. */
    wasEverConnected: boolean;
    wsState: WSState;
}

/** One live query or shape subscription in a {@link LunoraClient.debug} snapshot. */
interface ClientDebugSubscription {
    /** Whether the server has acknowledged the subscription on the current socket. */
    acked: boolean;
    /** `namespace:fn` for a query, `shape:<name>` for a replication shape. */
    functionPath: string;
    id: string;
    kind: "query" | "shape";
    /** Highest custom-mutator watermark echoed on THIS subscription (absent until a `settled`/poke frame arrives). */
    lastMutationId?: number;
    /** Per-call optimistic layers still folded onto this subscription's value — a non-zero count with no pending write is a leak. */
    pendingOptimisticLayers: number;
    /** Replicated rowset size (shapes only). */
    rowCount?: number;
    /** The `__cdc_log` cursor the current value reflects. */
    serverCursor?: number;
    shardKey: string | undefined;
    /** How many callers share this subscription (subscriptions are deduped by `(fn, args, shard)`). */
    subscriberCount: number;
}

/**
 * Everything the sync engine believes at one instant — see
 * {@link LunoraClient.debug} for why this exists.
 */
interface ClientDebugSnapshot {
    /** The watermark key the server's custom-mutator protocol advances per `clientSeq`. */
    clientId: string;
    closed: boolean;
    connectionStatus: ConnectionStatus;
    /** Writes waiting in the built-in offline queue (not the `@lunora/db` outbox). */
    pendingWrites: number;
    shards: ClientDebugShard[];
    subscriptions: ClientDebugSubscription[];
}

/**
 * Terminal verdict for a mutation that passed through the offline queue,
 * delivered to {@link LunoraClient.onMutationSettled}.
 *
 * Unlike the Promise returned by {@link LunoraClient.mutation} — which only the
 * original caller can await, and which no longer exists after a reload — this
 * fires for *every* queued write the server (or the queue) reaches a verdict on,
 * including writes restored from durable storage in a later session. It is the
 * channel a UI uses to tell the user "your queued change couldn't be saved"
 * instead of silently dropping a rolled-back optimistic row.
 *
 * `status: "rejected"` carries the failure `code` (e.g. `CONFLICT`,
 * `OFFLINE_QUEUE_OVERFLOW`, `OFFLINE_IDENTITY_CHANGED`) and the `error`.
 * `hadAwaiter` is `false` for a write whose original `mutation()` Promise is
 * gone (a hydrated/post-reload replay or an eviction), so a listener can tell
 * "the caller already saw this" apart from "nothing else will report this".
 */
interface MutationSettledEvent {
    /** The write's args, so a listener can describe or re-offer the change. */
    readonly args: Record<string, unknown>;
    /** Server/queue error code on `rejected` (e.g. `CONFLICT`), when present. */
    readonly code?: string;
    /** The rejection error on `status: "rejected"`. */
    readonly error?: unknown;
    /** The `<file>:<function>` reference of the mutation. */
    readonly functionPath: string;
    /** Whether a live caller was still awaiting this write's `mutation()` Promise. */
    readonly hadAwaiter: boolean;
    /** The write's stable id (idempotency key / queue id). */
    readonly id: string;
    /** Shard the write targeted, if any. */
    readonly shardKey?: string;
    /** Terminal outcome. */
    readonly status: "committed" | "rejected";
}

/**
 * Per-call options for {@link LunoraClient.action} — just `shardKey`, since an
 * action is not a write and carries none of the optimistic machinery. Exported
 * (at the end of this file) for the same reason {@link MutationCallOptions} is:
 * so the framework adapters (`@lunora/react`, `/solid`, `/svelte`, `/vue`,
 * `/angular`) type their `call(args, options?)` against one canonical
 * definition. Add an option here and every adapter forwards it; re-declare it
 * per adapter and they silently cannot.
 */
interface ActionCallOptions {
    /** Route the call to a specific shard. */
    shardKey?: string;
}

/**
 * Per-call options for {@link LunoraClient.mutation} — the optimistic-update
 * machinery plus `shardKey`. Exported (at the end of this file) so the framework
 * adapters (`@lunora/react`, `/solid`, `/svelte`, `/vue`) can type their
 * `mutate(args, options?)` against one canonical definition instead of
 * re-declaring it.
 */
interface MutationCallOptions<TCurrent = unknown, TValue = unknown, TArgs = unknown> {
    /**
     * Override the auto-generated idempotency key (`x-lunora-mutation-id`). Lets a
     * durable outbox replay a committed-but-unacked write under its *original* key
     * so the server dedups it instead of applying it twice. Omit for normal calls —
     * each then gets a fresh key.
     */
    mutationId?: string;
    optimistic?: (current: TCurrent | undefined) => TValue;

    /**
     * Convex-parity multi-query optimistic update. Receives an
     * `OptimisticLocalStore` over the live subscription cache plus the
     * mutation's args, so one mutation can patch many subscribed queries at
     * once; every write is rolled back atomically if the mutation fails.
     */
    optimisticUpdate?: OptimisticUpdate<TArgs>;

    /**
     * Sync predicate evaluated just before the offline queue replays this
     * write on reconnect. When it returns `false` the mutation is dropped
     * instead of replayed — use it to guard against replaying writes whose
     * assumptions are no longer valid (e.g. the document it referred to was
     * deleted by another client while this tab was offline).
     */
    precondition?: () => boolean;
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

    /**
     * The {@link LunoraClient.identityFingerprint} captured when this connection's
     * CURRENT socket was opened (`undefined` before the first attempt).
     *
     * A WebSocket credential is pinned in the upgrade URL and cannot be rotated
     * in place, so a `setAuthToken` that switches users leaves this socket
     * authenticated as the PREVIOUS one — it keeps delivering that user's rows
     * until something closes it, which on a client without `crossTabSync` is
     * nothing. Reading the live fingerprint when such a frame lands stamps the
     * previous user's data with the new user's identity; the durable read cache
     * (on by default in browsers) then hydrates it into the new session on the
     * next reload. Stamping what the SOCKET is authenticated as instead keeps
     * the cache's identity gate able to reject it.
     */
    identity?: string | null;

    /**
     * Wall-clock time (`Date.now()`) of the most recently received frame on
     * this connection's socket — ANY frame, including the plain-string
     * `lunora-pong` keepalive reply, which never reaches `handleServerMessage`'s
     * JSON parsing. Reset on every `open` so a fresh (re)connect starts its
     * watchdog window clean. The heartbeat tick force-closes a socket that's
     * gone quiet for more than `heartbeatIntervalMs * 2.5` despite reporting
     * `wsState === "open"` — a half-open socket (a proxy that swallowed the
     * close, a hibernation edge case) that would otherwise never fire `close`
     * and silently stale every live query bound to it forever.
     */
    lastFrameAt: number;
    /** Stream-start frames buffered while the socket was (re)connecting. Flushed on `open`. */
    pendingStreams?: ClientMessage[];
    /** Unsubscribes that couldn't be sent while the socket was down, each tagged with its wire type so a shape sub is torn down as `shape_unsubscribe`, never the legacy `unsubscribe`. */
    pendingUnsubscribes: { id: string; type: "shape_unsubscribe" | "unsubscribe" }[];
    reconnect: ReconnectCalculator;
    reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    /** `undefined` for the default shard (connects without a `shard` param). */
    readonly shardKey: string | undefined;
    socket: undefined | WebSocket;

    /**
     * Armed on `open`; resets the reconnect backoff if the socket is STILL open
     * when it fires. Cleared on disconnect/close.
     *
     * `open` is not proof — the upgrade is accepted before the credential is
     * read. The first inbound frame is not proof either for every client: the
     * server sends no ack for the `connect` envelope, and the keepalive pong is
     * a plain string answered by the runtime without waking the DO, so a client
     * with no active subscription may receive no JSON frame at all.
     *
     * Surviving this window is the proof. A rejected credential arrives as a
     * `TOKEN_EXPIRED` frame and a 4001 close within a round trip, well inside
     * it, and that path clears this timer before it can fire.
     */
    stableTimer: ReturnType<typeof setTimeout> | undefined;
    wasEverConnected: boolean;
    wsState: WSState;
}

/**
 * The subset of a connection's own state {@link LunoraClient.openManagedSocket}
 * manages directly: the live socket (the identity-guard's comparand), the
 * fail-fast connect-timeout, and the keepalive heartbeat with its half-open
 * watchdog (plan 217). `ShardConnection` satisfies this structurally, so the
 * shard socket passes itself straight through; `subscribeScheduledJobs`
 * constructs a small matching record so it inherits the same guarantees
 * instead of hand-rolling a second, divergent implementation (CLIENT-05).
 */
interface ManagedSocketState {
    connectTimer: ReturnType<typeof setTimeout> | undefined;
    heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    lastFrameAt: number;
    socket: undefined | WebSocket;
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

/**
 * Capability tokens this client announces on its `connect` frame — wire
 * behaviours it can handle that an older client cannot.
 *
 * `PAGE_DELTA_CAPABILITY` says `applyDelta` can merge a row delta into the
 * `page` of a `.paginate()` result, so the server may answer a paginated live
 * query with row deltas instead of re-sending the whole page on every write.
 *
 * Strictly additive: a server that does not recognise a token ignores it and
 * keeps sending what it always did. The token comes from `shared/` rather than
 * being retyped here, so a mismatch with the server's gate is impossible.
 */
const CLIENT_CAPABILITIES = [PAGE_DELTA_CAPABILITY] as const;

/** Map a shard key to its connection-map key (the default shard uses `""`). */
const connectionKey = (shardKey: string | undefined): string => shardKey ?? "";

/**
 * Pull the `code`/`message` off a server `error` frame — either the top-level
 * fields or the nested `error` envelope (the server uses both shapes) — falling
 * back to `fallbackMessage` when neither carries a usable message.
 */
const parseServerError = (message: ServerErrorMessage, fallbackMessage: string): { code: string | undefined; messageText: string } => {
    const errorEnvelope = message.error as { code?: unknown; message?: unknown } | undefined;
    const code = typeof errorEnvelope?.code === "string" ? errorEnvelope.code : undefined;
    const nestedMessage = typeof errorEnvelope?.message === "string" ? errorEnvelope.message : undefined;

    return { code, messageText: (typeof message.message === "string" ? message.message : undefined) ?? nestedMessage ?? fallbackMessage };
};

/** Build a coded `Error` from a stream-scoped server `error` frame. */
const buildStreamError = (message: ServerErrorMessage): Error => {
    const { code, messageText } = parseServerError(message, "stream error");

    return code === undefined ? new Error(messageText) : new LunoraError(code, messageText);
};

/**
 * Build a {@link SubscriptionError} from a subscription-scoped server `error`
 * frame, so an `onError` consumer can branch on a coded rejection instead of
 * only seeing the human message.
 */
const buildSubscriptionError = (message: ServerErrorMessage): SubscriptionError => {
    const { code, messageText } = parseServerError(message, "subscription error");

    return { message: messageText, ...(code === undefined ? {} : { code }) };
};

/**
 * Wrap a subscriber's callback in a fresh closure, so registering it in a
 * `Set` gives THIS subscriber its own slot.
 *
 * Registering the caller's own function directly deduped two consumers that
 * passed the SAME reference — a module-level handler, a `useCallback`-stable
 * one — down to a single Set entry, so the first `unsubscribe()` emptied the
 * set and tore the shared registration out from under the second consumer.
 * Passes `undefined` through so an unset `onError`/`onCheckpoint` stays unset.
 */
function wrapSubscriber<A>(callback: (argument: A) => void): (argument: A) => void;
function wrapSubscriber<A>(callback: ((argument: A) => void) | undefined): ((argument: A) => void) | undefined;
function wrapSubscriber<A>(callback: ((argument: A) => void) | undefined): ((argument: A) => void) | undefined {
    if (callback === undefined) {
        return undefined;
    }

    return (argument: A): void => {
        callback(argument);
    };
}

/** Fan an error out to every registered `onError` callback, swallowing throws so one bad listener can't starve the rest. */
const fanSubscriptionError = (callbacks: Iterable<SubscriptionErrorCallback>, error: SubscriptionError): void => {
    for (const errorCallback of callbacks) {
        try {
            errorCallback(error);
        } catch {
            /* user callback threw — ignore */
        }
    }
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

/** Callback a shape subscription invokes with its materialized rowset on every applied poke. */
type ShapeCallback = (rows: Record<string, unknown>[]) => void;

/**
 * The high-water marks a shape poke has now synced to the client: `checkpoint`
 * is the op-log cursor and `mutationId` the highest custom-mutator id the server
 * echoed for this client. A `@lunora/db` collection feeds these into its
 * checkpoint registry to drop optimistic overlays once the server's authoritative
 * rows have landed.
 */
interface SyncWatermark {
    checkpoint?: number;
    mutationId?: number;
}

/**
 * One live shape subscription's client state — the partial-replication parallel
 * to {@link SubscriptionState}. The view is a keyed map of the rows currently in
 * the shape (built up from seed + live poke diffs); `serverCursor`/`serverEpoch`
 * carry the last applied checkpoint so a reconnect resumes via `sinceCheckpoint`
 * instead of re-seeding.
 */
interface ShapeSubscriptionState {
    args: Record<string, unknown> | undefined;
    callbacks: Set<ShapeCallback>;
    errorCallbacks: Set<SubscriptionErrorCallback>;
    id: string;
    /** Highest custom-mutator watermark the server has echoed for this client on this shape. */
    lastMutationId?: number;
    name: string;
    /** Invoked after each applied poke with the watermark this shape has now synced. */
    onCheckpoint?: (watermark: SyncWatermark) => void;
    /** The shape's current rowset, keyed by `_id`. */
    rows: Map<string, Record<string, unknown>>;
    serverCursor?: number;
    serverEpoch?: string;
    shardKey: string | undefined;

    /**
     * The wire-encoded form of `args`, computed once at `subscribeShape` time (so
     * an unsupported value fails loud at the call site, not inside a reconnect's
     * open handler). Sent on every `shape_subscribe` frame — identical to `args`
     * for pure JSON, tagged tokens for `bigint`/`Date`/bytes/… (the shard
     * `decodeWire`s them before resolving the shape).
     */
    wireArgs: Record<string, unknown> | undefined;
}

/** A poke being assembled between `pokeStart` and `pokeEnd` — parts buffered per shape, applied atomically at end. */
interface PokeBuffer {
    /** Poke-level fallback base, used for a part that names none of its own. */
    baseCheckpoint: number | undefined;

    /** Per-shape base checkpoint: the cursor this shape's view must be at for the part's diff to splice on cleanly. */
    bases: Map<string, number>;
    epoch: string | undefined;
    lastMutationId: Map<string, number>;
    parts: Map<string, RowOp[]>;

    /** Shapes whose part carries the COMPLETE membership — their view is dropped before the ops apply. */
    resets: Set<string>;
}

/**
 * An `Error` carrying the server's machine-readable `code` and (for a
 * `LunoraError`) structured `data`, plus an optional actionable `hint` (Markdown)
 * and `docsUrl` resolved from the central error catalog. The client's public
 * error contract for RPC/batch failures — a UI can render `hint`/`docsUrl` to
 * tell the user how to fix the error. The `(string & {})` arm keeps
 * forward-compat/unknown server codes assignable without losing autocomplete on
 * the known {@link LunoraErrorCode} union.
 */
type LunoraClientError = Error & { code?: LunoraErrorCode | (string & {}); data?: unknown; docsUrl?: string; hint?: string | string[] };

/** Rebuild a thrown `Error` from a server `{ code, message, data?, hint?, docsUrl? }` envelope, wire-decoding `data` so `bigint`/`bytes` inside it survive. */
const reconstructError = (errorBody: { code?: string; data?: unknown; docsUrl?: string; hint?: string | string[]; message?: string }): LunoraClientError => {
    const error = new Error(errorBody.message ?? "request failed") as LunoraClientError;

    error.code = errorBody.code;

    if (errorBody.data !== undefined) {
        error.data = decodeWire(errorBody.data);
    }

    if (errorBody.hint !== undefined) {
        error.hint = errorBody.hint;
    }

    if (errorBody.docsUrl !== undefined) {
        error.docsUrl = errorBody.docsUrl;
    }

    return error;
};

/**
 * Rebuild a thrown `Error` from a server `{ error }` envelope ({@link reconstructError})
 * with any `Retry-After` response header folded into `data.retryAfterMs` — the ONE
 * channel a retry hint travels on, and the only one the public `getRetryAfterMs`
 * reads. The runtime's REST limiter sends its hint as the header (whole seconds)
 * where an application limiter puts milliseconds in the envelope, so both replay
 * paths normalise it here rather than each in their own way.
 */
const reconstructErrorWithRetryAfter = (
    errorBody: { code?: string; data?: unknown; docsUrl?: string; hint?: string | string[]; message?: string },
    retryAfterHeader: null | string,
): LunoraClientError => {
    const error = reconstructError(errorBody);
    const data = retryAfterData(error, retryAfterHeader);

    if (data !== undefined) {
        error.data = data;
    }

    return error;
};

/**
 * Wire-encode a call's `args`/payload, tagging an encode failure with the call it
 * came from. The bare codec error ("wire-codec: cannot encode a RegExp …") names
 * the type but not the operation — which is useless on the fire-and-forget whisper
 * path and the async outbox flush, where the throw has no call-site stack. Prefixing
 * with `label` (e.g. `args for 'messages:send'`) turns it into an actionable message
 * while preserving the original via `cause`.
 */
const encodeCallArgs = (payload: unknown, label: string): unknown => {
    try {
        return encodeWire(payload);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        throw new TypeError(`LunoraClient: cannot encode ${label} — ${reason}`, error instanceof Error ? { cause: error } : undefined);
    }
};

/** One demuxed result slot of a {@link LunoraClient.batch} call (plan 088). */
type BatchSlot = { error: LunoraClientError; ok: false } | { ok: true; value: unknown };

/**
 * Demux a `/_lunora/rpc-batch` response into per-call slots in input order,
 * wire-decoding each success value and reconstructing `.code`/`.data` on a
 * failing call. A slot the server never returned surfaces as an error rather
 * than a silent `undefined` success.
 */
const demuxBatchResults = (rawResults: { body?: unknown; id?: number }[], count: number): BatchSlot[] => {
    const slots = Array.from<BatchSlot | undefined>({ length: count });

    for (const entry of rawResults) {
        if (typeof entry.id !== "number" || entry.id < 0 || entry.id >= count) {
            continue;
        }

        const inner = entry.body as { error?: { code?: string; data?: unknown; message?: string }; result?: unknown } | undefined;

        slots[entry.id] =
            inner && "error" in inner && inner.error ? { error: reconstructError(inner.error), ok: false } : { ok: true, value: decodeWire(inner?.result) };
    }

    return slots.map((slot) => slot ?? { error: new Error("batch call returned no result"), ok: false });
};

/**
 * @internal
 */
const RESOLVED_PROMISE = Promise.resolve();

/**
 * Lunora browser/edge client. Talks RPC over HTTP and real-time deltas over
 * a single multiplexed WebSocket.
 *
 * Reconnect, offline queueing, and optimistic updates are all handled here;
 * see the package README for the wire protocol.
 */
class LunoraClient {
    /** Hard cap on concurrently-buffered pokes — a backstop that reclaims buffers abandoned by a mid-poke disconnect (no `pokeEnd`). Far above any real concurrent-in-flight count. */
    private static readonly MAX_POKE_BUFFERS = 256;

    /**
     * Create a typed {@link ClientQueryRef}. Convenience wrapper around
     * {@link createClientQuery} so you don't need a separate import.
     * @example
     * ```ts
     * const sidebarOpen = LunoraClient.createClientQuery("sidebarOpen", true);
     * ```
     */
    public static createClientQuery<T>(key: string, defaultValue: T): ClientQueryRef<T> {
        return { defaultValue, key };
    }

    public readonly url: string;

    public readonly wsUrl: string;

    /** Local reactive store for {@link ClientQueryRef} values — no server round-trip. Private; reach it via `getClientQuery` / `setClientQuery` / `subscribeClientQuery`. */
    private readonly clientQueryStore: ClientQueryStore;

    private wsToken: string | undefined | WsTokenProvider;

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

    /**
     * Durable outbox seam (the `@lunora/db` `createExecutorOutboxSink`). When
     * set, offline writes are delegated here and the built-in {@link OfflineQueue}
     * is bypassed, so a db app has exactly one durable write path.
     */
    private readonly outbox: OutboxSink | undefined;

    /** Stable per-client id stamped onto every `OutboxMutation` (custom-mutator watermark). */
    private readonly clientId: string;

    /**
     * Highest CDC cursor this client has seen a write commit at, per shard key
     * (`""` for the default shard) — the read-your-writes bookmark sent as
     * `x-lunora-min-seq`.
     *
     * In memory only, and deliberately: it exists to keep THIS session's reads
     * behind THIS session's writes. Persisting it across reloads would pin a
     * fresh page to a cursor it has no reason to require and force needless
     * fallbacks to the owner.
     */
    private readonly shardCursors = new Map<string, number>();

    /**
     * The server's own name for the default shard (`defaultShardKey`), learned
     * from the first response to a call that named no shard. `undefined` until
     * then, which is why `cursorKeyFor` falls back to a placeholder entry that
     * `learnDefaultShardKey` folds in once the name arrives.
     */
    private defaultShardKey: string | undefined;

    /**
     * `true` when the constructor's hydration microtask has finished loading the
     * durable read cache (Pillar 2) into `hydratedQueryCache`. Signals that
     * the cache is ready for synchronous `peekHydratedQuery` reads.
     */
    private readyResolved = false;

    /** Resolvers for `whenReady()` — called once hydration completes. */
    private readyResolve: (() => void) | undefined;

    /**
     * Promise that resolves once the durable read cache has been loaded. When
     * `hydrateOnStart` is not set or no query cache is configured, resolves
     * immediately (the constructor creates an already-resolved promise).
     */
    private readonly readyPromise: Promise<void>;

    /**
     * Highest custom-mutator watermark the server has echoed for this client,
     * nested by identity fingerprint (`identityFingerprint() ?? ""`) then shard
     * bucket (`shardKey ?? ""`) — the DO tracks one `__client_watermark` per
     * `(identity, clientId)` pair, not per bucket alone, so a bucket-only key
     * would let a user switch claim the previous identity's sequence and wedge
     * every push on `OUT_OF_ORDER` until a reload (plan 316). A nested map
     * (rather than a single map composite-keyed by a joined string) is what a
     * previous fix here tried and got wrong: an identity fingerprint or a
     * `shardKey` is an arbitrary string, so any string delimiter — even one as
     * exotic as U+FFFD — can appear in one operand and collide with the other
     * (a fingerprint of `a<SEP>x` + bucket `y` joins to the same string as
     * a fingerprint of `a` + bucket `x<SEP>y`), mixing two identities' watermarks.
     * The nested map has no join step, so there is no delimiter to collide.
     * `callMutator` bumps it from every ack; the `@lunora/db` mutator runtime
     * seeds its `clientSeq` generator from it so a reload (which resets the
     * in-memory counter) never reissues a stale sequence the server would
     * silently swallow as a replay.
     */
    private readonly clientWatermarks = new Map<string, Map<string, number>>();

    /** Monotonic per-client mutation counter backing the server `__client_watermark`. */
    private outboxMutationCounter = 0;

    private readonly onPersistenceError: ((context: PersistenceErrorContext) => void) | undefined;

    private readonly persistence: PersistenceAdapter | undefined;

    /** App/schema version stamped on persisted writes + cached reads; mismatches are purged. */
    private readonly persistenceVersion: string | undefined;

    /** Releases the multi-tab outbox-leader Web Lock on close (see `hydrateAsOutboxLeader`). */
    private outboxLeaderRelease: (() => void) | undefined;

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

    /**
     * Cross-tab coordinator; created only when `crossTabSync: true`. When the
     * client is not the elected leader, all WebSocket operations are skipped.
     * Not `readonly` — `close()` clears it (mirrors `outboxLeaderRelease`).
     */
    private tabCoordinator: TabCoordinator | undefined;

    /**
     * The leader's last-broadcast aggregate {@link ConnectionStatus}, mirrored
     * on a follower tab — which owns no `ShardConnection` of its own to
     * compute a status from (see `computeStatus`). `undefined` until the
     * leader's first broadcast (falls back to `"idle"`), and reset back to
     * `undefined` whenever this tab stops being a follower of the CURRENT
     * leader (becomes leader itself, or the leader changes), so a stale
     * mirror from a previous leader never survives a leadership change.
     */
    private leaderStatus: ConnectionStatus | undefined;

    /**
     * Sticky "has the mirrored leader status ever reported `connected`" flag —
     * the follower's counterpart to {@link ShardConnection.wasEverConnected},
     * since a follower has no `ShardConnection` of its own. Feeds the
     * offline-queue gate (see `mutation`) exactly like the real per-shard flag
     * does on the leader/single-tab path.
     */
    private leaderWasEverConnected = false;

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
     * Optional STABLE identity subject (a user id), the basis of the offline-queue
     * identity stamp when supplied. Keeps a same-user token *refresh* from looking
     * like an identity change (which would discard queued writes). `undefined` =
     * not supplied, so identity falls back to a hash of the raw token. See
     * `setAuthToken` / `identityFingerprint`.
     */
    private authSubject: string | null | undefined = undefined;

    /**
     * Identity stamp recorded against each queued offline mutation, keyed by
     * the queue-assigned mutation id. Captured at enqueue from the auth token
     * in effect at the time, and re-checked at flush so a queued write can
     * never replay under a different identity than the one that issued it.
     * See `identityFingerprint` for the fingerprint shape.
     */
    private readonly queuedIdentities = new Map<string, string | null>();

    /**
     * Distinct shard keys with a mutation currently sitting in `offlineQueue`
     * — fresh writes queued this session (`enqueueOfflineMutation`) or writes
     * restored from durable storage (`hydratePersistedQueue`). A follower tab
     * has no per-shard `ShardConnection` to iterate when its mirrored leader
     * status turns `"connected"` (see the `onConnectionStatus` coordinator
     * option), so this is what that flush walks instead. Entries are never
     * removed — flushing an already-empty shard is a cheap no-op, and the set
     * is bounded by the app's own distinct shard-key cardinality.
     */
    private readonly queuedOfflineShardKeys = new Set<string | undefined>();

    private closed = false;

    /** Subscribers to auth-token changes (see `onAuthTokenChange`). */
    private readonly authTokenListeners = new Listeners<string | null>();

    /** Subscribers to aggregate connection-status changes (see `onConnectionStatus`). */
    private readonly statusListeners = new Listeners<ConnectionStatus>();

    /** Subscribers notified when the server drops a socket for an expired token (see `onTokenExpired`). */
    private readonly tokenExpiredListeners = new Listeners();

    /** Subscribers to offline-queued mutation verdicts (see `onMutationSettled`). */
    private readonly mutationSettledListeners = new Listeners<MutationSettledEvent>();

    /** Subscribers to the offline-queue pending-count (see `onPendingChange`). */
    private readonly pendingChangeListeners = new Listeners<number>();

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
    private readonly streams = new Map<
        string,
        {
            durable: boolean;
            generation: number | undefined;
            handle: StreamHandle;
            lastSeq: number;
            message: ClientMessage;
            shardKey: string | undefined;

            /**
             * Whether the start frame ever reached the server. Distinguishes "the
             * run exists server-side and must be told to stop" from "the frame is
             * still queued locally and can simply be dropped" — which is the whole
             * question on the cancel path when the socket is down.
             */
            started: boolean;
        }
    >();

    /** Live shape subscriptions (partial replication), keyed by their wire id. */

    /* eslint-disable jsdoc/check-indentation -- intentional numbered list */

    /**
     * Teardown callbacks for the admin sockets {@link LunoraClient.subscribeScheduledJobs}
     * opens. Those run their own reconnect loop off a closure-local `closed`
     * flag rather than `this.closed` (they predate `ensureSocket`'s guard), so
     * without this registry a `close()` left every one of them reconnecting on
     * its backoff forever — re-minting an ephemeral admin sub-token on each
     * attempt when a `WsTokenProvider` is wired.
     */
    private readonly adminSocketTeardowns = new Set<() => void>();

    /**
     * The in-flight offline-queue replay per shard (`connectionKey`), while one
     * is running. Two jobs:
     *
     * 1. It serializes overlapping flushes for the same shard — two reconnect
     *    events in quick succession used to drain and replay concurrently.
     * 2. It is the barrier {@link LunoraClient.mutation} waits on before sending a FRESH
     *    write directly. The socket's `open` handler flips `wsState` to `"open"`
     *    first and calls the flush last, so from that instant `mutation()`'s
     *    offline gate is false and a new write raced straight to `/rpc` against
     *    the replay of the older, queued write for the same document — the newer
     *    one could land first and then be overwritten by the older. Ordering
     *    inside the replay (`replaySequential`) never covered this, because the
     *    racing write was never in the queue.
     */
    private readonly offlineFlushes = new Map<string, Promise<void>>();
    /* eslint-enable jsdoc/check-indentation */

    /**
     * Per-shard replay backoff, keyed by {@link connectionKey} exactly as the
     * flushes and their timers are: `delayMs` is the longest hint the CURRENT
     * flush of that key was given (written by
     * {@link LunoraClient.noteReplayRetryDelay}, consumed once by
     * {@link LunoraClient.scheduleRateLimitedRetry} at the end of the drain), and
     * `attempts` counts its consecutive failed flushes, which is what the
     * hintless backoff ramps on.
     *
     * Keyed, not a single field: flushes are per shard key and run concurrently,
     * so one field means one limited shard sets the wait for every other shard
     * and two flushes overwrite — then consume — each other's delay, leaving one
     * of them with nothing scheduled at all. Evicted by
     * {@link LunoraClient.scheduleRateLimitedRetry} the moment a key has nothing
     * left to retry, so an app that shards per document does not accumulate an
     * entry per document it ever wrote.
     */
    private readonly replayRetryState = new Map<string, { attempts: number; delayMs: number | undefined }>();

    /** Pending rate-limit retry flushes, keyed by {@link connectionKey}, so `close()` can cancel them. */
    private readonly replayRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

    private readonly shapeSubscriptions = new Map<string, ShapeSubscriptionState>();

    /**
     * In-flight pokes being assembled between `pokeStart` and `pokeEnd`, keyed by
     * `<connectionKey>\u0000<pokeId>`.
     *
     * The connection has to be in the key: `pokeId` is a per-DO counter that also
     * resets on eviction, so a multi-shard client — one socket per shard, one map
     * here — sees two shards mint `poke-1` concurrently. Keyed by `pokeId` alone
     * their frames interleave into a single buffer: one shard applies the other's
     * epoch (spurious fork → view wiped) and the other finds no buffer for its
     * parts at all, silently dropping rows while the server's memo advances.
     */
    private readonly pokeBuffers = new Map<string, PokeBuffer>();

    private nextShapeId = 0;

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
        // Auto-probe durable stores: an omitted option defaults to IndexedDB when
        // the environment supports it (browsers), so the bare client is local-first
        // out of the box; `false` opts out, an explicit adapter is used as-is. The
        // write-queue auto-default is suppressed when an outbox (the `@lunora/db`
        // path) owns the durable write path, so we never persist a second copy.
        this.persistence = resolvePersistenceAdapter(options.persistence, options.outbox === undefined);
        this.persistenceVersion = options.persistenceVersion;
        this.queryCache = resolveQueryCacheAdapter(options.queryCache);
        this.onPersistenceError = options.offlineQueue?.onPersistenceError;
        this.clientQueryStore = new ClientQueryStore();

        // Cross-tab coordinator: when `crossTabSync` is set, tabs coordinate
        // via BroadcastChannel so only one tab (the leader) opens WS sockets.
        if (options.crossTabSync) {
            this.tabCoordinator = this.createTabCoordinator();
            this.tabCoordinator.start();
        } else {
            this.tabCoordinator = undefined;
        }

        // `whenReady()` resolved immediately when no durable cache needs loading
        // or the caller opted out of hydration-gated rendering.
        if (options.hydrateOnStart && this.queryCache) {
            this.readyPromise = new Promise<void>((resolve) => {
                this.readyResolve = resolve;
            });
        } else {
            this.readyResolved = true;
            this.readyPromise = RESOLVED_PROMISE;
        }
        this.offlineQueue = new OfflineQueue(options.offlineQueue, {
            onEvict: (entry, error) => {
                this.emitItemSettled(entry, "rejected", error);
            },
            onSizeChange: (size) => {
                this.pendingChangeListeners.emit(size);
            },
            persistence: this.persistence,
            version: options.persistenceVersion,
        });
        this.outbox = options.outbox;
        // A db app persists a stable id alongside the outbox and passes it in; the
        // standalone client gets an ephemeral per-session id, fine because it only
        // matters when a durable outbox (which supplies its own) is wired.
        this.clientId = options.clientId ?? `client-${nextId()}`;

        if (this.persistence) {
            // Deferred to a microtask so the constructor itself stays
            // synchronous; hydration then opens sockets for any restored writes
            // so they flush once the WS connects. Gated behind a Web Lock so only
            // ONE tab re-queues the shared durable writes (see the method).
            queueMicrotask((): void => {
                this.hydrateAsOutboxLeader();
            });
        }

        if (this.queryCache) {
            // Load the durable read cache into `hydratedQueryCache` so the first
            // `subscribe()` for each key seeds its value before any socket opens.
            // Best-effort and identity-gated at seed time.
            queueMicrotask((): void => {
                const hydration = async (): Promise<void> => {
                    try {
                        await this.hydrateQueryCache();
                    } catch {
                        // Cache hydration failed — proceed without cache.
                    } finally {
                        this.readyResolved = true;
                        this.readyResolve?.();
                    }
                };

                hydration().catch(() => {
                    // Cache hydration is best-effort; failures are already
                    // handled inside the hydration function.
                });
            });
        }
    }

    // --- Auth helpers -------------------------------------------------------

    /**
     * Set (or clear) the bearer token sent on every HTTP RPC. Notifies any
     * {@link onAuthTokenChange} listeners so React hooks like `useAuth` stay in
     * sync across all mounted instances.
     *
     * Pass a STABLE `subject` (the user id) to key the offline-queue identity on
     * it instead of the token bytes, so a token *refresh* (same user, new JWT)
     * doesn't read as an identity change and discard queued writes. The subject is
     * **sticky**: a later call that omits it (or passes `undefined`) keeps the
     * established subject — so `setAuthToken(refreshedToken)` after a prior
     * `setAuthToken(token, user.id)` retains the identity. Pass `null` to clear it
     * (an explicit sign-out). Establishing the subject for the first time on an
     * UNCHANGED token (e.g. the user id resolves a tick after the token was set)
     * re-stamps any in-flight queued writes rather than dropping them — same
     * credential, just a more stable label. A real user switch (the token AND
     * subject both change) still drops the previous user's writes.
     *
     * Does NOT update the WebSocket auth — the WS token is fixed at upgrade
     * time and lives in the URL. To refresh live WS auth, call
     * {@link setWsToken} explicitly, which closes existing shard sockets to
     * force a reconnect with the new credential.
     */
    public setAuthToken(token: string | null, subject?: string | null): void {
        const tokenChanged = this.authToken !== token;
        // Compare the IDENTITY (subject when supplied, else token hash), not the
        // raw token, so a same-subject refresh doesn't trip the identity-change
        // drain. Capture the old fingerprint before mutating the inputs.
        const previousIdentity = this.identityFingerprint();

        this.authToken = token;
        // Sticky: only an explicit value (incl. `null` = sign-out) changes the
        // subject; omitting it keeps the established one.
        if (subject !== undefined) {
            this.authSubject = subject;
        }

        const newIdentity = this.identityFingerprint();

        if (newIdentity !== previousIdentity) {
            if (tokenChanged) {
                // A genuine credential change — drain and reject any in-memory
                // offline writes queued under the previous identity so they can
                // never replay as the new user. (Flush also re-checks each stamp.)
                this.rejectQueuedForIdentityChange();
            } else {
                // The token is unchanged (same credential) — the identity label
                // just got more stable (a subject resolved). Migrate queued writes
                // AND cached watermarks to the new fingerprint instead of dropping
                // them — losing the watermark here would re-derive `stale + 1`
                // against the same server-side identity and reintroduce the exact
                // OUT_OF_ORDER wedge composite-keying `clientWatermarks` fixes, in
                // reverse (contract §3.2, plan 316).
                this.restampQueuedIdentity(previousIdentity, newIdentity);
                this.restampWatermarks(previousIdentity, newIdentity);
            }

            // The cross-tab channel name embeds the identity fingerprint (see
            // `createTabCoordinator`) — restart on the re-derived channel so
            // this tab doesn't keep leading/following the PREVIOUS identity's
            // group. After the queue handling above, so drained/restamped
            // writes settle before the new group's leader election begins.
            // BroadcastChannel names are immutable, so a stop-old+construct-new
            // is the only way to move channels — but that means the fresh
            // coordinator would otherwise sit through the full
            // claim-then-`leaderTimeout` dance (3s default) before any tab
            // opens a socket again, freezing every live query for that long
            // on EVERY identity change (including a routine JWT refresh for
            // an app that doesn't pass a stable `subject` — the documented
            // reason to pass one). If this tab was already the leader, it's
            // overwhelmingly likely to remain the sole tab on the new
            // channel too, so promote it immediately instead of waiting —
            // `promoteImmediately`'s docblock covers the (self-healing) rare
            // case where another tab does the same at once.
            if (this.tabCoordinator) {
                const wasLeader = this.tabCoordinator.isLeader();

                this.tabCoordinator.stop();
                this.tabCoordinator = this.createTabCoordinator();
                this.tabCoordinator.start();

                if (wasLeader) {
                    this.tabCoordinator.promoteImmediately();
                }
            }
        }

        // Notify token listeners only on an actual token change (useAuth refetch).
        if (tokenChanged) {
            this.authTokenListeners.emit(token);
        }
    }

    public getAuthToken(): string | null {
        return this.authToken;
    }

    /**
     * The current identity fingerprint (the same stamp queued offline writes
     * carry). Exposed so a durable {@link OutboxSink}'s replay handler — which
     * owns its own at-least-once replay outside the built-in `OfflineQueue` —
     * can drop a persisted write whose captured `identity` no longer matches the
     * signed-in user, the guard the queue path applies in `flushOfflineQueue`.
     */
    public currentIdentity(): string | null {
        return this.identityFingerprint();
    }

    /**
     * Verdict on whether a durable write stamped with `stamped` may be replayed
     * now. The comparison a replay handler must NOT hand-roll.
     *
     * `"match"` is the same identity, or the same credential under a token hash
     * — which a late-resolving subject would otherwise make look different.
     *
     * `"unknown"` is nobody signed in *yet*. A durable replay starts when the
     * executor is constructed, before the app has resolved its session and
     * called {@link setAuthToken}, so this is the normal state on every reload.
     * There is no other identity to replay as, so such a write must be HELD,
     * never dropped — dropping here destroys the queuing user's own offline
     * writes. It is indistinguishable from an explicit sign-out (the fingerprint
     * is `null` for both), which is the safe conflation: holding a write for a
     * signed-out app costs a retry, dropping it costs the write.
     *
     * `"mismatch"` is a different identity signed in, and is the one that must be
     * terminal: replaying would attribute one user's write to another and pass
     * THEIR row-level security.
     */
    public replayIdentityVerdict(stamped: null | string | undefined): "match" | "mismatch" | "unknown" {
        const current = this.identityFingerprint();

        if (stamped === current) {
            return "match";
        }

        if (stamped !== undefined && this.isSameCredentialUnderTokenHash(stamped)) {
            return "match";
        }

        return current === null ? "unknown" : "mismatch";
    }

    /** This client's stable identifier — the watermark key the server's custom-mutator protocol advances per `clientSeq`. */
    public clientIdentifier(): string {
        return this.clientId;
    }

    /**
     * The highest custom-mutator watermark the server has echoed for this client
     * on the given shard (0 if none yet). The `@lunora/db` mutator runtime seeds
     * its `clientSeq` generator from this so a reload never reissues a sequence
     * the server has already applied (which it would swallow as a replay, silently
     * dropping the write).
     */
    public confirmedMutationWatermark(shardKey?: string): number {
        return this.clientWatermarks.get(this.identityFingerprint() ?? "")?.get(shardKey ?? "") ?? 0;
    }

    /**
     * Push a custom mutator to its authoritative server impl over the watermark
     * protocol (Phase 4): the request carries `x-lunora-client-id` + a monotonic
     * `x-lunora-client-seq`, so the DO runs it exactly once and advances this
     * client's `__client_watermark`.
     *
     * Returns the server `result` plus `applied`: `true` when the DO ran this push
     * as the next-in-order mutation, `false` when it was a replay ack (`clientSeq`
     * was at or below the stored watermark — e.g. a stale sequence after a reload).
     * A `false` verdict tells the caller to reissue above the now-known watermark
     * (echoed into {@link confirmedMutationWatermark}) rather than treat the benign
     * ack as a confirmed write. Every ack — applied or not — bumps the watermark.
     *
     * This is the online transport for `@lunora/db`'s client-mutator runtime; the
     * optimistic overlay + durable-outbox concerns live in that runtime, not here.
     */
    public async callMutator(
        functionPath: string,
        args: Record<string, unknown>,
        options?: { clientSeq?: number; shardKey?: string },
    ): Promise<{ applied: boolean; result: unknown }> {
        // An omitted `clientSeq` must stay `undefined` — NOT default to 0. A seq of
        // 0 is `<=` the initial watermark, so the DO classifies the push as an
        // already-applied replay and acks it WITHOUT running the handler — a silent
        // dropped write that still reports `applied: true`. Passing `undefined`
        // sends no `x-lunora-client-seq` header, so the server rides the idempotency
        // path and runs the mutation exactly once. The `@lunora/db` runtime always
        // supplies a monotonic seq (≥1); this guards direct callers of the raw API.
        const clientSeq = options?.clientSeq;

        // A supplied seq must be a positive integer: 0 / negatives are `<=` the
        // initial watermark and would be acked as replays (silent dropped write),
        // and a fractional seq can never equal the integer watermark. Reject
        // rather than send a poisoned header. `undefined` is the valid "no seq"
        // signal (rides the idempotency path) and is left untouched.
        if (clientSeq !== undefined && (!Number.isInteger(clientSeq) || clientSeq <= 0)) {
            throw new LunoraError("INTERNAL", `callMutator: clientSeq must be a positive integer, got ${String(clientSeq)}`);
        }

        const bucket = options?.shardKey ?? "";
        // Capture the watermark key for the identity in effect when this call
        // was INITIATED, before the RPC's await — not after. `setAuthToken`
        // can switch identity while the RPC is in flight; deriving it after the
        // await would file the ack under the NEW identity's bucket even though
        // the request was authenticated (and the ack earned) as the old one.
        // `define-mutators.ts` then derives the new identity's next sequence
        // from a watermark it never advanced, and the shard rejects it as
        // OUT_OF_ORDER — the exact wedge plan 316 exists to fix, reintroduced
        // through this door instead.
        const identity = this.identityFingerprint();
        let ackWatermark: number | undefined;

        const result = await this.rpc(functionPath, args, options?.shardKey, {
            captureBookmark: true,
            clientId: this.clientId,
            clientSeq,
            onMutationAck: (lastMutationId) => {
                ackWatermark = lastMutationId;
            },
        });

        if (ackWatermark !== undefined && ackWatermark > (this.clientWatermarks.get(identity ?? "")?.get(bucket) ?? 0)) {
            let bucketWatermarks = this.clientWatermarks.get(identity ?? "");

            if (bucketWatermarks === undefined) {
                bucketWatermarks = new Map();
                this.clientWatermarks.set(identity ?? "", bucketWatermarks);
            }

            bucketWatermarks.set(bucket, ackWatermark);
        }

        // The DO echoes `lastMutationId === clientSeq` only when it ran this push
        // as the next-in-order mutation; a replay ack echoes the (higher) stored
        // watermark. An absent echo (non-watermarked call) is treated as applied.
        const applied = ackWatermark === undefined || ackWatermark === clientSeq;

        return { applied, result };
    }

    /**
     * Subscribe to auth-token changes. Returns an unsubscribe function. The
     * listener is NOT invoked on registration — use {@link getAuthToken} for
     * the current value.
     */
    public onAuthTokenChange(listener: (token: string | null) => void): Unsubscribe {
        return this.authTokenListeners.add(listener);
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
     * in the studio, switching workspaces, etc.). Accepts a static string or a
     * {@link WsTokenProvider} resolved fresh at every (re)connect — the channel
     * for short-lived credentials like the minted ephemeral admin sub-token.
     * Bearer tokens for HTTP RPC are independent — see {@link setAuthToken}.
     */
    public setWsToken(token: string | undefined | WsTokenProvider): void {
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
     *
     * Not available on a `crossTabSync` FOLLOWER tab — the context rides the
     * `connect` envelope of a socket a follower does not own, so it would be
     * stored and never sent. Throws `NOT_IMPLEMENTED` there.
     */
    public setConnectionContext(context: Record<string, unknown> | undefined, options: { shardKey?: string } = {}): void {
        this.assertLeaderOwnedSurface("setConnectionContext");

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
        // Inert on a follower, NOT a throw. Every `usePresence` /
        // `createPresence` / `presence` adapter in the repo calls this from a
        // component effect the app cannot opt out of, so throwing unwinds the
        // whole tab (a React error boundary, a failed Svelte/Solid/Vue setup)
        // rather than degrading presence. The call could never reach the server
        // from a follower anyway — the cross-tab channel is leader-to-follower
        // only — so an inert release is the honest result. `whisper*` and
        // `setConnectionContext` still throw: those are only ever called by app
        // code, which can handle it.
        if (this.followsAnotherTab()) {
            return () => undefined;
        }

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
     *
     * Not available on a `crossTabSync` FOLLOWER tab — whisper frames are not
     * relayed over the cross-tab channel, so this throws `NOT_IMPLEMENTED`
     * there rather than registering a handler nothing can ever reach. See
     * {@link LunoraClientOptions.crossTabSync}.
     */
    public whisperSubscribe(topic: string, handler: (data: unknown, from?: string) => void, options: { shardKey?: string } = {}): Unsubscribe {
        this.assertLeaderOwnedSurface("whisperSubscribe");

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
     *
     * That best-effort drop is for a socket that is momentarily down. A
     * `crossTabSync` FOLLOWER tab has no socket and never will (see
     * {@link LunoraClientOptions.crossTabSync}), so every whisper from it would
     * be dropped forever — it throws `NOT_IMPLEMENTED` instead.
     */
    public whisper(topic: string, data?: unknown, options: { shardKey?: string } = {}): void {
        this.assertLeaderOwnedSurface("whisper");

        this.ensureSocket(options.shardKey);

        const conn = this.getConnection(options.shardKey);

        if (conn) {
            // Wire-encode before send so `bigint`/bytes payloads survive (raw
            // `JSON.stringify` would throw on a bigint). The shard relays the
            // encoded value verbatim and the receiving client `decodeWire`s it —
            // `encodeWire` is identity for JSON-safe data, so this stays
            // backward-compatible with older shards/clients. Omitted `data`
            // becomes an explicit `null` (the documented receiver contract).
            // eslint-disable-next-line unicorn/no-null -- an omitted whisper body is delivered as an explicit JSON `null`, never `undefined`
            sendOn(conn, { data: encodeCallArgs(data ?? null, `whisper data for topic '${topic}'`), topic, type: "whisper" });
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
        return this.tokenExpiredListeners.add(listener);
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
        const unsubscribe = this.statusListeners.add(listener);

        listener(this.computeStatus());

        return unsubscribe;
    }

    /**
     * Number of offline writes waiting in the built-in queue to be sent — the
     * depth for a "N changes waiting to sync" indicator. Counts writes that are
     * queued (offline / mid-reconnect), not ones already in flight on the wire.
     * A `@lunora/db` app whose writes ride the unified outbox should read
     * `LunoraDb.pendingCount()` instead (this counts only the built-in queue).
     */
    public pendingCount(): number {
        return this.offlineQueue.size;
    }

    /**
     * A point-in-time snapshot of everything the sync engine believes right now:
     * per-shard sockets and watermarks, every live query and shape subscription with
     * its cursor and ack state, and the offline-queue depth.
     *
     * This exists because the alternative is `console.log`. When an optimistic
     * overlay doesn't clear, the questions are always the same — *is the socket open?
     * what watermark has the server confirmed for this shard? has this shape been
     * poked since my write? is anything stuck in the queue?* — and none of them were
     * answerable from outside the client, so every adopter ends up instrumenting the
     * library by hand or building a bespoke policy layer around a symptom.
     *
     * Read it from a devtools console, log it next to a bug report, or render it in a
     * debug panel. Pull-only and allocation-cheap; nothing here is reactive, so poll
     * it or read it on demand.
     *
     * ```ts
     * const { shards, subscriptions } = client.debug();
     * // shards: [{ shardKey: "user-1", wsState: "open", confirmedMutationWatermark: 42, … }]
     * ```
     */
    public debug(): ClientDebugSnapshot {
        const shards: ClientDebugShard[] = [];
        // `clientWatermarks` is nested by identity then bucket — only surface the
        // CURRENT identity's bucket map, never another identity's cached
        // watermarks (a previous identity's watermark leaking into this
        // snapshot would be a correctness regression, not a cosmetic one).
        const currentWatermarks = this.clientWatermarks.get(this.identityFingerprint() ?? "");
        const shardKeys = new Set<string>([...this.connections.keys(), ...(currentWatermarks?.keys() ?? [])]);

        for (const key of shardKeys) {
            const conn = this.connections.get(key);

            shards.push({
                confirmedMutationWatermark: currentWatermarks?.get(key) ?? 0,
                hasSocket: conn?.socket !== undefined,
                shardKey: key === "" ? undefined : key,
                wasEverConnected: conn?.wasEverConnected ?? false,
                wsState: conn?.wsState ?? "idle",
            });
        }

        const subscriptions: ClientDebugSubscription[] = this.subscriptions.all().map((state) => {
            return {
                acked: state.acked,
                functionPath: state.fn.__lunoraRef,
                id: state.id,
                kind: "query",
                lastMutationId: state.lastMutationId,
                // A non-empty layer stack IS the "why is my optimistic row still here"
                // answer, so it is the one count worth surfacing per subscription.
                pendingOptimisticLayers: state.optimisticLayers.length,
                serverCursor: state.serverCursor,
                shardKey: state.shardKey,
                subscriberCount: state.callbacks.size,
            };
        });

        for (const state of this.shapeSubscriptions.values()) {
            subscriptions.push({
                // A shape has no separate ack frame; arrival of a cursor means the
                // server has served it.
                acked: state.serverCursor !== undefined,
                functionPath: `shape:${state.name}`,
                id: state.id,
                kind: "shape",
                lastMutationId: state.lastMutationId,
                pendingOptimisticLayers: 0,
                rowCount: state.rows.size,
                serverCursor: state.serverCursor,
                shardKey: state.shardKey,
                subscriberCount: state.callbacks.size,
            });
        }

        return {
            clientId: this.clientId,
            closed: this.closed,
            connectionStatus: this.computeStatus(),
            pendingWrites: this.offlineQueue.size,
            shards: shards.toSorted((a, b) => (a.shardKey ?? "").localeCompare(b.shardKey ?? "")),
            subscriptions: subscriptions.toSorted((a, b) => a.functionPath.localeCompare(b.functionPath)),
        };
    }

    /**
     * Subscribe to changes in {@link pendingCount}. Invokes `listener` immediately
     * with the current count, then whenever the queue depth changes (a write is
     * enqueued, flushed, or discarded). Returns an unsubscribe function.
     */
    public onPendingChange(listener: (pending: number) => void): Unsubscribe {
        const unsubscribe = this.pendingChangeListeners.add(listener);

        listener(this.offlineQueue.size);

        return unsubscribe;
    }

    /**
     * Subscribe to terminal verdicts for offline-queued mutations. The listener
     * fires once per queued write that commits or is rejected — including a write
     * restored from durable storage after a reload, whose original `mutation()`
     * Promise no longer exists (`hadAwaiter: false`), and a write the queue
     * evicts on overflow or discards on an identity change. This is the durable
     * channel for surfacing a rolled-back optimistic write to the UI; an online
     * mutation that never queued still surfaces through the Promise `mutation()`
     * returns. The listener is NOT invoked on registration. Returns an
     * unsubscribe function. See {@link MutationSettledEvent}.
     */
    public onMutationSettled(listener: (event: MutationSettledEvent) => void): Unsubscribe {
        return this.mutationSettledListeners.add(listener);
    }

    /**
     * The `WebSocket` implementation this client was constructed with (an
     * explicit `options.WebSocket`, or the ambient global on platforms that have
     * one) — `undefined` if neither is available. This is the seam a feature
     * that opens its OWN socket outside the client's multiplexed connection
     * (e.g. a voice-agent hook) should default to, instead of reaching for
     * `globalThis.WebSocket` directly: on React Native the client wraps this
     * constructor to inject the auth-headers factory's credential onto the
     * upgrade request (`createLunoraClient`'s `withAuthWebSocket`), which a raw
     * `new globalThis.WebSocket(url)` would silently bypass.
     */
    public getWebSocketImpl(): typeof WebSocket | undefined {
        return this.WebSocketImpl;
    }

    // --- Client Query (local state) ----------------------------------------

    /**
     * Read the current value for a {@link ClientQueryRef}. Returns
     * `ref.defaultValue` when no value has been explicitly set.
     */
    public getClientQuery<T>(ref: ClientQueryRef<T>): T {
        return this.clientQueryStore.get(ref);
    }

    /**
     * Set a new value for `ref` and notify every subscriber. Pass `undefined`
     * to reset the slot to `ref.defaultValue`.
     */
    public setClientQuery<T>(ref: ClientQueryRef<T>, value: T): void {
        this.clientQueryStore.set(ref, value);
    }

    /**
     * Subscribe to changes for `ref`. The callback is NOT invoked on
     * registration — call {@link getClientQuery} for the current value.
     * Returns an unsubscribe function.
     */
    public subscribeClientQuery(ref: ClientQueryRef, callback: (value: unknown) => void): Unsubscribe {
        return this.clientQueryStore.subscribe(ref, callback);
    }

    /**
     * Reset a {@link ClientQueryRef} to its default value, notifying every
     * subscriber. Equivalent to `setClientQuery(ref, ref.defaultValue)` but
     * removes the stored entry so a future {@link getClientQuery} returns
     * the default rather than an explicitly-set value.
     */
    public resetClientQuery(ref: ClientQueryRef): void {
        this.clientQueryStore.reset(ref);
    }

    /**
     * Capture a snapshot of the current live query value at call time and
     * produce a `() => boolean` precondition that compares it against the
     * value at replay time (on queue drain / reconnect).
     *
     * Delegates to {@link createSnapshotPrecondition} with this client bound —
     * no need to pass `client` explicitly. The comparison semantics (including
     * how an absent subscription is treated) live there, in one place.
     * @example
     * ```ts
     * client.mutation(api.todos.update, { id, text }, {
     *   precondition: client.snapshotPrecondition(api.todos.list, { userId }),
     * });
     * ```
     */
    public snapshotPrecondition(functionRef: FunctionReference, args: Record<string, unknown>, shardKey?: string): () => boolean {
        return createSnapshotPrecondition(this, functionRef, args, shardKey);
    }

    // --- Hydration helpers --------------------------------------------------

    /**
     * Resolves once the durable read cache has been loaded into memory. When
     * `hydrateOnStart` is not configured or no query cache adapter is active,
     * returns an already-resolved promise so callers can always await it
     * unconditionally.
     *
     * Framework adapters (React, Vue, etc.) use this to gate the first
     * (enabled) render of a live query behind hydration, so the user sees
     * cached data instead of an undefined flash before the socket round-trip.
     */
    public whenReady(): Promise<void> {
        return this.readyPromise;
    }

    /**
     * Synchronously reports whether {@link whenReady} has already resolved (the
     * durable read cache is loaded, or none is configured). Framework adapters
     * read this to seed the hydration-gate state on the first render without
     * awaiting, then subscribe via {@link whenReady} for the pending case.
     */
    public get isReady(): boolean {
        return this.readyResolved;
    }

    /**
     * Synchronously peek at a value the durable read cache loaded for the given
     * function path + args + shard key. Returns `undefined` when:
     *
     * - No query cache adapter is configured.
     * - Hydration hasn't completed yet (race — await {@link whenReady} first).
     * - The cached value's identity fingerprint doesn't match the current auth.
     *
     * Unlike the internal {@link takeHydratedCache}, this is a READ-ONLY peek:
     * the cached entry stays in `hydratedQueryCache` so the subscription created
     * later by {@link subscribe} consumes it normally.
     */
    public peekHydratedQuery(functionPath: string, args: Record<string, unknown>, shardKey?: string): unknown {
        if (!this.readyResolved) {
            return undefined;
        }

        const argsKey = stableWireKey(args);
        const key = queryCacheKey(functionPath, argsKey, shardKey);
        const entry = this.hydratedQueryCache.get(key);

        if (entry === undefined) {
            return undefined;
        }

        return entry.identity === this.identityFingerprint() ? entry.value : undefined;
    }

    /**
     * Peek at the **current live value** of an active subscription, reporting
     * whether one exists at all rather than just its value. `present` is `false`
     * when no subscription is open for the given `(functionPath, args, shardKey)`;
     * `value` is the subscription's `lastValue`, which includes any optimistic
     * overlay.
     *
     * The two are separate because a caller like the snapshot precondition has to
     * tell "no subscription is active, so this read knows nothing" apart from
     * "the subscription is active and its value is `undefined`" — collapsing both
     * into a bare `undefined` return makes an unmounted component look like a
     * changed value, and drops the queued write.
     *
     * Unlike {@link peekHydratedQuery} (which reads from the durable read cache
     * and is independent of active subscriptions), this reflects the current
     * in-memory state of an already-opened subscription.
     */
    public peekActiveQuerySnapshot(functionPath: string, args: Record<string, unknown>, shardKey?: string): { present: boolean; value: unknown } {
        const key = SubscriptionRegistry.key(functionPath, args, shardKey);
        const state = this.subscriptions.get(key);

        return { present: state !== undefined, value: state?.lastValue };
    }

    // --- RPC ---------------------------------------------------------------

    public async query<F extends FunctionReference>(function_: F, args: ArgsOf<F>, options: { shardKey?: string } = {}): Promise<ReturnOf<F>> {
        this.assertOpen();

        return (await this.rpc(function_.__lunoraRef, args as Record<string, unknown>, options.shardKey, { attachBookmark: true })) as ReturnOf<F>;
    }

    /**
     * Batch several independent calls into ONE round trip (plan 088). Each call is
     * dispatched server-side exactly as an individual RPC — per-shard
     * authorization, `(identity, mutationId)` idempotency, and custom-mutator
     * watermark ordering are all preserved — and the worker splits the batch by
     * shard so calls to different shards fan out to their own DOs. Results are
     * demuxed back in input order; a failing call does NOT fail the batch (its
     * slot carries `{ ok: false, error }`, with `.code`/`.data` reconstructed like
     * a single call). Args/results ride the value codec (bytes/bigint survive).
     *
     * No promise pipelining and no capability passing — a call's args cannot
     * reference another call's result (see plan 088 §fence; capabilities are
     * incompatible with DO hibernation).
     */
    public async batch(calls: ReadonlyArray<{ args?: Record<string, unknown>; fn: FunctionReference; shardKey?: string }>): Promise<BatchSlot[]> {
        this.assertOpen();

        if (!this.fetchImpl) {
            throw new LunoraError("INTERNAL", "LunoraClient: no `fetch` implementation available");
        }

        if (calls.length === 0) {
            return [];
        }

        const response = await this.fetchImpl(joinUrl(this.url, RPC_BATCH_PATH), {
            body: JSON.stringify({
                calls: calls.map((call, index) => {
                    return {
                        args: encodeCallArgs(call.args ?? {}, `args for batch call '${call.fn.__lunoraRef}'`),
                        functionPath: call.fn.__lunoraRef,
                        id: index,
                        shardKey: call.shardKey,
                    };
                }),
            }),
            headers: this.rpcRequestHeaders({ attachBookmark: true }),
            method: "POST",
        });

        const bookmark = response.headers.get("x-d1-bookmark");

        if (bookmark) {
            this.bookmark.set(bookmark);
        }

        let body: { error?: { code?: string; data?: unknown; message?: string }; results?: { body?: unknown; id?: number }[] };

        try {
            body = await response.json();
        } catch {
            throw new LunoraError("INTERNAL", `LunoraClient: batch response was not JSON (status ${response.status.toString()})`);
        }

        // A whole-batch rejection (bad request, method, or a per-entry authorization
        // denial that fails the batch closed BEFORE any dispatch) comes back as a
        // non-2xx `{ error }` with no `results` — surface it like a single call
        // rather than reporting every slot as an opaque "no result".
        if (!response.ok || (body.error && !body.results)) {
            if (body.error) {
                throw reconstructError(body.error);
            }

            throw new LunoraError("INTERNAL", `LunoraClient: batch request failed (status ${response.status.toString()})`);
        }

        // Each entry is dispatched as an independent single call server-side, so
        // each carries its own commit cursor — recorded under its OWN shard, or a
        // batched write would leave no read-your-writes requirement behind at
        // all. Read off the raw envelopes because `demuxBatchResults` keeps only
        // the result value.
        //
        // No outbound `x-lunora-min-seq` per entry: the batch route forwards
        // straight to the owner shard and is never replica-served, so a
        // per-entry freshness requirement would constrain nothing. What these
        // cursors constrain is the SINGLE reads that follow.
        for (const entry of body.results ?? []) {
            const commitCursor = (entry.body as { commitCursor?: unknown } | undefined)?.commitCursor;

            if (typeof entry.id === "number" && typeof commitCursor === "number") {
                this.recordShardCursor(calls[entry.id]?.shardKey, commitCursor);
            }
        }

        return demuxBatchResults(body.results ?? [], calls.length);
    }

    /* eslint-disable jsdoc/check-indentation, no-secrets/no-secrets -- intentional bullet list; the back-ticked `Promise<ReturnOf<F>>` type is prose, not a credential */

    /**
     * Invoke a mutation. Errors propagate as rejections.
     *
     * Offline-queue semantics: a mutation is queued (and replayed on reconnect)
     * only when the targeted shard's socket was open at least once already
     * (`wasEverConnected`), so the registry / resubscribe handshake has run.
     * Mutations issued before the very first WS connect to a shard fail fast.
     * Opt into queueing-before-first-connect via
     * `OfflineQueueOptions.queueBeforeFirstConnect`.
     *
     * **Return-value caveat — the queued paths do not carry the server's result.**
     * The declared `Promise<ReturnOf<F>>` only holds when the write goes straight
     * to the server. Once a write is queued:
     *
     * - with a durable `outbox` configured, this resolves **immediately with
     *   `undefined`** (typed as `ReturnOf<F>`) the moment the write is handed to
     *   the outbox — the replay happens later, out of band, with no awaiter;
     * - with the built-in offline queue, it stays pending until the replay lands
     *   and then resolves with the replayed call's value.
     *
     * So `const id = await client.mutation(api.todos.create, …)` is `undefined`
     * for every write issued while offline under an outbox. Generate ids
     * client-side (or read them back from a subscription) rather than depending
     * on a mutation's return value in an offline-capable app —
     * {@link LunoraClient.importRows} documents the same caveat for its counts.
     */
    /* eslint-enable jsdoc/check-indentation, no-secrets/no-secrets */
    public async mutation<F extends FunctionReference>(
        function_: F,
        args: ArgsOf<F>,
        options: MutationCallOptions<unknown, unknown, ArgsOf<F>> = {},
    ): Promise<ReturnOf<F>> {
        this.assertOpen();

        const argsRecord = args as Record<string, unknown>;

        // One stable idempotency key per logical mutation, shared by the direct
        // send and any offline-queue replay of this write (the entry reuses it as
        // its `id`). Lets the server dedup a replayed-but-already-committed write.
        // A durable outbox replay passes the original key back via `mutationId` so
        // its retry stays server-idempotent instead of minting a fresh key.
        const mutationId = options.mutationId ?? nextId();

        // Apply optimistic updates to any subscriber listening on this fn. Both
        // APIs ride the same rebaseable, cursor-gated layer engine: the per-call
        // `optimistic` transform patches the matching (fn, args, shard)
        // subscription, and the Convex-parity `optimisticUpdate` callback patches
        // many queries at once via a localStore (each `setQuery` a constant layer).
        // Their `confirm`/`rollback` closures collect into shared lists — all
        // confirmed on success, all unwound (LIFO) on failure.
        const { confirms: optimisticConfirms, rollbacks: optimisticRollbacks } = this.applyOptimisticUpdates(
            function_.__lunoraRef,
            argsRecord,
            options.shardKey,
            options.optimistic,
        );

        if (options.optimisticUpdate) {
            this.applyOptimisticUpdate(options.optimisticUpdate, args, options.shardKey, optimisticRollbacks, optimisticConfirms);
        }

        // Ordering barrier: a post-reconnect replay of THIS shard's queued writes
        // may be in flight. `onOpen` sets `wsState = "open"` before it starts the
        // flush, so without this the gate below is already false and a brand-new
        // write would race the replay of an older, queued write to the same
        // document — last-writer-wins then silently resurrects the older value.
        // Undefined (no replay running) is the overwhelmingly common case and
        // costs nothing; the gate is re-read AFTER the wait so a socket that
        // dropped again in the meantime queues this write instead of sending it.
        const replaying = this.offlineFlushes.get(connectionKey(options.shardKey));

        if (replaying !== undefined) {
            await replaying;
        }

        // Queue while offline (only mutations — queries fail fast). We also
        // queue when we're mid-reconnect (wsState === "connecting") provided
        // we've been connected before — otherwise the mutation would race
        // the resubscribe. State is scoped to the mutation's own shard so a
        // dropped shard only queues writes destined for it. A follower tab
        // has no `ShardConnection` of its own — `connectionGateState` derives
        // the same triple from the mirrored leader status instead.
        const { hasSocket, wasEverConnected, wsState } = this.connectionGateState(options.shardKey);
        const { queueBeforeFirstConnect } = this.offlineQueue;
        const connectedGate = wasEverConnected || queueBeforeFirstConnect;
        const shouldQueueOffline = this.WebSocketImpl !== undefined && connectedGate;
        const midReconnect = wsState === "connecting" && connectedGate;

        if ((wsState !== "open" && !hasSocket && shouldQueueOffline) || midReconnect) {
            return this.enqueueOfflineMutation(
                function_,
                argsRecord,
                options.shardKey,
                mutationId,
                optimisticRollbacks,
                optimisticConfirms,
                options.precondition,
            );
        }

        try {
            let commitCursor: number | undefined;
            const result = (await this.rpc(function_.__lunoraRef, argsRecord, options.shardKey, {
                captureBookmark: true,
                mutationId,
                onCommitCursor: (cursor) => {
                    commitCursor = cursor;
                },
            })) as ReturnOf<F>;

            // Confirm each per-call optimistic layer against the write's committed
            // CDC cursor: the layer drops gaplessly when (or once) a frame at that
            // cursor lands — never on this RPC-resolve timing, which races the WS
            // broadcast.
            for (const confirm of optimisticConfirms) {
                confirm(commitCursor);
            }

            return result;
        } catch (error) {
            // LIFO rollback: see the offline-queue reject path above.
            rollbackOptimistic(optimisticRollbacks);

            throw error;
        }
    }

    public async action<F extends FunctionReference>(function_: F, args: ArgsOf<F>, options: ActionCallOptions = {}): Promise<ReturnOf<F>> {
        this.assertOpen();

        // Both flags, because an action is the one entry point that does both
        // jobs: it reads through `ctx.runQuery` and writes through
        // `ctx.runMutation`. `query()` attaches and `mutation()` captures; this
        // passed neither, so an action writing through a `.global()` / D1 table
        // left `this.bookmark` untouched and the very next `query()` attached a
        // pre-action bookmark — answerable by a replica that predates the write.
        // The worker forwards an inbound `x-d1-bookmark` and returns one on this
        // route, so nothing upstream was compensating.
        return (await this.rpc(function_.__lunoraRef, args as Record<string, unknown>, options.shardKey, {
            attachBookmark: true,
            captureBookmark: true,
        })) as ReturnOf<F>;
    }

    /**
     * Bulk-import `rows` through a mutation that accepts a batch, chunked so a large
     * dataset lands in a bounded number of round-trips.
     *
     * **Offline caveat:** each chunk is sent with {@link LunoraClient.mutation}, which
     * resolves once the write is durably queued rather than once the server has applied
     * it. So an import run while offline resolves `{ chunks, imported }` with nothing
     * committed yet — the counts describe what was *handed over*, and the outbox
     * replays them on reconnect. Don't report "migration complete" on this alone.
     *
     * This is the one-shot migration / seed path: "I have 20k rows client-side and a
     * server mutation that inserts many at once". Doing it by hand goes wrong in two
     * predictable ways — a serial per-row loop pays one round-trip *and* one watermark
     * wait per row (a 200-row import becomes 200 sequential hops), while a single
     * giant call blows the DO's batch limit. So: chunk, send sequentially, and give
     * each chunk a stable idempotency key derived from `importId` + its index, so a
     * resumed or retried import doesn't double-insert the chunks that already landed.
     *
     * The server mutation is yours (Lunora can't guess the table or the row shape);
     * back it with `ctx.db.insertMany(...)`, or `insertManyUnsafe(...)` for data you
     * vouch for. `chunkSize` defaults to 500, matching the DO's default batch cap.
     *
     * ```ts
     * await client.importRows(api.migrate.importNodes, nodes, {
     *     importId: `migrate-${userId}`,
     *     onProgress: ({ done, total }) => setProgress(done / total),
     *     shardKey: userId,
     *     toArgs: (chunk) => ({ nodes: chunk }),
     * });
     * ```
     */
    public async importRows(
        function_: FunctionReference,
        rows: ReadonlyArray<unknown>,
        options: {
            /** Rows per call. Defaults to 500 — the DO's default batch cap. */
            chunkSize?: number;

            /**
             * Stable id for this import run. Each chunk is sent under
             * `${importId}:${chunkIndex}` as its mutation id, so re-running an import
             * that uses the SAME `chunkSize` re-sends each chunk under its prior key
             * and the server dedupes it instead of inserting twice.
             *
             * CAVEAT — the key is POSITIONAL, not content-based: it pins on the chunk
             * INDEX, not on the rows inside it. Resume or retry with a DIFFERENT
             * `chunkSize` (or a changed row ordering) and index N now covers different
             * rows than the first run's index N; the server sees a duplicate key and
             * SILENTLY DROPS those rows. Keep `chunkSize` (and the row order) identical
             * across resumes of the same `importId`. Omit `importId` only for a
             * throwaway import where double-insertion is acceptable.
             */
            importId?: string;

            /**
             * Called after each chunk is accepted — for a progress bar.
             *
             * "Accepted" is not always "committed": while offline (or mid-reconnect) a
             * `mutation` resolves as soon as the write is durably **queued**, so a fully
             * offline import reports completion with nothing yet applied server-side.
             * Gate a migration's "done" state on connectivity, not just on this.
             */
            onProgress?: (progress: { done: number; total: number }) => void;
            /** Routes every chunk to one shard's DO. */
            shardKey?: string;
            /** Build the mutation args for one chunk. Defaults to `{ rows: chunk }`. */
            toArgs?: (chunk: ReadonlyArray<unknown>) => Record<string, unknown>;
        } = {},
    ): Promise<{ chunks: number; imported: number }> {
        this.assertOpen();

        const chunkSize = Math.max(1, Math.trunc(options.chunkSize ?? 500));
        const toArgs =
            options.toArgs ??
            ((chunk: ReadonlyArray<unknown>) => {
                return { rows: chunk };
            });
        const total = rows.length;
        let done = 0;
        let chunks = 0;

        for (let offset = 0; offset < total; offset += chunkSize) {
            const chunk = rows.slice(offset, offset + chunkSize);
            const chunkIndex = chunks;

            // Sequential on purpose: concurrent chunks would race the shard's write
            // path and give up the deterministic resume point the idempotency key buys.
            // eslint-disable-next-line no-await-in-loop -- chunked import is sequential by design (see comment)
            await this.mutation(function_, toArgs(chunk), {
                ...(options.importId === undefined ? {} : { mutationId: `${options.importId}:${String(chunkIndex)}` }),
                shardKey: options.shardKey,
            });

            chunks += 1;
            done += chunk.length;
            options.onProgress?.({ done, total });
        }

        return { chunks, imported: done };
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
        this.assertOpen();

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
        this.assertOpen();

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
        this.assertOpen();

        const body = (await this.adminFetch(SCHEDULED_STATUS_PATH, "GET")) as Partial<SchedulerStatus>;

        return {
            backlog: body.backlog ?? 0,
            inFlight: body.inFlight ?? 0,
            pools: body.pools ?? [],
        };
    }

    /** Cancel a pending scheduled job by id. Returns whether a job was removed. */
    public async cancelScheduledJob(id: string): Promise<{ cancelled: boolean }> {
        this.assertOpen();

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
        this.assertOpen();

        // Walk every page. `/dead` became a bounded, cursored read so a shard
        // that dead-lettered thousands of jobs over a weekend cannot fail to
        // serialize them in one response — but the studio's dead-letter panel is
        // the ONLY view of a permanently-failed job and the only way to requeue
        // one, so stopping at the first page would hide exactly the backlog the
        // operator opened it for. Returning `records` alone made this silently
        // truncate the moment the route grew its limit.
        return await collectPages<ScheduleRecord>(
            async (cursor) =>
                (await this.adminFetch(cursor === undefined ? SCHEDULED_DEAD_PATH : `${SCHEDULED_DEAD_PATH}?cursor=${encodeURIComponent(cursor)}`, "GET")) as {
                    cursor?: string;
                    records?: ScheduleRecord[];
                    truncated?: boolean;
                },
        );
    }

    /**
     * Resurrect a dead-letter job by id: it re-enters the schedule with a fresh
     * retry budget and fires on the next drain. Returns whether a parked record
     * matched. Hits the admin-gated `POST /_lunora/admin/scheduled/dead/retry`.
     */
    public async retryDeadJob(id: string): Promise<{ retried: boolean }> {
        this.assertOpen();

        const body = (await this.adminFetch(SCHEDULED_DEAD_RETRY_PATH, "POST", { id })) as { retried?: boolean };

        return { retried: body.retried === true };
    }

    /**
     * Permanently drop a dead-letter job by id (the operator has decided not to
     * recover it). Returns whether a parked record was removed. Hits the
     * admin-gated `POST /_lunora/admin/scheduled/dead/cancel`.
     */
    public async removeDeadJob(id: string): Promise<{ removed: boolean }> {
        this.assertOpen();

        const body = (await this.adminFetch(SCHEDULED_DEAD_CANCEL_PATH, "POST", { id })) as { removed?: boolean };

        return { removed: body.removed === true };
    }

    /**
     * List a workflow's instances via the admin Workflows proxy
     * (`/_lunora/admin/workflows/instances`) — the Cloudflare control-plane data
     * the `Workflow` binding can't expose. Requires the worker to be built with a
     * `workflowsClient` (Cloudflare account id + API token). When one isn't
     * configured this does NOT reject: the proxy returns a `200 { configured:
     * false }` sentinel, so the result resolves with `configured === false` and an
     * empty `instances` list — callers should branch on that flag rather than
     * try/catch. (The instance-detail / status endpoints still reject with 501.)
     * `name` is the deployed workflow name.
     */
    public async listWorkflowInstances(options: {
        name: string;
        page?: number;
        perPage?: number;
        status?: WorkflowInstanceStatus;
    }): Promise<WorkflowInstancePage> {
        this.assertOpen();

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
        this.assertOpen();

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
        this.assertOpen();

        const body = (await this.adminFetch(WORKFLOWS_STATUS_PATH, "POST", { action: options.action, id: options.id, name: options.name })) as {
            status?: WorkflowInstanceStatus;
        };

        return { status: body.status ?? "unknown" };
    }

    /**
     * Subscribe to the live scheduled-jobs list over the SchedulerDO's admin
     * WebSocket. `onJobs` fires with the full list on connect and on every
     * change (schedule / cancel / alarm-fire). Reconnects with the client's
     * configured backoff. Requires `wsToken` to be set to an admin credential
     * (the browser can't send an `Authorization` header on a WS) — the master
     * token, or preferably a {@link WsTokenProvider} minting the ephemeral
     * sub-token so the master credential stays out of the URL. Returns an
     * unsubscribe function that closes the socket and stops reconnecting.
     */
    public subscribeScheduledJobs(onJobs: (jobs: ScheduleRecord[]) => void): Unsubscribe {
        this.assertOpen();

        if (this.WebSocketImpl === undefined) {
            return () => undefined;
        }

        const base = joinUrl(deriveWsUrl(this.url), SCHEDULED_WS_PATH);
        const reconnect = createReconnect(this.reconnectOptions);

        // This subscription's own connection state — the identity-guard
        // comparand `openManagedSocket` re-checks before every action, exactly
        // like the shard socket's `ShardConnection`. Built on the same shared
        // helper (plan 217's connect-timeout + heartbeat/watchdog, plan 231's
        // identity guard) instead of a second, hand-rolled implementation
        // (CLIENT-05).
        const conn: ManagedSocketState = {
            connectTimer: undefined,
            heartbeatTimer: undefined,
            lastFrameAt: 0,
            socket: undefined,
        };

        let timer: ReturnType<typeof setTimeout> | undefined;
        let closed = false;

        /** Arm the next reconnect attempt, unless `unsubscribe()` — or `close()` — already ran. */
        const scheduleReconnect = (): void => {
            if (closed || this.closed) {
                return;
            }

            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: the reconnect re-enters `connect`, declared just below with `openWith` in scope
            timer = setTimeout(connect, reconnect.next());
        };

        const openWith = (token: string | undefined): void => {
            if (closed || this.WebSocketImpl === undefined) {
                return;
            }

            const url = token === undefined ? base : `${base}?token=${encodeURIComponent(token)}`;

            this.openManagedSocket(conn, url, this.connectTimeoutMs, {
                onClose: () => {
                    scheduleReconnect();
                },
                onMessage: (event: MessageEvent) => {
                    // `lastFrameAt` is stamped by `openManagedSocket` itself
                    // (its `message` listener) for every caller — nothing to
                    // do here beyond parsing.
                    try {
                        const message = JSON.parse(typeof event.data === "string" ? event.data : "") as { records?: ScheduleRecord[]; type?: string };

                        if (message.type === "jobs" && Array.isArray(message.records)) {
                            // A payload frame is the proof of a live, ACCEPTED
                            // socket that `open` alone never was: the upgrade
                            // succeeds before the admin credential is checked,
                            // so resetting on `open` made a rejected token
                            // reconnect at the initial delay forever instead of
                            // backing off (mirrors the shard socket's fix).
                            reconnect.reset();
                            onJobs(message.records);
                        }
                    } catch {
                        /* a non-JSON frame — ignore */
                    }
                },
            });
        };

        /** Resolve the provider-shaped token, then open; a failed mint re-arms the reconnect timer. */
        const connectWithProvider = async (provider: WsTokenProvider): Promise<void> => {
            let token: string | undefined;

            try {
                token = await provider();
            } catch {
                scheduleReconnect();

                return;
            }

            openWith(token);
        };

        // Read `this.wsToken` at connect time (not once at subscribe time) so a
        // post-subscribe `setWsToken()` rotation is picked up on the next
        // reconnect attempt instead of looping forever with a stale token the
        // admin gate rejects. A provider-shaped token is resolved fresh per
        // attempt (re-minting the ephemeral admin sub-token); a provider failure
        // re-arms the reconnect timer so a broken mint endpoint degrades to
        // backoff retries.
        const connect = (): void => {
            if (closed || this.WebSocketImpl === undefined) {
                return;
            }

            const { wsToken } = this;

            if (typeof wsToken === "function") {
                // `connectWithProvider` never rejects (its awaits are try/caught),
                // so the fire-and-forget catch is belt-and-braces.
                connectWithProvider(wsToken).catch(() => undefined);

                return;
            }

            openWith(wsToken);
        };

        connect();

        const teardown = (): void => {
            closed = true;

            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }

            if (conn.connectTimer !== undefined) {
                clearTimeout(conn.connectTimer);
                conn.connectTimer = undefined;
            }

            this.stopHeartbeat(conn);

            conn.socket?.close();
            conn.socket = undefined;
        };

        // Registered so `close()` stops this socket too — its reconnect loop is
        // driven by the closure-local `closed` flag above, which nothing outside
        // the returned unsubscribe could ever set.
        this.adminSocketTeardowns.add(teardown);

        return () => {
            this.adminSocketTeardowns.delete(teardown);
            teardown();
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
        this.assertOpen();

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
        this.assertOpen();

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
        this.assertOpen();

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
        this.assertOpen();

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
        this.assertOpen();

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
        this.assertOpen();

        const path = withQuery(STORAGE_PATH, { bucket: options.bucket, cursor: options.cursor, limit: options.limit, prefix: options.prefix });
        const body = (await this.adminFetch(path, "GET")) as { cursor?: string; objects?: StorageObject[] };

        return { cursor: body.cursor, objects: body.objects ?? [] };
    }

    /**
     * Delete one object from the storage bucket by key. Hits the admin-gated
     * `DELETE /_lunora/admin/storage?key=…` endpoint — the worker must be built
     * with a `storageDelete` function and `adminToken`. Powers the studio file
     * browser's per-row delete; resolves `{ deleted, key }`.
     *
     * An absent `deleted` field reads as `false`, matching every sibling admin
     * verb (`runCronJob`'s `ran`, …): the studio renders this value as the row's
     * outcome, so defaulting a missing field to success would report a delete
     * that a mismatched/older worker never performed.
     */
    public async deleteStorageObject(key: string, options?: { bucket?: string }): Promise<{ deleted: boolean; key: string }> {
        this.assertOpen();

        const path = `${STORAGE_PATH}?key=${encodeURIComponent(key)}${bucketQuery(options?.bucket)}`;
        const body = (await this.adminFetch(path, "DELETE")) as { deleted?: boolean; key?: string };

        return { deleted: body.deleted === true, key: body.key ?? key };
    }

    /**
     * List the storage bucket names the worker exposes, for the studio file
     * browser's bucket picker. Hits the admin-gated
     * `GET /_lunora/admin/storage/buckets` endpoint — always resolves (an empty
     * array when the worker configures no `storageBuckets`, i.e. single-bucket).
     */
    public async listStorageBuckets(): Promise<string[]> {
        this.assertOpen();

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
        this.assertOpen();

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
        this.assertOpen();

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
        this.assertOpen();

        return (await this.adminFetch(GLOBAL_TABLES_PATH, "GET")) as GlobalTableInfo[];
    }

    /**
     * Read a page of rows from one `.global()` table. `filters` AND-narrows the
     * page to rows matching each `column = value` eq constraint — the drill-down a
     * facet-value click applies; the array is wire-encoded, JSON-encoded into the
     * `filters` query param, and the values are bound server-side.
     *
     * The response is `decodeWire`d. The worker encodes it (`readGlobalTablePage`
     * in `@lunora/d1`) because JSON cannot carry a `v.bigint()` column at all and
     * silently flattens a `v.bytes()` one to `{}` — so without the decode here the
     * grid renders the raw 3-element tagged array instead of the value. The shard
     * browser's twin already pairs the same way through `rpc`; this is the global
     * half of that symmetry.
     */
    public async readGlobalTablePage(options: { filters?: GlobalFilterClause[]; limit?: number; offset?: number; table: string }): Promise<GlobalTablePage> {
        this.assertOpen();

        const params = new URLSearchParams({ table: options.table });

        if (options.limit !== undefined) {
            params.set("limit", String(options.limit));
        }

        if (options.offset !== undefined) {
            params.set("offset", String(options.offset));
        }

        if (options.filters !== undefined && options.filters.length > 0) {
            params.set("filters", JSON.stringify(encodeWire(options.filters)));
        }

        return decodeWire(await this.adminFetch(`${GLOBAL_TABLE_PATH}?${params.toString()}`, "GET")) as GlobalTablePage;
    }

    /**
     * Summarise the distinct values of one column in a `.global()` table over the
     * active view (the same eq `filters` the browser is previewing) — the global
     * twin of the shard browser's facet. Hits the admin-gated
     * `GET /_lunora/admin/global/facet` endpoint; `column` is validated + bound
     * server-side. Powers the global data browser's facet sidebar.
     *
     * Wire-encoded/decoded on both legs for the same reason
     * {@link LunoraClient.readGlobalTablePage} is: a facet over a BLOB column
     * returns bytes, which `Response.json` flattens to `{}` — and since a facet
     * value is exactly what a click sends back as a `filters` clause, that is a
     * broken drill-down rather than a display glitch.
     */
    public async facetGlobalColumn(options: { column: string; filters?: GlobalFilterClause[]; limit?: number; table: string }): Promise<GlobalFacetResult> {
        this.assertOpen();

        const params = new URLSearchParams({ column: options.column, table: options.table });

        if (options.limit !== undefined) {
            params.set("limit", String(options.limit));
        }

        if (options.filters !== undefined && options.filters.length > 0) {
            params.set("filters", JSON.stringify(encodeWire(options.filters)));
        }

        return decodeWire(await this.adminFetch(`${GLOBAL_FACET_PATH}?${params.toString()}`, "GET")) as GlobalFacetResult;
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
        this.assertOpen();

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
        this.assertOpen();

        const body = (await this.adminFetch(VECTOR_QUERY_PATH, "POST", options)) as { matches?: VectorQueryMatch[] };

        return body.matches ?? [];
    }

    /**
     * Read one keyset-paginated page of the durable `ctx.log` archive that
     * `pipelineLogSink` writes to R2. Server-side only — the worker holds the R2
     * SQL credentials and runs the reader; the browser only sees the decoded
     * `{ rows, nextCursor }`. Pass the previous page's `nextCursor` as
     * `query.cursor` to page. Admin-gated. When the operator hasn't wired the
     * archive, `adminFetch` throws a `LunoraClientError` with `.code ===
     * "LOG_ARCHIVE_NOT_CONFIGURED"`, so a caller can render a "not configured"
     * state rather than an error.
     */
    public async queryLogArchive(query: PipelineLogQuery = {}): Promise<PipelineLogPage> {
        this.assertOpen();

        // `PipelineLogQuery` is a named interface (no index signature), so widen it
        // to the record shape `adminFetch` serializes.
        const body = (await this.adminFetch(LOG_ARCHIVE_PATH, "POST", query as Record<string, unknown>)) as Partial<PipelineLogPage>;

        return { nextCursor: body.nextCursor, rows: body.rows ?? [] };
    }

    // --- KV namespace admin -------------------------------------------------

    /**
     * List the worker's registered Workers KV namespaces (binding names). Hits
     * the admin-gated `GET /_lunora/admin/kv/namespaces` endpoint — the worker
     * must be built with a `kvIntrospector` and `adminToken`. Powers the
     * studio's KV browser.
     */
    public async listKvNamespaces(): Promise<KvNamespaceSummary[]> {
        this.assertOpen();

        const body = (await this.adminFetch(KV_NAMESPACES_PATH, "GET")) as { namespaces?: KvNamespaceSummary[] };

        return body.namespaces ?? [];
    }

    /**
     * List keys in a KV namespace, optionally filtered by `prefix` and
     * paginated via `cursor`. Hits the admin-gated
     * `GET /_lunora/admin/kv/keys` endpoint.
     */
    public async listKvKeys(options: { cursor?: string; limit?: number; namespace: string; prefix?: string }): Promise<KvKeyListResult> {
        this.assertOpen();

        const path = withQuery(KV_KEYS_PATH, {
            cursor: options.cursor,
            limit: options.limit,
            namespace: options.namespace,
            prefix: options.prefix,
        });

        return (await this.adminFetch(path, "GET")) as KvKeyListResult;
    }

    /**
     * Read a KV value (as text) and its metadata. Hits the admin-gated
     * `GET /_lunora/admin/kv/value` endpoint. Returns `{ value: null, metadata: null }`
     * when the key is absent.
     */
    public async getKvValue(options: { key: string; namespace: string }): Promise<KvValueResult> {
        this.assertOpen();

        const path = withQuery(KV_VALUE_PATH, { key: options.key, namespace: options.namespace });

        return (await this.adminFetch(path, "GET")) as KvValueResult;
    }

    /**
     * Write a string value to a KV namespace. Accepts an absolute `expiration`
     * (Unix seconds) or a relative `expirationTtl`, plus optional `metadata` —
     * re-send the loaded values on edit so a save preserves rather than clears
     * them. Hits the admin-gated `PUT /_lunora/admin/kv/value` endpoint.
     */
    public async putKvValue(options: {
        expiration?: number;
        expirationTtl?: number;
        key: string;
        metadata?: unknown;
        namespace: string;
        value: string;
    }): Promise<void> {
        this.assertOpen();

        await this.adminFetch(KV_VALUE_PATH, "PUT", options);
    }

    /**
     * Delete a key from a KV namespace. No-op when the key is absent. Hits the
     * admin-gated `DELETE /_lunora/admin/kv/value` endpoint.
     */
    public async deleteKvKey(options: { key: string; namespace: string }): Promise<void> {
        this.assertOpen();

        const path = withQuery(KV_VALUE_PATH, { key: options.key, namespace: options.namespace });

        await this.adminFetch(path, "DELETE");
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
        this.assertOpen();

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

    /**
     * Report the deployment's auth configuration — enabled plugins, sign-in
     * methods, user-settable create-user fields, organization sub-features
     * (teams / roles), and session / rate-limit policy. Drives the config panel
     * and the dynamic create-user form. Never carries a secret.
     */
    public async getAuthConfig(): Promise<AuthConfigInfo> {
        return (await this.adminFetch(AUTH_CONFIG_PATH, "GET")) as AuthConfigInfo;
    }

    /** Create an organization; optionally seed an `owner` member for `ownerId`. */
    public async createAuthOrganization(input: {
        logo?: string;
        metadata?: Record<string, unknown>;
        name: string;
        ownerId?: string;
        slug?: string;
    }): Promise<Record<string, unknown>> {
        return (await this.adminFetch(AUTH_CREATE_ORG_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Update an organization's name/slug/logo/metadata. */
    public async updateAuthOrganization(input: {
        logo?: string;
        metadata?: Record<string, unknown>;
        name?: string;
        organizationId: string;
        slug?: string;
    }): Promise<Record<string, unknown>> {
        return (await this.adminFetch(AUTH_UPDATE_ORG_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Delete an organization and cascade its members, invitations, teams, and custom roles. */
    public async deleteAuthOrganization(input: { organizationId: string }): Promise<void> {
        await this.adminFetch(AUTH_REMOVE_ORG_PATH, "POST", input);
    }

    /** Directly add an existing user to an organization (no invitation/acceptance). */
    public async addAuthOrgMember(input: { organizationId: string; role?: string; userId: string }): Promise<Record<string, unknown>> {
        return (await this.adminFetch(AUTH_ADD_MEMBER_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Create a pending email invitation to an organization. */
    public async inviteAuthOrgMember(input: { email: string; inviterId?: string; organizationId: string; role?: string }): Promise<Record<string, unknown>> {
        return (await this.adminFetch(AUTH_INVITE_MEMBER_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Change a member's role. */
    public async setAuthOrgMemberRole(input: { memberId: string; role: string | string[] }): Promise<Record<string, unknown>> {
        return (await this.adminFetch(AUTH_MEMBER_ROLE_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** List an organization's teams (requires the organization plugin with teams enabled). */
    public async listAuthOrgTeams(input: { limit?: number; offset?: number; organizationId: string }): Promise<AuthPage<Record<string, unknown>>> {
        const path = withQuery(AUTH_ORG_TEAMS_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

        return (await this.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
    }

    /** Create a team under an organization. */
    public async createAuthOrgTeam(input: { name: string; organizationId: string }): Promise<Record<string, unknown>> {
        return (await this.adminFetch(AUTH_CREATE_TEAM_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Rename a team. */
    public async updateAuthOrgTeam(input: { name: string; teamId: string }): Promise<Record<string, unknown>> {
        return (await this.adminFetch(AUTH_UPDATE_TEAM_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Delete a team and its memberships. */
    public async removeAuthOrgTeam(input: { teamId: string }): Promise<void> {
        await this.adminFetch(AUTH_REMOVE_TEAM_PATH, "POST", input);
    }

    /** List a team's members. */
    public async listAuthOrgTeamMembers(input: { limit?: number; offset?: number; teamId: string }): Promise<AuthPage<Record<string, unknown>>> {
        const path = withQuery(AUTH_ORG_TEAM_MEMBERS_PATH, { limit: input.limit, offset: input.offset, teamId: input.teamId });

        return (await this.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
    }

    /** Add a user to a team. */
    public async addAuthOrgTeamMember(input: { teamId: string; userId: string }): Promise<Record<string, unknown>> {
        return (await this.adminFetch(AUTH_ADD_TEAM_MEMBER_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Remove a member from a team. */
    public async removeAuthOrgTeamMember(input: { teamMemberId: string }): Promise<void> {
        await this.adminFetch(AUTH_REMOVE_TEAM_MEMBER_PATH, "POST", input);
    }

    /** List an organization's custom roles (requires the organization plugin with dynamic access control). */
    public async listAuthOrgRoles(input: { limit?: number; offset?: number; organizationId: string }): Promise<AuthPage<Record<string, unknown>>> {
        const path = withQuery(AUTH_ORG_ROLES_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

        return (await this.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
    }

    /** Create a custom org role with a permission grant (a `resource -> actions[]` map). */
    public async createAuthOrgRole(input: { organizationId: string; permission: Record<string, string[]>; role: string }): Promise<Record<string, unknown>> {
        return (await this.adminFetch(AUTH_CREATE_ROLE_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Replace a custom org role's permission grant. */
    public async updateAuthOrgRole(input: { permission: Record<string, string[]>; roleId: string }): Promise<Record<string, unknown>> {
        return (await this.adminFetch(AUTH_UPDATE_ROLE_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Delete a custom org role. */
    public async deleteAuthOrgRole(input: { roleId: string }): Promise<void> {
        await this.adminFetch(AUTH_REMOVE_ROLE_PATH, "POST", input);
    }

    /** List auth sessions, paged and optionally filtered to one user. */
    public async listAuthSessions(options: { limit?: number; offset?: number; userId?: string } = {}): Promise<AuthPage<AuthSession>> {
        this.assertOpen();

        const path = withQuery(AUTH_SESSIONS_PATH, { limit: options.limit, offset: options.offset, userId: options.userId });

        return (await this.adminFetch(path, "GET")) as AuthPage<AuthSession>;
    }

    // --- Subscriptions ------------------------------------------------------

    /**
     * Subscribe to a live query. The callback fires with the current value (from
     * the durable read cache, when one is hydrated) and again on every server
     * frame; the returned function unsubscribes.
     *
     * Subscriptions are deduped by `(functionPath, args, shardKey)` — a second
     * `subscribe` for the same triple joins the existing registration and shares
     * its value, cursor and optimistic layers.
     *
     * Available on a `crossTabSync` FOLLOWER tab, unlike the other socket-backed
     * surfaces: registering here is exactly what lets the cross-tab relay deliver
     * the leader's broadcasts (see the note in the body). The caveat is that the
     * channel only carries the LEADER's own subscriptions outward, so a follower
     * sees this query's frames only while the leader holds it too — see
     * {@link LunoraClientOptions.crossTabSync}.
     */
    public subscribe<F extends FunctionReference>(
        function_: F,
        args: ArgsOf<F>,
        callback: (data: ReturnOf<F>) => void,
        options: { onCheckpoint?: (watermark: SyncWatermark) => void; onError?: SubscriptionErrorCallback; shardKey?: string } = {},
    ): Unsubscribe {
        this.assertOpen();

        // NOT guarded by `assertLeaderOwnedSurface`, unlike the other
        // socket-backed surfaces: a follower's `subscribe` is exactly how the
        // cross-tab relay works. The registration below is what puts a
        // `SubscriptionState` in `this.subscriptions`, and `onSubscriptionData`
        // drops any broadcast whose key it cannot find there — so refusing a
        // follower's `subscribe` would not merely fail that call, it would make
        // the leader's entire broadcast path dead code and break every
        // `useQuery` in every non-leader tab.
        const argsRecord = (args ?? {}) as Record<string, unknown>;
        const key = SubscriptionRegistry.key(function_.__lunoraRef, argsRecord, options.shardKey);

        let state = this.subscriptions.get(key);

        // Wrap, never register the caller's own function: `callbacks` is a Set,
        // so two consumers that pass the SAME reference (a module-level handler,
        // a `useCallback`-stable one) would collapse to one entry and the first
        // unsubscribe would tear the registration out from under the second.
        // A fresh closure per `subscribe()` call gives each consumer its own
        // slot, its own delivery, and its own unsubscribe. Mirrored below for
        // `onError`/`onCheckpoint`, which have the same shape.
        const subscriptionCallback: SubscriptionCallback = wrapSubscriber(callback as SubscriptionCallback);
        const errorCallback = wrapSubscriber(options.onError);
        const checkpointCallback = wrapSubscriber(options.onCheckpoint);

        if (!state) {
            this.nextSubId += 1;
            const id = `sub_${this.nextSubId.toString()}`;
            const argsKey = stableWireKey(argsRecord);
            const cached = this.takeHydratedCache(function_.__lunoraRef, argsKey, options.shardKey);

            state = {
                acked: false,
                args: argsRecord,
                argsKey,
                callbacks: new Set<SubscriptionCallback>(),
                checkpointCallbacks: new Set(),
                errorCallbacks: new Set<SubscriptionErrorCallback>(),
                fn: function_,
                id,
                lastValue: cached?.value,
                optimisticLayers: [],
                serverBase: cached?.value,
                serverCursor: cached?.serverCursor,
                shardKey: options.shardKey,
                // Encode ONCE, here, so an unsupported arg value throws at this
                // call site instead of inside a reconnect's open handler — and
                // so a caller mutating its own `args` object afterwards cannot
                // poison the resubscribe (see `SubscriptionState.wireArgs`).
                wireArgs: encodeCallArgs(argsRecord, `args for '${function_.__lunoraRef}'`) as Record<string, unknown>,
                ...(cached?.serverEpoch === undefined ? {} : { serverEpoch: cached.serverEpoch }),
            };
            this.subscriptions.add(state);
        }

        state.callbacks.add(subscriptionCallback);

        if (errorCallback) {
            state.errorCallbacks.add(errorCallback);
        }

        // Register this subscriber's checkpoint callback on the SHARED state, so a
        // `@lunora/db` collection still receives `settled` fan-out even when it
        // joins a query a plain `useQuery` opened first (the state already existed
        // above). One slot would drop every subscriber but the state's creator.
        if (checkpointCallback) {
            state.checkpointCallbacks.add(checkpointCallback);
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

            if (checkpointCallback) {
                subscriptionState.checkpointCallbacks.delete(checkpointCallback);
            }

            if (subscriptionState.callbacks.size === 0) {
                this.sendOrQueueUnsubscribe(subscriptionState.shardKey, subscriptionState.id, "unsubscribe");
                this.subscriptions.remove(subscriptionState);
            }
        };
    }

    /**
     * Subscribe to a declarative **shape** — server-side partial replication
     * scoped by `shardBy` + the shape's predicate + RLS. The parallel to
     * {@link subscribe} for the poke protocol: the client sends the shape *name* +
     * validated `args` (never a `where` the client could forge), the server seeds
     * the current membership as an insert-poke and streams live membership diffs.
     * Each applied poke materializes the shape's rowset and invokes `callback`.
     *
     * Unlike {@link subscribe}, shape subscriptions are NOT deduped by
     * (name, args): the server resolves them under the socket's verified identity,
     * so every call gets its own id + view. The returned function unsubscribes.
     *
     * Not available on a `crossTabSync` FOLLOWER tab: shape pokes are not part of
     * the leader→follower broadcast set, so a follower's shape could never
     * resolve. Throws `NOT_IMPLEMENTED` there — see
     * {@link LunoraClientOptions.crossTabSync}.
     */
    public subscribeShape(
        shape: { args?: Record<string, unknown>; name: string },
        callback: ShapeCallback,
        options: { onCheckpoint?: (watermark: SyncWatermark) => void; onError?: SubscriptionErrorCallback; shardKey?: string } = {},
    ): Unsubscribe {
        this.assertOpen();

        // Inert on a follower, for the same reason as
        // `acquireConnectionContext`: `@lunora/db`'s shape-backed
        // `createCollection` calls this from its sync path, so a throw takes out
        // the collection rather than degrading it. The leader broadcasts nothing
        // for shapes, so a follower's handle can only ever be inert.
        if (this.followsAnotherTab()) {
            return () => undefined;
        }

        this.nextShapeId += 1;
        const id = `shape_${this.nextShapeId.toString()}`;
        const state: ShapeSubscriptionState = {
            args: shape.args,
            callbacks: new Set([callback]),
            errorCallbacks: options.onError ? new Set([options.onError]) : new Set(),
            id,
            name: shape.name,
            onCheckpoint: options.onCheckpoint,
            rows: new Map(),
            shardKey: options.shardKey,
            // Encode ONCE, here, so an unsupported arg value throws at this call
            // site instead of inside a reconnect's open handler.
            wireArgs: shape.args === undefined ? undefined : (encodeCallArgs(shape.args, `shape args for '${shape.name}'`) as Record<string, unknown>),
        };

        this.shapeSubscriptions.set(id, state);
        this.ensureSocket(options.shardKey);
        this.sendShapeSubscribeIfOpen(state);

        return () => {
            this.shapeSubscriptions.delete(id);
            this.sendOrQueueUnsubscribe(state.shardKey, id, "shape_unsubscribe");
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
        options: { durable?: boolean; maxBuffer?: number; shardKey?: string } = {},
    ): StreamIterable<ReturnOf<F>> {
        this.assertOpen();

        if (this.WebSocketImpl === undefined) {
            throw new LunoraError("INTERNAL", "LunoraClient: streams require a WebSocket implementation");
        }

        this.nextStreamId += 1;
        const id = `stream_${this.nextStreamId.toString()}`;
        const { shardKey } = options;
        const argsRecord = (args ?? {}) as Record<string, unknown>;

        const { handle, iterable } = createStream<ReturnOf<F>>({
            maxBuffer: options.maxBuffer,
            onCancel: () => {
                this.cancelStream(id, shardKey);
            },
        });

        this.ensureSocket(shardKey);

        const conn = this.getConnection(shardKey);
        const message: ClientMessage = {
            id,
            // Wire-encode the stream args so `bigint`/bytes survive the send (raw
            // `JSON.stringify` throws on a bigint); the shard `decodeWire`s them
            // before invoking the stream handler.
            query: {
                args: encodeCallArgs(argsRecord, `stream args for '${function_.__lunoraRef}'`) as Record<string, unknown>,
                functionPath: function_.__lunoraRef,
                shardKey,
            },
            type: "stream",
        };

        // Record before sending so an immediate ack/chunk reaching the dispatch
        // path before we return finds its target. The start frame is kept so a
        // durable stream can be re-sent verbatim (plus its resume watermark)
        // when the socket comes back.
        // `durable` starts from the caller's intent and is corrected by the first
        // `seq`-bearing chunk; a server that did not declare the procedure durable
        // never sends one, so the stream stays non-resumable.
        const record = {
            durable: options.durable === true,
            generation: undefined as number | undefined,
            handle: handle as StreamHandle,
            lastSeq: 0,
            message,
            shardKey,
            started: false,
        };

        this.streams.set(id, record);

        // Fast path: socket is open, try to send immediately. `sendOn` can still
        // return `false` if the socket closed between the `wsState` check and the
        // `.send()` call (or `.send()` threw) — in that race the frame was never
        // delivered, so fall through to the bounded pending-queue path below so it
        // rides the next reconnect instead of leaking a forever-hanging consumer.
        const sentImmediately = conn?.wsState === "open" && sendOn(conn, message);

        // Once the frame lands the server owns a run for this id, so a later
        // cancel has to reach it rather than just dropping the local record.
        record.started = sentImmediately;

        if (!sentImmediately && conn === undefined) {
            // No connection at all, so there is nothing to send on AND nothing to
            // queue against. `ensureSocket` returns before creating one whenever
            // this tab is not the cross-tab leader — which includes the window
            // every `crossTabSync` client spends as a follower before it
            // self-promotes — and cross-tab relays only subscription frames, so a
            // follower has no stream path.
            //
            // Both branches below used to be guarded on `conn`, so this case fell
            // off the end: the stream was recorded and its iterable returned
            // having sent nothing and queued nothing, and the consumer's
            // `for await` hung forever with no error and no completion. Failing
            // it names the limitation instead.
            this.streams.delete(id);
            handle.fail(
                new LunoraError(
                    "STREAM_DISCONNECTED",
                    "stream unavailable: this tab is not the cross-tab WebSocket leader, so it holds no socket to stream over",
                ),
            );

            return iterable;
        }

        // `conn` is provably present here — the branch above returned for its
        // absence, which is the case that used to fall through both guards.
        if (!sentImmediately) {
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
                    droppedStream.handle.fail(new LunoraError("STREAM_QUEUE_OVERFLOW", "stream-start frame evicted while socket was unreachable"));
                    this.streams.delete(droppedId as string);
                }
            }

            conn.pendingStreams.push(message);
        }

        return iterable;
    }

    /**
     * Open a typed **HTTP-SSE route stream** (`httpRoute.<verb>(path).stream()`).
     * Distinct from {@link LunoraClient.stream}, which consumes the WS procedure
     * stream (`kind: "stream"`): this one opens the route's own URL with `fetch`
     * and parses the Server-Sent Events framing the route pump writes (`data:`
     * chunks, a final `event: complete`, an `event: error` on throw).
     *
     * The reference comes from the generated `httpStreams.*` registry, so the
     * yielded chunk type is the route handler's yielded type. Cancelling the
     * returned iterable (or aborting `options.signal`) aborts the fetch, which
     * the server handler observes via its `signal`. The client's bearer token
     * (when set) rides as an `authorization` header.
     * @experimental Reconnect/POST-body/wire-fidelity design questions are still open, so the shape may change.
     */
    public httpStream<Ref extends HttpStreamRef>(
        route: Ref,
        args?: HttpStreamArgsOf<Ref>,
        options: { headers?: Record<string, string>; maxBuffer?: number; signal?: AbortSignal } = {},
    ): StreamIterable<HttpStreamChunkOf<Ref>> {
        if (this.closed) {
            throw new LunoraError("CLIENT_CLOSED", "LunoraClient is closed");
        }

        if (!this.fetchImpl) {
            throw new LunoraError("INTERNAL", "LunoraClient: no `fetch` implementation available");
        }

        const headers: Record<string, string> = {
            ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
            ...options.headers,
        };

        return httpStream(route, args, {
            baseUrl: this.url,
            fetch: this.fetchImpl,
            headers,
            maxBuffer: options.maxBuffer,
            signal: options.signal,
        });
    }

    public close(): void {
        this.closed = true;

        // Release multi-tab outbox leadership so another tab can take over.
        this.outboxLeaderRelease?.();
        this.outboxLeaderRelease = undefined;

        // Fail any in-flight streams so consumers see a deterministic
        // termination instead of an iterator that hangs forever after the
        // underlying socket goes away.
        for (const stream of this.streams.values()) {
            stream.handle.fail(new LunoraError("CLIENT_CLOSED", "LunoraClient closed"));
        }

        this.streams.clear();

        for (const conn of this.connections.values()) {
            this.teardownConnection(conn);
        }

        // Admin sockets (`subscribeScheduledJobs`) are not in `connections` and
        // run their own reconnect loop — stop each one explicitly.
        for (const teardown of this.adminSocketTeardowns) {
            teardown();
        }

        this.adminSocketTeardowns.clear();

        // Rate-limit retry flushes are the one timer that outlives the socket
        // teardown above (they fire against an open connection, not a reconnect).
        for (const timer of this.replayRetryTimers.values()) {
            clearTimeout(timer);
        }

        this.replayRetryTimers.clear();
        this.replayRetryState.clear();

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
        this.mutationSettledListeners.clear();
        this.pendingChangeListeners.clear();
        this.whisperHandlers.clear();

        // Shape subscriptions retain user row/error callbacks and replicated
        // rows; poke buffers hold partially-assembled membership. Neither is
        // touched by the registries above, so drop them too — otherwise the UI
        // closures they close over outlive the terminal client.
        this.shapeSubscriptions.clear();
        this.pokeBuffers.clear();

        // The three registries the comment above always claimed to cover but
        // never did. Each `SubscriptionState` holds three callback sets
        // (`callbacks`, `errorCallbacks`, `checkpointCallbacks` — React state
        // setters and `@lunora/db` collection closures); `clientQueryStore`
        // holds a subscriber set per client-query ref; `hydratedQueryCache`
        // holds the whole restored read cache. All three survived `close()`
        // for as long as the client object stayed reachable — which, for a
        // client held in a module-level singleton or a React context, is the
        // lifetime of the page.
        this.subscriptions.clear();
        this.clientQueryStore.clear();
        this.hydratedQueryCache.clear();

        // Stop cross-tab coordination and release the BroadcastChannel.
        this.tabCoordinator?.stop();
        this.tabCoordinator = undefined;
    }

    /** Guard shared by every public entry point: a closed client accepts no further calls. */
    private assertOpen(): void {
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }
    }

    /**
     * `true` when this tab is a cross-tab FOLLOWER of a live leader — i.e. it
     * will not open a socket of its own and another tab is known to hold one.
     *
     * Deliberately NOT just `!isLeader()`. Every `crossTabSync` client is a
     * non-leader for the first `leaderTimeout` of its life, while its
     * claim-leadership probe is outstanding; a lone tab self-promotes at the end
     * of that window and `onBecomeLeader` opens the sockets and replays every
     * registered subscription. That window is a legitimate, self-healing defer,
     * not a failure. A KNOWN leader on another tab is the state that never heals.
     */
    private followsAnotherTab(): boolean {
        const coordinator = this.tabCoordinator;

        if (coordinator === undefined || coordinator.isLeader()) {
            return false;
        }

        const leader = coordinator.leaderTabId;

        return leader !== undefined && leader !== coordinator.id;
    }

    /**
     * Reject a call that needs a socket this tab will never have.
     *
     * The cross-tab protocol is one-directional: a leader broadcasts
     * `subscription-data` / `-error` / `-settled` / `connection-status` to
     * followers, and a follower has no frame with which to tell the leader what
     * it needs (see `cross-tab.ts`'s `WsFollowerMessage`, which is exactly
     * heartbeat / claim-leadership / yield-leadership). `subscribeShape` /
     * `whisper*` / `setConnectionContext` / `acquireConnectionContext` — none of
     * which the leader broadcasts at all — therefore never worked on a follower
     * under any circumstances: each returned a handle that looked live, fired no
     * callback, raised no error, and reported `connectionStatus() ===
     * "connected"` (mirrored from the leader).
     *
     * `subscribe` is deliberately NOT in that set. A follower's `subscribe`
     * registers the key the leader's broadcast is matched against, so it is the
     * mechanism the relay is built on rather than a surface that silently fails.
     * A follower sees a query only while the leader holds the same
     * `(fn, args, shardKey)` — that is the documented shape of the option, not a
     * defect.
     *
     * `stream()` reaches the same outcome by a different route: it fails the
     * handle it returns rather than throwing at the call. See
     * {@link LunoraClientOptions.crossTabSync} for what the option does and does
     * not cover.
     */
    private assertLeaderOwnedSurface(surface: string): void {
        if (!this.followsAnotherTab()) {
            return;
        }

        throw new LunoraError(
            "NOT_IMPLEMENTED",
            `LunoraClient: \`${surface}\` is unavailable on a cross-tab follower tab. ` +
                `The \`crossTabSync\` channel only carries data from the leader tab outward, so this call could never reach the server. ` +
                `Turn off \`crossTabSync\`, or keep \`${surface}\` on the leader tab.`,
        );
    }

    /**
     * Clear every timer a {@link ShardConnection} can have armed.
     *
     * One function because both teardown paths must clear all three and a fourth
     * timer would otherwise have to be remembered in two places — which is how a
     * leak gets added rather than written.
     */
    // eslint-disable-next-line class-methods-use-this -- cohesive connection helper; pairs with the teardown paths that call it
    private clearConnectionTimers(conn: ShardConnection): void {
        /* eslint-disable no-param-reassign -- mutate the shared ShardConnection state machine in place, as its callers do */
        clearTimeout(conn.reconnectTimer);
        clearTimeout(conn.connectTimer);
        clearTimeout(conn.stableTimer);
        conn.reconnectTimer = undefined;
        conn.connectTimer = undefined;
        conn.stableTimer = undefined;
        /* eslint-enable no-param-reassign */
    }

    /**
     * Tear down one {@link ShardConnection}'s live state: clear its reconnect/
     * connect timers, stop its heartbeat, and close its socket (if any).
     * Shared by `close()` (terminal) and the cross-tab `onStopBeingLeader`
     * handler (demoted, but still alive) so a demoted leader can't leak a
     * pending `reconnectTimer` or an open socket's `heartbeatTimer` the way
     * an inline `conn.socket?.close()` — which skips both — used to.
     *
     * Settles this shard's in-flight streams first. The teardown clears
     * `conn.socket` BEFORE the real `close` event fires, so that event trips
     * `openManagedSocket`'s identity guard (`conn.socket !== socket`) and
     * returns — meaning `handleDisconnect`, the only other place that settles a
     * shard's streams, never runs for this connection again. `close()` already
     * failed and cleared `this.streams` before it gets here, so this is a no-op
     * on that path; the cross-tab demotion path is the one where a consumer's
     * `for await` used to block forever with no error and no completion.
     */
    private teardownConnection(conn: ShardConnection): void {
        /* eslint-disable no-param-reassign -- mutate the shared, long-lived ShardConnection record so every timer/socket field observes the same teardown (matches `handleDisconnect`'s established pattern in this file) */
        const streamKey = connectionKey(conn.shardKey);

        for (const [id, stream] of this.streams) {
            if (connectionKey(stream.shardKey) !== streamKey) {
                continue;
            }

            stream.handle.fail(new LunoraError("STREAM_DISCONNECTED", "stream terminated: the connection carrying it was torn down"));
            this.streams.delete(id);
        }

        // Every consumer these frames belonged to was just failed above, and the
        // socket they were waiting on is going away — drop them rather than
        // leaving them attached to a connection record the caller may reuse.
        // Queued unsubscribes go the same way: the server drops a socket's
        // subscriptions when it closes, so there is nothing left to tell it.
        conn.pendingStreams = undefined;
        conn.pendingUnsubscribes = [];
        this.clearConnectionTimers(conn);
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
        /* eslint-enable no-param-reassign */
    }

    /**
     * Build (but do not start) this client's `TabCoordinator`. Extracted out of
     * the constructor so `setAuthToken` can rebuild it on an identity change —
     * the default channel name embeds the identity fingerprint (see below), so
     * a new identity needs a new coordinator on a new channel. The callback
     * bodies are the drift-sensitive region (a hand-merged identity guard on
     * the shard message listener sits ahead of an extracted `lastFrameAt`
     * stamp elsewhere in this file) — moved verbatim, not reflowed.
     */
    private createTabCoordinator(): TabCoordinator {
        // Scope the channel to this deployment + identity so two same-origin
        // tabs signed in as different users (or two different Lunora apps on
        // one origin) never share a leader or a query result — see the durable
        // read-cache identity gate this mirrors (`identityFingerprint()`'s
        // docblock, and the `entry.identity === this.identityFingerprint()`
        // check at the cache-peek/hydration-seed sites). `anon` is a stable,
        // non-secret label for "no identity yet" (signed-out or not-yet-resolved) —
        // distinct from the fingerprint's own `null` sentinel, which can't appear
        // in a channel-name string. The fingerprint itself is already a
        // non-reversible stamp (see its docblock), so this introduces no new
        // exposure class; `this.url` is not a secret to same-origin script either.
        const channelName = `lunora-bridge::${this.url}::${this.identityFingerprint() ?? "anon"}`;

        return new TabCoordinator({
            channelName,
            onBecomeLeader: () => {
                // Re-open sockets for every active subscription now that
                // we own the WS connections.
                for (const state of this.subscriptions.all()) {
                    this.ensureSocket(state.shardKey);
                    this.sendSubscribeIfOpen(state);
                }

                // Broadcast our aggregate status once immediately, so a
                // follower that was mirroring the PREVIOUS leader isn't
                // stuck displaying a stale value until this tab's own
                // status happens to change (which may be a while, e.g. no
                // active subscription ever opens a socket).
                this.tabCoordinator?.broadcastConnectionStatus(this.computeStatus(), this.identityFingerprint());
            },
            onStopBeingLeader: () => {
                // Close all WS connections now that another tab leads —
                // reuse the same timer-teardown sequence `close()` uses so
                // a demoted leader can't leak a `reconnectTimer` /
                // `heartbeatTimer` the way an inline `conn.socket?.close()`
                // (which skips both) used to.
                for (const [key, conn] of this.connections) {
                    this.teardownConnection(conn);
                    this.connections.delete(key);
                }

                // We're now a follower of whoever won leadership — clear
                // any stale mirror from the previous leader until the new
                // one's first `connection-status` broadcast arrives.
                this.leaderStatus = undefined;
                this.leaderWasEverConnected = false;
            },
            onConnectionStatus: (status, identity) => {
                // Belt-and-braces: the channel-name scoping is the primary
                // defence (a different identity is normally on a different
                // channel entirely), but a `setAuthToken` in this tab can move
                // it to a new channel while a stale frame from the OLD leader
                // is already queued in the message task queue. Drop it when a
                // stamp is present and doesn't match; an absent stamp
                // (mixed-version leader) is accepted, same as today.
                if (identity !== undefined && identity !== this.identityFingerprint()) {
                    return;
                }

                // A follower has no `ShardConnection` of its own — this is
                // its only truthful status signal. Mirror it and re-run
                // the same notify path a real status change takes so this
                // tab's own `onConnectionStatus`/`connectionStatus()`
                // consumers see it.
                const transitionedToConnected = status === "connected" && this.leaderStatus !== "connected";

                this.leaderStatus = status;

                if (status === "connected") {
                    this.leaderWasEverConnected = true;
                }

                this.emitConnectionStatus();

                // Flush this tab's own queued offline writes now that the
                // (leader's) connection is back — they replay over HTTP
                // RPC, which needs no socket of this follower's own.
                if (transitionedToConnected) {
                    this.flushAllOfflineQueues();
                }
            },
            onSubscriptionData: (key, data, cursor, epoch, identity) => {
                // Belt-and-braces identity check — see `onConnectionStatus`'s
                // comment for the full rationale (identical here).
                if (identity !== undefined && identity !== this.identityFingerprint()) {
                    return;
                }

                // A follower tab received the authoritative server value from
                // the leader. Update serverBase and re-fold any local optimistic
                // layers so the displayed value reflects both the new base and
                // the follower's own pending writes.
                const state = this.subscriptions.get(key);

                if (!state) {
                    return;
                }

                state.serverBase = data;

                // `cursor` rides the broadcast only from a CLIENT-01-aware
                // leader tab. When present, advance this follower's own resume
                // cursor/epoch and run the SAME confirmed-layer drop + notify
                // tail `handleDataMessage` uses on the leader — so a follower's
                // optimistic overlay (per-call or `setQuery`) is released the
                // moment the confirming frame arrives instead of staying masked
                // forever (CLIENT-01). A mixed-version deploy where the leader
                // hasn't shipped the cursor yet falls through to the historical
                // fold-and-notify-without-drop behavior below — backward
                // compatible with a cursor-less wire frame.
                if (cursor !== undefined) {
                    state.serverCursor = cursor;

                    if (epoch !== undefined) {
                        state.serverEpoch = epoch;
                    }

                    dropConfirmedLayers(state, cursor);
                }

                notifySubscription(state, foldOptimistic(data, state.optimisticLayers));
            },
            onLeaderClaimAnswered: () => {
                // A new tab just announced itself. Re-state our status directly:
                // `emitConnectionStatus` short-circuits when nothing changed, so
                // a stable leader never re-broadcasts and a late-joining follower
                // would otherwise sit on `leaderStatus === undefined` — reporting
                // `"idle"` while the app is live, and never seeing the
                // transitioned-to-connected edge that flushes its offline queue.
                if (this.tabCoordinator?.isLeader()) {
                    this.tabCoordinator.broadcastConnectionStatus(this.computeStatus(), this.identityFingerprint());
                }
            },
            onSubscriptionError: (key, error, identity) => {
                // Belt-and-braces identity check — see `onConnectionStatus`'s
                // comment for the full rationale (identical here). This was the
                // one of the four callbacks without it, which only went unnoticed
                // because nothing broadcast to it.
                if (identity !== undefined && identity !== this.identityFingerprint()) {
                    return;
                }

                const state = this.subscriptions.get(key);

                if (state) {
                    fanSubscriptionError(state.errorCallbacks, error);
                }
            },
            onSubscriptionSettled: (key, cursor, epoch, lastMutationId, clientId, identity) => {
                // Belt-and-braces identity check — see `onConnectionStatus`'s
                // comment for the full rationale (identical here).
                if (identity !== undefined && identity !== this.identityFingerprint()) {
                    return;
                }

                // The leader's `settled` checkpoint advanced with no value
                // change — reuse the exact same tail the leader itself runs
                // (ack + advance cursor/epoch + drop confirmed layers +
                // notify) so a follower's `setQuery`/per-call overlay a
                // byte-identical write just confirmed gets released here too.
                const state = this.subscriptions.get(key);

                if (state) {
                    this.ackAndAdvanceCursor(state, cursor, epoch);

                    // The echoed `lastMutationId` is the LEADER's own
                    // per-client watermark — scoped server-side to ITS
                    // announced `clientId` — so it only belongs to this
                    // follower when the two clientIds match (clientIds CAN
                    // legitimately be shared across tabs, e.g. a `@lunora/db`
                    // app persisting one stable id alongside its outbox; see
                    // `this.clientId`'s docblock). An absent `clientId`
                    // (mixed-version leader) also skips this half — the
                    // follower's own RPC-ack watermark path and the
                    // `CheckpointRegistry` bounded fallback still resolve it.
                    // `Math.max` guards monotonicity: this must never move
                    // `state.lastMutationId` backwards.
                    if (lastMutationId !== undefined && clientId === this.clientId) {
                        state.lastMutationId = Math.max(state.lastMutationId ?? 0, lastMutationId);
                    }

                    // Fan out to every registered checkpoint subscriber, same
                    // as the leader's own `handleSettledMessage` tail — a
                    // `@lunora/db` `onCheckpoint` gate on a follower tab must
                    // advance too, or it hangs on a confirmed write the leader
                    // already acknowledged. The checkpoint (cursor) half
                    // always fires; `state.lastMutationId` is whatever it was
                    // above — unchanged (a no-op re-resolve) when the frame
                    // didn't own this follower's watermark.
                    for (const onCheckpoint of state.checkpointCallbacks) {
                        onCheckpoint({ checkpoint: state.serverCursor, mutationId: state.lastMutationId });
                    }
                }
            },
        });
    }

    // --- Internals ----------------------------------------------------------

    /**
     * Persist a mutation that can't go out on the wire right now (offline, or
     * mid-reconnect after a prior connect). The optimistic update has already
     * been applied by `mutation`; this only chooses the durable write path and
     * rolls the optimistic write back if persistence is rejected.
     *
     * Two paths: when an `outbox` sink is wired (the `@lunora/db` executor) it
     * owns persistence + at-least-once replay, so we delegate and return
     * optimistically (confirmation rides the synced view). Otherwise the
     * built-in `OfflineQueue` resolves/rejects the returned promise on replay.
     */
    private async enqueueOfflineMutation<F extends FunctionReference>(
        function_: F,
        argsRecord: Record<string, unknown>,
        shardKey: string | undefined,
        mutationId: string,
        optimisticRollbacks: (() => void)[],
        optimisticConfirms: ((commitCursor: number | undefined) => void)[],
        precondition?: () => boolean,
    ): Promise<ReturnOf<F>> {
        // Bind the issuing identity at enqueue time so the write can only replay
        // under the same identity (see flushOfflineQueue).
        const issuingIdentity = this.identityFingerprint();

        if (this.outbox) {
            this.outboxMutationCounter += 1;
            const outboxMutationId = this.outboxMutationCounter;

            try {
                await this.outbox.enqueue({
                    args: argsRecord,
                    clientId: this.clientId,
                    functionPath: function_.__lunoraRef,
                    idempotencyKey: `${this.clientId}:${String(outboxMutationId)}`,
                    identity: issuingIdentity,
                    mutationId: outboxMutationId,
                    shardKey,
                });
            } catch (error) {
                rollbackOptimistic(optimisticRollbacks);

                throw error instanceof Error ? error : new Error(String(error));
            }

            // The unified outbox (a `@lunora/db` app) manages its own optimistic
            // overlays via the checkpoint watermark; a raw per-call optimistic layer
            // can't be cursor-confirmed through this path, so drop it now (confirm
            // with no cursor) rather than leak it onto every later frame.
            for (const confirm of optimisticConfirms) {
                confirm(undefined);
            }

            return undefined as ReturnOf<F>;
        }

        return new Promise<ReturnOf<F>>((resolve, reject) => {
            const entry: QueuedMutation<ReturnOf<F>> = {
                args: argsRecord,
                functionPath: function_.__lunoraRef,
                // A live caller is awaiting this Promise, so a terminal verdict
                // reaches them directly; the observer event carries
                // `hadAwaiter: true`. Hydrated replays leave this unset.
                liveAwaiter: true,
                // Reuse the call's idempotency key as the queue id so the replay
                // carries the same `x-lunora-mutation-id` the server dedups on.
                id: mutationId,
                // Persisted alongside the write so a replay (including one after a
                // reload) namespaces server-side under the id that ISSUED it — the
                // standalone client's own id is per-session, and an anonymous
                // caller's `__idempotency` row is keyed by it.
                clientId: this.clientId,
                // Persist the stamp alongside the record so a hydrated write can
                // only replay under the identity that queued it.
                identity: issuingIdentity,
                // Optional precondition checked before replay — see drainConflict.
                precondition,
                // Confirm the per-call optimistic layer(s) against the commit cursor
                // the flush replay echoes (see flushOfflineQueue).
                onCommit: (commitCursor) => {
                    for (const confirm of optimisticConfirms) {
                        confirm(commitCursor);
                    }
                },
                reject: (error) => {
                    // Drop this write's identity stamp on any rejection (overflow
                    // eviction, identity change, close) so the `queuedIdentities`
                    // map can't leak entries for writes the queue has already
                    // discarded — `mutationId` is the entry's stable id.
                    this.queuedIdentities.delete(mutationId);

                    rollbackOptimistic(optimisticRollbacks);

                    reject(error instanceof Error ? error : new Error(String(error)));
                },
                resolve,
                shardKey,
            };

            this.offlineQueue.enqueue<ReturnOf<F>>(entry);
            // Track the shard so a follower tab (no `ShardConnection` of its
            // own to iterate) knows to flush it once the mirrored leader
            // status turns `"connected"` — see `flushAllOfflineQueues`.
            this.queuedOfflineShardKeys.add(shardKey);

            // `enqueue` assigns `entry.id` when absent; stamp the captured
            // identity against it for the flush-time check.
            if (entry.id !== undefined) {
                this.queuedIdentities.set(entry.id, issuingIdentity);
            }
        });
    }

    /**
     * Restore offline mutations persisted in a prior session and open a socket
     * for each shard they target so they flush once the WS reconnects. Failures
     * are swallowed — a broken durable store must not stop the client booting.
     */
    private async hydratePersistedQueue(): Promise<void> {
        try {
            const shardKeys = await this.offlineQueue.hydrate();

            for (const shardKey of shardKeys) {
                // Track the shard even on a follower tab, where `ensureSocket`
                // is a no-op — `flushAllOfflineQueues` is what actually
                // replays a follower's restored writes, once the mirrored
                // leader status turns `"connected"`.
                this.queuedOfflineShardKeys.add(shardKey);
                this.ensureSocket(shardKey);
            }
        } catch {
            /* durable store unavailable — boot without restored writes */
        }
    }

    /**
     * Re-queue the durable offline writes — but only as the multi-tab LEADER. The
     * persisted queue is shared across a profile's tabs; without coordination
     * every tab would re-queue and replay the same writes (correct only because
     * the server dedups by idempotency key, but wasteful + racy). A Web Lock makes
     * exactly one tab hydrate; it holds the lock for its lifetime, so when it
     * closes another tab acquires the lock and takes over. Falls back to
     * unconditional hydration where Web Locks are unavailable (React Native, older
     * browsers, SSR) — single-context there, so no coordination is needed.
     */
    private hydrateAsOutboxLeader(): void {
        const hydrate = (): void => {
            this.hydratePersistedQueue().catch(() => undefined);
        };
        const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;

        if (!locks) {
            // No Web Locks (React Native / older browser / SSR) — single context,
            // no coordination needed.
            hydrate();

            return;
        }

        locks
            // Lock request rejected/aborted → fall back to direct hydration.
            .request(`lunora:outbox-leader:${this.url}`, () => {
                // Leadership acquired. Hydrate once, then hold the lock (an
                // unresolved promise) until close() releases it — at which point
                // the next tab waiting on the lock becomes leader.
                if (!this.closed) {
                    hydrate();
                }

                return new Promise<void>((resolve) => {
                    if (this.closed) {
                        resolve();

                        return;
                    }

                    this.outboxLeaderRelease = resolve;
                });
            })
            .catch(hydrate);
    }

    /**
     * Load every cached query so a `subscribe()` for the key seeds its initial
     * value off disk.
     *
     * The load is asynchronous but every framework adapter subscribes
     * SYNCHRONOUSLY at mount, so the subscriptions that most want the cache
     * already exist by the time it lands. Those are seeded here and their entry
     * is dropped: an entry that stayed in {@link hydratedQueryCache} behind a
     * live subscription would be consumed by the NEXT subscribe of the same key
     * (a remount after navigating away) and replay the previous session's value
     * over whatever the socket had since delivered. A cache entry therefore
     * never outlives a live subscription for its key — it is either handed to
     * that subscription or discarded.
     *
     * Only keys with no live subscription are held for a later `subscribe()`;
     * the identity gate applies to both paths, so a signed-out cache never leaks
     * into a new session.
     */
    private async hydrateQueryCache(): Promise<void> {
        if (!this.queryCache) {
            return;
        }

        try {
            const entries = await this.queryCache.load();

            // Index the already-open subscriptions by READ-CACHE key (the
            // registry keys on the raw args object, the cache on `argsKey`).
            const live = new Map<string, SubscriptionState>();

            for (const state of this.subscriptions.all()) {
                live.set(queryCacheKey(state.fn.__lunoraRef, state.argsKey, state.shardKey), state);
            }

            for (const { key, ...entry } of entries) {
                // Version gate: a value persisted under a different app/schema
                // version is dropped and purged rather than hydrated.
                if (isStaleVersion(this.persistenceVersion, entry.version)) {
                    this.queryCache.remove(key).catch(() => undefined);

                    continue;
                }

                const openSubscription = live.get(key);

                if (openSubscription) {
                    this.seedSubscriptionFromCache(openSubscription, entry);

                    continue;
                }

                this.hydratedQueryCache.set(key, entry);
            }
        } catch {
            /* durable store unavailable — boot without restored reads */
        }
    }

    /**
     * Hand a loaded read-cache entry to a subscription that was opened before
     * the load resolved — the same value, cursor and epoch {@link subscribe}
     * would have taken from {@link takeHydratedCache} had the load finished
     * first, so the cursor still rides the `subscribe` frame as `sinceSeq` (that
     * frame only goes out once the socket opens, well after this microtask).
     *
     * A no-op once the socket has delivered anything for this key: a live value
     * always beats the cache. Identity-gated exactly like `takeHydratedCache`.
     */
    private seedSubscriptionFromCache(state: SubscriptionState, entry: CachedQuery): void {
        if (state.serverBase !== undefined || state.lastValue !== undefined || entry.identity !== this.identityFingerprint()) {
            return;
        }

        // eslint-disable-next-line no-param-reassign -- in-place seed of the shared subscription state, mirroring `notifySubscription`
        state.serverBase = entry.value;
        // eslint-disable-next-line no-param-reassign -- in-place seed of the shared subscription state
        state.serverCursor = entry.serverCursor;

        if (entry.serverEpoch !== undefined) {
            // eslint-disable-next-line no-param-reassign -- in-place seed of the shared subscription state
            state.serverEpoch = entry.serverEpoch;
        }

        notifySubscription(state, foldOptimistic(entry.value, state.optimisticLayers));
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
        // Persist the authoritative server value (`serverBase`), never an optimistic
        // overlay, so a reload restores confirmed data (pending writes re-hydrate
        // from the durable outbox separately). `serverBase` tracks `lastValue` when
        // no optimistic layer is active.
        const authoritative = state.serverBase;

        if (!this.queryCache || authoritative === undefined) {
            return;
        }

        const key = queryCacheKey(state.fn.__lunoraRef, state.argsKey, state.shardKey);

        // Stamp the identity the delivering SOCKET is authenticated as, not the
        // one the client currently advertises — see `ShardConnection.identity`.
        // After a `setAuthToken` user switch the previous user's socket is still
        // open (nothing closes it: the WS credential lives in the upgrade URL and
        // only `setWsToken` bounces it), so its frames would otherwise be
        // persisted under the NEW user's stamp and hydrate into their session on
        // the next reload. A follower tab holds no connection of its own; its
        // values arrive over the identity-checked cross-tab channel, so the live
        // fingerprint is the right stamp there.
        const socketIdentity = this.getConnection(state.shardKey)?.identity;

        this.pendingCacheWrites.set(key, {
            identity: socketIdentity === undefined ? this.identityFingerprint() : socketIdentity,
            serverCursor: state.serverCursor,
            ts: Date.now(),
            value: authoritative,
            ...(state.serverEpoch === undefined ? {} : { serverEpoch: state.serverEpoch }),
            ...(this.persistenceVersion === undefined ? {} : { version: this.persistenceVersion }),
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
        // failures (a quota error on one key must not drop the others). Each
        // `put` is deferred into promise-land so a synchronously-throwing
        // adapter is captured per-entry too, not allowed to escape `.map()`.
        await Promise.allSettled(batch.map(async ([key, entry]) => queryCache.put(key, entry)));
    }

    /** Derive the aggregate status from the per-shard socket states. */
    private computeStatus(): ConnectionStatus {
        // A follower owns no `ShardConnection` of its own (that's the whole
        // point of cross-tab sync — see `ensureSocket`) — mirror whatever the
        // leader last broadcast instead of reading the (always-empty)
        // `connections` map, which would otherwise report `"idle"` forever
        // regardless of the leader's real socket state.
        if (this.tabCoordinator && !this.tabCoordinator.isLeader()) {
            return this.leaderStatus ?? "idle";
        }

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

        this.statusListeners.emit(next);

        // Mirror our own aggregate status to follower tabs, which have no
        // socket of their own to compute it from (see `computeStatus`). A
        // no-op on a follower or single-tab client — `broadcastConnectionStatus`
        // itself gates on `isLeader()`.
        if (this.tabCoordinator?.isLeader()) {
            this.tabCoordinator.broadcastConnectionStatus(next, this.identityFingerprint());
        }
    }

    /**
     * Build a {@link MutationSettledEvent} from a queued entry and emit it on the
     * {@link onMutationSettled} channel. `item.id` is always assigned by the time
     * a write settles (`enqueue`/`hydrate` guarantee it), so the `?? ""` fallback
     * is unreachable — present only to satisfy the optional queue-id type.
     */
    private emitItemSettled(item: QueuedMutation, status: "committed" | "rejected", error?: unknown): void {
        this.mutationSettledListeners.emit({
            args: item.args,
            code: error === undefined ? undefined : (error as { code?: string }).code,
            error,
            functionPath: item.functionPath,
            hadAwaiter: item.liveAwaiter ?? false,
            id: item.id ?? "",
            shardKey: item.shardKey,
            status,
        });
    }

    /**
     * Apply an optimistic update to the subscription that matches the mutation's
     * `(functionRef, args, shardKey)` triple, returning the rollback callbacks to
     * invoke if the mutation later fails.
     *
     * The registry is already indexed by exactly this triple via
     * `SubscriptionRegistry.key`, so at most one subscription can match. A direct
     * O(1) keyed lookup replaces the former O(N) linear scan over all subscriptions.
     *
     * `shardKey` normalization: both `undefined` and `""` map to the empty string
     * inside `SubscriptionRegistry.key` (via `?? ""`), so a mutation fired without
     * a shardKey correctly matches a subscription registered without one regardless
     * of whether the caller passed `undefined` or omitted the field.
     */
    private applyOptimisticUpdates(
        functionRef: string,
        argsRecord: Record<string, unknown>,
        mutationShardKey: string | undefined,
        optimistic: ((current: unknown) => unknown) | undefined,
    ): { confirms: ((commitCursor: number | undefined) => void)[]; rollbacks: (() => void)[] } {
        const confirms: ((commitCursor: number | undefined) => void)[] = [];
        const rollbacks: (() => void)[] = [];

        if (!optimistic) {
            return { confirms, rollbacks };
        }

        // Build the same composite key the registry used when the subscription was
        // registered so we can retrieve the matching state in O(1) instead of
        // scanning all subscriptions.
        const matchKey = SubscriptionRegistry.key(functionRef, argsRecord, mutationShardKey);
        const state = this.subscriptions.get(matchKey);

        if (state) {
            const handle: OptimisticLayerHandle | undefined = applyOptimisticLayer(state, optimistic);

            if (handle) {
                confirms.push(handle.confirm);
                rollbacks.push(handle.rollback);
            }
        }

        return { confirms, rollbacks };
    }

    /**
     * Run a Convex-parity `optimisticUpdate` callback against a localStore bound
     * to the live subscription registry. Each `setQuery` registers a constant
     * optimistic LAYER on its target subscription (via the same engine the
     * per-call `optimistic` path uses), so the multi-query patch rebases onto
     * incoming deltas and drops gaplessly on its commit cursor — its `confirm` /
     * `rollback` closures are appended to the mutation's settle lists. A throwing
     * callback unwinds its own partial writes — LIFO over just the rollbacks it
     * produced — and is swallowed, so a buggy optimistic update can never fail the
     * mutation or leave a partial patch live.
     */
    private applyOptimisticUpdate<F extends FunctionReference>(
        optimisticUpdate: OptimisticUpdate<ArgsOf<F>>,
        args: ArgsOf<F>,
        shardKey: string | undefined,
        optimisticRollbacks: (() => void)[],
        optimisticConfirms: ((commitCursor: number | undefined) => void)[],
    ): void {
        const { confirms, rollbacks, store } = createLocalStore(this.subscriptions, shardKey);

        try {
            optimisticUpdate(store, args);
        } catch {
            // Unwind only this callback's own writes, most-recent first, so a
            // throwing localStore update leaves the cache as it found it.
            rollbackOptimistic(rollbacks);

            return;
        }

        optimisticRollbacks.push(...rollbacks);
        optimisticConfirms.push(...confirms);
    }

    private getConnection(shardKey: string | undefined): ShardConnection | undefined {
        return this.connections.get(connectionKey(shardKey));
    }

    /**
     * Send an unsubscribe frame (tagged with its wire type) on the shard's
     * socket, or queue it for the next reconnect when the send can't go out.
     */
    private sendOrQueueUnsubscribe(shardKey: string | undefined, id: string, type: "shape_unsubscribe" | "unsubscribe"): void {
        const conn = this.getConnection(shardKey);

        if (conn && !sendOn(conn, { id, type })) {
            conn.pendingUnsubscribes.push({ id, type });
        }
    }

    /**
     * The `(wsState, hasSocket, wasEverConnected)` triple `mutation()`'s
     * offline-queue gate reads. On the leader/single-tab path this is exactly
     * the real `ShardConnection`'s state (byte-identical to the pre-cross-tab
     * behavior). A follower has no `ShardConnection` of its own (see
     * `ensureSocket`), so it derives the same triple from the mirrored
     * `leaderStatus`/`leaderWasEverConnected` instead: `"connected"` maps to
     * `"open"` (queue-eligible once `wasEverConnected`), `"connecting"` stays
     * `"connecting"` (the mid-reconnect queue branch), anything else is
     * `"idle"`. `hasSocket` is always `false` for a follower — it never has
     * one.
     */
    private connectionGateState(shardKey: string | undefined): { hasSocket: boolean; wasEverConnected: boolean; wsState: WSState } {
        if (this.tabCoordinator && !this.tabCoordinator.isLeader()) {
            let wsState: WSState = "idle";

            if (this.leaderStatus === "connected") {
                wsState = "open";
            } else if (this.leaderStatus === "connecting") {
                wsState = "connecting";
            }

            return { hasSocket: false, wasEverConnected: this.leaderWasEverConnected, wsState };
        }

        const conn = this.getConnection(shardKey);

        return { hasSocket: conn?.socket !== undefined, wasEverConnected: conn?.wasEverConnected ?? false, wsState: conn?.wsState ?? "idle" };
    }

    private getOrCreateConnection(shardKey: string | undefined): ShardConnection {
        const key = connectionKey(shardKey);
        let conn = this.connections.get(key);

        if (!conn) {
            conn = {
                connectTimer: undefined,
                heartbeatTimer: undefined,
                lastFrameAt: 0,
                pendingUnsubscribes: [],
                reconnect: createReconnect(this.reconnectOptions),
                reconnectTimer: undefined,
                shardKey,
                socket: undefined,
                stableTimer: undefined,
                wasEverConnected: false,
                wsState: "idle",
            };
            this.connections.set(key, conn);
        }

        return conn;
    }

    private wsUrlFor(shardKey: string | undefined, token: string | undefined): string {
        const params: string[] = [];

        if (shardKey !== undefined) {
            params.push(`shard=${encodeURIComponent(shardKey)}`);
        }

        if (token !== undefined) {
            params.push(`token=${encodeURIComponent(token)}`);
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
    private rpcRequestHeaders(
        flags: { attachBookmark?: boolean; clientId?: string; clientSeq?: number; mutationId?: string },
        shardKey?: string,
    ): Record<string, string> {
        const headers: Record<string, string> = { "content-type": "application/json" };

        // Read-your-writes across region-local read replicas: the cursor this
        // client's last write to this shard committed at. A worker with
        // `replicaReads` on will only answer from a replica that has caught up
        // to it; everywhere else the header is inert. Sent on every call rather
        // than only on reads — a write is routed to the owner regardless, so
        // there is no branch here that could get the two out of step.
        const shardCursor = this.shardCursors.get(this.cursorKeyFor(shardKey));

        if (shardCursor !== undefined) {
            headers["x-lunora-min-seq"] = shardCursor.toString();
        }

        if (this.authToken) {
            headers["authorization"] = `Bearer ${this.authToken}`;
        }

        if (flags.mutationId) {
            headers["x-lunora-mutation-id"] = flags.mutationId;
        }

        // Custom-mutator push protocol (server reads these in `classifyClientMutation`):
        // the per-client identity + the monotonic per-client sequence that drives
        // the `__client_watermark` advance.
        //
        // Also sent alongside a bare `mutationId`: an ANONYMOUS caller has no
        // server-minted user id, so the shard namespaces its `__idempotency` rows
        // by this client id instead. Without it every anonymous client would share
        // one dedup key space and a colliding mutation id would suppress another
        // client's write (the shard skips the cache entirely rather than risk it).
        if (flags.clientId !== undefined || flags.mutationId !== undefined) {
            headers["x-lunora-client-id"] = flags.clientId ?? this.clientId;
        }

        if (flags.clientSeq !== undefined) {
            headers["x-lunora-client-seq"] = flags.clientSeq.toString();
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
        flags: {
            attachBookmark?: boolean;
            captureBookmark?: boolean;
            clientId?: string;
            clientSeq?: number;
            mutationId?: string;
            /** Invoked on a successful response with the server's echoed commit CDC cursor (if any) — gates per-call optimistic-layer drops. */
            onCommitCursor?: (commitCursor: number | undefined) => void;
            /** Invoked on a successful response with the server's echoed custom-mutator watermark (if any). */
            onMutationAck?: (lastMutationId: number | undefined) => void;
        } = {},
    ): Promise<unknown> {
        if (!this.fetchImpl) {
            throw new TransportError("LunoraClient: no `fetch` implementation available");
        }

        const headers = this.rpcRequestHeaders(flags, shardKey);

        const response = await this.fetchImpl(joinUrl(this.url, RPC_PATH), {
            // `encodeWire` tags leaves plain JSON can't carry (`bigint`,
            // `ArrayBuffer`/typed arrays, `NaN`/±Infinity); a pure-JSON `args`
            // encodes byte-identically, so a pre-codec server still interops.
            body: JSON.stringify({ args: encodeCallArgs(args, `args for '${functionPath}'`), functionPath, shardKey }),
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
            // Not a Lunora envelope at all — an edge's HTML page, a captive
            // portal, a truncated body. The HTTP status is the only verdict
            // there is, and `unparseableResponseError` is where the outbox's
            // "unknown fate, re-queue" / "refused, settle" split is decided.
            throw unparseableResponseError(response.status, response.statusText, response.headers.get("retry-after"));
        }

        if ("error" in body) {
            // Rebuilt with its `.code` and (for an app `LunoraError`) wire-decoded
            // `.data`, plus any `Retry-After` normalised into that `data` — the
            // one channel the hint travels on.
            throw reconstructErrorWithRetryAfter(body.error, response.headers.get("retry-after"));
        }

        // A non-2xx response whose body parsed as JSON but carried no `error`
        // envelope would otherwise be treated as a successful result. Classified
        // by status, exactly as an unparseable body is: a 5xx re-queues a durable
        // write rather than dropping it over a gateway blip, a 4xx settles it
        // rather than replaying a refusal forever.
        if (!response.ok) {
            throw unparseableResponseError(response.status, response.statusText, response.headers.get("retry-after"));
        }

        flags.onMutationAck?.(body.lastMutationId);
        flags.onCommitCursor?.(body.commitCursor);

        // Remember how far this shard had committed, so a later read can demand
        // at least this much from a replica — filed under the one key both an
        // implicit call and an explicit default-shard call resolve to.
        this.learnDefaultShardKey(response, shardKey);
        this.recordShardCursor(shardKey, body.commitCursor);

        return decodeWire(body.result);
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
            throw new LunoraError("INTERNAL", "LunoraClient: no `fetch` implementation available");
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

            throw new LunoraError("INTERNAL", `LunoraClient: response was not JSON (status ${response.status.toString()}${statusText})`);
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

            throw new LunoraError("INTERNAL", `LunoraClient: admin request failed (status ${response.status.toString()}${statusText})`);
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
            // See {@link CLIENT_CAPABILITIES}.
            caps: CLIENT_CAPABILITIES,
            // Lets the server scope this connection's `__client_watermark` so
            // custom-mutator pokes can echo this client's `lastMutationId`.
            clientId: this.clientId,
            id: "connect",
            type: "connect",
            ...(context === undefined ? {} : { context }),
        });
    }

    /**
     * Re-send every shape subscription bound to `shardKey` over its (now open)
     * socket. Each frame carries the shape's last applied checkpoint, so the
     * server resumes from it — or re-seeds when the cursor fell below CDC
     * retention or the epoch forked.
     */
    private resendShapeSubscriptions(shardKey: string | undefined): void {
        for (const state of this.shapeSubscriptions.values()) {
            if (connectionKey(state.shardKey) === connectionKey(shardKey)) {
                this.sendShapeSubscribeIfOpen(state);
            }
        }
    }

    private ensureSocket(shardKey: string | undefined): void {
        if (this.closed || this.WebSocketImpl === undefined) {
            return;
        }

        // When cross-tab sync is active and this tab is not the WS leader, skip
        // opening sockets — the leader tab owns all connections. Every public
        // surface that needs one is gated by `assertLeaderOwnedSurface` ahead of
        // this point, so reaching here as a follower means the caller is one of
        // the paths that legitimately no-ops (a reconnect timer, a hydrated
        // queue's shard warm-up), or this tab is still inside its startup
        // leadership-claim window and `onBecomeLeader` will open the socket and
        // replay every registered subscription when it self-promotes.
        if (this.tabCoordinator && !this.tabCoordinator.isLeader()) {
            return;
        }

        const conn = this.getOrCreateConnection(shardKey);

        if (conn.wsState === "open" || conn.wsState === "connecting") {
            return;
        }

        conn.wsState = "connecting";
        this.emitConnectionStatus();

        // A provider-shaped `wsToken` is resolved fresh per connect attempt (so a
        // short-lived credential is re-minted on every reconnect, including the
        // one after a 4001 token-expired drop); a static string keeps the fully
        // synchronous connect path callers and tests rely on.
        if (typeof this.wsToken === "function") {
            // `openSocketWithProvidedToken` never rejects (its awaits are
            // try/caught), so the fire-and-forget catch is belt-and-braces.
            this.openSocketWithProvidedToken(conn, shardKey, this.wsToken).catch(() => undefined);

            return;
        }

        this.openSocket(conn, shardKey, this.wsToken);
    }

    /**
     * Resolve the {@link WsTokenProvider} and open the shard socket with the
     * minted token. The connection is already in the `connecting` state, so the
     * async gap is race-guarded: a client `close()`, a `setWsToken` bounce, or a
     * competing connect that landed first all abandon this attempt. A provider
     * failure fails the attempt through {@link handleDisconnect}, which arms the
     * normal reconnect backoff — a broken mint endpoint degrades to retries, not
     * a silent tokenless socket the admin gate would reject.
     */
    private async openSocketWithProvidedToken(conn: ShardConnection, shardKey: string | undefined, provider: WsTokenProvider): Promise<void> {
        let token: string | undefined;

        try {
            token = await provider();
        } catch {
            this.handleDisconnect(conn);

            return;
        }

        if (this.closed || this.WebSocketImpl === undefined || conn.wsState !== "connecting" || conn.socket !== undefined) {
            return;
        }

        this.openSocket(conn, shardKey, token);
    }

    /**
     * Construct one WebSocket connection attempt and wire the shared
     * lifecycle guarantees around it — the fail-fast connect-timeout, the
     * identity guard that stops a superseded attempt's late `open`/`message`/
     * `close`/`error` from touching a connection a newer attempt already
     * owns, and (once open) the keepalive heartbeat with its half-open
     * watchdog (plan 217). One call opens ONE attempt; the caller owns
     * reconnect scheduling from `onClose` — mirrors the shard's existing
     * `ensureSocket` / `handleDisconnect` split, now shared with
     * `subscribeScheduledJobs` so it stops re-living the bug that split
     * already fixed once (CLIENT-05).
     *
     * The identity guard is `conn.socket !== socket`, re-checked before every
     * action below. `conn.socket` is reassigned to a new attempt's socket
     * synchronously — right here, before `open` ever fires — so an older
     * attempt's guard trips the instant it's superseded, even if its
     * underlying socket only fires its real `close`/`error` much later. This
     * ordering is load-bearing: preserve it exactly.
     */
    private openManagedSocket(
        conn: ManagedSocketState,
        url: string,
        connectTimeoutMs: number,
        handlers: {
            onClose: (event?: { code?: number }) => void;
            onMessage: (event: MessageEvent) => void;
            /** Optional: the scheduled-jobs socket has nothing to do on `open` (its backoff resets on the first payload frame, not here). */
            onOpen?: () => void;
        },
    ): void {
        const { WebSocketImpl } = this;

        if (WebSocketImpl === undefined) {
            // Unreachable: every caller already checked `this.WebSocketImpl
            // !== undefined` before reaching here.
            throw new LunoraError("INTERNAL", "no WebSocket implementation available");
        }

        // Intentional mutation of the shared, caller-owned connection record
        // so the handlers below and the caller's own bookkeeping observe the
        // same state machine (mirrors `handleDisconnect`).
        /* eslint-disable no-param-reassign -- mutate the shared connection state machine in place */
        const socket = new WebSocketImpl(url);

        conn.socket = socket;

        /** Generic teardown shared by every disconnect trigger below (timeout, close, error): stop the heartbeat and release this attempt's identity slot so a later real event on this same socket is ignored. */
        const teardown = (): void => {
            this.stopHeartbeat(conn);

            if (conn.connectTimer !== undefined) {
                clearTimeout(conn.connectTimer);
                conn.connectTimer = undefined;
            }

            if (conn.socket === socket) {
                conn.socket = undefined;
            }
        };

        /** The two-step disconnect sequence every trigger below runs: tear down this attempt's bookkeeping, then hand the (optional) close event to the caller. */
        const disconnect = (event?: { code?: number }): void => {
            teardown();
            handlers.onClose(event);
        };

        // Fail-fast connect timeout: if the handshake doesn't reach `open`
        // within `connectTimeoutMs` (a hung proxy / cold worker that never
        // upgrades), force-close the socket and report it through `onClose`
        // so the caller's normal reconnect/backoff takes over — instead of
        // the live channel hanging on the browser's much longer default.
        // Cleared on `open`/disconnect.
        if (connectTimeoutMs > 0) {
            conn.connectTimer = setTimeout(() => {
                conn.connectTimer = undefined;

                // Only act if THIS socket is still the connection's current
                // one. A newer reconnect socket (or an already-resolved
                // open/close) must be left untouched. `conn.socket !== socket`
                // alone is sufficient here (no additional `wsState !==
                // "connecting"` check needed): `open` below clears
                // `connectTimer` synchronously, before setting `wsState =
                // "open"`, so once a socket has reached `open` this timer can
                // never fire for it — it was already cancelled.
                if (conn.socket !== socket) {
                    return;
                }

                try {
                    socket.close();
                } catch {
                    /* a stuck socket may throw on close — onClose below still arms reconnect */
                }

                disconnect();
            }, connectTimeoutMs);
        }

        socket.addEventListener("open", (): void => {
            // Ignore a late event from a socket that's no longer the connection's
            // current one — a timed-out/closed socket must never resurrect itself
            // or stomp the state of the newer socket that replaced it.
            if (conn.socket !== socket) {
                return;
            }

            if (conn.connectTimer !== undefined) {
                clearTimeout(conn.connectTimer);
                conn.connectTimer = undefined;
            }

            // Fresh (re)connect — start the half-open watchdog window clean
            // rather than carrying over a stale timestamp from before a
            // disconnect/reconnect cycle.
            conn.lastFrameAt = Date.now();

            // A WS listener that throws unwinds into the host's event loop,
            // where nothing can recover it — the rest of `onOpen` (resubscribe,
            // queued unsubscribes, stream flush, whisper rejoin, offline-queue
            // flush) is skipped and the client still reports `connected`. The
            // legs are individually throw-free today (args are pre-encoded at
            // subscribe time, every send goes through `sendOn`); this is the
            // containment that keeps a future one from silently killing a
            // reconnect. Same guard on `message` below.
            try {
                handlers.onOpen?.();
            } catch (error) {
                // eslint-disable-next-line no-console -- last-resort visibility for a throw that would otherwise vanish into the event loop
                console.error("[lunora] connection open handler threw", error);
            }

            this.startHeartbeat(conn, disconnect);
        });

        socket.addEventListener("message", (event: MessageEvent): void => {
            // Ignore a late message from a socket the connection already moved
            // past (see `open`/`close`/`error` above) — without this guard a
            // stale socket's frame would stamp the newer socket's `lastFrameAt`
            // and defeat the heartbeat watchdog.
            if (conn.socket !== socket) {
                return;
            }

            // Any inbound frame — including the plain-string `lunora-pong`
            // keepalive reply, which `handleServerMessage`'s JSON.parse guard
            // silently drops — proves the socket is still alive. Stamp it
            // unconditionally, before delegating to the caller's handler, so
            // the heartbeat watchdog (see `startHeartbeat`) can tell a
            // half-open socket from a healthy one. One writer, co-located
            // with the reader below, for every caller of this helper.
            conn.lastFrameAt = Date.now();

            try {
                handlers.onMessage(event);
            } catch (error) {
                // See the `open` listener above. Frame handlers that can fail on
                // hostile/corrupt input route their own failure to the affected
                // subscriber (see `handleDataMessage`); this catches whatever is
                // left so one bad frame cannot take the socket's listener down.
                // eslint-disable-next-line no-console -- last-resort visibility for a throw that would otherwise vanish into the event loop
                console.error("[lunora] server frame handler threw", error);
            }
        });

        socket.addEventListener("close", (event?: { code?: number }): void => {
            // Ignore a late close from a socket the connection already moved past
            // (e.g. the fail-fast timeout force-closed it and a reconnect already
            // built a newer socket). Acting on it would tear down the live socket.
            if (conn.socket !== socket) {
                return;
            }

            disconnect(event);
        });

        socket.addEventListener("error", (): void => {
            // Ignore a late error from a superseded socket (see `close` above):
            // only the connection's current socket may drive a disconnect.
            if (conn.socket !== socket) {
                return;
            }

            // Some WebSocket implementations (notably misbehaving proxies and
            // certain test doubles) fire `error` without a follow-up `close`.
            // Report it through `onClose` too so the caller's reconnect always
            // arms; `onClose` is idempotent downstream (mirrors
            // `handleDisconnect`'s `wsState === "idle"` checks).
            disconnect();
        });
        /* eslint-enable no-param-reassign */
    }

    /** Construct the shard socket and wire its lifecycle handlers. The connection must already be in the `connecting` state. */
    private openSocket(conn: ShardConnection, shardKey: string | undefined, token: string | undefined): void {
        if (this.WebSocketImpl === undefined) {
            return;
        }

        // Pin the identity this socket is being upgraded under — see
        // `ShardConnection.identity`. Captured here (not at frame time) because
        // the credential in the upgrade URL is what the server authenticates,
        // and it can't change for the life of the socket.
        // eslint-disable-next-line no-param-reassign -- mutate the shared ShardConnection state machine in place
        conn.identity = this.identityFingerprint();

        this.openManagedSocket(conn, this.wsUrlFor(shardKey, token), this.connectTimeoutMs, {
            onClose: (event) => {
                // Close code 4001 is the server's `token_expired` signal: notify
                // listeners so the app can refresh its credential before the
                // (always-armed) reconnect re-resolves identity. The event is
                // optional — some WS doubles fire `close` without one, and a
                // synthesized disconnect (connect-timeout, watchdog, bare error)
                // never carries one either.
                if (event?.code === 4001) {
                    this.notifyTokenExpired();
                }

                this.handleDisconnect(conn);
            },
            onMessage: (event) => {
                this.handleServerMessage(event.data, shardKey);
            },
            onOpen: () => {
                // Intentional mutation of the shared, long-lived connection
                // record so the rest of the client observes the same state
                // machine (mirrors `handleDisconnect`).
                /* eslint-disable no-param-reassign -- mutate the shared ShardConnection state machine in place */
                conn.wsState = "open";
                conn.wasEverConnected = true;

                // See `ShardConnection.stableTimer` for why `open` is not proof.
                clearTimeout(conn.stableTimer);
                conn.stableTimer = setTimeout(() => {
                    // Belt-and-braces: every transition out of `"open"` clears
                    // this timer first, so this cannot currently be false.
                    if (conn.wsState === "open") {
                        conn.reconnect.reset();
                    }
                }, SOCKET_STABLE_MS);
                /* eslint-enable no-param-reassign */
                // NOT `conn.reconnect.reset()` — an upgrade is not proof of a
                // usable connection. The server accepts the upgrade before it
                // ever looks at the credential and only drops an expired one on
                // the first frame that follows, so resetting here turns a lapsed
                // token into a fixed-interval reconnect storm at the INITIAL
                // delay that never backs off: open, `connect`, `TOKEN_EXPIRED`,
                // close 4001, repeat. The reset now happens in
                // `handleServerMessage` when a non-`error` frame proves the
                // socket is live (see there).
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

                // Re-send shape subscriptions bound to this shard. Each carries its
                // last applied checkpoint, so the server resumes (or re-seeds when the
                // cursor fell below retention / the epoch forked).
                this.resendShapeSubscriptions(shardKey);

                // Flush any unsubscribes that piled up while the socket was down.
                if (conn.pendingUnsubscribes.length > 0) {
                    const pending = conn.pendingUnsubscribes;

                    // eslint-disable-next-line no-param-reassign -- mutate the shared ShardConnection state machine in place
                    conn.pendingUnsubscribes = [];

                    for (const { id, type } of pending) {
                        sendOn(conn, { id, type });
                    }
                }

                // Flush stream-start frames queued while we were (re)connecting.
                // Reconnect-after-close: in-flight streams have already torn down
                // on the server, so the only entries here are brand-new ones that
                // raced the connect.
                this.flushPendingStreams(conn);

                // Rejoin every whisper topic registered for this shard so ephemeral
                // channels survive a socket bounce.
                const byTopic = this.whisperHandlers.get(connectionKey(shardKey));

                if (byTopic) {
                    for (const topic of byTopic.keys()) {
                        sendOn(conn, { topic, type: "whisper_subscribe" });
                    }
                }

                this.flushOfflineQueue(shardKey).catch(() => undefined);
            },
        });
    }

    /**
     * Send the stream-start frames queued while the socket was (re)connecting,
     * marking each one that lands as started on the server.
     */
    private flushPendingStreams(conn: ShardConnection): void {
        if (!conn.pendingStreams || conn.pendingStreams.length === 0) {
            return;
        }

        const pending = conn.pendingStreams;

        // eslint-disable-next-line no-param-reassign -- mutate the shared ShardConnection state machine in place
        conn.pendingStreams = [];

        for (const message of pending) {
            // Reaching the server is what makes a later cancel owe it an
            // unsubscribe rather than a silent local delete.
            const stream = sendOn(conn, message) ? this.streams.get(String((message as { id?: string }).id)) : undefined;

            if (stream) {
                stream.started = true;
            }
        }
    }

    /**
     * Tear down a stream the consumer cancelled, telling the server when the
     * server is the one still holding it.
     */
    private cancelStream(id: string, shardKey: string | undefined): void {
        const conn = this.getConnection(shardKey);
        const stream = this.streams.get(id);

        if (conn) {
            // Drop a start frame still waiting on the socket. Without this the
            // cancelled stream was sent anyway on the next open: the server opened
            // an iterator nobody consumes, its chunks arrived for an id no longer
            // in `this.streams` (a silent no-op), and no `unsubscribe` ever
            // followed because the consumer had already gone. `handleDisconnect`
            // knows to filter `pendingStreams` by id; that knowledge just never
            // reached the cancel path.
            conn.pendingStreams = conn.pendingStreams?.filter((pending) => (pending as { id?: string }).id !== id);

            // Dropping the cancel when the socket is down is right only for an
            // EPHEMERAL run: the DO lost its handle on close, so there is nothing
            // left to abort. A DURABLE run is the opposite — it outlives the
            // socket by design, and the line above just removed the resume frame
            // that would have carried us back to it. Without queueing the
            // unsubscribe the server keeps producing and persisting a run no one
            // will ever read, and nothing later says stop. `pendingUnsubscribes`
            // already flushes ahead of `pendingStreams` on open, so the teardown
            // lands before any resume that races it.
            if (!sendOn(conn, { id, type: "unsubscribe" }) && stream?.durable === true && stream.started) {
                conn.pendingUnsubscribes.push({ id, type: "unsubscribe" });
            }
        }

        this.streams.delete(id);
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

        // The connect timer's deadline has been overtaken by this close, and the
        // socket did not survive its stability window so it never earned a
        // backoff reset — that non-reset is the storm case the delay damps.
        // `reconnectTimer` is cleared here too and re-armed unconditionally at
        // the end of this method.
        this.clearConnectionTimers(conn);

        conn.socket = undefined;
        conn.wsState = "idle";
        this.emitConnectionStatus();
        this.markShardPendingAck(conn.shardKey);

        // Settle every in-flight stream bound to this shard. An EPHEMERAL stream
        // whose start frame was already sent lost its server-side iterator when
        // the socket dropped and can't resume, so a consumer's `for await` would
        // otherwise hang forever on a next() that never settles (streams are
        // failed on close()/error/overflow but a socket bounce is the common
        // termination). A DURABLE stream is the opposite case: the run survives
        // the socket, so it is re-queued with a resume watermark instead.
        // Stream-start frames still queued in `pendingStreams` were never sent,
        // so they legitimately ride the next reconnect — exclude those ids.
        const pendingStreamIds = new Set((conn.pendingStreams ?? []).map((message) => (message as { id?: string }).id));

        for (const [id, stream] of this.streams) {
            if (connectionKey(stream.shardKey) !== connectionKey(conn.shardKey) || pendingStreamIds.has(id)) {
                continue;
            }

            if (stream.durable) {
                // A durable run outlives the socket: the server keeps producing
                // and persists every chunk, so re-send the start frame carrying
                // the last seq we saw and the reconnect replays the gap. The
                // consumer's `for await` never observes the interruption.
                // The stored `generation` (stamped on every durable chunk) rides
                // along so the server can tell "continuing this run" from
                // "splicing onto a different run under the same key".
                const resume = {
                    ...(stream.message as { id: string; type: "stream" }),
                    ...(stream.generation === undefined ? {} : { generation: stream.generation }),
                    sinceChunk: stream.lastSeq,
                } as ClientMessage;

                stream.message = resume;
                // Replace, don't append: repeated bounces before the socket comes
                // back would otherwise stack one frame per attempt for the same id.
                conn.pendingStreams = [...(conn.pendingStreams ?? []).filter((queued) => (queued as { id?: string }).id !== id), resume];

                continue;
            }

            stream.handle.fail(new LunoraError("STREAM_DISCONNECTED", "stream terminated: WebSocket disconnected"));
            this.streams.delete(id);
        }

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
     * Begin the keepalive heartbeat on an open connection attempt — the only
     * caller is {@link openManagedSocket}'s own `open` handler, so both the
     * shard socket and `subscribeScheduledJobs` share this one implementation
     * instead of each hand-rolling their own (plan 217, generalized).
     *
     * Each tick first checks the half-open watchdog (see
     * {@link ManagedSocketState.lastFrameAt}): if no frame at all has arrived
     * within `heartbeatIntervalMs * 2.5`, the far end has gone quiet without
     * the socket ever firing `close` — force it closed and report it through
     * `onWatchdogTrip` (the caller's `onClose`) so the normal reconnect/backoff
     * takes over instead of every live query on it silently staling forever.
     * Otherwise it sends a {@link WS_KEEPALIVE_PING} text frame the server
     * answers from its hibernation auto-response without waking the DO. A
     * no-op when the heartbeat is disabled (an interval of zero or less);
     * idempotent — any existing timer is cleared first so a reconnect can't
     * leak intervals.
     */
    private startHeartbeat(conn: ManagedSocketState, onWatchdogTrip: () => void): void {
        this.stopHeartbeat(conn);

        if (this.heartbeatIntervalMs <= 0) {
            return;
        }

        // eslint-disable-next-line no-param-reassign -- store the timer on the shared connection record so stopHeartbeat can clear it
        conn.heartbeatTimer = setInterval(() => {
            if (!conn.socket) {
                return;
            }

            const { socket } = conn;

            if (Date.now() - conn.lastFrameAt > this.heartbeatIntervalMs * 2.5) {
                // Mirrors the fail-fast connect-timeout pattern in
                // `openManagedSocket`: a stuck socket may throw on close, but
                // the watchdog-trip report below still arms reconnect either way.
                try {
                    socket.close();
                } catch {
                    /* a stuck socket may throw on close — the report below still arms reconnect */
                }

                onWatchdogTrip();

                return;
            }

            try {
                socket.send(WS_KEEPALIVE_PING);
            } catch {
                // A send race against a closing socket is harmless — the close
                // handler will tear the heartbeat down.
            }
        }, this.heartbeatIntervalMs);
    }

    /** Clear a connection's keepalive timer, if any. Safe to call repeatedly. */
    // eslint-disable-next-line class-methods-use-this -- cohesive connection helper; pairs with startHeartbeat
    private stopHeartbeat(conn: ManagedSocketState): void {
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

        // A resume position is only replayable with the VALUE it describes behind
        // it: the server answers a still-current `sinceSeq` with a bare `resume`
        // frame carrying no data, so asking to resume with nothing cached leaves
        // the subscription hanging empty forever. A cross-tab FOLLOWER is how a
        // cursor gets ahead of the value — a `settled` broadcast advances its
        // cursor even though the leader's `data` frames landed before it joined —
        // and promoting that tab to leader is what puts the frame on the wire.
        // Drop `sinceSeq` there and take the full snapshot.
        const resumable = state.serverCursor !== undefined && state.serverBase !== undefined;

        sendOn(conn, {
            id: state.id,
            // `sinceSeq` rides along when we hold a persisted cursor for this
            // sub (a hydrated read or an earlier frame), so the server can
            // resume instead of re-snapshotting. Omitted on a cold sub.
            query: {
                // `wireArgs` is the pre-encoded form of `args` (computed at
                // `subscribe` time) so a `bigint`/`Date`/bytes arg survives the
                // frame's `JSON.stringify`; the shard `decodeWire`s it at its
                // subscribe entry point. Identity for pure-JSON args. Encoding
                // HERE would run inside the reconnect's `open` handler, where a
                // caller's post-subscribe mutation of its own args object turns
                // into a throw that kills the whole resubscribe sequence.
                args: state.wireArgs,
                functionPath: state.fn.__lunoraRef,
                table,
                ...(resumable ? { sinceSeq: state.serverCursor } : {}),
                ...(resumable && state.serverEpoch !== undefined ? { sinceEpoch: state.serverEpoch } : {}),
            },
            type: "subscribe",
        });
    }

    private sendShapeSubscribeIfOpen(state: ShapeSubscriptionState): void {
        const conn = this.getConnection(state.shardKey);

        if (conn?.wsState !== "open") {
            return;
        }

        sendOn(conn, {
            id: state.id,
            // `wireArgs` is the pre-encoded form of `args` (computed at
            // `subscribeShape` time) so a `bigint`/`Date`/bytes arg survives the
            // frame's `JSON.stringify`; the shard `decodeWire`s it at its
            // `shape_subscribe` entry point. Identity for pure-JSON args.
            shape: { name: state.name, ...(state.wireArgs === undefined ? {} : { args: state.wireArgs }) },
            type: "shape_subscribe",
            // Resume from the last applied checkpoint when we hold one; a cold
            // subscribe omits it and the server seeds the full membership.
            ...(state.serverCursor === undefined ? {} : { sinceCheckpoint: state.serverCursor }),
            ...(state.serverEpoch === undefined ? {} : { sinceEpoch: state.serverEpoch }),
        });
    }

    private handleServerMessage(raw: unknown, shardKey?: string): void {
        // `lastFrameAt` is stamped by `openManagedSocket` itself (its `message`
        // listener) before this handler is ever invoked — nothing to do here
        // beyond parsing.
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

        // A parsed frame that is not an `error` is the first hard proof that this
        // socket is both open AND accepted — the point where the reconnect
        // backoff may safely restart. An `error` frame is excluded on purpose:
        // the server's `TOKEN_EXPIRED` rejection arrives as one, immediately
        // before it closes with 4001, so counting it would restore the reconnect
        // storm this moved the reset out of `onOpen` to fix.
        if (message.type !== "error") {
            this.getConnection(shardKey)?.reconnect.reset();
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
                const { data, generation, id, seq } = message;
                const stream = this.streams.get(id);

                if (stream && typeof seq === "number") {
                    stream.lastSeq = seq;

                    if (typeof generation === "number") {
                        stream.generation = generation;
                    }
                    // `seq` rides only a DURABLE run, so the server's answer —
                    // not the caller's `durable` flag — decides whether this
                    // stream can resume. Trusting the caller meant a `durable:
                    // true` against an ephemeral procedure re-sent its start
                    // frame on a bounce and replayed the whole transcript into
                    // the same consumer.
                    stream.durable = true;
                }

                stream?.handle.push(decodeWire(data));

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
            case "pokeEnd": {
                this.handlePokeEnd(message, shardKey);

                break;
            }
            case "pokePart": {
                this.handlePokePart(message, shardKey);

                break;
            }
            case "pokeStart": {
                this.handlePokeStart(message, shardKey);

                break;
            }
            case "resume": {
                this.handleResumeMessage(message);

                break;
            }
            case "settled": {
                this.handleSettledMessage(message);

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
            const subscriptionError = buildSubscriptionError(message);

            // Snapshot the identity and key BEFORE fanning. `fanSubscriptionError`
            // runs subscriber `onError` callbacks synchronously, and one of them
            // may call `setAuthToken` — signing out and back in is a natural
            // reaction to an auth-shaped rejection. Reading the fingerprint
            // afterwards stamps this frame with the identity that replaced the one
            // the error was raised under, and the `identity` field is exactly what
            // followers trust to decide the frame is theirs: tabs on the NEW
            // identity would accept a rejection belonging to the OLD session.
            //
            // Stamping the captured identity is the whole fix — followers still on
            // that identity accept it (correct) and everyone else drops it
            // (correct), so there is no need to also suppress the broadcast.
            const identity = this.identityFingerprint();
            const key = SubscriptionRegistry.keyOf(state);

            fanSubscriptionError(state.errorCallbacks, subscriptionError);

            // Fan it to follower tabs too. `broadcastSubscriptionError` existed
            // with no caller, so the `onSubscriptionError` handler wired to it
            // was unreachable: a `subscribe(..., { onError })` on a follower
            // never fired for a server-side rejection (an RLS denial, a failed
            // admin gate) and the query just sat empty. Guarded on leadership
            // like its `data` and `settled` siblings — only the leader holds the
            // socket that produced this frame.
            if (this.tabCoordinator?.isLeader()) {
                this.tabCoordinator.broadcastSubscriptionError(key, subscriptionError, identity);
            }

            return;
        }

        // A shape subscription is keyed in its own map (`shape_*` ids), so the
        // lookup above misses it. Without this a rejected `shape_subscribe`
        // (unknown shape, RLS-denied, cross-shard-invalid) would never reach the
        // subscriber's `onError` and the shape would silently hang with no data.
        const shapeState = id === undefined ? undefined : this.shapeSubscriptions.get(id);

        if (shapeState) {
            fanSubscriptionError(shapeState.errorCallbacks, buildSubscriptionError(message));
        }
    }

    /** Buffer key for an in-flight poke: `pokeId` is only unique per shard socket, so it is scoped by connection. */
    // eslint-disable-next-line class-methods-use-this -- a pure key derivation kept beside the poke handlers that are its only callers
    private pokeBufferKey(shardKey: string | undefined, pokeId: string): string {
        return `${connectionKey(shardKey)}\u0000${pokeId}`;
    }

    private handlePokeStart(message: ServerPokeStartMessage, shardKey: string | undefined): void {
        // A buffer is dropped at its `pokeEnd`; one whose socket drops mid-poke
        // (no `pokeEnd`) is abandoned and the server re-seeds on resume, so it
        // would otherwise linger forever. Bound the map by evicting the oldest
        // entry once it exceeds the cap — abandoned buffers are always the oldest,
        // and live pokes resolve within a few frames, so this only ever reclaims
        // dead buffers in practice.
        evictOldestEntry(this.pokeBuffers, LunoraClient.MAX_POKE_BUFFERS);

        // Open a buffer for this poke. Parts accumulate per shape and apply
        // atomically at `pokeEnd`, so a socket dropping mid-poke leaves the view
        // untouched and re-seeds on reconnect (no torn state).
        this.pokeBuffers.set(this.pokeBufferKey(shardKey, message.pokeId), {
            baseCheckpoint: message.baseCheckpoint,
            bases: new Map(),
            epoch: message.epoch,
            lastMutationId: new Map(),
            parts: new Map(),
            resets: new Set(),
        });
    }

    private handlePokePart(message: ServerPokePartMessage, shardKey: string | undefined): void {
        const buffer = this.pokeBuffers.get(this.pokeBufferKey(shardKey, message.pokeId));

        if (!buffer) {
            // No matching `pokeStart` (we connected mid-poke) — ignore; the
            // server re-seeds the shape on the next subscribe.
            return;
        }

        const existing = buffer.parts.get(message.shapeId) ?? [];

        // Wire-decode each row-op's post-image (no-op on a pure-JSON value), so a
        // shape carrying a `bytes`/`bigint` column applies real values locally.
        // Loop rather than `push(...map())` — a large `rowsPatch` would otherwise
        // allocate an intermediate array and risk the JS argument-count ceiling.
        for (const op of message.rowsPatch) {
            existing.push(op.value === undefined ? op : { ...op, value: decodeWire(op.value) as Record<string, unknown> });
        }
        buffer.parts.set(message.shapeId, existing);

        if (message.lastMutationId !== undefined) {
            buffer.lastMutationId.set(message.shapeId, message.lastMutationId);
        }

        const base = message.baseCheckpoint ?? buffer.baseCheckpoint;

        if (base !== undefined) {
            buffer.bases.set(message.shapeId, base);
        }

        // A shape can only ever receive one part per poke, but record the flag
        // sticky (never cleared) so a server that split a seed across parts still
        // replaces rather than merges.
        if (message.reset === true) {
            buffer.resets.add(message.shapeId);
        }
    }

    private handlePokeEnd(message: ServerPokeEndMessage, shardKey: string | undefined): void {
        const key = this.pokeBufferKey(shardKey, message.pokeId);
        const buffer = this.pokeBuffers.get(key);

        if (!buffer) {
            return;
        }

        this.pokeBuffers.delete(key);

        for (const shapeId of buffer.parts.keys()) {
            const state = this.shapeSubscriptions.get(shapeId);

            if (state) {
                this.applyPokePart(state, buffer, message);
            }
        }
    }

    /**
     * Commit one shape's slice of a poke, or refuse it and re-seed.
     *
     * Split out of {@link handlePokeEnd} because every decision here is PER SHAPE
     * — the reset flag, the base checkpoint, the watermark — while the poke
     * envelope around it is not.
     */
    private applyPokePart(state: ShapeSubscriptionState, buffer: PokeBuffer, message: ServerPokeEndMessage): void {
        // Read from the buffer rather than taken as a parameter: the caller could
        // only ever pass `buffer.parts.get(state.id)`, and two ways to reach one
        // value is one way for them to disagree.
        const ops = buffer.parts.get(state.id) ?? [];
        /* eslint-disable no-param-reassign -- advance the shared shape-subscription state in place, as the rest of the poke path does */
        // A `reset` part carries the shape's COMPLETE membership, so it is
        // authoritative on its own: drop whatever we hold and apply it. Without
        // this the ops splice onto the stale view — and a seed is inserts-only,
        // so every row deleted while we were disconnected survives the reconnect
        // and renders forever. It also settles a forked epoch / diverged base in
        // one round trip instead of provoking a redundant re-subscribe below.
        const reset = buffer.resets.has(state.id);

        // An epoch mismatch means the changelog timeline forked since we last
        // applied (a reset/recycled DO); a base mismatch means this diff was
        // computed against a checkpoint we're not actually at (a dropped poke
        // / gap). Either way, splicing the incremental ops onto our view would
        // corrupt it — so drop the local view, clear the cursor, SKIP the ops,
        // and re-subscribe so the server re-seeds the membership from scratch.
        const base = buffer.bases.get(state.id);
        const epochForked = buffer.epoch !== undefined && state.serverEpoch !== undefined && buffer.epoch !== state.serverEpoch;
        const baseDiverged = base !== undefined && state.serverCursor !== undefined && state.serverCursor !== base;

        if (!reset && (epochForked || baseDiverged)) {
            state.rows.clear();
            state.serverCursor = undefined;
            state.serverEpoch = undefined;
            this.emitShapeRows(state);
            this.sendShapeSubscribeIfOpen(state);

            return;
        }

        if (reset) {
            state.rows.clear();
        }

        applyRowOpsToView(state.rows, ops);

        if (message.checkpoint !== undefined) {
            state.serverCursor = message.checkpoint;
        }

        if (message.epoch !== undefined) {
            state.serverEpoch = message.epoch;
        }

        const watermark = buffer.lastMutationId.get(state.id);

        if (watermark !== undefined) {
            state.lastMutationId = watermark;
        }

        this.emitShapeRows(state);

        // Surface the advanced watermark so a `@lunora/db` collection can drop
        // the optimistic overlay for any mutation this poke has now synced.
        state.onCheckpoint?.({ checkpoint: state.serverCursor, mutationId: state.lastMutationId });
        /* eslint-enable no-param-reassign */
    }

    /**
     * Force the server to re-send a full snapshot for `state`, leaving the
     * currently displayed value alone until it lands. Used when a delta frame
     * cannot be applied: dropping the resume cursor is what makes the resubscribe
     * a snapshot rather than a `resume`, and un-acking is what lets
     * `sendSubscribeIfOpen` put the frame on the wire at all. Mirrors the shape
     * path's re-seed on a diverged base.
     */
    private resnapshotSubscription(state: SubscriptionState): void {
        /* eslint-disable no-param-reassign -- reset the shared subscription state in place, as the other recovery paths do */
        state.acked = false;
        state.serverCursor = undefined;
        state.serverEpoch = undefined;
        /* eslint-enable no-param-reassign */

        // eslint-disable-next-line no-console -- last-resort visibility: the client recovers on its own, but a frame it cannot apply is a protocol-level surprise worth surfacing.
        console.warn("[lunora] could not merge a row delta into the cached result; re-subscribing for a full snapshot");

        this.sendSubscribeIfOpen(state);
    }

    /** Materialize a shape's keyed view to an array and invoke its callbacks. */
    // eslint-disable-next-line class-methods-use-this -- a pure state→callback fan-out kept beside the shape-subscription pipeline it serves.
    private emitShapeRows(state: ShapeSubscriptionState): void {
        const rows = [...state.rows.values()];

        for (const shapeCallback of state.callbacks) {
            try {
                shapeCallback(rows);
            } catch {
                /* user callback threw — ignore */
            }
        }
    }

    private handleDataMessage(message: ServerDataMessage): void {
        const { id } = message;
        const state = id ? this.subscriptions.getById(id) : undefined;

        if (!state) {
            return;
        }

        let payload: unknown;

        try {
            payload = this.resolveDataPayload(message, state);
        } catch (error) {
            // The frame carried a value `decodeWire` refuses (an over-long
            // bigint, an over-depth tree, a malformed map entry). Left to throw
            // it escapes the WS `message` listener: `onError` never fires, the
            // cursor never advances, and every later frame carrying the same
            // value dies identically — the subscription frozen with the
            // indicator still reading `connected`. Surface it to the subscriber
            // instead and leave the cached value + cursor untouched.
            fanSubscriptionError(state.errorCallbacks, {
                code: "WIRE_DECODE_FAILED",
                message: `could not decode a server frame for this subscription — ${error instanceof Error ? error.message : String(error)}`,
            });

            return;
        }

        if (payload === UNMERGEABLE_DELTA) {
            this.resnapshotSubscription(state);

            return;
        }

        // `payload` is the new authoritative base. Update it first, then advance
        // the cursor, so a layer whose write committed at/under this cursor is
        // dropped (its effect is now in `payload`) before we re-fold. With no
        // layers active (the common case) the displayed value is just `payload`,
        // byte-identical to the historical behaviour.
        state.serverBase = payload;

        // Advance the resume cursor + epoch when the frame carries them
        // (CDC-enabled shard); replayed as `sinceSeq` / `sinceEpoch` on the
        // next reconnect.
        if (message.cursor !== undefined) {
            state.serverCursor = message.cursor;
        }

        if (message.epoch !== undefined) {
            state.serverEpoch = message.epoch;
        }

        // Consume the per-client custom-mutator watermark this frame carries
        // (mirrors the `settled` tail in `handleSettledMessage`), so a
        // `@lunora/db` checkpoint gate sees the watermark THIS frame's rows
        // actually reflect, instead of relying solely on the provisional
        // RPC-ack signal (`confirmedMutationWatermark`) which can race ahead
        // of what has actually synced. `Math.max` guards monotonicity. Fired
        // BEFORE `notifySubscription` below (which drives `@lunora/db`'s
        // `onRows`) so a fresher, frame-scoped watermark is already recorded
        // by the time any RPC-ack-based fallback would otherwise run.
        if (message.lastMutationId !== undefined) {
            state.lastMutationId = Math.max(state.lastMutationId ?? 0, message.lastMutationId);

            for (const onCheckpoint of state.checkpointCallbacks) {
                onCheckpoint({ checkpoint: state.serverCursor, mutationId: state.lastMutationId });
            }
        }

        // Persist the authoritative server value (never the optimistic overlay)
        // to the durable read cache (debounced).
        this.persistQueryValue(state);

        // Drop any optimistic layer the server has now confirmed (its commit cursor
        // is at/under this frame's cursor), then display `serverBase` re-folded
        // through whatever optimistic layers remain pending (rebasing).
        dropConfirmedLayers(state, state.serverCursor);
        notifySubscription(state, foldOptimistic(payload, state.optimisticLayers));

        // When cross-tab sync is active and we're the WS leader, broadcast
        // the new value to follower tabs so they stay in sync without their
        // own WS connections. Deliberately does NOT carry `lastMutationId` —
        // a follower gets the watermark only via the `settled` broadcast,
        // which is clientId-scoped (plan 266 S3); relaying a `data` frame's
        // watermark here would reintroduce the same cross-client leak S3 fixed.
        if (this.tabCoordinator?.isLeader()) {
            const key = SubscriptionRegistry.keyOf(state);

            this.tabCoordinator.broadcastSubscriptionData(key, payload, state.serverCursor, state.serverEpoch, this.identityFingerprint());
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

        this.ackAndAdvanceCursor(state, message.cursor, message.epoch);
    }

    /**
     * Handle a `settled` frame: a write touched one of this subscription's read
     * tables but produced a byte-identical result, so the server suppressed the
     * data frame. Like {@link handleResumeMessage} the value didn't change — we
     * advance the resume position and re-persist — but we ALSO surface the echoed
     * custom-mutator watermark via `onCheckpoint` so a `@lunora/db` list
     * collection drops the optimistic overlay for the confirmed write (otherwise
     * its checkpoint gate, fed only by data frames, would hang forever). Sent
     * only to custom-mutator clients; plain `useQuery` subscribers leave
     * `onCheckpoint` unset and this is a near no-op.
     */
    private handleSettledMessage(message: ServerSettledMessage): void {
        const state = this.subscriptions.getById(message.id);

        if (!state) {
            return;
        }

        this.ackAndAdvanceCursor(state, message.cursor, message.epoch);

        if (message.lastMutationId !== undefined) {
            // `Math.max`, like the `data`-frame and cross-tab `settled` siblings.
            // The server's watermark is monotonic in normal operation, but it
            // restarts from a lower value whenever the `__client_watermark` row
            // is reset (a recycled DO, a PITR restore, the shard's own watermark
            // recovery path) — a bare assignment would then walk this gate
            // BACKWARDS and re-open an overlay a later frame already confirmed.
            state.lastMutationId = Math.max(state.lastMutationId ?? 0, message.lastMutationId);
        }

        // Fan out to every registered subscriber (shared state — see
        // SubscriptionState.checkpointCallbacks). A snapshot isn't needed: a
        // checkpoint callback never (un)subscribes to this same state mid-flush.
        for (const onCheckpoint of state.checkpointCallbacks) {
            onCheckpoint({ checkpoint: state.serverCursor, mutationId: state.lastMutationId });
        }

        // Cross-tab: propagate the checkpoint advance to follower tabs too, or a
        // `setQuery`/per-call optimistic overlay this byte-identical write just
        // confirmed would stay masked on a follower until the next VISIBLE data
        // frame (see `onSubscriptionSettled` in the constructor).
        if (this.tabCoordinator?.isLeader()) {
            const key = SubscriptionRegistry.keyOf(state);

            this.tabCoordinator.broadcastSubscriptionSettled(
                key,
                state.serverCursor,
                state.serverEpoch,
                state.lastMutationId,
                this.clientId,
                this.identityFingerprint(),
            );
        }
    }

    /**
     * Mark `state` acked and, when the frame carries a newer cursor/epoch than
     * the cached position, advance the resume watermark and re-persist. Shared by
     * the `resume` and `settled` frame handlers — both acknowledge "nothing the
     * client must re-render changed, but the resume position may have moved".
     */
    private ackAndAdvanceCursor(state: SubscriptionState, cursor: number | undefined, epoch: string | undefined): void {
        /* eslint-disable no-param-reassign -- advance the shared subscription state in place (same pattern as the optimistic-update path above) */
        state.acked = true;

        if ((cursor !== undefined && cursor !== state.serverCursor) || (epoch !== undefined && epoch !== state.serverEpoch)) {
            if (cursor !== undefined) {
                state.serverCursor = cursor;
            }

            if (epoch !== undefined) {
                state.serverEpoch = epoch;
            }

            this.persistQueryValue(state);

            // A `resume`/`settled` frame advances the cursor without a value change
            // — but a write whose result was byte-identical for this query still
            // committed at/under this cursor, so its optimistic layer is now
            // confirmed. Sweep confirmed layers here too (not just on `data`
            // frames), or a no-visible-change write would leave its overlay stuck.
            if (dropConfirmedLayers(state, state.serverCursor)) {
                notifySubscription(state, foldOptimistic(state.serverBase, state.optimisticLayers));
            }
        }
        /* eslint-enable no-param-reassign */
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
            // Wire-decode the snapshot so a `bytes`/`bigint` column arrives as a
            // real ArrayBuffer/bigint (no-op on a pure-JSON payload).
            return decodeWire(message.data);
        }

        const delta = decodeWire(message.delta);

        // Merge into the authoritative `serverBase`, NOT the displayed `lastValue`
        // (which may carry an optimistic overlay) — a delta describes a change to
        // server truth, re-folded under the overlay afterwards. With no optimistic
        // layers active `serverBase === lastValue`, so this is the historical path.
        if (isMutationDelta(delta)) {
            // No cached base is NOT a merge failure — there is nothing to merge
            // into and nothing to corrupt. This is the legacy `broadcastDelta`
            // fan-out, which stamps no `cursor` at all (see `ShardDO.broadcastDelta`:
            // "legacy broadcast path has no diff baseline to protect"), so handing
            // the change itself to a subscriber that has not been seeded strands
            // no cursor and is the behaviour that path has always had. Asking for
            // a snapshot here would turn every such broadcast into a re-subscribe.
            if (state.serverBase === undefined) {
                return delta;
            }

            // A base we DO hold and cannot splice the delta into is the dangerous
            // case: wholesale replacement publishes the `{ key, op, table, row }`
            // envelope over a real query result, and a frame that carries a cursor
            // advances it, so nothing would ever reconcile it. Ask for a snapshot.
            return applyDelta(state.serverBase, delta) ?? UNMERGEABLE_DELTA;
        }

        // Opaque delta payload (e.g. a full result the server sent verbatim):
        // replace wholesale, preserving the historical behaviour.
        return delta;
    }

    /** Route an inbound whisper to the topic's handlers on the originating shard. */
    private dispatchWhisper(message: ServerWhisperMessage, shardKey?: string): void {
        const handlers = this.whisperHandlers.get(connectionKey(shardKey))?.get(message.topic);

        if (!handlers) {
            return;
        }

        const data = decodeWire(message.data);

        for (const handler of handlers) {
            try {
                handler(data, message.from);
            } catch {
                /* user callback threw — ignore */
            }
        }
    }

    /** Notify every {@link onTokenExpired} listener (best-effort, listener throws swallowed). */
    private notifyTokenExpired(): void {
        this.tokenExpiredListeners.emit();
    }

    /**
     * CLIENT-04: `type: "complete"` today is sent ONLY by `@lunora/do`'s
     * `handleStream` (see `shard-do.ts`), gated to the `stream` envelope type
     * and minting only `stream_*` ids — the `subscribe` path never sends it, so
     * a live SUBSCRIPTION provably never receives `complete` from the current
     * server. But `ServerCompleteMessage` is a generic `id`-keyed frame and
     * `ShardDO` is user-subclassable, so this stays defensive rather than
     * assuming a `sub_*` id can never reach here: unlike the historical
     * `subscriptions.remove(state)`, which dropped the state out of
     * `subscriptions.all()` — the set the reconnect resubscribe loop walks
     * (`ensureSocket`'s `open` handler) — and so froze the query forever across
     * every future reconnect, this fans a cancellation error to any listener
     * and marks the registration un-acked instead. Non-destructive: the state
     * stays in the registry, so the very next reconnect resubscribes it. The
     * two id-spaces don't overlap (`sub_*` vs `stream_*`), so the stream and
     * subscription lookups below are mutually exclusive.
     */
    private handleCompleteMessage(id: string): void {
        const stream = this.streams.get(id);

        if (stream) {
            stream.handle.complete();
            this.streams.delete(id);

            return;
        }

        const state = this.subscriptions.getById(id);

        if (state) {
            state.acked = false;
            fanSubscriptionError(state.errorCallbacks, { code: "SUBSCRIPTION_CANCELLED", message: "subscription was cancelled by the server" });
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
        // A stable subject (user id), when supplied to `setAuthToken`, is the
        // identity — so a same-user token refresh keeps the same fingerprint and
        // doesn't discard queued writes. `null` subject = explicitly signed out.
        if (this.authSubject !== undefined) {
            // `subj:` is a distinct namespace from the token-hash format
            // (`<len>:<hash>`) so a subject can never alias a token fingerprint.
            // eslint-disable-next-line unicorn/no-null -- signed-out identity sentinel, distinct from undefined
            return this.authSubject === null ? null : `subj:${this.authSubject}`;
        }

        const token = this.authToken;

        if (token === null) {
            // eslint-disable-next-line unicorn/no-null -- signed-out identity sentinel, distinct from undefined
            return null;
        }

        return this.hashToken(token);
    }

    /**
     * Stable token-hash fingerprint of a bearer token (the `<len>:<fnv>:<djb2>`
     * format a token-stamped queued write carries). Extracted so the replay gate
     * can recompute the hash of the current credential and recognise a write
     * stamped under it — even after the fingerprint was relabelled to a subject.
     *
     * Two independent 32-bit passes (FNV-1a + djb2) give a ~64-bit digest, so
     * two distinct equal-length tokens are astronomically unlikely to share a
     * fingerprint. A single 32-bit hash collides ~1-in-4e9 per equal-length
     * pair — enough that, on a shared device, user B could hydrate A's cached
     * reads. Different algorithms (not the same FNV with a different seed, which
     * would be affine-related) keep the two passes genuinely independent.
     * Still synchronous (no crypto) and stable across surrogate pairs.
     */
    // eslint-disable-next-line class-methods-use-this -- pure helper; a method for locality with identityFingerprint, reads no shared state
    private hashToken(token: string): string {
        let fnv = 0x81_1c_9d_c5;
        let djb2 = 5381;

        for (let index = 0; index < token.length; index += 1) {
            // eslint-disable-next-line unicorn/prefer-code-point -- charCode keeps the digest stable across surrogate pairs
            const code = token.charCodeAt(index);

            // eslint-disable-next-line no-bitwise -- FNV-1a XOR step
            fnv ^= code;
            fnv = Math.imul(fnv, 0x01_00_01_93);
            djb2 = Math.imul(djb2, 33) + code;
        }

        // Delimit the two base36 digests so distinct (fnv, djb2) pairs can't
        // encode to the same string via variable-width concatenation.
        // eslint-disable-next-line no-bitwise -- coerce both accumulators to unsigned 32-bit integers
        return `${token.length.toString(36)}:${(fnv >>> 0).toString(36)}:${(djb2 >>> 0).toString(36)}`;
    }

    /**
     * True when `stamped` is a token-hash of the SAME credential still held now,
     * even though the live identity has since been relabelled to a subject. Covers
     * `setAuthToken(token, userId)` where the subject resolved a tick after the
     * token was set: a write persisted (or requeued) under the token hash must
     * still replay — the credential never changed, only its label — instead of
     * being dropped as an identity mismatch. This is the durable counterpart to
     * {@link restampQueuedIdentity}, which only relabels the in-memory live stamp
     * (consumed on the first flush) and never touches `item.identity` or the
     * persisted record, so a reload or a transient-failure requeue would otherwise
     * fall back to the stale token-hash and wrongly reject the same user's write.
     */
    private isSameCredentialUnderTokenHash(stamped: string | null): boolean {
        // Only a token-hash stamp qualifies — never a `subj:` label or the
        // signed-out `null` sentinel (a token can't alias either namespace).
        if (stamped === null || stamped.startsWith("subj:")) {
            return false;
        }

        const token = this.authToken;

        return token === null ? false : this.hashToken(token) === stamped;
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
            this.emitItemSettled(item, "rejected", error);
        }

        this.clearQueryCacheForIdentityChange();
    }

    /* eslint-disable no-secrets/no-secrets -- the back-ticked method name in the prose below, not a credential */

    /**
     * Migrate every identity stamp from `from` to `to` — used when the auth
     * identity label changes but the underlying credential (token) does NOT, e.g.
     * the user id resolves a tick after the token was set. The in-memory
     * `queuedIdentities` map is the flush-time source of truth, so re-stamping it
     * keeps the in-flight writes replayable under the new (more stable) identity
     * instead of the flush guard discarding them as a mismatch.
     *
     * That map alone was not enough: it is consumed and DELETED on the first
     * flush attempt (`passesReplayIdentityGate`), while the queue entry and its
     * persisted record keep the original stamp. So a reload, or a requeue after a
     * transient failure, fell back to the old token hash — and once the token had
     * been refreshed, `isSameCredentialUnderTokenHash` no longer recognised it
     * and the write was rejected `OFFLINE_IDENTITY_CHANGED` for the very user
     * `setAuthToken`'s sticky-`subject` contract promises to protect. The queue's
     * own re-stamp covers both the entry and its durable record.
     */
    /* eslint-enable no-secrets/no-secrets */
    private restampQueuedIdentity(from: string | null, to: string | null): void {
        for (const [id, stamp] of this.queuedIdentities) {
            if (stamp === from) {
                this.queuedIdentities.set(id, to);
            }
        }

        this.offlineQueue.restampIdentity(from, to);
    }

    /**
     * Migrate the {@link clientWatermarks} bucket map nested under identity
     * `from` to identity `to` — the sibling of {@link restampQueuedIdentity},
     * for the same same-credential-subject-resolves case. Without this, a
     * bucket's watermark cached under the token-hash fingerprint would look
     * unset once the fingerprint relabels to `subj:…`, so the next push
     * re-derives `1` against a server watermark the DO already advanced — the
     * OUT_OF_ORDER wedge this cache-keying scheme exists to fix, reintroduced
     * by the fix itself. `to` may already hold a bucket map (switching back to
     * an identity that has its own cached watermarks); merge into it rather
     * than clobbering it, with `from`'s entries winning on a colliding bucket —
     * the same overwrite a plain `Map.set` would have done before this was a
     * nested map.
     */
    private restampWatermarks(from: string | null, to: string | null): void {
        const fromKey = from ?? "";
        const fromWatermarks = this.clientWatermarks.get(fromKey);

        if (fromWatermarks === undefined) {
            return;
        }

        this.clientWatermarks.delete(fromKey);

        const toKey = to ?? "";
        const toWatermarks = this.clientWatermarks.get(toKey);

        if (toWatermarks === undefined) {
            this.clientWatermarks.set(toKey, fromWatermarks);
        } else {
            for (const [bucket, watermark] of fromWatermarks) {
                toWatermarks.set(bucket, watermark);
            }
        }
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

    /**
     * Flush every shard with a mutation currently queued in `offlineQueue`
     * (see `queuedOfflineShardKeys`). Used on a FOLLOWER tab when the
     * mirrored leader status transitions to `"connected"` — a follower has no
     * per-shard `ShardConnection` reconnect event to hang the usual
     * single-shard `flushOfflineQueue(shardKey)` call off of (see the
     * `handleConnect` call site), so this walks every shard that might have
     * something queued instead. Flushing an already-empty shard is a cheap
     * no-op (`flushOfflineQueue` returns immediately once `drain` yields
     * nothing), so over-inclusion here is harmless.
     */
    private flushAllOfflineQueues(): void {
        for (const shardKey of this.queuedOfflineShardKeys) {
            this.flushOfflineQueue(shardKey).catch(() => undefined);
        }
    }

    /**
     * Replay a shard's queued writes, serialized per shard and published as
     * {@link offlineFlushes} so a concurrent `mutation()` can wait behind it.
     * Never rejects: every entry's outcome is settled individually inside
     * {@link drainOfflineQueue}, and a poisoned chain would strand every later
     * flush AND every write waiting on the barrier.
     */
    private async flushOfflineQueue(shardKey: string | undefined): Promise<void> {
        const key = connectionKey(shardKey);
        const previous = this.offlineFlushes.get(key);

        // Nothing queued at all (the overwhelmingly common reconnect) — both
        // drains below would yield nothing, so return without publishing a
        // barrier. Otherwise every `mutation()` issued right after a socket
        // opened would wait a turn on an empty replay.
        if (previous === undefined && this.offlineQueue.size === 0) {
            return;
        }

        // An async IIFE rather than `.then()`: this is a sequencing barrier with
        // no value to pass along, and chaining off `previous` is what serializes
        // overlapping flushes for the same shard.
        const flush = (async () => {
            await (previous ?? Promise.resolve());

            try {
                await this.drainOfflineQueue(shardKey);
            } catch {
                /* per-item verdicts are settled inside the drain — never poison the chain */
            }
        })();

        this.offlineFlushes.set(key, flush);

        await flush;

        // Only the newest chain link owns the slot: a flush queued behind this
        // one has already replaced it and must stay visible to the barrier.
        if (this.offlineFlushes.get(key) === flush) {
            this.offlineFlushes.delete(key);
        }
    }

    private async drainOfflineQueue(shardKey: string | undefined): Promise<void> {
        // Drop stale writes whose precondition no longer holds before draining
        // the remaining valid mutations for replay. Each conflicted entry is
        // rejected with `OFFLINE_PRECONDITION_FAILED` inline.
        const conflicted = this.offlineQueue.drainConflict();

        for (const item of conflicted) {
            this.unpersist(item.id);
            this.queuedIdentities.delete(item.id ?? "");
            // Stamp `.code` (not just `.message`) so `onMutationSettled` sees the
            // documented code — matches every other terminal path in this file.
            const error = new Error("offline mutation skipped: precondition failed before replay");
            (error as Error & { code?: string }).code = "OFFLINE_PRECONDITION_FAILED";
            this.emitItemSettled(item, "rejected", error);
        }

        const key = connectionKey(shardKey);
        const drained = this.offlineQueue.drain((item) => connectionKey(item.shardKey) === key);

        if (drained.length === 0) {
            return;
        }

        // Gate every drained write against ONE identity snapshot. A batch is a
        // single authenticated request, so all its entries necessarily run under
        // one identity; the single-write path likewise has no between-item `await`
        // where a `setAuthToken` / token rotation could slip in, so an up-front
        // snapshot re-gates exactly what the old per-item read did. Mismatches are
        // rejected (not silently dropped) so awaiting callers see a deterministic
        // failure; the rest keep their FIFO order.
        const currentIdentity = this.identityFingerprint();
        const sendable: QueuedMutation[] = [];

        for (const item of drained) {
            if (this.passesReplayIdentityGate(item, currentIdentity)) {
                sendable.push(item);
            }
        }

        if (sendable.length === 0) {
            return;
        }

        const encodable = this.encodableOrSettleTerminal(sendable);

        if (encodable.length === 0) {
            return;
        }

        // A lone write rides the proven single-call path; two or more coalesce
        // into `/_lunora/rpc-batch` round trips (plan 088 follow-on) — the
        // flaky-reconnect win (N queued writes → a handful of RTTs, not N).
        if (encodable.length === 1) {
            await this.replaySequential(encodable, shardKey);
            this.scheduleRateLimitedRetry(shardKey);

            return;
        }

        // Chunk to the worker's per-batch cap: a flush larger than
        // `MAX_BATCH_ENTRIES` would otherwise be one over-cap request the worker
        // rejects wholesale (dropping every durable write). Chunks replay
        // sequentially to preserve FIFO order across the flush; every write that
        // didn't durably settle is re-queued once, in order, for the next reconnect.
        const toRequeue: QueuedMutation[] = [];

        for (let start = 0; start < encodable.length; start += MAX_BATCH_ENTRIES) {
            const chunk = encodable.slice(start, start + MAX_BATCH_ENTRIES);
            // eslint-disable-next-line no-await-in-loop -- chunks replay sequentially to preserve FIFO ordering across the flush
            const outcome = await this.replayBatched(chunk, shardKey);

            toRequeue.push(...outcome.requeue);

            if (outcome.stop) {
                // A whole-batch transport failure — leave every not-yet-sent write
                // queued (in order) for the next reconnect rather than sending on.
                toRequeue.push(...encodable.slice(start + MAX_BATCH_ENTRIES));

                break;
            }
        }

        if (toRequeue.length > 0) {
            this.offlineQueue.requeue(toRequeue);
        }

        this.scheduleRateLimitedRetry(shardKey);
    }

    /**
     * Remember the longest delay this shard's flush was told (or worked out) to
     * wait, so the drain can honour it before trying again
     * ({@link LunoraClient.replayRetryState}). Counts the attempt either way:
     * that is what a hintless refusal backs off on.
     */
    private noteReplayRetryDelay(shardKey: string | undefined, error: unknown): void {
        const key = connectionKey(shardKey);
        const previous = this.replayRetryState.get(key);
        const attempts = (previous?.attempts ?? 0) + 1;
        const delay = replayRetryDelayMs(error, attempts);

        this.replayRetryState.set(key, {
            attempts,
            delayMs: delay === undefined ? previous?.delayMs : Math.max(previous?.delayMs ?? 0, delay),
        });
    }

    /**
     * Consume this shard's retry delay and re-flush it once the delay has
     * elapsed.
     *
     * Only a failure the server or an edge ANSWERED schedules anything (see
     * {@link replayRetryDelayMs}): a `fetch` that never landed is already covered
     * by the reconnect that will flush the queue, whereas a refused flush happens
     * over a socket that stays open — so without this the writes sit queued
     * indefinitely. One pending timer per shard; a second delay replaces it
     * rather than stacking flushes.
     *
     * Nothing left to retry on this key (drained, closed, or no delay) drops its
     * backoff state, which is both the reset after progress and what bounds the
     * map.
     */
    private scheduleRateLimitedRetry(shardKey: string | undefined): void {
        const key = connectionKey(shardKey);
        const state = this.replayRetryState.get(key);
        const delay = state?.delayMs;

        if (state === undefined || delay === undefined || this.closed || this.offlineQueue.size === 0) {
            this.replayRetryState.delete(key);

            return;
        }

        state.delayMs = undefined;

        const existing = this.replayRetryTimers.get(key);

        if (existing !== undefined) {
            clearTimeout(existing);
        }

        this.replayRetryTimers.set(
            key,
            setTimeout(() => {
                this.replayRetryTimers.delete(key);
                this.flushOfflineQueue(shardKey).catch(() => undefined);
            }, delay),
        );
    }

    /**
     * Partition already-gated writes into the encodable ones (returned) and reject
     * the rest terminally. A write whose args can't be wire-encoded (e.g. a RegExp
     * or class instance in a `v.any()` field) can NEVER replay — the codec failure
     * is deterministic, not transient. Rejecting here is essential: otherwise
     * `encodeWire` throws mid-flush, is classified as transient (a codec error has
     * no `.code`), and re-queues forever — a silent hang where the caller's Promise
     * never settles and the optimistic write never rolls back. Encoding is cheap;
     * the flush is the slow reconnect path.
     */
    private encodableOrSettleTerminal(items: QueuedMutation[]): QueuedMutation[] {
        const encodable: QueuedMutation[] = [];

        for (const item of items) {
            try {
                encodeCallArgs(item.args, `args for '${item.functionPath}'`);
                encodable.push(item);
            } catch (error) {
                this.settleReplayTerminal(item, error instanceof Error ? error : new Error(String(error)));
            }
        }

        return encodable;
    }

    /**
     * Identity guard for one queued write about to replay: a write stamped under
     * one identity must never replay under another. The live `queuedIdentities`
     * map is the source of truth for the current session; a hydrated write whose
     * id isn't in the map falls back to the stamp persisted with the record
     * (`item.identity`), so a reload can't replay another user's queued writes.
     * Only legacy records (persisted before stamps were durable —
     * `item.identity === undefined`) replay under whatever identity is current.
     *
     * `Map.get` returns `undefined` for unstamped/hydrated ids and `item.identity`
     * is `undefined` for legacy records; a persisted `null` (queued while signed
     * out) is a real value that must not collapse into `undefined` — hence the
     * explicit `=== undefined` check rather than `??`. Returns `true` when the
     * write may replay; otherwise settles it `OFFLINE_IDENTITY_CHANGED` and returns
     * `false`. Either way the live stamp is consumed.
     */
    private passesReplayIdentityGate(item: QueuedMutation, currentIdentity: string | null): boolean {
        const liveStamp = item.id === undefined ? undefined : this.queuedIdentities.get(item.id);
        const stamped = liveStamp === undefined ? item.identity : liveStamp;

        // A stamp that mismatches the current identity is still replayable when it
        // is a token-hash of the credential still held now — the subject label
        // resolved after the write was stamped/persisted, but the credential never
        // changed (setAuthToken's documented re-stamp promise). Without this, a
        // reload or a transient-failure requeue falls back to the stale token-hash
        // and wrongly rejects the same user's durable write.
        if (stamped !== undefined && stamped !== currentIdentity && !this.isSameCredentialUnderTokenHash(stamped)) {
            this.queuedIdentities.delete(item.id ?? "");
            this.unpersist(item.id);

            const error = new Error("offline mutation skipped: auth identity changed before replay");

            (error as Error & { code?: string }).code = "OFFLINE_IDENTITY_CHANGED";
            item.reject(error);
            this.emitItemSettled(item, "rejected", error);

            return false;
        }

        this.queuedIdentities.delete(item.id ?? "");

        return true;
    }

    /** Settle a write that replayed successfully: confirm its optimistic layer against the echoed commit cursor BEFORE resolving, so the gapless drop is in place when the awaiter (and any confirming frame) observes the settle. */
    private settleReplaySuccess(item: QueuedMutation, value: unknown, commitCursor: number | undefined): void {
        this.unpersist(item.id);
        // A replayed write commits like any other, so it advances this shard's
        // read-your-writes bookmark too. Recorded HERE rather than only in
        // `rpc()` because the batched replay never goes through it — and a
        // client flushing its queue after a reconnect, then reading, is exactly
        // the case the bookmark exists for.
        this.recordShardCursor(item.shardKey, commitCursor);
        item.onCommit?.(commitCursor);
        item.resolve(value);
        this.emitItemSettled(item, "committed");
    }

    /**
     * The entry a shard's cursor lives under.
     *
     * Only the server knows that an omitted `shardKey` and an explicit one
     * spelling out its configured default name are the same shard — the default
     * is server-side configuration the client never sees. Keying on what was
     * SENT would split one shard's cursor across two entries, so a write under
     * one spelling would stop constraining a read under the other. Resolving
     * `undefined` through the learned name is what keeps both spellings on one
     * entry.
     */
    private cursorKeyFor(shardKey: string | undefined): string {
        return shardKey ?? this.defaultShardKey ?? "";
    }

    /**
     * Learn the server's own name for the default shard from a response to a
     * call that named no shard.
     *
     * Any cursor recorded before the name was known sits under the placeholder
     * entry, so it is folded in rather than stranded — otherwise the requirement
     * from a client's first write would be lost exactly once, which is the kind
     * of gap that only shows up as a stale read under load.
     */
    private learnDefaultShardKey(response: { headers: { get: (name: string) => null | string } }, shardKey: string | undefined): void {
        const canonical = response.headers.get("x-lunora-shard-key");

        if (canonical === null || shardKey !== undefined || this.defaultShardKey === canonical) {
            return;
        }

        this.defaultShardKey = canonical;

        const pending = this.shardCursors.get("");

        if (pending !== undefined) {
            this.shardCursors.set(canonical, Math.max(this.shardCursors.get(canonical) ?? 0, pending));
            this.shardCursors.delete("");
        }
    }

    /**
     * Record the cursor a write committed at as this shard's read-your-writes
     * requirement.
     *
     * Monotonic: responses can land out of order, and moving the requirement
     * BACKWARDS would let a later read be answered from a replica copy that
     * predates a write this client already saw.
     */
    private recordShardCursor(shardKey: string | undefined, commitCursor: number | undefined): void {
        if (typeof commitCursor !== "number") {
            return;
        }

        const key = this.cursorKeyFor(shardKey);

        this.shardCursors.set(key, Math.max(this.shardCursors.get(key) ?? 0, commitCursor));
    }

    /** Settle a write the server reached a coded verdict on: replaying would re-trigger the same failure (a poison-message loop), so drop it. */
    private settleReplayTerminal(item: QueuedMutation, error: unknown): void {
        this.unpersist(item.id);
        item.reject(error);
        this.emitItemSettled(item, "rejected", error);
    }

    /**
     * Replay already-identity-gated writes one at a time on the single-call `/rpc`
     * path, preserving FIFO order (parallel `.then()` chains would race the
     * ordering callers depend on). Each replays under its stable `mutationId` so
     * the server dedups a write it already committed (exactly-once). A server verdict
     * drops the write; a transient failure ({@link isTransientReplayFailure} — a
     * transport error, a shard the worker couldn't reach, a rate-limit refusal, or a
     * non-2xx carrying no `{ error }` envelope) stops the flush and re-queues this
     * write and every unreplayed one for the next reconnect — their callers stay
     * pending, and the identity guard re-applies on retry via each record's persisted
     * stamp. The batch path classifies a slot by the same rule, so a durable write's
     * fate never depends on how many siblings happened to be queued alongside it.
     */
    private async replaySequential(items: QueuedMutation[], shardKey: string | undefined): Promise<void> {
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];

            if (!item) {
                continue;
            }

            try {
                let commitCursor: number | undefined;
                // eslint-disable-next-line no-await-in-loop -- sequential replay preserves the FIFO order callers depend on
                const value = await this.rpc(item.functionPath, item.args, item.shardKey, {
                    captureBookmark: true,
                    // The id that queued the write, not the live session's — see the
                    // `clientId` stamp in `enqueueOffline`.
                    clientId: item.clientId ?? this.clientId,
                    mutationId: item.id,
                    onCommitCursor: (cursor) => {
                        commitCursor = cursor;
                    },
                });

                this.settleReplaySuccess(item, value, commitCursor);
            } catch (error) {
                if (!isTransientReplayFailure(error)) {
                    this.settleReplayTerminal(item, error);

                    continue;
                }

                this.noteReplayRetryDelay(shardKey, error);
                this.offlineQueue.requeue(items.slice(index));

                return;
            }
        }
    }

    /**
     * Coalesce already-identity-gated writes for a single shard into ONE
     * `/_lunora/rpc-batch` round trip (plan 088 follow-on). The worker forwards
     * them to the shard DO, which replays each through its single-call dispatch, so
     * per-entry `mutationId` idempotency and in-order application are inherited from
     * the proven path. Per-slot demux mirrors {@link replaySequential}'s
     * classification: success confirms the optimistic layer against the echoed
     * `commitCursor`; a coded application verdict is terminal; a {@link
     * TRANSIENT_REPLAY_ERROR_CODES} code, a missing slot, or a whole-batch
     * transport failure re-queues for the next reconnect (never dropping a durable
     * write). A whole-batch coded rejection (bad request / authorization denial the
     * server reached a verdict on) is terminal for every entry.
     *
     * The body is also held under {@link MAX_BATCH_BODY_BYTES}: the worker caps a
     * batch body at 1 MiB and answers `413`, which is ONE refusal covering every
     * write in the chunk. An over-budget chunk is halved before it is sent, and a
     * `413` for a chunk of more than one write halves it and retries rather than
     * settling the whole chunk terminally — so a backlog of large writes still
     * commits, one bisection deeper.
     *
     * Returns the writes that must be re-queued and `stop` — `true` when the whole
     * chunk failed at the transport level, so the caller leaves later chunks queued
     * rather than sending on. The caller re-queues once, in order, so requeuing is
     * NOT done here.
     */
    private async replayBatched(items: QueuedMutation[], shardKey: string | undefined): Promise<{ requeue: QueuedMutation[]; stop: boolean }> {
        if (!this.fetchImpl) {
            return { requeue: items, stop: true };
        }

        const body = JSON.stringify({
            calls: items.map((item, index) => {
                return {
                    args: encodeCallArgs(item.args, `args for '${item.functionPath}'`),
                    functionPath: item.functionPath,
                    id: index,
                    // Stable per-write key so the DO dedups a write it already
                    // committed (exactly-once), exactly as the single-call replay.
                    // `clientId` rides with it: the DO namespaces an ANONYMOUS
                    // caller's dedup row by it, and without one the batch entry
                    // has no namespace and the write re-runs. Per entry, not on
                    // the outer request — a batch is one transport hop but its
                    // entries are dispatched as independent single calls.
                    clientId: item.clientId ?? this.clientId,
                    mutationId: item.id,
                    shardKey: item.shardKey,
                };
            }),
        });

        // Over the worker's body cap — sending it would earn one `413` covering
        // every write in the chunk. Halve and retry instead.
        if (items.length > 1 && utf8ByteLength(body) > MAX_BATCH_BODY_BYTES) {
            return await this.replayBatchedHalves(items, shardKey);
        }

        let response: Response;

        try {
            response = await this.fetchImpl(joinUrl(this.url, RPC_BATCH_PATH), {
                body,
                // No shard key: a batch's entries may target several shards, and
                // one outbound `x-lunora-min-seq` cannot state a requirement for
                // all of them. Writes go to the owner regardless, so omitting it
                // costs nothing — the per-entry cursors are recorded on the way
                // back out (`settleReplaySuccess`).
                headers: this.rpcRequestHeaders({ attachBookmark: true }),
                method: "POST",
            });
        } catch {
            // Transport failure (offline mid-flush) — nothing committed; retry all.
            return { requeue: items, stop: true };
        }

        const bookmark = response.headers.get("x-d1-bookmark");

        if (bookmark) {
            this.bookmark.set(bookmark);
        }

        // The body cap the client measured against is not the one that counts —
        // the header framing rides along, and a proxy may impose its own. A `413`
        // is a verdict on the REQUEST, not on the writes inside it, so halve and
        // retry; only a lone write that is itself over the cap falls through to
        // the terminal envelope below (replaying it can never succeed).
        if (response.status === 413 && items.length > 1) {
            return await this.replayBatchedHalves(items, shardKey);
        }

        let payload: { error?: { code?: string; data?: unknown; message?: string }; results?: { body?: RpcResponseBody; id?: number }[] };

        const retryAfterHeader = response.headers.get("retry-after");

        try {
            payload = await response.json();
        } catch {
            // Not a Lunora envelope at all (an edge's HTML page) — classified by
            // HTTP status, since re-queuing every such reply unconditionally
            // parks a chunk the edge REFUSED at the head of the outbox forever.
            return this.settleWholeBatchError(items, unparseableResponseError(response.status, response.statusText, retryAfterHeader), shardKey);
        }

        // Whole-batch rejection with no per-slot results: one outcome covering
        // every entry in the chunk — a coded `{ error }` the server sent, or the
        // status of a non-2xx that carried no envelope.
        if (!payload.results) {
            const error =
                payload.error === undefined
                    ? unparseableResponseError(response.status, response.statusText, retryAfterHeader)
                    : reconstructErrorWithRetryAfter(payload.error, retryAfterHeader);

            return this.settleWholeBatchError(items, error, shardKey);
        }

        return { requeue: this.settleReplayBatchSlots(items, payload.results, shardKey), stop: false };
    }

    /**
     * Classify a `/_lunora/rpc-batch` reply that carried no per-slot results — one
     * outcome covering every entry in the chunk. A {@link TRANSIENT_REPLAY_ERROR_CODES}
     * code (an unreachable shard, a rate-limit refusal) or a
     * {@link TransportError} (an edge reply with no verdict in it) leaves every
     * write durable for the next attempt; anything else is a verdict reached on
     * the request itself, and settles all of them.
     */
    private settleWholeBatchError(
        items: QueuedMutation[],
        error: Error & { code?: string },
        shardKey: string | undefined,
    ): { requeue: QueuedMutation[]; stop: boolean } {
        if (error instanceof TransportError || (error.code !== undefined && TRANSIENT_REPLAY_ERROR_CODES.has(error.code))) {
            this.noteReplayRetryDelay(shardKey, error);

            return { requeue: items, stop: true };
        }

        for (const item of items) {
            this.settleReplayTerminal(item, error);
        }

        return { requeue: [], stop: false };
    }

    /**
     * Split an over-large batch chunk in half and replay each half, preserving
     * FIFO order. Recurses through {@link replayBatched}, so a chunk keeps halving
     * until it fits (or reaches one write, which is then the server's verdict to
     * give). A `stop` on the first half leaves the second unsent and queued.
     */
    private async replayBatchedHalves(items: QueuedMutation[], shardKey: string | undefined): Promise<{ requeue: QueuedMutation[]; stop: boolean }> {
        const middle = Math.ceil(items.length / 2);
        const first = await this.replayBatched(items.slice(0, middle), shardKey);

        if (first.stop) {
            return { requeue: [...first.requeue, ...items.slice(middle)], stop: true };
        }

        const second = await this.replayBatched(items.slice(middle), shardKey);

        return { requeue: [...first.requeue, ...second.requeue], stop: second.stop };
    }

    /**
     * Demux a `/_lunora/rpc-batch` reply back onto the queued writes it replayed,
     * in input order. Each slot's envelope classifies its write the same way
     * {@link replaySequential} does: a success confirms the optimistic layer
     * against the echoed `commitCursor`; a coded application verdict is terminal;
     * a transient failure ({@link TRANSIENT_REPLAY_ERROR_CODES}) or a slot the
     * server never returned is returned for the caller to re-queue.
     * @returns the writes that must be re-queued (transient slots), in input order
     */
    private settleReplayBatchSlots(
        items: QueuedMutation[],
        results: { body?: RpcResponseBody; id?: number }[],
        shardKey: string | undefined,
    ): QueuedMutation[] {
        const bySlot = new Map<number, RpcResponseBody>();

        for (const entry of results) {
            if (typeof entry.id === "number" && entry.body !== undefined) {
                bySlot.set(entry.id, entry.body);
            }
        }

        const requeue: QueuedMutation[] = [];

        for (const [index, item] of items.entries()) {
            const inner = bySlot.get(index);

            if (inner === undefined) {
                // The server never returned this slot — it may or may not have
                // committed; retry under the same `mutationId` (idempotent).
                requeue.push(item);
            } else if ("error" in inner) {
                if (TRANSIENT_REPLAY_ERROR_CODES.has(inner.error.code)) {
                    this.noteReplayRetryDelay(shardKey, reconstructError(inner.error));
                    requeue.push(item);
                } else {
                    this.settleReplayTerminal(item, reconstructError(inner.error));
                }
            } else {
                this.settleReplaySuccess(item, decodeWire(inner.result), inner.commitCursor);
            }
        }

        return requeue;
    }
}

export { LunoraClient };
export type {
    ActionCallOptions,
    BatchSlot,
    ClientDebugShard,
    ClientDebugSnapshot,
    ClientDebugSubscription,
    ConnectionStatus,
    LunoraClientError,
    MutationCallOptions,
    MutationSettledEvent,
    SyncWatermark,
};
