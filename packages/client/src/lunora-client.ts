import { LunoraError } from "@lunora/errors";

import { MAX_BATCH_ENTRIES } from "../../../shared/batch-wire";
import { evictOldestEntry } from "../../../shared/evict-oldest";
import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import { stableWireKey } from "../../../shared/wire-key";
import createInMemoryBookmarkStorage from "./bookmark";
import type { ClientQueryRef } from "./client-query-store";
import { ClientQueryStore } from "./client-query-store";
import { TabCoordinator } from "./cross-tab";
import { applyDelta, isMutationDelta } from "./delta-merge";
import type { LunoraErrorCode } from "./errors";
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

/** Build the `&amp;bucket=…` query fragment for a storage admin request, or `""` when no bucket is selected. */
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
    /** The `&lt;file>:&lt;function>` reference of the mutation. */
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
    /** Unsubscribes that couldn't be sent while the socket was down, each tagged with its wire type so a shape sub is torn down as `shape_unsubscribe`, never the legacy `unsubscribe`. */
    pendingUnsubscribes: { id: string; type: "shape_unsubscribe" | "unsubscribe" }[];
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
 * Build a coded `Error` from a stream-scoped server `error` frame. Pulls the
 * `code`/`message` off either the top-level fields or the nested `error`
 * envelope (the server uses both shapes), falling back to "stream error".
 */
