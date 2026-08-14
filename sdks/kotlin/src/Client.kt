package dev.lunora

import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/** The single endpoint every query/mutation/action posts to. */
const val RPC_PATH: String = "/_lunora/rpc"

/** The live-subscription endpoint. */
const val WS_PATH: String = "/_lunora/ws"

/**
 * Which RPC method a call dispatches to. Generated code emits these entries
 * rather than raw strings, so a typo in a target template is a compile error
 * instead of a read silently sent over the write path.
 */
enum class Verb { QUERY, MUTATION, ACTION }

/** A coded error from an RPC error envelope. */
class ApiException(val code: String, message: String, val data: WireValue? = null) : RuntimeException(message)

/** A subscription-scoped error the server pushed. */
data class SubscriptionError(val code: String?, val message: String)

/** One HTTP response: the status matters, see [Client.parseRpcResponse]. */
data class HttpResponse(val status: Int, val body: String)

/** What [Client.submit] did with a write. */
enum class MutationStatus { COMMITTED, QUEUED, REJECTED }

/**
 * What [Client.submit] did with a write.
 *
 * This is the deliberate divergence from `@lunora/client`, whose `mutation()`
 * returns a promise that stays PENDING until a queued write finally replays. A
 * pending promise is a fine thing to hold in a browser event loop and a bad thing
 * to hold on a pooled JVM thread, so the ports return the outcome immediately and
 * report the eventual verdict through `onSettled` (per write) or
 * [Client.onMutationSettled] (per client). A caller that must not report success
 * early checks [status].
 */
data class MutationOutcome(val status: MutationStatus, val mutationId: String, val value: WireValue? = null, val commitCursor: Long? = null)

/**
 * The terminal verdict on a queued write, once it replays.
 *
 * [hadAwaiter] is false for a write restored from durable storage: the caller that
 * submitted it is gone, so this event is the ONLY report it produces.
 */
data class MutationSettled(
    val mutationId: String,
    val status: MutationStatus,
    val value: WireValue? = null,
    val error: RuntimeException? = null,
    val hadAwaiter: Boolean = false,
)

/** What one [Client.flushOfflineQueue] pass achieved. */
class FlushReport {
    /** The ids the server accepted. */
    val committed = mutableListOf<String>()

    /** The ids dropped on a verdict, an identity change, or a stale precondition. */
    val rejected = mutableListOf<String>()

    /** The ids left queued for the next reconnect. */
    val requeued = mutableListOf<String>()

    /** The ids dropped because their precondition no longer held. */
    val conflicted = mutableListOf<String>()
}

/** One offline-capable write. */
class SubmitOptions(val functionPath: String, val args: WireValue? = null) {
    /** Null routes to the default shard. */
    var shardKey: String? = null

    /** The idempotency key; minted when null. */
    var mutationId: String? = null

    /**
     * The single-query shortcut: the transform is layered onto every subscription
     * registered under the SAME (functionPath, args, shardKey) as this write,
     * mirroring `@lunora/client`'s per-call `optimistic`.
     */
    var optimistic: ((WireValue) -> WireValue)? = null

    /**
     * The general form — it receives an [Optimistic.LocalStore] and may patch any
     * number of subscribed queries. Both settle together, against one cursor.
     */
    var optimisticUpdate: ((Optimistic.LocalStore, WireValue?) -> Unit)? = null

    /**
     * Re-evaluated just before a QUEUED write replays; false drops it rather than
     * replaying a write that can only fail.
     */
    var precondition: (() -> Boolean)? = null

    /** Reports the eventual verdict on a queued write. */
    var onSettled: ((MutationSettled) -> Unit)? = null
}

/**
 * A Lunora deployment client.
 *
 * The HTTP poster and the socket frame sender are injected rather than assumed,
 * so the conformance suite runs with no network and a consumer keeps its own
 * HTTP stack, timeouts and WebSocket library instead of inheriting ours.
 */
