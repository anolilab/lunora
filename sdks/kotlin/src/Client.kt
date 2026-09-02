package dev.lunora

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean

/** The single endpoint every query/mutation/action posts to. */
const val RPC_PATH: String = "/_lunora/rpc"

/**
 * Where a flush of two or more queued writes goes: one hop carrying independent
 * calls.
 */
const val RPC_BATCH_PATH: String = "/_lunora/rpc-batch"

/** The live-subscription endpoint. */
const val WS_PATH: String = "/_lunora/ws"

/**
 * How many un-applied poke buffers to retain before evicting the oldest. A
 * buffer is only released at its `pokeEnd`; a socket that drops mid-poke never
 * sends one, so without a bound the abandoned buffers accumulate for the life of
 * the client — one per reconnect, and unbounded against a peer that opens pokes
 * it never closes. Concurrent in-flight pokes number in the low single digits,
 * so this is far above any legitimate working set.
 */
const val MAX_PENDING_POKES: Int = 64

/**
 * Which RPC method a call dispatches to. Generated code emits these entries
 * rather than raw strings, so a typo in a target template is a compile error
 * instead of a read silently sent over the write path.
 */
enum class Verb { QUERY, MUTATION, ACTION }

/**
 * A coded error from an RPC error envelope.
 *
 * [transient] says the call never reached a verdict — a 5xx, or a non-2xx
 * carrying no envelope at all (an edge error page, a WAF block, a proxy). It is
 * set where the HTTP STATUS is still in scope, because nothing downstream can
 * recover it: [code] alone cannot tell a `BAD_REQUEST` the function returned from
 * the `INTERNAL` this client synthesises for a body that never came from one.
 */