const buildStreamError = (message: ServerErrorMessage): Error => {
    const errorEnvelope = message.error as { code?: unknown; message?: unknown } | undefined;
    const code = typeof errorEnvelope?.code === "string" ? errorEnvelope.code : undefined;
    const nestedMessage = typeof errorEnvelope?.message === "string" ? errorEnvelope.message : undefined;
    const messageText = (typeof message.message === "string" ? message.message : undefined) ?? nestedMessage ?? "stream error";

    return code === undefined ? new Error(messageText) : new LunoraError(code, messageText);
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
    /** The checkpoint the client's view must be at for this poke's diff to splice on cleanly; a mismatch forces a re-seed. */
    baseCheckpoint: number | undefined;
    epoch: string | undefined;
    lastMutationId: Map<string, number>;
    parts: Map<string, RowOp[]>;
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
 * Per-slot error codes the worker injects for a **transient** shard/transport
 * failure rather than an application verdict: a whole sub-batch that couldn't
 * reach its shard (`SHARD_UNAVAILABLE`) or whose shard response was unusable /
 * partial (`SHARD_ERROR`). For a single-shard outbox flush these fail every entry
 * uniformly, so a durable-outbox replay **re-queues** them for the next reconnect
 * instead of dropping the write — mirroring the single-call path's "codeless =
 * transient" rule. Every other coded error is a server verdict (terminal).
 */
const TRANSIENT_BATCH_ERROR_CODES = new Set(["SHARD_ERROR", "SHARD_UNAVAILABLE"]);

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
     * keyed by shard bucket (`shardKey ?? ""`) since the DO tracks one
     * `__client_watermark` per shard. `callMutator` bumps it from every
     * ack; the `@lunora/db` mutator runtime seeds its `clientSeq` generator from
     * it so a reload (which resets the in-memory counter) never reissues a stale
     * sequence the server would silently swallow as a replay.
     */
    private readonly clientWatermarks = new Map<string, number>();

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
    private readonly streams = new Map<string, { handle: StreamHandle; shardKey: string | undefined }>();

    /** Live shape subscriptions (partial replication), keyed by their wire id. */
    private readonly shapeSubscriptions = new Map<string, ShapeSubscriptionState>();

    /** In-flight pokes being assembled between `pokeStart` and `pokeEnd`, keyed by `pokeId`. */
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
            this.tabCoordinator = new TabCoordinator({
                onBecomeLeader: () => {
                    // Re-open sockets for every active subscription now that
                    // we own the WS connections.
                    for (const state of this.subscriptions.all()) {
                        this.ensureSocket(state.shardKey);
                        this.sendSubscribeIfOpen(state);
                    }
                },
                onStopBeingLeader: () => {
                    // Close all WS connections now that another tab leads.
                    for (const [key, conn] of this.connections) {
                        conn.socket?.close();
                        this.connections.delete(key);
                    }
                },
                onSubscriptionData: (key, data) => {
                    // A follower tab received the authoritative server value from
                    // the leader. Update serverBase and re-fold any local optimistic
                    // layers so the displayed value reflects both the new base and
                    // the follower's own pending writes.
                    const state = this.subscriptions.get(key);

                    if (state) {
                        state.serverBase = data;

                        const folded = state.optimisticLayers.length === 0 ? data : foldOptimistic(data, state.optimisticLayers);

                        state.lastValue = folded;

                        for (const callback of state.callbacks) {
                            try {
                                callback(folded);
                            } catch {
                                /* user callback threw — ignore */
                            }
                        }
                    }
                },
                onSubscriptionError: (key, error) => {
                    const state = this.subscriptions.get(key);

                    if (state) {
                        for (const callback of state.errorCallbacks) {
                            try {
                                callback(error);
                            } catch {
                                /* user callback threw — ignore */
                            }
                        }
                    }
                },
            });
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
                // to the new fingerprint instead of dropping them.
                this.restampQueuedIdentity(previousIdentity, newIdentity);
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
        return this.clientWatermarks.get(shardKey ?? "") ?? 0;
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
        let ackWatermark: number | undefined;

        const result = await this.rpc(functionPath, args, options?.shardKey, {
            captureBookmark: true,
            clientId: this.clientId,
            clientSeq,
            onMutationAck: (lastMutationId) => {
                ackWatermark = lastMutationId;
            },
        });

        if (ackWatermark !== undefined && ackWatermark > (this.clientWatermarks.get(bucket) ?? 0)) {
            this.clientWatermarks.set(bucket, ackWatermark);
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
     * When the precondition is checked it re-reads the query's current value
     * via `peekActiveQueryValue`. If the value differs from what was
     * captured at call time the precondition returns `false` and the offline
     * mutation is dropped as stale.
     *
     * This is a method wrapper around `createSnapshotPrecondition` that
     * binds the client instance for you — no need to pass `client` explicitly.
     * @example
     * ```ts
     * client.mutation(api.todos.update, { id, text }, {
     *   precondition: client.snapshotPrecondition(api.todos.list, { userId }),
     * });
     * ```
     */
    public snapshotPrecondition(functionRef: FunctionReference, args: Record<string, unknown>, shardKey?: string): () => boolean {
        const snapshot = this.peekActiveQueryValue(functionRef.__lunoraRef, args, shardKey);
        const snapshotKey = snapshot === undefined ? undefined : stableWireKey(snapshot);

        return (): boolean => {
            const current = this.peekActiveQueryValue(functionRef.__lunoraRef, args, shardKey);

            // Both undefined → no snapshot taken and no value now → no conflict.
            if (snapshotKey === undefined && current === undefined) {
                return true;
            }

            // One is undefined, the other is not → the value appeared or disappeared.
            if (snapshotKey === undefined || current === undefined) {
                return false;
            }

            return stableWireKey(current) === snapshotKey;
        };
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
     * Peek at the **current live value** of an active subscription, if one
     * exists. Returns the subscription's `lastValue` (which includes any
     * optimistic overlay) or `undefined` if no subscription is active for the
     * given `(functionPath, args, shardKey)`.
     *
     * Unlike {@link peekHydratedQuery} (which reads from the durable read cache
     * and is independent of active subscriptions), this method reflects the
     * current in-memory state of an already-opened subscription — useful for
     * offline mutation preconditions that need to snapshot the value at call time
     * and compare it at replay time.
     */
    public peekActiveQueryValue(functionPath: string, args: Record<string, unknown>, shardKey?: string): unknown {
        const key = SubscriptionRegistry.key(functionPath, args, shardKey);
        const state = this.subscriptions.get(key);

        return state?.lastValue;
    }

    // --- RPC ---------------------------------------------------------------

    public async query<F extends FunctionReference>(function_: F, args: ArgsOf<F>, options: { shardKey?: string } = {}): Promise<ReturnOf<F>> {
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

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
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

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

        return demuxBatchResults(body.results ?? [], calls.length);
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

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

    public async action<F extends FunctionReference>(function_: F, args: ArgsOf<F>, options: { shardKey?: string } = {}): Promise<ReturnOf<F>> {
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

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
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
     * configured backoff. Requires `wsToken` to be set to an admin credential
     * (the browser can't send an `Authorization` header on a WS) — the master
     * token, or preferably a {@link WsTokenProvider} minting the ephemeral
     * sub-token so the master credential stays out of the URL. Returns an
     * unsubscribe function that closes the socket and stops reconnecting.
     */
    public subscribeScheduledJobs(onJobs: (jobs: ScheduleRecord[]) => void): Unsubscribe {
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

        if (this.WebSocketImpl === undefined) {
            return () => undefined;
        }

        const base = joinUrl(deriveWsUrl(this.url), SCHEDULED_WS_PATH);
        const reconnect = createReconnect(this.reconnectOptions);

        let socket: undefined | WebSocket;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let closed = false;

        const openWith = (token: string | undefined): void => {
            if (closed || this.WebSocketImpl === undefined) {
                return;
            }

            const url = token === undefined ? base : `${base}?token=${encodeURIComponent(token)}`;

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
                    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: the reconnect re-enters `connect`, declared just below with `openWith` in scope
                    timer = setTimeout(connect, reconnect.next());
                }
            });

            socket.addEventListener("error", () => {
                /* the runtime follows up with close; reconnect handles it there */
            });
        };

        /** Resolve the provider-shaped token, then open; a failed mint re-arms the reconnect timer. */
        const connectWithProvider = async (provider: WsTokenProvider): Promise<void> => {
            let token: string | undefined;

            try {
                token = await provider();
            } catch {
                if (!closed) {
                    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: the retry re-enters `connect`, declared just below
                    timer = setTimeout(connect, reconnect.next());
                }

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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

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
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

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
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

        const body = (await this.adminFetch(KV_NAMESPACES_PATH, "GET")) as { namespaces?: KvNamespaceSummary[] };

        return body.namespaces ?? [];
    }

    /**
     * List keys in a KV namespace, optionally filtered by `prefix` and
     * paginated via `cursor`. Hits the admin-gated
     * `GET /_lunora/admin/kv/keys` endpoint.
     */
    public async listKvKeys(options: { cursor?: string; limit?: number; namespace: string; prefix?: string }): Promise<KvKeyListResult> {
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

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
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

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
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

        await this.adminFetch(KV_VALUE_PATH, "PUT", options);
    }

    /**
     * Delete a key from a KV namespace. No-op when the key is absent. Hits the
     * admin-gated `DELETE /_lunora/admin/kv/value` endpoint.
     */
    public async deleteKvKey(options: { key: string; namespace: string }): Promise<void> {
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

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
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
        options: { onCheckpoint?: (watermark: SyncWatermark) => void; onError?: SubscriptionErrorCallback; shardKey?: string } = {},
    ): Unsubscribe {
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

        const argsRecord = (args ?? {}) as Record<string, unknown>;
        const key = SubscriptionRegistry.key(function_.__lunoraRef, argsRecord, options.shardKey);

        let state = this.subscriptions.get(key);
        const subscriptionCallback = callback as SubscriptionCallback;
        const errorCallback = options.onError;

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
        if (options.onCheckpoint) {
            state.checkpointCallbacks.add(options.onCheckpoint);
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

            if (options.onCheckpoint) {
                subscriptionState.checkpointCallbacks.delete(options.onCheckpoint);
            }

            if (subscriptionState.callbacks.size === 0) {
                const conn = this.getConnection(subscriptionState.shardKey);
                const ok = conn ? sendOn(conn, { id: subscriptionState.id, type: "unsubscribe" }) : false;

                if (!ok && conn) {
                    conn.pendingUnsubscribes.push({ id: subscriptionState.id, type: "unsubscribe" });
                }

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
     */
    public subscribeShape(
        shape: { args?: Record<string, unknown>; name: string },
        callback: ShapeCallback,
        options: { onCheckpoint?: (watermark: SyncWatermark) => void; onError?: SubscriptionErrorCallback; shardKey?: string } = {},
    ): Unsubscribe {
        if (this.closed) {
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
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
            const conn = this.getConnection(state.shardKey);
            const ok = conn ? sendOn(conn, { id, type: "shape_unsubscribe" }) : false;

            if (!ok && conn) {
                conn.pendingUnsubscribes.push({ id, type: "shape_unsubscribe" });
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
            throw new LunoraError("INTERNAL", "LunoraClient is closed");
        }

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
                    droppedStream.handle.fail(new LunoraError("STREAM_QUEUE_OVERFLOW", "stream-start frame evicted while socket was unreachable"));
                    this.streams.delete(droppedId as string);
                }
            }

            conn.pendingStreams.push(message);
        }

        return iterable;
    }

    /**
     * Open a typed **HTTP-SSE route stream** (`httpRoute.&lt;verb>(path).stream()`).
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
        this.mutationSettledListeners.clear();
        this.pendingChangeListeners.clear();
        this.whisperHandlers.clear();

        // Shape subscriptions retain user row/error callbacks and replicated
        // rows; poke buffers hold partially-assembled membership. Neither is
        // touched by the registries above, so drop them too — otherwise the UI
        // closures they close over outlive the terminal client.
        this.shapeSubscriptions.clear();
        this.pokeBuffers.clear();

        // Stop cross-tab coordination and release the BroadcastChannel.
        this.tabCoordinator?.stop();
        this.tabCoordinator = undefined;
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
                // Version gate: a value persisted under a different app/schema
                // version is dropped and purged rather than hydrated.
                if (isStaleVersion(this.persistenceVersion, entry.version)) {
                    this.queryCache.remove(key).catch(() => undefined);

                    continue;
                }

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
        // Persist the authoritative server value (`serverBase`), never an optimistic
        // overlay, so a reload restores confirmed data (pending writes re-hydrate
        // from the durable outbox separately). `serverBase` tracks `lastValue` when
        // no optimistic layer is active.
        const authoritative = state.serverBase;

        if (!this.queryCache || authoritative === undefined) {
            return;
        }

        const key = queryCacheKey(state.fn.__lunoraRef, state.argsKey, state.shardKey);

        this.pendingCacheWrites.set(key, {
            identity: this.identityFingerprint(),
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

        this.statusListeners.emit(next);
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
            for (let index = rollbacks.length - 1; index >= 0; index -= 1) {
                rollbacks[index]?.();
            }

            return;
        }

        optimisticRollbacks.push(...rollbacks);
        optimisticConfirms.push(...confirms);
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
    private rpcRequestHeaders(flags: { attachBookmark?: boolean; clientId?: string; clientSeq?: number; mutationId?: string }): Record<string, string> {
        const headers: Record<string, string> = { "content-type": "application/json" };

        if (this.authToken) {
            headers["authorization"] = `Bearer ${this.authToken}`;
        }

        if (flags.mutationId) {
            headers["x-lunora-mutation-id"] = flags.mutationId;
        }

        // Custom-mutator push protocol (server reads these in `classifyClientMutation`):
        // the per-client identity + the monotonic per-client sequence that drives
        // the `__client_watermark` advance.
        if (flags.clientId !== undefined) {
            headers["x-lunora-client-id"] = flags.clientId;
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
            throw new LunoraError("INTERNAL", "LunoraClient: no `fetch` implementation available");
        }

        const headers = this.rpcRequestHeaders(flags);

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
            const statusText = response.statusText ? ` ${response.statusText}` : "";

            throw new LunoraError("INTERNAL", `LunoraClient: response was not JSON (status ${response.status.toString()}${statusText})`);
        }

        if ("error" in body) {
            // Reconstruct the thrown error with its `.code` and (for an app
            // `LunoraError`) wire-decoded `.data`.
            throw reconstructError(body.error);
        }

        // A non-2xx response whose body parsed as JSON but carried no `error`
        // envelope would otherwise be treated as a successful result. Surface the
        // HTTP status so callers get an actionable error instead.
        if (!response.ok) {
            const statusText = response.statusText ? ` ${response.statusText}` : "";

            throw new LunoraError("INTERNAL", `LunoraClient: request failed (status ${response.status.toString()}${statusText})`);
        }

        flags.onMutationAck?.(body.lastMutationId);
        flags.onCommitCursor?.(body.commitCursor);

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

        // When cross-tab sync is active and this tab is not the WS leader,
        // skip opening sockets — the leader tab owns all connections.
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

    /** Construct the shard socket and wire its lifecycle handlers. The connection must already be in the `connecting` state. */
    private openSocket(conn: ShardConnection, shardKey: string | undefined, token: string | undefined): void {
        if (this.WebSocketImpl === undefined) {
            return;
        }

        // Intentional mutation of the shared, long-lived connection record so
        // the open/close/error handlers all observe the same state machine
        // (mirrors `handleDisconnect`).
        /* eslint-disable no-param-reassign -- mutate the shared ShardConnection state machine in place */
        const socket = new this.WebSocketImpl(this.wsUrlFor(shardKey, token));

        conn.socket = socket;

        // Fail-fast connect timeout: if the handshake doesn't reach `open` within
        // `connectTimeoutMs` (a hung proxy / cold worker that never upgrades),
        // force-close the socket so `close` → `handleDisconnect` arms the normal
        // reconnect/backoff and surfaces `offline` — instead of the live channel
        // hanging on the browser's much longer default. Cleared on `open`/disconnect.
        if (this.connectTimeoutMs > 0) {
            conn.connectTimer = setTimeout(() => {
                conn.connectTimer = undefined;

                // Only act if THIS socket is still the connection's current,
                // still-connecting socket. A newer reconnect socket (or an
                // already-resolved open/close) must be left untouched.
                if (conn.socket !== socket || conn.wsState !== "connecting") {
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

            // Re-send shape subscriptions bound to this shard. Each carries its
            // last applied checkpoint, so the server resumes (or re-seeds when the
            // cursor fell below retention / the epoch forked).
            this.resendShapeSubscriptions(shardKey);

            // Flush any unsubscribes that piled up while the socket was down.
            if (conn.pendingUnsubscribes.length > 0) {
                const pending = conn.pendingUnsubscribes;

                conn.pendingUnsubscribes = [];

                for (const { id, type } of pending) {
                    sendOn(conn, { id, type });
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
            // Ignore a late close from a socket the connection already moved past
            // (e.g. the fail-fast timeout force-closed it and a reconnect already
            // built a newer socket). Acting on it would tear down the live socket.
            if (conn.socket !== socket) {
                return;
            }

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
            // Ignore a late error from a superseded socket (see `close` above):
            // only the connection's current socket may drive a disconnect.
            if (conn.socket !== socket) {
                return;
            }

            // Some WebSocket implementations (notably misbehaving proxies and
            // certain test doubles) fire `error` without a follow-up `close`.
            // Treat error in `connecting`/`open` as a disconnect ourselves to
            // make sure the reconnect timer always arms; `handleDisconnect` is
            // idempotent via the `wsState === "idle"` checks downstream.
            if (conn.wsState === "connecting" || conn.wsState === "open") {
                this.handleDisconnect(conn);
            }
        });
        /* eslint-enable no-param-reassign */
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

        // Fail every in-flight stream bound to this shard. A stream whose start
        // frame was already sent lost its server-side iterator when the socket
        // dropped and can't resume, so a consumer's `for await` would otherwise
        // hang forever on a next() that never settles (streams are failed on
        // close()/error/overflow but a socket bounce is the common termination).
        // Stream-start frames still queued in `pendingStreams` were never sent,
        // so they legitimately ride the next reconnect — exclude those ids.
        const pendingStreamIds = new Set((conn.pendingStreams ?? []).map((message) => (message as { id?: string }).id));

        for (const [id, stream] of this.streams) {
            if (connectionKey(stream.shardKey) === connectionKey(conn.shardKey) && !pendingStreamIds.has(id)) {
                stream.handle.fail(new LunoraError("STREAM_DISCONNECTED", "stream terminated: WebSocket disconnected"));
                this.streams.delete(id);
            }
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
                // Wire-encode so a `bigint`/`Date`/bytes arg survives the frame's
                // `JSON.stringify` (the shard `decodeWire`s at its subscribe entry
                // point). Identity for pure-JSON args. Cannot throw here: the
                // registry key (`stableWireKey`) already encoded these args at
                // subscribe() time, so reconnect resends stay safe.
                args: encodeWire(state.args) as Record<string, unknown>,
                functionPath: state.fn.__lunoraRef,
                table,
                ...(state.serverCursor === undefined ? {} : { sinceSeq: state.serverCursor }),
                ...(state.serverEpoch === undefined ? {} : { sinceEpoch: state.serverEpoch }),
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
                this.handlePokeEnd(message);

                break;
            }
            case "pokePart": {
                this.handlePokePart(message);

                break;
            }
            case "pokeStart": {
                this.handlePokeStart(message);

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
            fanSubscriptionError(state.errorCallbacks, buildSubscriptionError(message));

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

    private handlePokeStart(message: ServerPokeStartMessage): void {
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
        this.pokeBuffers.set(message.pokeId, { baseCheckpoint: message.baseCheckpoint, epoch: message.epoch, lastMutationId: new Map(), parts: new Map() });
    }

    private handlePokePart(message: ServerPokePartMessage): void {
        const buffer = this.pokeBuffers.get(message.pokeId);

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
    }

    private handlePokeEnd(message: ServerPokeEndMessage): void {
        const buffer = this.pokeBuffers.get(message.pokeId);

        if (!buffer) {
            return;
        }

        this.pokeBuffers.delete(message.pokeId);

        for (const [shapeId, ops] of buffer.parts) {
            const state = this.shapeSubscriptions.get(shapeId);

            if (!state) {
                continue;
            }

            // An epoch mismatch means the changelog timeline forked since we last
            // applied (a reset/recycled DO); a base mismatch means this diff was
            // computed against a checkpoint we're not actually at (a dropped poke
            // / gap). Either way, splicing the incremental ops onto our view would
            // corrupt it — so drop the local view, clear the cursor, SKIP the ops,
            // and re-subscribe so the server re-seeds the membership from scratch.
            const epochForked = buffer.epoch !== undefined && state.serverEpoch !== undefined && buffer.epoch !== state.serverEpoch;
            const baseDiverged = buffer.baseCheckpoint !== undefined && state.serverCursor !== undefined && state.serverCursor !== buffer.baseCheckpoint;

            if (epochForked || baseDiverged) {
                state.rows.clear();
                state.serverCursor = undefined;
                state.serverEpoch = undefined;
                this.emitShapeRows(state);
                this.sendShapeSubscribeIfOpen(state);

                continue;
            }

            applyRowOpsToView(state.rows, ops);

            if (message.checkpoint !== undefined) {
                state.serverCursor = message.checkpoint;
            }

            if (message.epoch !== undefined) {
                state.serverEpoch = message.epoch;
            }

            const watermark = buffer.lastMutationId.get(shapeId);

            if (watermark !== undefined) {
                state.lastMutationId = watermark;
            }

            this.emitShapeRows(state);

            // Surface the advanced watermark so a `@lunora/db` collection can drop
            // the optimistic overlay for any mutation this poke has now synced.
            state.onCheckpoint?.({ checkpoint: state.serverCursor, mutationId: state.lastMutationId });
        }
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

        const payload = this.resolveDataPayload(message, state);

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

        // Persist the authoritative server value (never the optimistic overlay)
        // to the durable read cache (debounced).
        this.persistQueryValue(state);

        // Drop any optimistic layer the server has now confirmed (its commit cursor
        // is at/under this frame's cursor), then display `serverBase` re-folded
        // through whatever optimistic layers remain pending (rebasing).
        dropConfirmedLayers(state, state.serverCursor);
        notifySubscription(state, state.optimisticLayers.length === 0 ? payload : foldOptimistic(payload, state.optimisticLayers));

        // When cross-tab sync is active and we're the WS leader, broadcast
        // the new value to follower tabs so they stay in sync without their
        // own WS connections.
        if (this.tabCoordinator?.isLeader()) {
            const key = SubscriptionRegistry.key(state.fn.__lunoraRef, state.args, state.shardKey);

            this.tabCoordinator.broadcastSubscriptionData(key, payload);
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
            state.lastMutationId = message.lastMutationId;
        }

        // Fan out to every registered subscriber (shared state — see
        // SubscriptionState.checkpointCallbacks). A snapshot isn't needed: a
        // checkpoint callback never (un)subscribes to this same state mid-flush.
        for (const onCheckpoint of state.checkpointCallbacks) {
            onCheckpoint({ checkpoint: state.serverCursor, mutationId: state.lastMutationId });
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
        if (isMutationDelta(delta) && state.serverBase !== undefined) {
            const merged = applyDelta(state.serverBase, delta);

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
     * Stable token-hash fingerprint of a bearer token (the `&lt;len>:&lt;fnv>:&lt;djb2>`
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

    /**
     * Migrate every live identity stamp from `from` to `to` — used when the auth
     * identity label changes but the underlying credential (token) does NOT, e.g.
     * the user id resolves a tick after the token was set. The in-memory
     * `queuedIdentities` map is the flush-time source of truth, so re-stamping it
     * keeps the in-flight writes replayable under the new (more stable) identity
     * instead of the flush guard discarding them as a mismatch.
     */
    private restampQueuedIdentity(from: string | null, to: string | null): void {
        for (const [id, stamp] of this.queuedIdentities) {
            if (stamp === from) {
                this.queuedIdentities.set(id, to);
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

    private async flushOfflineQueue(shardKey: string | undefined): Promise<void> {
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
            await this.replaySequential(encodable);

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
            const outcome = await this.replayBatched(chunk);

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
        item.onCommit?.(commitCursor);
        item.resolve(value);
        this.emitItemSettled(item, "committed");
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
     * the server dedups a write it already committed (exactly-once). A coded error
     * is a server verdict (drop it); a codeless (transport/transient) failure stops
     * the flush and re-queues this write and every unreplayed one for the next
     * reconnect — their callers stay pending, and the identity guard re-applies on
     * retry via each record's persisted stamp.
     */
    private async replaySequential(items: QueuedMutation[]): Promise<void> {
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
                    mutationId: item.id,
                    onCommitCursor: (cursor) => {
                        commitCursor = cursor;
                    },
                });

                this.settleReplaySuccess(item, value, commitCursor);
            } catch (error) {
                if ((error as { code?: string }).code !== undefined) {
                    this.settleReplayTerminal(item, error);

                    continue;
                }

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
     * `commitCursor`; a coded application verdict is terminal; a transient shard
     * failure (`SHARD_UNAVAILABLE`/`SHARD_ERROR`), a missing slot, or a whole-batch
     * transport failure re-queues for the next reconnect (never dropping a durable
     * write). A whole-batch coded rejection (bad request / authorization denial the
     * server reached a verdict on) is terminal for every entry.
     *
     * Returns the writes that must be re-queued and `stop` — `true` when the whole
     * chunk failed at the transport level, so the caller leaves later chunks queued
     * rather than sending on. The caller re-queues once, in order, so requeuing is
     * NOT done here.
     */
    private async replayBatched(items: QueuedMutation[]): Promise<{ requeue: QueuedMutation[]; stop: boolean }> {
        if (!this.fetchImpl) {
            return { requeue: items, stop: true };
        }

        let response: Response;

        try {
            response = await this.fetchImpl(joinUrl(this.url, RPC_BATCH_PATH), {
                body: JSON.stringify({
                    calls: items.map((item, index) => {
                        return {
                            args: encodeCallArgs(item.args, `args for '${item.functionPath}'`),
                            functionPath: item.functionPath,
                            id: index,
                            // Stable per-write key so the DO dedups a write it already
                            // committed (exactly-once), exactly as the single-call replay.
                            mutationId: item.id,
                            shardKey: item.shardKey,
                        };
                    }),
                }),
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

        let body: { error?: { code?: string; data?: unknown; message?: string }; results?: { body?: RpcResponseBody; id?: number }[] };

        try {
            body = await response.json();
        } catch {
            // Non-JSON body (an edge 5xx, say) — transient, don't lose the writes.
            return { requeue: items, stop: true };
        }

        // Whole-batch rejection with no per-slot results: a coded `{ error }` (bad
        // request / authorization denial) is a verdict on every entry — terminal;
        // a non-2xx WITHOUT a coded envelope is a transient transport error.
        if (!body.results) {
            if (body.error) {
                const error = reconstructError(body.error);

                for (const item of items) {
                    this.settleReplayTerminal(item, error);
                }

                return { requeue: [], stop: false };
            }

            return { requeue: items, stop: true };
        }

        return { requeue: this.settleReplayBatchSlots(items, body.results), stop: false };
    }

    /**
     * Demux a `/_lunora/rpc-batch` reply back onto the queued writes it replayed,
     * in input order. Each slot's envelope classifies its write the same way
     * {@link replaySequential} does: a success confirms the optimistic layer
     * against the echoed `commitCursor`; a coded application verdict is terminal;
     * a transient shard failure ({@link TRANSIENT_BATCH_ERROR_CODES}) or a slot the
     * server never returned is returned for the caller to re-queue.
     * @returns the writes that must be re-queued (transient slots), in input order
     */
    private settleReplayBatchSlots(items: QueuedMutation[], results: { body?: RpcResponseBody; id?: number }[]): QueuedMutation[] {
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
                if (TRANSIENT_BATCH_ERROR_CODES.has(inner.error.code)) {
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
export type { BatchSlot, ConnectionStatus, LunoraClientError, MutationCallOptions, MutationSettledEvent, SyncWatermark };
