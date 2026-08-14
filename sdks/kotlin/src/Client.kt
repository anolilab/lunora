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
     *
     * Minted PER INSTANCE, from the same generator that mints mutation ids. A
     * per-language constant would put every anonymous client in a process — and in
     * a fleet — into one namespace, so two unauthenticated callers passing the same
     * [SubmitOptions.mutationId] would collide on `(anon:<clientId>, <mutationId>)`
     * and the second write would short-circuit to the first one's cached result
     * without ever running.
     *
     * Pin a stable per-device value when the offline queue is DURABLE: a replayed
     * write namespaces under the id that ISSUED it (persisted on the record), and a
     * consumer that also wants pre-restart and post-restart writes to share one
     * namespace has to supply that continuity itself.
     */
    @Volatile var clientId: String = "client-${randomId()}",
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
     *
     * `internal` rather than private, along with the state below it, because the
     * write path lives in `Submit.kt` as extension functions and must take the same
     * monitor — a second lock over one logical operation is how a deadlock gets
     * built. Nothing outside this module sees them.
     */
    internal val lock = Any()

    internal var send: ((Map<String, Any?>) -> Unit)? = null
    internal val subscriptions = LinkedHashMap<String, Subscription>()
    private val shapes = LinkedHashMap<String, Shape>()
    private val pokes = LinkedHashMap<String, LinkedHashMap<String, MutableList<Map<String, Any?>>>>()
    private var nextId = 0
    private var nextShapeId = 0

    internal class Subscription(
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
        /**
         * Builds the `POST /_lunora/rpc` body. [shardKey] is omitted when null —
         * and when EMPTY.
         *
         * The runtime treats an empty string as a valid NAMED shard
         * (`idFromName("")` is its own Durable Object), while this client treats
         * absent and empty as the default shard throughout — see [sameShard],
         * which is what makes a `""` write drain on a null-shard flush and target
         * a null-shard subscription. Sending the key would split those two apart
         * at the boundary: the write would land on a shard neither the overlay nor
         * the flush ever refers to.
         */
        fun buildRpcBody(functionPath: String, args: WireValue?, shardKey: String? = null): Map<String, Any?> {
            val body = LinkedHashMap<String, Any?>()

            body["args"] = Wire.encode(args ?: WireValue.Obj(emptyList()))
            body["functionPath"] = functionPath
            namedShard(shardKey)?.let { body["shardKey"] = it }

            return body
        }

        /** The shard key as the wire carries it: null for the default shard, empty included. */
        internal fun namedShard(shardKey: String?): String? = shardKey?.takeIf { it.isNotEmpty() }

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
         *
         * A codec failure is the exception to that: it carries no code but is not
         * a blip either — the same arguments will fail to encode on every attempt,
         * so treating it as transient re-queues the write at the FRONT of the FIFO
         * forever. [flushOfflineQueue] settles such writes before the replay loop;
         * this arm is what keeps one surfacing from anywhere else terminal too.
         */
        fun isTransient(error: RuntimeException): Boolean = when (error) {
            is ApiException -> error.code in TRANSIENT_ERROR_CODES
            is OfflineException -> false
            is WireFormatException -> false
            else -> true
        }
    }

    /** The durable write queue backing [submit]. */
    var offlineQueue: OfflineQueue = OfflineQueue()

    internal var wasEverConnected = false
    internal var closed = false
    internal val settledListeners = mutableListOf<(MutationSettled) -> Unit>()

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
        val discarded = synchronized(lock) {
            closed = true
            send = null
            offlineQueue.clear()
        }

        reportDiscarded(discarded)
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
                        // `cursor` is OPTIONAL on data/delta frames, and a frame
                        // without one must LEAVE the tracked cursor where it is:
                        // nulling it strands every pending layer, because the
                        // tracked cursor is what a later commit cursor is compared
                        // against, so the write renders twice until some later
                        // cursored frame happens to land.
                        if (frame.containsKey("cursor")) entry.state.serverCursor = (frame["cursor"] as? Number)?.toLong()
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
    //
    // The write path itself (submit, the flush, the optimistic settle helpers)
    // lives in `Submit.kt` as extension functions over this class.

    /**
     * Restores writes persisted in a prior session; returns their shard keys.
     *
     * Open a socket for each returned key and flush it to replay them. A restored
     * write has no live caller and no settle handler of its own, so its verdict —
     * including an eviction the capacity cap makes during the restore — arrives
     * only through [onMutationSettled], stamped `hadAwaiter = false`.
     */
    fun hydrateOfflineQueue(): List<String?> {
        val hydrated = synchronized(lock) { offlineQueue.hydrate() }

        reportDiscarded(hydrated.evicted)

        return hydrated.shardKeys
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
            // Omitted when empty, for the same reason [buildRpcBody] omits it: the
            // runtime would open a socket against a shard named "" rather than the
            // default one this client resolves an empty key to.
            namedShard(shardKey)?.let { add("shard=" + URLEncoder.encode(it, StandardCharsets.UTF_8)) }
            token?.let { add("token=" + URLEncoder.encode(it, StandardCharsets.UTF_8)) }
        }

        if (params.isEmpty()) return endpoint

        return endpoint + (if (endpoint.contains('?')) "&" else "?") + params.joinToString("&")
    }

    private fun join(path: String): String = baseUrl.trimEnd('/') + path
}
