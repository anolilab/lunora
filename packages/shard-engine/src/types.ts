import type { WhereInput } from "./where-types";

export interface SubscriptionQuery {
    args?: Record<string, unknown>;

    /**
     * `<file>:<function>` identifier of the query to re-run server-side when
     * a write touches a table it reads. Present on subscriptions that opt into
     * server re-execution; absent on legacy delta-only subscriptions, which
     * are matched by `table` alone.
     */
    functionPath?: string;

    /**
     * Resume epoch: the `epoch` token the client persisted alongside
     * `sinceSeq` from an earlier frame. The server resumes only when this
     * matches the shard's current epoch — a mismatch means the changelog
     * timeline forked (a reset, or a recycled Durable Object id) since the
     * client cached, so its `sinceSeq` names an unrelated point and it must
     * re-snapshot. Absent on a first-time subscribe and on pre-epoch clients
     * (treated as "unknown epoch" → full snapshot when `sinceSeq` is set).
     */
    sinceEpoch?: string;

    /**
     * Resume cursor: the `__cdc_log.seq` high-watermark the client last observed
     * for this shard (the `cursor` it persisted from an earlier `data`/`delta`
     * frame). Present only on a reconnecting subscription that opts into
     * incremental resume. When supplied and the client is still within the CDC
     * retention window, the server skips re-sending a full snapshot if no table
     * the query reads changed since `sinceSeq` (it sends a lightweight `resume`
     * frame instead). Absent on a first-time subscribe, which always seeds with
     * a full snapshot.
     */
    sinceSeq?: number;

    /**
     * Table name the legacy raw-delta fan-out path matches against. Kept for
     * `broadcastDelta`; the server re-execution path keys off
     * `functionPath` instead.
     */
    table?: string;
}

/**
 * A live shape subscription registered on a socket — the partial-replication
 * parallel to {@link SubscriptionQuery}. The client names a `defineShape` shape
 * and supplies validated `args`; the DO resolves it to a table + RLS-composed
 * `effectiveWhere` under the socket's verified identity (never the client's
 * word) and pokes the membership diff. `sinceSeq`/`sinceEpoch` carry the
 * client's last applied checkpoint for resume.
 */
export interface ShapeSubscriptionQuery {
    /** Validated shape arguments (e.g. `{ channelId }`); forwarded to `resolveShape`. */
    args?: Record<string, unknown>;

    /** Registered shape name (the `defineShape` export the codegen subclass resolves). */
    name: string;

    /** Resume epoch the client persisted alongside {@link ShapeSubscriptionQuery.sinceSeq} (see {@link SubscriptionQuery.sinceEpoch}). */
    sinceEpoch?: string;

    /** Resume checkpoint: the `__cdc_log` cursor the client's view of this shape last reflected (see {@link SubscriptionQuery.sinceSeq}). */
    sinceSeq?: number;
}

export interface SubscriptionEnvelope {
    /**
     * Optional capability tokens carried by the `connect` envelope, naming wire
     * behaviours this client can handle that older ones cannot (currently only
     * `"pageDelta"` — see `shared/page-result.ts`). Resolved to the decisions
     * they gate and recorded on the attachment; an unrecognised token is simply
     * never matched, so a newer client talking to an older server degrades
     * silently. Strictly opt-in: absent means the server keeps to the wire
     * behaviour every client already understood.
     */
    caps?: string[];

    /**
     * Stable per-client id carried by the `connect` envelope. Recorded on the
     * socket attachment so a shape poke can echo this client's
     * `__client_watermark` as its `lastMutationId`. Ignored on other envelope
     * types; absent for clients that don't use custom mutators.
     */
    clientId?: string;

    /**
     * App-supplied connection context carried by the `connect` envelope (e.g.
     * `{ roomId, sessionId }`). Merged into the socket attachment and forwarded
     * to every lifecycle hook as `event.context`. Ignored on other envelope types.
     */
    context?: Record<string, unknown>;

