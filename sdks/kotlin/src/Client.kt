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
    var authToken: String? = null,
) {
    private var send: ((Map<String, Any?>) -> Unit)? = null
    private val subscriptions = LinkedHashMap<String, Subscription>()
    private val shapes = LinkedHashMap<String, Shape>()
    private val pokes = LinkedHashMap<String, LinkedHashMap<String, MutableList<Map<String, Any?>>>>()
    private var nextId = 0
    private var nextShapeId = 0

    private class Subscription(
        val functionPath: String,
        val args: WireValue,
        val onData: ((WireValue) -> Unit)?,
        val onError: ((SubscriptionError) -> Unit)?,
    ) {
        var cursor: Any? = null
        var epoch: Any? = null
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

        fun buildShapeUnsubscribeFrame(id: String): Map<String, Any?> =
            linkedMapOf("id" to id, "type" to "shape_unsubscribe")
    }

    /** Registers the sender used for subscription frames. Call once the socket is open. */
    fun attachSocket(sender: (Map<String, Any?>) -> Unit) {
        send = sender
    }

    fun query(functionPath: String, args: WireValue? = null, shardKey: String? = null): WireValue =
        rpc(functionPath, args, shardKey, null)

    fun mutation(functionPath: String, args: WireValue? = null, shardKey: String? = null, mutationId: String? = null): WireValue =
        rpc(functionPath, args, shardKey, mutationId)

    /**
     * Same envelope as a mutation, but never an idempotency key: an action
     * performs external side effects and is not replayed against the shard, so
     * claiming mutation-style de-duplication for it would be a lie.
     */
    fun action(functionPath: String, args: WireValue? = null, shardKey: String? = null): WireValue =
        rpc(functionPath, args, shardKey, null)

    /** Dispatches on [verb], which is what lets generated code stay uniform. */
    fun call(verb: Verb, functionPath: String, args: WireValue? = null, shardKey: String? = null): WireValue =
        when (verb) {
            Verb.QUERY -> query(functionPath, args, shardKey)
            Verb.ACTION -> action(functionPath, args, shardKey)
            Verb.MUTATION -> mutation(functionPath, args, shardKey)
        }

    private fun rpc(functionPath: String, args: WireValue?, shardKey: String?, mutationId: String?): WireValue {
        val poster = post ?: throw ApiException("INTERNAL", "no HTTP poster configured")
        val headers = LinkedHashMap<String, String>()

        headers["content-type"] = "application/json"
        authToken?.let { headers["authorization"] = "Bearer $it" }
        mutationId?.let { headers["x-lunora-mutation-id"] = it }

        val payload = Json.write(buildRpcBody(functionPath, args, shardKey))
        val response = poster(join(RPC_PATH), headers, payload.toByteArray(StandardCharsets.UTF_8))

        return parseRpcResponse(Json.parse(response.body) as Map<*, *>, response.status)
    }

    fun subscribe(
        functionPath: String,
        args: WireValue?,
        onData: ((WireValue) -> Unit)?,
        onError: ((SubscriptionError) -> Unit)? = null,
    ): () -> Unit {
        nextId++

        val id = "sub_$nextId"

        subscriptions[id] = Subscription(functionPath, args ?: WireValue.Obj(emptyList()), onData, onError)
        send?.invoke(buildSubscribeFrame(id, functionPath, args))

        return {
            subscriptions.remove(id)
            send?.invoke(buildUnsubscribeFrame(id))
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
        nextShapeId++

        val id = "shape_$nextShapeId"

        shapes[id] = Shape(onRows, onError)
        send?.invoke(buildShapeSubscribeFrame(id, name, args))

        return {
            shapes.remove(id)
            send?.invoke(buildShapeUnsubscribeFrame(id))
        }
    }

    /** Re-subscribes everything after a reconnect, carrying each resume cursor. */
    fun resendSubscriptions() {
        val sender = send ?: return

        for ((id, entry) in subscriptions) {
            sender(buildSubscribeFrame(id, entry.functionPath, entry.args, null, entry.cursor, entry.epoch))
        }
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
        val entry = subscriptions[id]

        when (kind) {
            "data", "delta" -> {
                val payload = frame["data"] ?: frame["delta"]
                val value = Wire.decode(payload)

                entry?.let {
                    advance(it, frame)
                    it.onData?.invoke(value)
                }
            }
            "resume", "settled" -> entry?.let { advance(it, frame) }
            "error" -> {
                val envelope = frame["error"] as? Map<*, *> ?: emptyMap<String, Any?>()
                val error = SubscriptionError(
                    envelope["code"] as? String,
                    frame["message"] as? String ?: envelope["message"] as? String ?: "subscription error",
                )

                entry?.onError?.invoke(error)
                shapes[id]?.onError?.invoke(error)
            }
            "complete" -> subscriptions.remove(id)
            "pokeStart" -> pokes[frame["pokeId"].toString()] = LinkedHashMap()
            "pokePart" -> bufferPokePart(frame)
            "pokeEnd" -> applyPoke(frame)
        }

        return kind
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
        // A part for an unknown poke is dropped: without its pokeStart there is
        // no batch to join, and guessing would apply a fragment of one.
        val buffer = pokes[frame["pokeId"].toString()] ?: return
        val operations = (frame["rowsPatch"] as? List<*>)?.filterIsInstance<Map<String, Any?>>() ?: emptyList()

        buffer.getOrPut(frame["shapeId"].toString()) { mutableListOf() }.addAll(operations)
    }

    private fun applyPoke(frame: Map<*, *>) {
        val buffer = pokes.remove(frame["pokeId"].toString()) ?: return

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

            shape.onRows?.invoke(shape.order.mapNotNull { shape.rows[it] })
        }
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