class Client(
    private val baseUrl: String,
    private val post: ((String, Map<String, String>, ByteArray) -> HttpResponse)? = null,
    @Volatile var authToken: String? = null,
    /**
     * Identifies this client to the shard. It rides every write that carries an
     * idempotency key, because an anonymous caller has no server-minted user id to
     * namespace its de-duplication rows by.
     */
    @Volatile var clientId: String = "kotlin-client",
    /**
     * An opaque, stable, NON-SECRET stamp for whoever is signed in — a user id,
     * not a bearer token. It is persisted alongside every queued write and
     * re-checked before that write replays, so a restart cannot push one user's
     * queued writes as another. Null means signed out, which is itself an identity
     * a write can be stamped with.
     */
    @Volatile var identity: String? = null,
) {
    /**
     * Guards every field below, and the `cursor`/`epoch`/row state hanging off
     * [Subscription] and [Shape].
     *
     * Two threads normally drive this client: a socket reader calling
     * [handleFrame] and the app thread calling [subscribe]. A [LinkedHashMap]
     * resized from both corrupts silently — its Go equivalent is what made this
     * visible, because Go answers the same race with an unrecoverable fatal error
     * rather than a wrong answer.
     *
     * Frames and user callbacks are dispatched OUTSIDE the lock: a sender writes a
     * socket the consumer owns, and holding the lock across a callback would let
     * one slow consumer stall the socket reader.
     */
    private val lock = Any()

    private var send: ((Map<String, Any?>) -> Unit)? = null
    private val subscriptions = LinkedHashMap<String, Subscription>()
    private val shapes = LinkedHashMap<String, Shape>()
    private val pokes = LinkedHashMap<String, LinkedHashMap<String, MutableList<Map<String, Any?>>>>()
    private var nextId = 0
    private var nextShapeId = 0

    private class Subscription(
        val functionPath: String,
        val args: WireValue,
        val shardKey: String?,
        val onData: ((WireValue) -> Unit)?,
        val onError: ((SubscriptionError) -> Unit)?,
    ) {
        var cursor: Any? = null
        var epoch: Any? = null

        /**
         * The stable wire key of [args], computed once at subscribe time so a
         * write's optimistic targeting can compare without re-serialising every
         * subscription's args on every write.
         */
        val argsKey: String = Key.stableWireKey(args)

        /** The displayed value and its optimistic overlays. See [Optimistic]. */
        val state = Optimistic.State().also { state ->
            onData?.let { state.callbacks.add(it) }
        }
    }

    private class Shape(val onRows: ((List<WireValue>) -> Unit)?, val onError: ((SubscriptionError) -> Unit)?) {
        val rows = LinkedHashMap<String, WireValue>()
        val order = mutableListOf<String>()
        var checkpoint: Any? = null
        var epoch: Any? = null
    }

    companion object {
        /** Builds the `POST /_lunora/rpc` body. [shardKey] is omitted when null. */
        fun buildRpcBody(functionPath: String, args: WireValue?, shardKey: String? = null): Map<String, Any?> {
            val body = LinkedHashMap<String, Any?>()

            body["args"] = Wire.encode(args ?: WireValue.Obj(emptyList()))
            body["functionPath"] = functionPath
            shardKey?.let { body["shardKey"] = it }

            return body
        }

        /**
         * Returns the decoded result, or throws [ApiException].
         *
         * [status] is required for correctness, not diagnostics:
         * `protocol/README.md` §4.2 says a non-2xx whose body carries no `error`
         * envelope surfaces as an INTERNAL transport error. Without it a 502
         * with body `{"message":"…"}` returns null and throws nothing — the
         * caller believes its mutation committed.
         */
        fun parseRpcResponse(body: Map<*, *>, status: Int = 200): WireValue {
            val envelope = body["error"]

            if (envelope is Map<*, *>) {
                val data = envelope["data"]?.let { Wire.decode(it) }

                throw ApiException(
                    envelope["code"] as? String ?: "INTERNAL",
                    envelope["message"] as? String ?: "request failed",
                    data,
                )
            }

            if (status !in 200..299) {
                throw ApiException("INTERNAL", "HTTP $status without an error envelope")
            }

            return Wire.decode(body["result"])
        }

        fun buildConnectFrame(clientId: String? = null, context: Map<String, Any?>? = null): Map<String, Any?> {
            val frame = LinkedHashMap<String, Any?>()

            frame["id"] = "connect"
            frame["type"] = "connect"
            clientId?.let { frame["clientId"] = it }
            context?.let { frame["context"] = it }

            return frame
        }

        fun buildSubscribeFrame(
            id: String,
            functionPath: String,
            args: WireValue?,
            table: String? = null,
            sinceSeq: Any? = null,
            sinceEpoch: Any? = null,
        ): Map<String, Any?> {
            val query = LinkedHashMap<String, Any?>()

            query["args"] = Wire.encode(args ?: WireValue.Obj(emptyList()))
            query["functionPath"] = functionPath
            query["table"] = table ?: functionPath
            sinceSeq?.let { query["sinceSeq"] = it }
            sinceEpoch?.let { query["sinceEpoch"] = it }

            return linkedMapOf("id" to id, "query" to query, "type" to "subscribe")
        }

        fun buildUnsubscribeFrame(id: String): Map<String, Any?> = linkedMapOf("id" to id, "type" to "unsubscribe")

        fun buildShapeSubscribeFrame(
            id: String,
            name: String,
            args: WireValue? = null,
            sinceCheckpoint: Any? = null,
            sinceEpoch: Any? = null,
        ): Map<String, Any?> {
            val shape = LinkedHashMap<String, Any?>()

            shape["name"] = name
            args?.let { shape["args"] = Wire.encode(it) }

            val frame = linkedMapOf<String, Any?>("id" to id, "shape" to shape, "type" to "shape_subscribe")

            sinceCheckpoint?.let { frame["sinceCheckpoint"] = it }
            sinceEpoch?.let { frame["sinceEpoch"] = it }

            return frame
        }

        fun buildShapeUnsubscribeFrame(id: String): Map<String, Any?> = linkedMapOf("id" to id, "type" to "shape_unsubscribe")

        /**
         * The CDC cursor a write committed at, echoed on a mutation's response.
         *
         * Null when the call was a read, or when the shard has CDC off — the
         * degraded case the optimistic engine falls back to one-shot behaviour for.
         */
        fun parseCommitCursor(body: Map<*, *>): Long? = (body["commitCursor"] as? Number)?.toLong()

        /**
         * Whether a failed replay may be retried rather than dropped.
         *
         * A raw exception from the injected poster is the network, not the server:
         * no verdict was reached, so the write is still good.
         */
        fun isTransient(error: RuntimeException): Boolean = when (error) {
            is ApiException -> error.code in TRANSIENT_ERROR_CODES
            is OfflineException -> false
            else -> true
        }
    }

    /** The durable write queue backing [submit]. */
    var offlineQueue: OfflineQueue = OfflineQueue()

    private var wasEverConnected = false
    private var closed = false
    private val settledListeners = mutableListOf<(MutationSettled) -> Unit>()

    /**
     * Registers the sender used for subscription frames. Call once the socket is
     * open.
     *
     * It also latches "has connected at least once", which is what the write queue
     * gates on: a write made before the FIRST connect fails fast by default, so a
     * misconfigured endpoint surfaces on the first write instead of silently
     * filling a queue that will never flush.
     */
    fun attachSocket(sender: (Map<String, Any?>) -> Unit) {
        synchronized(lock) {
            send = sender
            wasEverConnected = true
        }
    }

    /** Forgets the sender, so subsequent writes queue rather than fail. */
    fun detachSocket() {
        synchronized(lock) { send = null }
    }

    /** Whether a socket is currently attached. */
    fun online(): Boolean = synchronized(lock) { send != null }

    /** How many writes are waiting for the socket. */
    fun pendingMutationCount(): Int = synchronized(lock) { offlineQueue.size }

    /**
     * Observes every queued write's terminal verdict; returns an unsubscribe.
     *
     * This is the ONLY report a write restored from durable storage produces — its
     * original caller did not survive the restart.
     */
    fun onMutationSettled(listener: (MutationSettled) -> Unit): () -> Unit {
        synchronized(lock) { settledListeners.add(listener) }

        return { synchronized(lock) { settledListeners.remove(listener) } }
    }

    /**
     * Rejects every queued write so no caller waits on a dead client. Durable
     * storage is untouched: the next session restores those writes.
     */
    fun close() {
        val queue = synchronized(lock) {
            closed = true
            send = null
            offlineQueue
        }

        queue.clear()
    }

    fun query(functionPath: String, args: WireValue? = null, shardKey: String? = null): WireValue = rpc(functionPath, args, shardKey, null)

    fun mutation(functionPath: String, args: WireValue? = null, shardKey: String? = null, mutationId: String? = null): WireValue =
        rpc(functionPath, args, shardKey, mutationId)

    /**
     * Same envelope as a mutation, but never an idempotency key: an action
     * performs external side effects and is not replayed against the shard, so
     * claiming mutation-style de-duplication for it would be a lie.
     */
    fun action(functionPath: String, args: WireValue? = null, shardKey: String? = null): WireValue = rpc(functionPath, args, shardKey, null)

    /** Dispatches on [verb], which is what lets generated code stay uniform. */
    fun call(verb: Verb, functionPath: String, args: WireValue? = null, shardKey: String? = null): WireValue = when (verb) {
        Verb.QUERY -> query(functionPath, args, shardKey)
        Verb.ACTION -> action(functionPath, args, shardKey)
        Verb.MUTATION -> mutation(functionPath, args, shardKey)
    }

    private fun rpc(functionPath: String, args: WireValue?, shardKey: String?, mutationId: String?): WireValue =
        rpcFull(functionPath, args, shardKey, mutationId).result

    /** One RPC round-trip: the decoded result plus the commit cursor the response echoed. */
    data class RpcReply(val result: WireValue, val commitCursor: Long?)

    /**
     * One round-trip, keeping the echoed `commitCursor`.
     *
     * The cursor is what gates an optimistic overlay's removal, so it has to
     * survive the call rather than be discarded by [parseRpcResponse].
     * [issuingClientId] overrides this session's, so a replayed write namespaces
     * server-side under the id that ISSUED it.
     */
    internal fun rpcFull(functionPath: String, args: WireValue?, shardKey: String?, mutationId: String?, issuingClientId: String? = null): RpcReply {
        val poster = post ?: throw ApiException("INTERNAL", "no HTTP poster configured")
        val headers = LinkedHashMap<String, String>()

        headers["content-type"] = "application/json"
        authToken?.let { headers["authorization"] = "Bearer $it" }

        if (mutationId != null) {
            headers["x-lunora-mutation-id"] = mutationId
            // Rides WITH the idempotency key, never alone. An anonymous caller has
            // no server-minted user id, so the shard namespaces its de-duplication
            // rows by this client id instead; without one every anonymous client
            // shares a single key space and a colliding mutation id suppresses
            // another client's write.
            headers["x-lunora-client-id"] = issuingClientId ?: clientId
        }

        val payload = Json.write(buildRpcBody(functionPath, args, shardKey))
        val response = poster(join(RPC_PATH), headers, payload.toByteArray(StandardCharsets.UTF_8))
        val body = Json.parse(response.body) as Map<*, *>

        return RpcReply(parseRpcResponse(body, response.status), parseCommitCursor(body))
    }

    /**
     * Opens a live query.
     *
     * [shardKey] does NOT ride the subscribe frame: the protocol selects a
     * shard per SOCKET, via the `?shard=` parameter [wsUrl] builds. It is
     * accepted so the generated surface is identical across languages, and is
     * otherwise unused — this client holds one socket, so it must already be
     * the shard that socket was opened against.
     */
    fun subscribe(
        functionPath: String,
        args: WireValue?,
        onData: ((WireValue) -> Unit)?,
        onError: ((SubscriptionError) -> Unit)? = null,
        shardKey: String? = null,
    ): () -> Unit {
        val (id, socket) = synchronized(lock) {
            nextId++

            val id = "sub_$nextId"

            subscriptions[id] = Subscription(functionPath, args ?: WireValue.Obj(emptyList()), shardKey, onData, onError)

            id to send
        }

        socket?.invoke(buildSubscribeFrame(id, functionPath, args))

        return {
            val current = synchronized(lock) {
                subscriptions.remove(id)
                send
            }

            current?.invoke(buildUnsubscribeFrame(id))
        }
    }

    /**
     * Opens a partially-replicated keyed view. [onRows] fires once per applied
     * poke with the view's full contents, in insertion order.
     */
    fun subscribeShape(
        name: String,
        args: WireValue? = null,
        onRows: ((List<WireValue>) -> Unit)?,
        onError: ((SubscriptionError) -> Unit)? = null,
    ): () -> Unit {
        val (id, socket) = synchronized(lock) {
            nextShapeId++

            val id = "shape_$nextShapeId"

            shapes[id] = Shape(onRows, onError)

            id to send
        }

        socket?.invoke(buildShapeSubscribeFrame(id, name, args))

        return {
            val current = synchronized(lock) {
                shapes.remove(id)
                send
            }

            current?.invoke(buildShapeUnsubscribeFrame(id))
        }
    }

    /** Re-subscribes everything after a reconnect, carrying each resume cursor. */
    fun resendSubscriptions() {
        // The frames are BUILT under the lock, not just the iteration: each one
        // reads `cursor`/`epoch`, which the frame handler writes. Snapshotting the
        // entries and reading their cursors afterwards resends a torn one.
        val (sender, frames) = synchronized(lock) {
            val sender = send
            val frames =
                if (sender == null) {
                    emptyList()
                } else {
                    subscriptions.map { (id, entry) ->
                        buildSubscribeFrame(id, entry.functionPath, entry.args, null, entry.cursor, entry.epoch)
                    }
                }

            sender to frames
        }

        if (sender == null) return

        for (frame in frames) sender(frame)
    }

    /**
     * Applies one server frame and returns its type. Unknown types are ignored,
     * per the protocol's forward-compatibility rule.
     */
    fun handleFrame(raw: String): String? {
        if (raw == "lunora-ping" || raw == "lunora-pong") return null

        val frame = try {
            Json.parse(raw) as? Map<*, *> ?: return null
        } catch (error: IllegalArgumentException) {
            // Non-JSON frames are ignored by the client parser, not fatal.
            return null
        }

        val kind = frame["type"] as? String ?: ""
        val id = frame["id"] as? String ?: ""

        // Each branch resolves the subscription UNDER the lock and hands the
        // callback back out, rather than looking `entry` up once up here: the app
        // thread can unsubscribe in between, and `advance` writes the very state
        // the lock exists to protect.
        when (kind) {
            "data", "delta" -> {
                val payload = frame["data"] ?: frame["delta"]
                val value = Wire.decode(payload)
                val deferred = mutableListOf<() -> Unit>()

                synchronized(lock) {
                    subscriptions[id]?.let { entry ->
                        advance(entry, frame)
                        entry.state.serverBase = value
                        entry.state.serverCursor = (frame["cursor"] as? Number)?.toLong()
                        // Drop the overlays this frame has caught up with, then
                        // RE-FOLD the rest onto the new authoritative base rather
                        // than clobbering them: a still-queued write's predicted
                        // value has to survive an unrelated delta on this query.
                        Optimistic.dropConfirmedLayers(entry.state, entry.state.serverCursor)
                        Optimistic.notifySubscription(
                            entry.state,
                            Optimistic.fold(entry.state.serverBase, entry.state.layers),
                            deferred,
                        )
                    }
                }

                for (call in deferred) call()
            }
            "resume", "settled" -> synchronized(lock) { subscriptions[id]?.let { advance(it, frame) } }
            "error" -> {
                val envelope = frame["error"] as? Map<*, *> ?: emptyMap<String, Any?>()
                val error = SubscriptionError(
                    envelope["code"] as? String,
                    frame["message"] as? String ?: envelope["message"] as? String ?: "subscription error",
                )
                val handlers = synchronized(lock) { listOfNotNull(subscriptions[id]?.onError, shapes[id]?.onError) }

                for (handler in handlers) handler(error)
            }
            "complete" -> synchronized(lock) { subscriptions.remove(id) }
            "pokeStart" -> synchronized(lock) { pokes[frame["pokeId"].toString()] = LinkedHashMap() }
            "pokePart" -> bufferPokePart(frame)
            "pokeEnd" -> applyPoke(frame)
        }

        return kind
    }

    // --- Offline-capable writes ---------------------------------------------

    /**
     * Writes, sending it now or queueing it until the socket is back.
     *
     * It returns as soon as the write is either committed or durably queued. A
     * queued write's optimistic overlay stays displayed until the replay's commit
     * cursor is reached by a server frame; a failed one rolls back.
     */
    fun submit(options: SubmitOptions): MutationOutcome {
        val deferred = mutableListOf<() -> Unit>()
        val writeId = options.mutationId ?: randomId()
        val settlers: LayerSettlers
        val queueIt: Boolean
        val stamp: String?
        val queue: OfflineQueue
        val issuingClientId: String

        synchronized(lock) {
            if (closed) throw OfflineException(CLIENT_CLOSED, "client is closed")

            settlers = applyOptimistic(options, deferred)
            queueIt = send == null && (wasEverConnected || offlineQueue.queueBeforeFirstConnect)
            stamp = identity
            queue = offlineQueue
            issuingClientId = clientId
        }

        for (call in deferred) call()

        if (queueIt) {
            enqueueWrite(queue, options, writeId, issuingClientId, stamp, settlers)

            return MutationOutcome(MutationStatus.QUEUED, writeId)
        }

        val reply = try {
            rpcFull(options.functionPath, options.args, options.shardKey, writeId)
        } catch (error: RuntimeException) {
            settleLayers(emptyList(), settlers.rollbacks, null)

            throw error
        }

        // Confirmed against the write's COMMITTED cursor, so the overlay drops when
        // (or once) a frame at that cursor lands — never on this call's return,
        // which races the socket broadcast.
        settleLayers(settlers.confirms, emptyList(), reply.commitCursor)

        return MutationOutcome(MutationStatus.COMMITTED, writeId, reply.result, reply.commitCursor)
    }

    /**
     * Restores writes persisted in a prior session; returns their shard keys.
     *
     * Open a socket for each returned key and flush it to replay them. A restored
     * write has no live caller, so its verdict arrives only through
     * [onMutationSettled].
     */
    fun hydrateOfflineQueue(): List<String?> {
        val queue = synchronized(lock) { offlineQueue }
        val restored = queue.hydrate()

        for (item in queue.items()) {
            if (item.resolve == null && item.reject == null) attachHydratedSettlers(item)
        }

        return restored
    }

    /**
     * Replays one shard's queued writes, in order, over HTTP. Call it when that
     * shard's socket comes back.
     *
     * Each write replays under its own idempotency key, so one the server already
     * committed is de-duplicated rather than applied twice. Per write: success
     * confirms its optimistic overlay against the ECHOED commit cursor; a coded
     * verdict is terminal; a transient failure — a raw transport error, or one of
     * [TRANSIENT_ERROR_CODES] — stops the flush and re-queues that write and every
     * unreplayed one, in order, for the next attempt.
     */
    fun flushOfflineQueue(shardKey: String? = null): FlushReport {
        val report = FlushReport()
        val queue: OfflineQueue
        val current: String?

        synchronized(lock) {
            queue = offlineQueue
            current = identity
        }

        for (item in queue.drainConflict()) {
            queue.unpersist(item.id)
            report.conflicted.add(item.id)
            report.rejected.add(item.id)
        }

        val drained = queue.drain { it.shardKey == shardKey }

        if (drained.isEmpty()) return report

        // Gated against ONE identity snapshot: a flush is a single authenticated
        // burst, so every write in it necessarily runs under one identity.
        val sendable = mutableListOf<QueuedMutation>()

        for (item in drained) {
            if (identityAllowsReplay(item.identity, current)) {
                sendable.add(item)

                continue
            }

            queue.unpersist(item.id)
            item.reject?.invoke(
                OfflineException(OFFLINE_IDENTITY_CHANGED, "offline mutation skipped: auth identity changed before replay"),
            )
            report.rejected.add(item.id)
        }

        replay(queue, sendable, report)

        return report
    }

    private fun replay(queue: OfflineQueue, sendable: List<QueuedMutation>, report: FlushReport) {
        for ((index, item) in sendable.withIndex()) {
            val reply = try {
                rpcFull(item.functionPath, item.args, item.shardKey, item.id, item.clientId)
            } catch (error: RuntimeException) {
                if (!isTransient(error)) {
                    queue.unpersist(item.id)
                    item.reject?.invoke(error)
                    report.rejected.add(item.id)

                    continue
                }

                // Nothing after this write may go out ahead of it: replaying out of
                // order is how a durable queue corrupts the data it was protecting.
                val pending = sendable.subList(index, sendable.size).toList()

                queue.requeue(pending)
                pending.mapTo(report.requeued) { it.id }

                return
            }

            queue.unpersist(item.id)
            // The overlay is confirmed BEFORE the caller is told, so the gapless
            // drop is already in place when the confirming frame lands.
            item.onCommit?.invoke(reply.commitCursor)
            item.resolve?.invoke(reply.result)
            report.committed.add(item.id)
        }
    }

    /** The settle closures one write's optimistic layers produced. */
    private class LayerSettlers(val confirms: List<(Long?, MutableList<() -> Unit>) -> Unit>, val rollbacks: List<(MutableList<() -> Unit>) -> Unit>)

    /** Registers both optimistic APIs' layers. Runs with the monitor held. */
    private fun applyOptimistic(options: SubmitOptions, deferred: MutableList<() -> Unit>): LayerSettlers {
        val confirms = mutableListOf<(Long?, MutableList<() -> Unit>) -> Unit>()
        val rollbacks = mutableListOf<(MutableList<() -> Unit>) -> Unit>()

        options.optimistic?.let { transform ->
            for (entry in findSubscriptions(options.functionPath, options.args, options.shardKey)) {
                val handle = Optimistic.applyLayer(entry.state, transform, deferred) ?: continue

                confirms.add(handle::confirm)
                rollbacks.add(handle::rollback)
            }
        }

        val update = options.optimisticUpdate ?: return LayerSettlers(confirms, rollbacks)
        val store = Optimistic.LocalStore(
            { path, args -> findSubscriptions(path, args, options.shardKey).map { it.state } },
            { path -> matchingQueries(path, options.shardKey) },
            deferred,
        )

        try {
            update(store, options.args)
            confirms.addAll(store.confirms)
            rollbacks.addAll(store.rollbacks)
        } catch (error: RuntimeException) {
            // A throwing update unwinds only its OWN writes, so the cache is left
            // exactly as it was found, and the write itself proceeds.
            Optimistic.rollbackAll(store.rollbacks, deferred)
        }

        return LayerSettlers(confirms, rollbacks)
    }

    /**
     * The live subscriptions registered under exactly this (path, args, shard).
     *
     * A linear scan, unlike `@lunora/client`'s keyed registry, and deliberately:
     * this client does not de-duplicate subscriptions, so several can share one
     * triple and all of them must receive the overlay. The scan is over a handful
     * of entries on the write path, never the frame path.
     */
    private fun findSubscriptions(functionPath: String, args: WireValue?, shardKey: String?): List<Subscription> {
        val argsKey = Key.stableWireKey(args ?: WireValue.Obj(emptyList()))

        return subscriptions.values.filter { it.functionPath == functionPath && it.argsKey == argsKey && it.shardKey == shardKey }
    }

    private fun matchingQueries(functionPath: String, shardKey: String?): List<Optimistic.QueryEntry> = subscriptions.values
        .filter { it.functionPath == functionPath && it.shardKey == shardKey }
        .map { Optimistic.QueryEntry(it.args, it.state.lastValue) }

    private fun enqueueWrite(queue: OfflineQueue, options: SubmitOptions, writeId: String, issuingClientId: String, stamp: String?, settlers: LayerSettlers) {
        val entry = QueuedMutation(writeId, options.functionPath, options.args ?: WireValue.Obj(emptyList()), options.shardKey)

        entry.clientId = issuingClientId
        // Bound at enqueue time, so the write can only ever replay as whoever made it.
        entry.identity = Identity.stamp(stamp)
        entry.liveAwaiter = true
        entry.precondition = options.precondition
        entry.onCommit = { cursor -> settleLayers(settlers.confirms, emptyList(), cursor) }
        entry.resolve = { value ->
            emitSettled(MutationSettled(writeId, MutationStatus.COMMITTED, value, null, true), options.onSettled)
        }
        entry.reject = { error ->
            settleLayers(emptyList(), settlers.rollbacks, null)
            emitSettled(MutationSettled(writeId, MutationStatus.REJECTED, null, error, true), options.onSettled)
        }

        synchronized(lock) { queue.enqueue(entry) }
    }

    /** Gives a restored write the observer-only settlers it lost in the restart. */
    private fun attachHydratedSettlers(item: QueuedMutation) {
        val id = item.id

        item.liveAwaiter = false
        item.resolve = { value -> emitSettled(MutationSettled(id, MutationStatus.COMMITTED, value), null) }
        item.reject = { error -> emitSettled(MutationSettled(id, MutationStatus.REJECTED, null, error), null) }
    }

    /**
     * Runs a write's confirms or rollbacks under the monitor and delivers the
     * resulting notifications outside it.
     */
    private fun settleLayers(
        confirms: List<(Long?, MutableList<() -> Unit>) -> Unit>,
        rollbacks: List<(MutableList<() -> Unit>) -> Unit>,
        commitCursor: Long?,
    ) {
        val deferred = mutableListOf<() -> Unit>()

        synchronized(lock) {
            Optimistic.confirmAll(confirms, commitCursor, deferred)
            Optimistic.rollbackAll(rollbacks, deferred)
        }

        for (call in deferred) call()
    }

    private fun emitSettled(event: MutationSettled, onSettled: ((MutationSettled) -> Unit)?) {
        val listeners = mutableListOf<(MutationSettled) -> Unit>()

        onSettled?.let { listeners.add(it) }
        synchronized(lock) { listeners.addAll(settledListeners) }

        for (listener in listeners) {
            try {
                listener(event)
            } catch (error: RuntimeException) {
                // A write's terminal verdict is the only report a restored write
                // ever produces, so one bad observer must not stop the rest.
            }
        }
    }

    private fun advance(entry: Subscription, frame: Map<*, *>) {
        if (frame.containsKey("cursor")) entry.cursor = frame["cursor"]
        if (frame.containsKey("epoch")) entry.epoch = frame["epoch"]
    }

    /**
     * Parts buffer until `pokeEnd`: a poke is an atomic batch, so applying them
     * as they arrive would expose a torn view, and a socket dropping mid-poke
     * would leave it permanently half-applied.
     */
    private fun bufferPokePart(frame: Map<*, *>) {
        val operations = (frame["rowsPatch"] as? List<*>)?.filterIsInstance<Map<String, Any?>>() ?: emptyList()

        synchronized(lock) {
            // A part for an unknown poke is dropped: without its pokeStart there
            // is no batch to join, and guessing would apply a fragment of one.
            val buffer = pokes[frame["pokeId"].toString()] ?: return

            buffer.getOrPut(frame["shapeId"].toString()) { mutableListOf() }.addAll(operations)
        }
    }

    private fun applyPoke(frame: Map<*, *>) {
        // The view is mutated under the lock; `onRows` fires after it is released,
        // with the row snapshot taken while still holding it — so a callback sees
        // one consistent poke even if the next one lands mid-delivery.
        val deliveries = synchronized(lock) {
            val buffer = pokes.remove(frame["pokeId"].toString()) ?: return
            val pending = mutableListOf<Pair<(List<WireValue>) -> Unit, List<WireValue>>>()

            for ((shapeId, operations) in buffer) {
                val shape = shapes[shapeId] ?: continue

                for (operation in operations) {
                    val key = operation["key"]?.toString() ?: continue

                    if (operation["op"] == "delete") {
                        if (shape.rows.remove(key) != null) shape.order.remove(key)

                        continue
                    }

                    // A value-less upsert is membership-only; it must not blank an
                    // existing row.
                    val value = operation["value"] ?: continue

                    if (!shape.rows.containsKey(key)) shape.order.add(key)

                    shape.rows[key] = Wire.decode(value)
                }

                if (frame.containsKey("checkpoint")) shape.checkpoint = frame["checkpoint"]
                if (frame.containsKey("epoch")) shape.epoch = frame["epoch"]

                shape.onRows?.let { onRows -> pending.add(onRows to shape.order.mapNotNull { key -> shape.rows[key] }) }
            }

            pending
        }

        for ((onRows, rows) in deliveries) onRows(rows)
    }

    /**
     * The socket URL: the origin with its scheme swapped, plus the shard and
     * credential query parameters when present.
     */
    fun wsUrl(shardKey: String? = null, token: String? = null): String {
        var endpoint = join(WS_PATH)

        endpoint = when {
            endpoint.startsWith("https://") -> "wss://" + endpoint.removePrefix("https://")
            endpoint.startsWith("http://") -> "ws://" + endpoint.removePrefix("http://")
            else -> endpoint
        }

        val params = buildList {
            shardKey?.let { add("shard=" + URLEncoder.encode(it, StandardCharsets.UTF_8)) }
            token?.let { add("token=" + URLEncoder.encode(it, StandardCharsets.UTF_8)) }
        }

        if (params.isEmpty()) return endpoint

        return endpoint + (if (endpoint.contains('?')) "&" else "?") + params.joinToString("&")
    }

    private fun join(path: String): String = baseUrl.trimEnd('/') + path
}