    /**
     * Opaque ephemeral payload of a `whisper` envelope, fanned out verbatim to
     * the topic's other subscribers. Bounded in size; never persisted.
     */
    data?: unknown;

    /**
     * Run generation on a resuming `stream` envelope: the `startedAt` stamp of
     * the durable run the client's {@link SubscriptionEnvelope.sinceChunk}
     * watermark belongs to, echoed back from the chunk frames that carried it.
     * A resume whose generation does not match the stored run fails with
     * `STREAM_INTERRUPTED` instead of splicing a different run's transcript
     * onto the prefix the client already holds. Absent from older clients.
     */
    generation?: number;
    id: string;
    query?: SubscriptionQuery;

    /**
     * Shape descriptor of a `shape_subscribe` envelope: the named shape + its
     * validated args. Carries the client's resume checkpoint via
     * {@link SubscriptionEnvelope.sinceCheckpoint}/{@link SubscriptionEnvelope.sinceEpoch}.
     */
    shape?: { args?: Record<string, unknown>; name: string };

    /** Resume checkpoint on a `shape_subscribe` envelope (the `__cdc_log` cursor the client's shape view is at). */
    sinceCheckpoint?: number;

    /**
     * Resume watermark for a `stream` envelope: the highest chunk `seq` this
     * client already has. Only meaningful for a stream declared `durable` —
     * the run replays everything after it, then continues live. Absent or `0`
     * asks for the whole transcript.
     *
     * Deliberately NOT named `sinceSeq`: that name is already taken, one level
     * down in `query`, for the CDC cursor a live query resumes from. Two
     * different watermarks on the same envelope need two different names.
     */
    sinceChunk?: number;

    /** CDC epoch the {@link SubscriptionEnvelope.sinceCheckpoint} belongs to. */
    sinceEpoch?: string;

    /**
     * Topic of a `whisper`/`whisper_subscribe`/`whisper_unsubscribe` envelope —
     * an app-chosen channel name (e.g. `"room:42:cursors"`) scoped to this shard.
     */
    topic?: string;

    /**
     * `subscribe`/`unsubscribe`/`ack` drive live queries; `stream` opens a
     * streaming-query iterator that yields `ServerChunkMessage` frames
     * until the server emits `complete` (or the client cancels with
     * `unsubscribe` on the same id). `connect` is the one-shot control frame the
     * client sends right after the socket opens to register its connection
     * `context` and fire the `onConnect` lifecycle hooks.
     *
     * `whisper_subscribe`/`whisper_unsubscribe` join/leave a whisper `topic`;
     * `whisper` broadcasts ephemeral `data` to the topic's other subscribers on
     * this shard with NO SQLite/CDC write (AnyCable-style whispering — typing
     * indicators, live cursors). The sender never receives its own whisper.
     */
    type:
        | "ack"
        | "connect"
        | "shape_subscribe"
        | "shape_unsubscribe"
        | "stream"
        | "subscribe"
        | "unsubscribe"
        | "whisper"
        | "whisper_subscribe"
        | "whisper_unsubscribe";
}

export interface RpcRequest {
    args?: Record<string, unknown>;
    functionPath: string;
}

/**
 * Per-WebSocket metadata that survives hibernation via
 * `ws.serializeAttachment` / `ws.deserializeAttachment`.
 *
 * Wire format reminder — every JSON envelope on the socket carries `type`
 * and `id`, the latter echoed back by the runtime so the client can match
 * acks/deltas to outstanding subscriptions. The shapes the runtime emits:
 *
 * ```jsonc
 * // client -> server (subscribe)
 * { "type": "subscribe",   "id": "sub-1", "query": { "table": "messages" } }
 * // server -> client (ack)
 * { "type": "ack",         "id": "sub-1" }
 *
 * // client -> server (unsubscribe)
 * { "type": "unsubscribe", "id": "sub-1" }
 * // server -> client (ack)
 * { "type": "ack",         "id": "sub-1" }
 *
 * // server -> client (delta) — fan-out from broadcastDelta
 * { "type": "delta", "id": "sub-1",
 *   "delta": { "table": "messages", "op": "insert", "key": "msg-42",
 *              "row": { "_id": "msg-42", "text": "hi" } } }
 * ```
 *
 * The attachment itself only persists the live `subs` map; ack/delta
 * messages are derived on-demand from that map plus the runtime payload.
 */