class ApiException(val code: String, message: String, val data: WireValue? = null, val transient: Boolean = false) : RuntimeException(message)

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
    private val pokes = LinkedHashMap<String, PokeBuffer>()
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

    /**
     * One in-flight poke: the row ops buffered per shape, plus the shapes whose
     * part carried `reset: true`.
     *
     * The flag is tracked per SHAPE, not per poke: one poke can re-seed one shape
     * while delivering an ordinary diff to another on the same socket.
     */
    private class PokeBuffer {
        val parts = LinkedHashMap<String, MutableList<Map<String, Any?>>>()

        /**
         * Shapes whose `rowsPatch` is the shape's COMPLETE membership rather than a
         * diff, so the view has to be dropped before it is applied. A seed carries
         * inserts only, so merging one leaves every row that left the shape while
         * the socket was down on screen for the life of the client.
         */
        val resets = mutableSetOf<String>()
    }

    /**
     * [name] and [args] are KEPT, not merely used to build the first frame: a
     * reconnect has to re-send `shape_subscribe` for every live shape, and a
     * registry holding only the callbacks cannot build that frame at all.
     */
    private class Shape(val name: String, val args: WireValue?, val onRows: ((List<WireValue>) -> Unit)?, val onError: ((SubscriptionError) -> Unit)?) {
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
        fun parseRpcResponse(body: Map<*, *>, status: Int): WireValue {
            val envelope = body["error"]

            if (envelope is Map<*, *>) {
                val data = envelope["data"]?.let { Wire.decode(it) }

                throw ApiException(
                    envelope["code"] as? String ?: "INTERNAL",
                    envelope["message"] as? String ?: "request failed",
                    data,
                    // A 5xx is the shard or the edge failing UNDER the call, not a
                    // verdict on it, so a queued write replayed under the same
                    // idempotency key is still good. See [isTransient].
                    status >= 500,
                )
            }

            if (status !in 200..299) {
                // No envelope at all, so this body never came from a Lunora
                // function: an edge error page, a WAF block, a proxy. Nothing
                // reached the shard, which makes it transport rather than a
                // verdict — the batch path already classified the identical
                // response that way, and a lone queued write must not be dropped
                // for being alone.
                throw ApiException("INTERNAL", "HTTP $status without an error envelope", transient = true)
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
         * Three ways in: [ApiException.transient], set from the HTTP status where
         * a code cannot say (a 5xx, or a non-2xx with no envelope at all); a shard
         * code; or a rate limit, which is "not now" rather than "no" and is the
         * one verdict a durable queue must never honour — the write is valid and
         * the server asked for it later, so dropping it loses data for being
         * punctual.
         *
         * A raw exception from the injected poster is the network, not the server:
         * no verdict was reached, so the write is still good. `Exception`, not
         * `RuntimeException`: a poster is a bare function type with no exception
         * discipline, and every realistic one (HttpURLConnection, OkHttp) throws
         * a checked `IOException` on the dropped connection this loop exists for.
         *
         * A codec failure is the exception to that: it carries no code but is not
         * a blip either — the same arguments will fail to encode on every attempt,
         * so treating it as transient re-queues the write at the FRONT of the FIFO
         * forever. [flushOfflineQueue] settles such writes before the replay loop;
         * this arm is what keeps one surfacing from anywhere else terminal too.
         */
        fun isTransient(error: Exception): Boolean = when (error) {
            is ApiException -> error.transient || error.code in TRANSIENT_ERROR_CODES || error.code in RATE_LIMIT_ERROR_CODES
            is OfflineException -> false
            is WireFormatException -> false
            else -> true
        }
    }

    /** The durable write queue backing [submit]. */
    var offlineQueue: OfflineQueue = OfflineQueue()

    internal var wasEverConnected = false
    internal var closed = false

    /**
     * The `System.nanoTime()` reading before which a flush is a no-op, set when a
     * replay came back rate-limited and the envelope named a delay. Monotonic, so
     * a wall-clock adjustment cannot strand a queue for hours.
     */
    internal var flushNotBefore = 0L
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
     * POSTs one `/_lunora/rpc-batch` chunk, returning the parsed body.
     *
     * No `x-lunora-mutation-id` on the request: a batch is ONE transport hop
     * carrying independent calls, so each entry carries its own idempotency key
     * and client id in the body. A single outer header would name one write and
     * de-duplicate the whole chunk against it.
     */
    internal fun rpcBatch(calls: List<Any?>): Map<*, *> {
        val poster = post ?: throw ApiException("INTERNAL", "no HTTP poster configured")
        val headers = LinkedHashMap<String, String>()

        headers["content-type"] = "application/json"
        authToken?.let { headers["authorization"] = "Bearer $it" }

        val payload = Json.write(mapOf("calls" to calls))
        val response = poster(join(RPC_BATCH_PATH), headers, payload.toByteArray(StandardCharsets.UTF_8))

        return Json.parse(response.body) as? Map<*, *> ?: emptyMap<String, Any?>()
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
     * One item delivered by [stream]: a value, or the subscription error the
     * server pushed.
     *
     * One queue carrying both, rather than a value queue plus an error queue: a
     * consumer polling two of them can read them out of order, and the whole
     * point of a stream is that what arrived first is delivered first.
     */
    data class StreamEvent(val value: WireValue?, val error: SubscriptionError?)

    /**
     * A live query as a closeable [Sequence], for `for (event in stream)`.
     *
     * Iterating BLOCKS waiting for the next frame, which is what makes the loop
     * the whole consumer. [close] unsubscribes and ends the loop, so it belongs
     * in a `use { }` — otherwise the subscription outlives the loop and the
     * iterator blocks forever.
     *
     * A `Sequence` and a `BlockingQueue` rather than a `Flow` and a `Channel`:
     * `Flow` lives in kotlinx-coroutines, and this transport takes no
     * dependencies beyond the JDK.
     */
    class Stream internal constructor() :
        Sequence<StreamEvent>,
        AutoCloseable {
        // Unbounded, so the frame dispatcher never blocks on a slow consumer; the
        // trade is that one which stops reading without closing grows the buffer.
        internal val events = LinkedBlockingQueue<StreamEvent>()

        // The sentinel the iterator stops on. A distinct instance rather than a
        // null, because LinkedBlockingQueue rejects nulls outright.
        private val end = StreamEvent(null, null)
        private val closed = AtomicBoolean()
        internal var unsubscribe: () -> Unit = {}

        override fun iterator(): Iterator<StreamEvent> = object : Iterator<StreamEvent> {
            private var next: StreamEvent? = null

            override fun hasNext(): Boolean {
                if (next != null) return true

                next = events.take()

                return next !== end
            }

            override fun next(): StreamEvent {
                if (!hasNext()) throw NoSuchElementException("the stream is closed")

                return checkNotNull(next).also { next = null }
            }
        }

        override fun close() {
            if (!closed.compareAndSet(false, true)) return

            unsubscribe()
            // Wakes a consumer blocked in `take()` so the loop ends instead of
            // hanging on a subscription nothing will ever deliver to again.
            events.add(end)
        }
    }

    /**
     * Opens a live query as a [Stream].
     *
     * Each call opens its OWN subscription — at CALL time, so a frame arriving
     * before the loop starts is not lost — and [Stream.close] tears it down. Use
     * [subscribe] directly when the value outlives one loop.
     */
    fun stream(functionPath: String, args: WireValue? = null, shardKey: String? = null): Stream {
        val stream = Stream()

        stream.unsubscribe = subscribe(
            functionPath,
            args,
            { value -> stream.events.add(StreamEvent(value, null)) },
            { error -> stream.events.add(StreamEvent(null, error)) },
            shardKey,
        )

        return stream
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

            shapes[id] = Shape(name, args, onRows, onError)

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
                    // BOTH registries. A resend that walks only the queries leaves
                    // every shape view subscribed to a socket that no longer
                    // exists — silently, and for the rest of the process's life.
                    subscriptions.map { (id, entry) ->
                        buildSubscribeFrame(id, entry.functionPath, entry.args, null, entry.cursor, entry.epoch)
                    } +
                        shapes.map { (id, shape) ->
                            buildShapeSubscribeFrame(id, shape.name, shape.args, shape.checkpoint, shape.epoch)
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
                val value = try {
                    Wire.decode(payload)
                } catch (error: WireFormatException) {
                    // One subscription's payload is one subscription's problem.
                    // Thrown out of here it ends the caller's read loop and with it
                    // EVERY other subscription on this client, so it is delivered
                    // to the addressed subscription's error callbacks instead and
                    // the frame is reported as the error it is.
                    val handler = synchronized(lock) { subscriptions[id]?.onError }

                    handler?.invoke(SubscriptionError("INVALID_FRAME", error.message ?: "subscription payload could not be decoded"))

                    return "error"
                }
                val deferred = mutableListOf<() -> Unit>()

                synchronized(lock) {
                    subscriptions[id]?.let { entry ->
                        advance(entry, frame)
                        entry.state.serverBase = value
                        // `cursor` is OPTIONAL on data/delta frames, and a frame
                        // that omits it — or sends an explicit null — must LEAVE
                        // the tracked cursor where it is: nulling it strands every
                        // pending layer, because the tracked cursor is what a later
                        // commit cursor is compared against, so the write renders
                        // twice until some later cursored frame happens to land.
                        (frame["cursor"] as? Number)?.let { entry.state.serverCursor = it.toLong() }
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
            "resume", "settled" -> {
                val deferred = mutableListOf<() -> Unit>()

                synchronized(lock) {
                    subscriptions[id]?.let { entry ->
                        advance(entry, frame)
                        // A resume/settled frame advances the cursor without a
                        // value change — but a write whose result was
                        // byte-identical for this query still committed at or
                        // under this cursor, so its overlay is confirmed. Sweep
                        // here too, not just on data frames, or a
                        // no-visible-change write leaves its prediction on screen
                        // until some unrelated write happens to produce a data
                        // frame — indefinitely on a quiet query.
                        (frame["cursor"] as? Number)?.let { entry.state.serverCursor = it.toLong() }

                        if (Optimistic.dropConfirmedLayers(entry.state, entry.state.serverCursor)) {
                            Optimistic.notifySubscription(
                                entry.state,
                                Optimistic.fold(entry.state.serverBase, entry.state.layers),
                                deferred,
                            )
                        }
                    }
                }

                for (call in deferred) call()
            }
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
            "pokeStart" -> synchronized(lock) {
                // Evict oldest-first at the cap. A LinkedHashMap iterates in
                // insertion order, so the first key is the oldest buffer; one
                // that old is no longer going to see its pokeEnd.
                val oldest = pokes.keys.iterator()

                while (pokes.size >= MAX_PENDING_POKES && oldest.hasNext()) {
                    oldest.next()
                    oldest.remove()
                }

                pokes[frame["pokeId"].toString()] = PokeBuffer()
            }
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
            val shapeId = frame["shapeId"].toString()

            buffer.parts.getOrPut(shapeId) { mutableListOf() }.addAll(operations)

            // Recorded sticky (never cleared) so a server that splits one seed across
            // several parts still replaces rather than merges. `reset` is the ONLY
            // signal: a missing `baseCheckpoint` does not imply a seed, and a
            // retention re-seed arrives with the epoch unchanged.
            if (frame["reset"] == true) buffer.resets.add(shapeId)
        }
    }

    private fun applyPoke(frame: Map<*, *>) {
        // The view is mutated under the lock; `onRows` fires after it is released,
        // with the row snapshot taken while still holding it — so a callback sees
        // one consistent poke even if the next one lands mid-delivery.
        val deliveries = synchronized(lock) {
            val buffer = pokes.remove(frame["pokeId"].toString()) ?: return
            val pending = mutableListOf<Pair<(List<WireValue>) -> Unit, List<WireValue>>>()

            for ((shapeId, operations) in buffer.parts) {
                val shape = shapes[shapeId] ?: continue

                // A reset part is the shape's complete membership, so it is
                // authoritative on its own: drop what we hold before applying it.
                // `.global()` shapes re-seed in full on EVERY reconnect and an op-log
                // shape past changelog retention does too, so without this a row
                // deleted while the socket was down is never removed.
                if (shapeId in buffer.resets) {
                    shape.rows.clear()
                    shape.order.clear()
                }

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
