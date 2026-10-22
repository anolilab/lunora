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

/** The close code the server sends when the session credential has expired (protocol §5.2). */
private const val CLOSE_TOKEN_EXPIRED: Int = 4001

/** The close code for a refused credential (protocol §6). */
private const val CLOSE_REFUSED: Int = 4003

/** The 4003 reason that marks a socket which never sent `connect`: it refused no credential. */
private const val CONNECT_DEADLINE_REASON: String = "connect deadline"

/**
 * Which RPC method a call dispatches to. Generated code emits these entries
 * rather than raw strings, so a typo in a target template is a compile error
 * instead of a read silently sent over the write path.
 */
enum class Verb { QUERY, MUTATION, ACTION }

/**
 * The code a call fails with when the server's reply was a SUCCESS whose `result`
 * does not decode. The write behind it committed: a queued write settles
 * `COMMITTED` carrying this error, and is never replayed.
 */
const val WIRE_DECODE_FAILED: String = "WIRE_DECODE_FAILED"

/**
 * A coded error from an RPC error envelope.
 *
 * [transient] says the call never reached a verdict: a reply carrying NO envelope
 * at all — an edge error page, a WAF block, a proxy, a body that is not a JSON
 * object — whatever its status (a 413 excepted: that is `PAYLOAD_TOO_LARGE`, a
 * verdict on the request). It is set where the reply is still in scope, because
 * [code] alone cannot tell a `BAD_REQUEST` the function returned from the
 * `INTERNAL` this client synthesises for a body that never came from one. A CODED
 * envelope never sets it: its code is the whole classification, whatever the
 * status, so a coded 5xx is the server's verdict on the single-call path exactly
 * as it is on the batch path.
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
    authToken: String? = null,
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
    identity: String? = null,
) {
    /**
     * An opaque, stable, NON-SECRET stamp for whoever is signed in — a user id,
     * not a bearer token. It is persisted alongside every queued write and
     * re-checked before that write replays, so a restart cannot push one user's
     * queued writes as another. Left null, a write is stamped with a digest of
     * [authToken] instead ([Identity.Token]; signed out with no token either), so a
     * new token is a new identity: a token refresh rejects the writes queued under
     * the old one and evicts its session. Set this to keep them across a refresh.
     * Any string is accepted: no identity, however it is spelled, equals a token
     * stamp.
     *
     * Changing it FROM a set value to a different one — a sign-out, or another
     * user signing in — evicts the previous session: every query and shape
     * subscription drops its resume cursor and epoch, so the next resubscribe is a
     * cold one, and every shape view is emptied and its callback told so (`[]`).
     * Those cursors were the previous identity's position in the changelog and
     * those rows were what IT could see; resuming from them asks the server for a
     * diff against a view the new identity never held. A first sign-in (from
     * null) and re-asserting the same identity evict nothing.
     */
    @Volatile
    var identity: String? = identity
        set(value) {
            val cleared = synchronized(lock) {
                val previous = field

                field = value

                if (previous == null || previous == value) return

                evictPreviousIdentitySession()
            }

            for (onRows in cleared) onRows(emptyList())
        }

    /**
     * Supplies the session credential, read on every socket open and sent as
     * `connect.token`. It never enters the socket URL. Null sends none.
     *
     * Assigning it starts a new credential generation, which re-arms the one 4003
     * refusal report [onTokenExpired] makes per generation. A provider that reads a
     * mutable token needs a fresh assignment to re-arm it.
     */
    @Volatile
    var wsToken: (() -> String?)? = null
        set(value) {
            synchronized(lock) {
                field = value
                credentialGeneration++
            }
        }

    /**
     * Supplies the ephemeral admin ticket, read on every [wsUrl] call and sent as
     * the `?token=` query parameter. Null sends none.
     */
    @Volatile
    var wsTicket: (() -> String?)? = null

    /**
     * The bearer token every RPC carries; the next call picks up a new one.
     *
     * With [identity] unset the token's digest IS the identity, so a different
     * token (or none) retires the previous one's session exactly as [identity]
     * changing from a set value does. With [identity] set a token change is a
     * refresh, not a change of user, and evicts nothing. Setting it flushes
     * nothing: the app calls [flushOfflineQueue] after a refresh, as on a
     * reconnect.
     */
    @Volatile
    var authToken: String? = authToken
        set(value) {
            val cleared = synchronized(lock) {
                val previous = effectiveIdentity()

                field = value

                if (previous == Identity.SignedOut || previous == effectiveIdentity()) return

                evictPreviousIdentitySession()
            }

            for (onRows in cleared) onRows(emptyList())
        }

    /**
     * Who a write queued now belongs to; call with [lock] held. [identity] when set,
     * else [Identity.Token] of [authToken], else [Identity.SignedOut] — the
     * reference's `identityFingerprint`. Without the token branch every write made
     * with no identity was stamped signed out and matched any token, so a flush
     * after an account switch sent the previous user's writes with the new user's
     * credential.
     */
    internal fun effectiveIdentity(): Identity = identity?.let { Identity.Of(it) }
        ?: authToken?.let { Identity.Token(tokenDigest(it)) }
        ?: Identity.SignedOut

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

    /** Bumped by every attach and detach, so an attach whose connect is still going out can tell it was superseded. */
    private var attachGeneration = 0L
    internal val subscriptions = LinkedHashMap<String, Subscription>()
    private val shapes = LinkedHashMap<String, Shape>()
    private val pokes = LinkedHashMap<String, PokeBuffer>()

    /** The open [Stream]s, so [close] can end them. */
    private val streams = mutableSetOf<Stream>()
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
    private class PokeBuffer(val epoch: Any?, val baseCheckpoint: Any?) {
        val parts = LinkedHashMap<String, MutableList<Map<String, Any?>>>()

        /**
         * Per shape, the checkpoint the server computed this diff against: the
         * part's own `baseCheckpoint`, else the `pokeStart`'s.
         */
        val bases = mutableMapOf<String, Any>()

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
            checkRpcResponse(body, status)

            return decodeResult(body["result"])
        }

        /**
         * Throws the verdict a response carries, if any: its coded envelope, or —
         * with none — the transport error its non-2xx status stands for.
         *
         * A coded envelope is classified by its CODE alone ([isTransient]), never
         * by the status beside it: the batch path has no per-slot status to read,
         * so a status rule here made a coded 5xx a retry when a write was queued
         * alone and a verdict when it shared a flush.
         */
        internal fun checkRpcResponse(body: Map<*, *>, status: Int) {
            val envelope = body["error"]

            if (envelope is Map<*, *>) throw envelopeError(envelope, "request failed")

            if (status !in 200..299) throw envelopeless(status)
        }

        /**
         * The coded error an envelope carries — a single call's, a batch slot's or a
         * whole batch's — defaulting a missing code to `INTERNAL`.
         *
         * `data` the codec refuses is DROPPED, not thrown: the envelope is still the
         * server's verdict and its code still classifies it. Throwing the codec's
         * exception made it look like a transport failure on the single-call path
         * (re-queued at the head of the queue forever) and aborted a batch's demux.
         */
        internal fun envelopeError(envelope: Map<*, *>, fallback: String): ApiException = ApiException(
            envelope["code"] as? String ?: "INTERNAL",
            envelope["message"] as? String ?: fallback,
            try {
                envelope["data"]?.let { Wire.decode(it) }
            } catch (error: WireFormatException) {
                null
            },
        )

        /**
         * A non-2xx reply with no envelope: nothing a Lunora function returned.
         *
         * A 413 is a verdict on the REQUEST whatever its body — an edge or proxy
         * refuses an oversized body with its own page long before the worker could
         * write the coded one — so it is `PAYLOAD_TOO_LARGE`, terminal for a lone
         * write and the split signal for a batch. Anything else reached no verdict:
         * transport, and transient.
         */
        internal fun envelopeless(status: Int): ApiException = if (status == 413) {
            ApiException(PAYLOAD_TOO_LARGE, "HTTP 413 without an error envelope")
        } else {
            ApiException("INTERNAL", "HTTP $status without an error envelope", transient = true)
        }

        /**
         * Decodes a success's `result`, failing with the SDK's own
         * [WIRE_DECODE_FAILED] rather than the codec's exception: the call
         * SUCCEEDED, and a caller — or the replay — has to be able to tell that
         * apart from a call that never reached the server.
         */
        internal fun decodeResult(raw: Any?): WireValue = try {
            Wire.decode(raw)
        } catch (error: WireFormatException) {
            throw ApiException(WIRE_DECODE_FAILED, "the call succeeded but its result could not be decoded: ${error.message}")
        }

        fun buildConnectFrame(clientId: String? = null, context: Map<String, Any?>? = null, token: String? = null): Map<String, Any?> {
            val frame = LinkedHashMap<String, Any?>()

            frame["id"] = "connect"
            frame["type"] = "connect"
            clientId?.let { frame["clientId"] = it }
            context?.let { frame["context"] = it }
            token?.let { frame["token"] = it }

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

        fun buildWhisperSubscribeFrame(topic: String): Map<String, Any?> = linkedMapOf("topic" to topic, "type" to "whisper_subscribe")

        fun buildWhisperUnsubscribeFrame(topic: String): Map<String, Any?> = linkedMapOf("topic" to topic, "type" to "whisper_unsubscribe")

        fun buildWhisperFrame(topic: String, data: WireValue): Map<String, Any?> =
            linkedMapOf("data" to Wire.encode(data), "topic" to topic, "type" to "whisper")

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
         * ONE predicate for the single-call and the batch path alike. Three ways
         * in: [ApiException.transient], set only for a reply carrying no envelope
         * (a coded envelope is classified by its code alone, whatever the status);
         * a shard code; or a rate limit, which is "not now" rather than "no" and is the
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
            is ApiException ->
                error.transient ||
                    error.code in TRANSIENT_ERROR_CODES ||
                    error.code in RATE_LIMIT_ERROR_CODES ||
                    error.code in AUTH_REPLAY_ERROR_CODES
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

    /** Bumped by every assignment to [wsToken]; see [detachSocket]. */
    private var credentialGeneration = 0L

    /** The generation the open socket's `connect` was sent under. */
    private var socketGeneration = 0L

    /** The generation of the last 4003 refusal reported to [onTokenExpired]; null before any. */
    private var refusedGeneration: Long? = null

    private val tokenExpiredListeners = mutableListOf<() -> Unit>()

    /** Joined topics and their listeners. A topic is present while it has at least one. */
    private val whisperTopics = LinkedHashMap<String, MutableList<WhisperListener>>()

    private class WhisperListener(val onValue: (WireValue) -> Unit)

    /**
     * Registers the sender used for subscription frames. Call once the socket is
     * open.
     *
     * It also latches "has connected at least once", which is what the write queue
     * gates on: a write made before the FIRST connect fails fast by default, so a
     * misconfigured endpoint surfaces on the first write instead of silently
     * filling a queue that will never flush.
     *
     * It sends the `connect` frame first, carrying [wsToken] resolved now, so every
     * open and every reconnect presents the session credential before any
     * subscription. The app must not send `connect` itself.
     */
    fun attachSocket(sender: (Map<String, Any?>) -> Unit) = attachSocket(null, sender)

    /**
     * [attachSocket] with a connection [context] on the `connect` frame. The server
     * records it for the `onConnect` hooks, so it applies to every open and reconnect.
     *
     * After `connect`, every registered whisper topic is joined again. Subscriptions
     * are not: [resendSubscriptions] sends those, and the app calls it after attaching.
     */
    fun attachSocket(context: Map<String, Any?>?, sender: (Map<String, Any?>) -> Unit) {
        // Writes queue while the connect frame goes out, so none can reach the socket this one replaces.
        // The credential generation is read with the attach generation: a rotation racing this attach
        // must not tag the socket with a generation newer than the credential it presents.
        val (generation, credential) = synchronized(lock) {
            send = null
            ++attachGeneration to credentialGeneration
        }
        sender(buildConnectFrame(clientId = clientId, context = context, token = wsToken?.invoke()))
        // A detach or a newer attach during the send supersedes this one: installing this sender would undo it,
        // so it is not installed and its whisper joins are not sent.
        // The topics are snapshotted in the same block that publishes the sender: a join registered after this
        // block sees `send` and sends itself, so each topic is joined exactly once.
        val topics = synchronized(lock) {
            if (generation != attachGeneration) return
            send = sender
            socketGeneration = credential
            wasEverConnected = true
            whisperTopics.keys.toList()
        }
        for (topic in topics) sender(buildWhisperSubscribeFrame(topic))
    }

    /**
     * Forgets the sender, so subsequent writes queue rather than fail. Every detach
     * leaves the client offline.
     *
     * [closeCode] and [reason] are the close frame the socket ended with, when the
     * socket library reports one; null means none. They decide whether
     * [onTokenExpired] listeners hear of it:
     *  - 4001 (token expired): always.
     *  - 4003 (refused credential): once per credential generation, and only for a
     *    socket that opened under the current one: a socket opened under a superseded
     *    credential refused a credential no longer in force. A reason of exactly
     *    "connect deadline" refuses no credential, so it notifies nothing.
     *  - anything else: nothing.
     */
    fun detachSocket(closeCode: Int? = null, reason: String? = null) {
        val expired = synchronized(lock) {
            send = null
            attachGeneration++

            when {
                closeCode == CLOSE_TOKEN_EXPIRED -> true
                closeCode == CLOSE_REFUSED && reason != CONNECT_DEADLINE_REASON &&
                    socketGeneration == credentialGeneration && refusedGeneration != socketGeneration -> {
                    refusedGeneration = socketGeneration

                    true
                }

                else -> false
            }
        }

        if (expired) notifyTokenExpired()
    }

    /**
     * Observes token expiry: a 4001 close, a `TOKEN_EXPIRED` error frame, or a 4003
     * refusal (see [detachSocket]). Returns an unregister.
     */
    fun onTokenExpired(listener: () -> Unit): () -> Unit {
        synchronized(lock) { tokenExpiredListeners.add(listener) }

        return { synchronized(lock) { tokenExpiredListeners.remove(listener) } }
    }

    private fun notifyTokenExpired() {
        val listeners = synchronized(lock) { tokenExpiredListeners.toList() }

        for (listener in listeners) {
            try {
                listener()
            } catch (error: Exception) {
                // One bad observer must not stop the rest, nor the socket teardown or
                // frame handling that reported the expiry.
            }
        }
    }

    /**
     * Joins [topic] and hands each relayed `whisper` value to [listener]. The join is
     * sent now when a socket is attached and again after every reconnect. Returns the
     * leave: removing the topic's last listener sends `whisper_unsubscribe`.
     */
    fun whisperSubscribe(topic: String, listener: (WireValue) -> Unit): () -> Unit {
        val entry = WhisperListener(listener)
        val socket = synchronized(lock) {
            val listeners = whisperTopics.getOrPut(topic) { mutableListOf() }

            listeners.add(entry)

            send.takeIf { listeners.size == 1 }
        }

        socket?.invoke(buildWhisperSubscribeFrame(topic))

        return {
            val leave = synchronized(lock) {
                val listeners = whisperTopics[topic]

                when {
                    listeners == null || !listeners.remove(entry) -> null

                    listeners.isEmpty() -> {
                        whisperTopics.remove(topic)

                        send
                    }

                    else -> null
                }
            }

            leave?.invoke(buildWhisperUnsubscribeFrame(topic))
        }
    }

    /**
     * Relays [data] to [topic] over the attached socket. Returns false, and queues
     * nothing, when no socket is attached.
     */
    fun whisper(topic: String, data: WireValue): Boolean {
        val socket = synchronized(lock) { send } ?: return false

        socket(buildWhisperFrame(topic, data))

        return true
    }

    /** A joined room: [send] relays a message to it, [close] leaves it. */
    class Room internal constructor(private val relay: (WireValue) -> Boolean, private val leave: () -> Unit) {
        /** Relays [message]; false when no socket is attached. */
        fun send(message: WireValue): Boolean = relay(message)

        fun close() = leave()
    }

    /**
     * Joins the room `room:<name>` and hands its messages to [listener]. Does not wait
     * for an ack: a room topic is never acknowledged.
     */
    fun connectRoom(name: String, listener: (WireValue) -> Unit): Room {
        val topic = "room:$name"
        val leave = whisperSubscribe(topic, listener)

        return Room({ message -> whisper(topic, message) }, leave)
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
     * Rejects every queued write so no caller waits on a dead client, and ends
     * every open [Stream], so a loop blocked on one returns instead of waiting
     * forever on a client nothing will deliver to again. Durable storage is
     * untouched: the next session restores those writes.
     */
    fun close() {
        val (discarded, open) = synchronized(lock) {
            closed = true
            send = null
            offlineQueue.clear() to streams.toList()
        }

        for (stream in open) stream.close()

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
        rpcFull(functionPath, args, shardKey, mutationId).value()

    /**
     * One RPC round-trip: the decoded result plus the commit cursor the response
     * echoed.
     *
     * [decodeError] is set, and [result] null, when the call SUCCEEDED but its
     * result does not decode. Returned rather than thrown so the commit cursor
     * survives it: the write committed, and its overlay is confirmed against that
     * cursor like any other.
     */
    data class RpcReply(val result: WireValue?, val commitCursor: Long?, val decodeError: ApiException? = null) {
        /** The result, or the [decodeError] thrown. */
        fun value(): WireValue {
            decodeError?.let { throw it }

            return checkNotNull(result)
        }
    }

    /**
     * One round-trip, keeping the echoed `commitCursor`.
     *
     * The cursor is what gates an optimistic overlay's removal, so it has to
     * survive the call rather than be discarded by [parseRpcResponse].
     * [issuingClientId] overrides this session's, so a replayed write namespaces
     * server-side under the id that ISSUED it. [token] is the bearer to send (null:
     * none); a replay passes the one its identity gate judged the pass against, so
     * a token swapped mid-flush cannot carry the rest of it.
     */
    internal fun rpcFull(
        functionPath: String,
        args: WireValue?,
        shardKey: String?,
        mutationId: String?,
        issuingClientId: String? = null,
        token: String? = authToken,
    ): RpcReply {
        val poster = post ?: throw ApiException("INTERNAL", "no HTTP poster configured")
        val headers = LinkedHashMap<String, String>()

        headers["content-type"] = "application/json"
        token?.let { headers["authorization"] = "Bearer $it" }

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
        // A body that is not a JSON object carries neither a result nor an
        // envelope — an HTML error page, a proxy's `null` — so it is read the way
        // every envelope-less reply is, as the SDK's own error, never as the JSON
        // parser's or a cast's exception escaping every handler the caller wrote.
        val body = readObject(response.body) ?: throw if (response.status in 200..299) {
            ApiException("INTERNAL", "HTTP ${response.status} with a body that is not a JSON object", transient = true)
        } else {
            envelopeless(response.status)
        }

        checkRpcResponse(body, response.status)

        val cursor = parseCommitCursor(body)

        return try {
            RpcReply(decodeResult(body["result"]), cursor)
        } catch (error: ApiException) {
            RpcReply(null, cursor, error)
        }
    }

    /** [raw] parsed as a JSON object, or null when it is not one (or not JSON at all). */
    private fun readObject(raw: String): Map<*, *>? = try {
        Json.parse(raw) as? Map<*, *>
    } catch (error: IllegalArgumentException) {
        null
    }

    /**
     * POSTs one `/_lunora/rpc-batch` chunk, returning the status and the parsed
     * body — null when the body is not a JSON object. The status is kept because
     * a 413 is a verdict on the request whatever its body says.
     *
     * No `x-lunora-mutation-id` on the request: a batch is ONE transport hop
     * carrying independent calls, so each entry carries its own idempotency key
     * and client id in the body. A single outer header would name one write and
     * de-duplicate the whole chunk against it. [token] as for [rpcFull].
     */
    internal fun rpcBatch(calls: List<Any?>, token: String?): Pair<Int, Map<*, *>?> {
        val poster = post ?: throw ApiException("INTERNAL", "no HTTP poster configured")
        val headers = LinkedHashMap<String, String>()

        headers["content-type"] = "application/json"
        token?.let { headers["authorization"] = "Bearer $it" }

        val payload = Json.write(mapOf("calls" to calls))
        val response = poster(join(RPC_BATCH_PATH), headers, payload.toByteArray(StandardCharsets.UTF_8))

        return response.status to readObject(response.body)
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
        val unsubscribe = subscribe(
            functionPath,
            args,
            { value -> stream.events.add(StreamEvent(value, null)) },
            { error -> stream.events.add(StreamEvent(null, error)) },
            shardKey,
        )

        stream.unsubscribe = {
            synchronized(lock) { streams.remove(stream) }
            unsubscribe()
        }
        synchronized(lock) { streams.add(stream) }

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

                // Token expiry is the socket's signal, not a subscription's failure: the
                // server sends it just before closing 4001, and routing it would hand the
                // subscription an error the credential refresh is about to cure. Checked
                // before the id lookup, so an id-less frame still notifies.
                if (envelope["code"] == "TOKEN_EXPIRED") {
                    notifyTokenExpired()

                    return kind
                }

                val error = SubscriptionError(
                    envelope["code"] as? String,
                    frame["message"] as? String ?: envelope["message"] as? String ?: "subscription error",
                )
                val handlers = synchronized(lock) { listOfNotNull(subscriptions[id]?.onError, shapes[id]?.onError) }

                for (handler in handlers) handler(error)
            }
            "complete" -> {
                // NON-DESTRUCTIVE, and that is the whole point: removing the
                // entry takes it out of the map `resendSubscriptions` walks, so
                // the query froze for the life of the process across every
                // future reconnect, with nothing reported. Fan a cancellation to
                // the listener and leave the registration in place; the next
                // reconnect resubscribes it.
                val cancelled = synchronized(lock) { subscriptions[id]?.onError }

                cancelled?.invoke(SubscriptionError("SUBSCRIPTION_CANCELLED", "subscription was cancelled by the server"))
            }
            // A poke frame without a string `pokeId` names no poke, and one keyed by
            // its rendering ("null", "7.0") would be joined by an equally malformed
            // part or end.
            "pokeStart" -> synchronized(lock) {
                val pokeId = frame["pokeId"] as? String ?: return kind

                // Evict oldest-first at the cap. A LinkedHashMap iterates in
                // insertion order, so the first key is the oldest buffer; one
                // that old is no longer going to see its pokeEnd.
                val oldest = pokes.keys.iterator()

                while (pokes.size >= MAX_PENDING_POKES && oldest.hasNext()) {
                    oldest.next()
                    oldest.remove()
                }

                pokes[pokeId] = PokeBuffer(frame["epoch"], frame["baseCheckpoint"])
            }
            "pokePart" -> bufferPokePart(frame)
            "pokeEnd" -> applyPoke(frame)
            "whisper" -> {
                // A frame with no topic names no listeners, and a payload the codec refuses
                // is one bad frame, not a reason to end the read loop. Both are ignored.
                val topic = frame["topic"] as? String

                if (!topic.isNullOrEmpty()) {
                    val value = try {
                        Wire.decode(frame["data"])
                    } catch (error: WireFormatException) {
                        return kind
                    }
                    val listeners = synchronized(lock) { whisperTopics[topic]?.toList().orEmpty() }

                    for (listener in listeners) listener.onValue(value)
                }
            }
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

    /**
     * Drops the resume state the previous identity left, under the lock; returns
     * the shape callbacks to tell (outside it) that their view is now empty.
     */
    private fun evictPreviousIdentitySession(): List<(List<WireValue>) -> Unit> {
        for (entry in subscriptions.values) {
            entry.cursor = null
            entry.epoch = null
        }

        return shapes.values.mapNotNull { shape ->
            shape.rows.clear()
            shape.order.clear()
            shape.checkpoint = null
            shape.epoch = null
            shape.onRows
        }
    }

    /**
     * Tracks a frame's resume position. A `cursor` that is not an integer is not
     * a cursor: resending it verbatim asks the server to resume from `"9"`, so it
     * leaves the tracked one where it was.
     */
    private fun advance(entry: Subscription, frame: Map<*, *>) {
        (frame["cursor"] as? Number)?.toDouble()?.takeIf { it == Math.rint(it) && !it.isInfinite() }?.let { entry.cursor = it }
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
            val buffer = pokes[frame["pokeId"] as? String ?: return] ?: return
            val shapeId = frame["shapeId"] as? String ?: return

            buffer.parts.getOrPut(shapeId) { mutableListOf() }.addAll(operations)

            // Recorded sticky (never cleared) so a server that splits one seed across
            // several parts still replaces rather than merges. `reset` is the ONLY
            // signal: a missing `baseCheckpoint` does not imply a seed, and a
            // retention re-seed arrives with the epoch unchanged.
            if (frame["reset"] == true) buffer.resets.add(shapeId)

            (frame["baseCheckpoint"] ?: buffer.baseCheckpoint)?.let { buffer.bases[shapeId] = it }
        }
    }

    private fun applyPoke(frame: Map<*, *>) {
        // The view is mutated under the lock; `onRows` fires after it is released,
        // with the row snapshot taken while still holding it — so a callback sees
        // one consistent poke even if the next one lands mid-delivery.
        val deliveries = synchronized(lock) {
            val buffer = pokes.remove(frame["pokeId"] as? String ?: return) ?: return
            val pending = mutableListOf<() -> Unit>()
            val sender = send

            for ((shapeId, operations) in buffer.parts) {
                val shape = shapes[shapeId] ?: continue

                // Every row is decoded BEFORE the view is touched: a poke applies
                // whole or not at all. Decoding inside the apply loop cleared the
                // view for a reset and then threw on the bad row, leaving it half
                // applied (or empty) with nothing reported — and the exception ended
                // the caller's read loop. Refused, the shape keeps its view, its
                // checkpoint and its epoch, so a resume still asks for the rows it
                // never held; its error callback hears why.
                val decoded = try {
                    operations.map { operation ->
                        operation to operation["value"]?.takeIf { operation["op"] != "delete" }?.let { Wire.decode(it) }
                    }
                } catch (error: WireFormatException) {
                    shape.onError?.let { onError ->
                        pending.add { onError(SubscriptionError(WIRE_DECODE_FAILED, error.message ?: "shape rows could not be decoded")) }
                    }

                    continue
                }

                // The server computed this diff against `base`. If the view is not at
                // that checkpoint — a poke was refused or dropped — or the changelog
                // epoch forked, splicing the ops on corrupts the view for good (the
                // missed rows never come again). Drop it, skip the ops, tell the
                // callback `[]` and re-subscribe COLD so the server re-seeds it. A
                // reset part is the full membership and settles either case itself.
                val base = buffer.bases[shapeId]
                val epochForked = buffer.epoch != null && shape.epoch != null && buffer.epoch != shape.epoch
                val baseDiverged = base != null && shape.checkpoint != null && shape.checkpoint != base

                if (shapeId !in buffer.resets && (epochForked || baseDiverged)) {
                    shape.rows.clear()
                    shape.order.clear()
                    shape.checkpoint = null
                    shape.epoch = null
                    shape.onRows?.let { onRows -> pending.add { onRows(emptyList()) } }
                    sender?.let { pending.add { it(buildShapeSubscribeFrame(shapeId, shape.name, shape.args)) } }

                    continue
                }

                // A reset part is the shape's complete membership, so it is
                // authoritative on its own: drop what we hold before applying it.
                // `.global()` shapes re-seed in full on EVERY reconnect and an op-log
                // shape past changelog retention does too, so without this a row
                // deleted while the socket was down is never removed.
                if (shapeId in buffer.resets) {
                    shape.rows.clear()
                    shape.order.clear()
                }

                for ((operation, value) in decoded) {
                    val key = operation["key"]?.toString() ?: continue

                    if (operation["op"] == "delete") {
                        if (shape.rows.remove(key) != null) shape.order.remove(key)

                        continue
                    }

                    // A value-less upsert is membership-only; it must not blank an
                    // existing row.
                    if (value == null) continue

                    if (!shape.rows.containsKey(key)) shape.order.add(key)

                    shape.rows[key] = value
                }

                if (frame.containsKey("checkpoint")) shape.checkpoint = frame["checkpoint"]
                if (frame.containsKey("epoch")) shape.epoch = frame["epoch"]

                shape.onRows?.let { onRows ->
                    val rows = shape.order.mapNotNull { key -> shape.rows[key] }

                    pending.add { onRows(rows) }
                }
            }

            pending
        }

        for (delivery in deliveries) delivery()
    }

    /**
     * The socket URL: the origin with its scheme swapped, plus the shard and the
     * admin ticket as `?token=` when present. The session credential is never in
     * the URL; it travels in the `connect` frame.
     */
    fun wsUrl(shardKey: String? = null): String {
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
            wsTicket?.invoke()?.let { add("token=" + URLEncoder.encode(it, StandardCharsets.UTF_8)) }
        }

        if (params.isEmpty()) return endpoint

        return endpoint + (if (endpoint.contains('?')) "&" else "?") + params.joinToString("&")
    }

    private fun join(path: String): String = baseUrl.trimEnd('/') + path
}