export interface SocketAttachment {
    /**
     * `true` when the upgrade presented a token matching `LUNORA_ADMIN_TOKEN`,
     * gating the reserved `__lunora_admin__:*` introspection subscriptions to
     * the same credential as the HTTP admin RPCs. Absent/`false` on ordinary
     * user-subscription sockets, which may never read admin data over the wire.
     */
    admin?: boolean;

    /**
     * Fingerprint of the `LUNORA_ADMIN_TOKEN` that authorized this socket at
     * upgrade (`shared/ws-admin-token`'s `adminSocketBinding`). Every later
     * admin read re-derives it from `env` and compares, so rotating or clearing
     * the master token revokes a live admin socket instead of only closing the
     * HTTP admin plane. Absent on non-admin sockets, and an absent value is
     * refused — the gate fails closed.
     */
    adminBinding?: string;

    /**
     * Stable per-client id from the `connect` envelope (the same id the client
     * stamps on its custom-mutator pushes). Lets a shape poke echo this client's
     * `__client_watermark` as the poke's `lastMutationId`, so a `@lunora/db`
     * collection can drop the optimistic overlay for writes this poke has
     * synced. Absent for clients that don't use custom mutators. Persisted so it
     * survives hibernation.
     */
    clientId?: string;

    /**
     * `true` once the socket's `connect` envelope has fired the `onConnect`
     * hooks. Gates the dispatch so a client that re-sends `connect` (or a
     * duplicate frame) can't re-fire the hooks for an already-announced socket —
     * `onConnect`/`onDisconnect` stay symmetric. Persisted so it survives
     * hibernation.
     */
    connected?: boolean;

    /**
     * Stable per-socket id minted at upgrade. Its presence marks a socket that
     * has been through the lifecycle-aware upgrade path, so `webSocketClose`
     * only dispatches `onDisconnect` hooks for a socket that recorded one.
     */
    connectionId?: string;

    /**
     * App-supplied connection context from the client `connect` envelope (e.g.
     * `{ roomId, sessionId }`). Stashed here so it survives hibernation and can
     * be replayed to the `onDisconnect` hooks at close time.
     */
    context?: Record<string, unknown>;

    /**
     * Token-expiry (epoch ms) of the credential resolved at upgrade, when the
     * runtime forwarded one (`x-lunora-identity-exp`). The DO drops the socket
     * with a `TOKEN_EXPIRED` error + close code `4001` the next time it sends a
     * frame at or after this instant, so the client reconnects and re-resolves a
     * fresh identity. Absent for sockets whose identity declares no expiry.
     */
    expiresAt?: number;

    /**
     * Verified caller identity claims resolved at upgrade (from the
     * `x-lunora-identity` header the runtime forwards). Replayed to lifecycle
     * hooks so they run under the connecting user.
     */
    identity?: Record<string, unknown>;

    /**
     * `true` when the socket's `connect` envelope announced the `pageDelta`
     * capability — i.e. this client can merge a row delta into the `page` of a
     * paginated result, so the server may diff one instead of re-sending it.
     *
     * The resolved DECISION, not the announced token list: `caps` is
     * client-supplied and unbounded, and nothing ever reads an unrecognised
     * token back. Persisted so it survives hibernation — `connect` is one-shot,
     * so a capability lost across a wake could never be re-announced and the
     * socket would quietly fall back to snapshots for the rest of its life.
     */
    pageDeltas?: boolean;

