package dev.lunora

import java.math.BigInteger
import java.util.Base64

/**
 * The tagged value codec for Lunora's client↔server wire, ported from
 * `shared/wire-codec.ts`.
 *
 * The wire is JSON with no reviver; values JSON cannot carry (big integers,
 * bytes, dates, maps/sets, ±Infinity/NaN, `undefined` in an array position)
 * become self-delimiting tagged arrays whose first element is [TAG]. Pure-JSON
 * values encode to a structurally identical tree.
 *
 * Kotlin's sealed class lets [WireValue] represent every wire shape exactly, so
 * `encode(decode(x)) == x` is total rather than a convention — the same
 * property Rust's enum gives, and the reason both ports read the most directly.
 *
 * See `protocol/README.md` §2 for the normative grammar.
 */
object Wire {
    /** Marks a JSON array as a tagged wire value. */
    const val TAG: String = "\$lunora.wire\$"

    /** Bounds recursion so a hostile deeply-nested payload cannot exhaust the stack. */
    const val MAX_DEPTH: Int = 64

    /**
     * Bounds a decoded big integer. Decimal parsing is superlinear, so an
     * unbounded digit string from an untrusted peer is a denial of service.
     * Applied only on decode — the untrusted direction.
     */
    const val MAX_BIGINT_DIGITS: Int = 1024

    /** Encode [value] into a JSON-safe tree, tagging the leaves JSON cannot carry. */
    fun encode(value: WireValue, depth: Int = 0): Any? {
        if (depth > MAX_DEPTH) throw WireFormatException("wire-codec: value nesting exceeds the $MAX_DEPTH-level limit")

        return when (value) {
            is WireValue.Null -> null
            // Distinct from Null: as an object field this is dropped on encode
            // (matching JSON.stringify), but in an array position it must be
            // preserved, or every later element silently shifts.
            is WireValue.Undefined -> listOf(TAG, "undefined")
            is WireValue.Bool -> value.value
            is WireValue.Num -> value.value
            is WireValue.NaN -> listOf(TAG, "nan")
            is WireValue.Infinity -> listOf(TAG, "inf")
            is WireValue.NegInfinity -> listOf(TAG, "-inf")
            is WireValue.Text -> value.value
            is WireValue.BigInt -> listOf(TAG, "bigint", value.value.toString())
            is WireValue.Date -> listOf(TAG, "date", encode(value.epochMs, depth + 1))
            is WireValue.Url -> listOf(TAG, "url", value.href)
            is WireValue.Bytes -> listOf(TAG, "bytes", Base64.getEncoder().encodeToString(value.data))
            is WireValue.TypedBytes ->
                listOf(TAG, "bytes", Base64.getEncoder().encodeToString(value.data), value.ctor)
            is WireValue.Arr -> encodeArray(value, depth)
            is WireValue.Obj -> value.fields.filterNot { it.second is WireValue.Undefined }
                .associate { it.first to encode(it.second, depth + 1) }
            is WireValue.WireMap ->
                listOf(TAG, "map", value.entries.map { listOf(encode(it.first, depth + 1), encode(it.second, depth + 1)) })
            is WireValue.WireSet -> listOf(TAG, "set", value.items.map { encode(it, depth + 1) })
            is WireValue.Err -> encodeError(value, depth)
        }
    }

    private fun encodeArray(value: WireValue.Arr, depth: Int): Any {
        val encoded = value.items.map { encode(it, depth + 1) }

        // Escape a user array whose first element is literally the sentinel, or
        // the decoder would mistake it for a tagged value.
        return if (encoded.firstOrNull() == TAG) listOf(TAG, "arr", encoded) else encoded
    }

    private fun encodeError(value: WireValue.Err, depth: Int): Any {
        val props = value.props.filterNot { it.second is WireValue.Undefined }
            .associate { it.first to encode(it.second, depth + 1) }
        val encoded = mutableListOf<Any?>(TAG, "error", value.name, value.message, props)

        // `cause` rides a positional slot; absent when unset, keeping the
        // 5-element form.
        value.cause?.takeIf { it !is WireValue.Undefined }?.let { encoded.add(encode(it, depth + 1)) }

        return encoded
    }

    /** Inverse of [encode]: revive tagged leaves into [WireValue]. */
    fun decode(value: Any?, depth: Int = 0): WireValue {
        if (depth > MAX_DEPTH) throw WireFormatException("wire-codec: value nesting exceeds the $MAX_DEPTH-level limit")

        return when (value) {
            null -> WireValue.Null
            is Boolean -> WireValue.Bool(value)
            is Double -> WireValue.Num(value)
            is String -> WireValue.Text(value)
            is List<*> -> if (value.firstOrNull() == TAG) decodeTagged(value, depth) else WireValue.Arr(value.map { decode(it, depth + 1) })
            is Map<*, *> -> WireValue.Obj(value.map { (key, item) -> key.toString() to decode(item, depth + 1) })
            else -> throw WireFormatException("wire-codec: cannot decode a ${value.javaClass.name}")
        }
    }

    private fun decodeTagged(items: List<*>, depth: Int): WireValue =
        when (items.getOrNull(1)) {
            "undefined" -> WireValue.Undefined
            "nan" -> WireValue.NaN
            "inf" -> WireValue.Infinity
            "-inf" -> WireValue.NegInfinity
            "bigint" -> decodeBigInt(items)
            "date" -> WireValue.Date(decode(items.getOrNull(2), depth + 1))
            "url" -> WireValue.Url(items[2] as String)
            "map" -> WireValue.WireMap(
                (items[2] as List<*>).map { entry ->
                    val pair = entry as List<*>
                    decode(pair[0], depth + 1) to decode(pair[1], depth + 1)
                },
            )
            "set" -> WireValue.WireSet((items[2] as List<*>).map { decode(it, depth + 1) })
            "error" -> decodeError(items, depth)
            "bytes" -> decodeBytes(items)
            "arr" -> WireValue.Arr((items[2] as List<*>).map { decode(it, depth + 1) })
            // Unknown tag (forward compatibility): an ordinary array.
            else -> WireValue.Arr(items.map { decode(it, depth + 1) })
        }

    private fun decodeBigInt(items: List<*>): WireValue {
        val raw = items.getOrNull(2)

        if (raw !is String || raw.length > MAX_BIGINT_DIGITS || !isBigIntLiteral(raw)) {
            throw WireFormatException("wire-codec: invalid or over-long bigint (max $MAX_BIGINT_DIGITS digits)")
        }

        return WireValue.BigInt(BigInteger(raw))
    }

    private fun decodeError(items: List<*>, depth: Int): WireValue {
        val props = (items.getOrNull(4) as? Map<*, *>)
            ?.map { (key, item) -> key.toString() to decode(item, depth + 1) }
            ?: emptyList()

        return WireValue.Err(
            name = items.getOrNull(2) as? String ?: "",
            message = items.getOrNull(3) as? String ?: "",
            props = props,
            cause = if (items.size > 5) decode(items[5], depth + 1) else null,
        )
    }

    private fun decodeBytes(items: List<*>): WireValue {
        val data = Base64.getDecoder().decode(items[2] as String)
        val ctor = items.getOrNull(3) as? String ?: "Uint8Array"

        // A plain Uint8Array re-encodes to the 2-element form; every other view
        // keeps its constructor name.
        return if (ctor == "Uint8Array") WireValue.Bytes(data) else WireValue.TypedBytes(data, ctor)
    }

    /** Whether [raw] is an optionally-negative run of ASCII digits. */
    private fun isBigIntLiteral(raw: String): Boolean {
        val body = raw.removePrefix("-")

        return body.isNotEmpty() && body.all { it in '0'..'9' }
    }

    /**
     * Convert a plain JSON tree — such as a generated model serialised through
     * its own accessors — into a [WireValue].
     *
     * Safe as a structural mapping because a generated model can never contain a
     * wire wrapper: the generator refuses to emit a typed model for any schema
     * carrying a `v.bigint()` or `v.bytes()`.
     */
    fun fromJson(value: Any?): WireValue = decode(value)
}

/** Every value the Lunora wire can carry. */
sealed class WireValue {
    object Null : WireValue()

    /** JavaScript's `undefined`, distinct from JSON null. */
    object Undefined : WireValue()

    object NaN : WireValue()

    object Infinity : WireValue()

    object NegInfinity : WireValue()

    data class Bool(val value: Boolean) : WireValue()

    data class Num(val value: Double) : WireValue()

    data class Text(val value: String) : WireValue()

    /** A `v.bigint()`. [BigInteger] is arbitrary-precision, so no range is lost. */
    data class BigInt(val value: BigInteger) : WireValue()

    /** A Date, as epoch milliseconds. An invalid Date carries NaN and round-trips exactly. */
    data class Date(val epochMs: WireValue) : WireValue()

    data class Url(val href: String) : WireValue()

    data class Arr(val items: List<WireValue>) : WireValue()

    /** Field order is preserved, so a pure-JSON object survives a round trip. */
    data class Obj(val fields: List<Pair<String, WireValue>>) : WireValue()

    /** Ordered pairs whose keys may be non-string, which a Map cannot represent. */
    data class WireMap(val entries: List<Pair<WireValue, WireValue>>) : WireValue()

    data class WireSet(val items: List<WireValue>) : WireValue()

    /** A plain `Uint8Array`: raw bytes, 2-element wire form. */
    class Bytes(val data: ByteArray) : WireValue()

    /** Any other typed-array view, carrying its constructor name. */
    class TypedBytes(val data: ByteArray, val ctor: String) : WireValue()

    data class Err(
        val name: String,
        val message: String,
        val props: List<Pair<String, WireValue>> = emptyList(),
        val cause: WireValue? = null,
    ) : WireValue()
}

class WireFormatException(message: String) : RuntimeException(message)