    /**
     * Live shape subscriptions registered on this socket, keyed by the
     * client-supplied subscription id. The partial-replication parallel to
     * {@link SocketAttachment.subs}: the poke protocol fans membership diffs to
     * these, while `subs` drives the legacy `data`/`delta` re-execution path.
     * Absent until the socket sends its first `shape_subscribe`.
     */
    shapes?: Record<string, ShapeSubscriptionQuery>;
    subs: Record<string, SubscriptionQuery>;

    /**
     * Verified user id resolved at upgrade (from `x-lunora-userid`), or absent
     * for an anonymous socket. Replayed to lifecycle hooks as `event.userId`.
     */
    userId?: string;

    /**
     * Topics this socket listens to for AnyCable-style whisper messages —
     * ephemeral peer broadcasts to co-subscribers WITHOUT any SQLite / CDC write
     * (typing indicators, cursors, presence pings). Persisted so the membership
     * survives hibernation; absent until the socket joins a topic.
     */
    whispers?: string[];
}

/**
 * A `shape_subscribe`'s resolved query: which `table` to replicate, the
 * identity-scoped `effectiveWhere` (the shape predicate AND-merged with the
 * table's RLS read base-where), the optional projected `columns` allow-list,
 * and whether the table is `.global()` (served by the latency-tiered poll path
 * rather than the CDC poke path). The codegen subclass's `resolveShape` builds
 * it under the socket's verified identity, so the membership query the poke
 * protocol runs is RLS-correct by construction.
 */
export interface ResolvedShape {
    columns?: ReadonlyArray<string>;
    effectiveWhere?: WhereInput;
    /** `true` when the shape's table is `.global()` (lives in D1, not this DO's SQLite) — no per-DO op-log to diff, so served by the poll path. */
    global?: boolean;
    table: string;
}

/**
 * Identity a subscription/shape query is executed under, threaded EXPLICITLY
 * into the codegen `resolveShape`/`buildCtx` rather than read from the shared,
 * per-request identity fields. The value passed is the socket's OWN verified
 * identity (stamped on the {@link SocketAttachment} at the WS upgrade from the
 * runtime-minted `x-lunora-userid`/`x-lunora-identity` headers the client can't
 * forge), passed BY VALUE so a deferred refresh or interleaved RPC can't clobber
 * it. An anonymous socket leaves both fields `undefined`, so an RLS/`ctx.auth`
 * query fails closed (empty/denied) rather than leaking another user's data.
 */
export interface SubscriptionIdentity {
    identity?: Record<string, unknown>;
    userId?: string;
}

/**
 * The socket surface the shard's subscription helpers actually touch.
 *
 * Deliberately structural and minimal so that BOTH a runtime `WebSocket` (what
 * the host hands to a message/close callback) and a `SocketHandle` from
 * `@lunora/platform` (what socket enumeration yields) satisfy it. Helpers typed
 * on this can be reached from either path, which is what lets the engine
 * migrate off the provider socket type one call site at a time instead of in a
 * single cut across every helper.
 *
 * Widening a helper from `WebSocket` to this is source-compatible: existing
 * callers still pass, and a subclass override declaring the narrower
 * `WebSocket` still type-checks under TypeScript's parameter bivariance.
 */
export interface ShardSocketLike {
    /** Outbound queue depth, when the transport reports it — drives delivery backpressure. */
    readonly bufferedAmount?: number;
    /** Close the socket. Absent on doubles that only assert on sends. */
    close?: (code?: number, reason?: string) => void;
    /** Read the hibernation attachment, when the transport persists one. */
    deserializeAttachment?: () => unknown;
    /** Send one frame. The only member every caller relies on. */
    send: (data: string) => void;
    /** Persist hibernation state, when the transport supports it. */
    serializeAttachment?: (value: unknown) => void;
}

export { type LifecycleDispatchInfo, type LifecycleEvent, type MutationDelta } from "./schema-types";
