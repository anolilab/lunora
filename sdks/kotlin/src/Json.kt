package dev.lunora

import java.math.BigDecimal
import java.util.Locale

/**
 * A minimal JSON reader/writer plus the stable subscription key.
 *
 * Hand-rolled because the JVM ships no JSON, and pulling in Jackson would make
 * the transport's only dependency a parser it barely uses. The risk that
 * normally makes hand-rolling a bad idea does not apply: the golden fixtures
 * under `protocol/fixtures` are themselves a demanding parser suite, so a
 * mistake here fails the conformance tests rather than hiding.
 *
 * Values map to plain Kotlin types, matching every other Lunora port: `null`,
 * [Boolean], [Double], [String], [List] and [LinkedHashMap] (insertion ordered,
 * because object field order must survive a round trip).
 */
object Json {
    /**
     * Levels of ENVELOPE a wire value can sit under before its own nesting
     * starts. Every payload arrives wrapped: `{"result": V}` is one, and the two
     * deepest — a batch response `{"results":[{"result": V}]}` and a poke part
     * `{"rowsPatch":[{"value": V}]}` — are three.
     */
    private const val MAX_ENVELOPE_DEPTH: Int = 3

    /**
     * The parser's own nesting cap, counted from the DOCUMENT root.
     *
     * It cannot be [Wire.MAX_DEPTH] directly: that bounds a wire VALUE, whose
     * root is already [MAX_ENVELOPE_DEPTH] levels into the frame carrying it, so
     * charging the envelope against the value's budget refused frames whose
     * payload the reference encodes happily. The cap is here to keep a hostile
     * frame off the stack, and a few extra levels cost nothing against that.
     */
    const val MAX_DEPTH: Int = Wire.MAX_DEPTH + MAX_ENVELOPE_DEPTH

    fun parse(text: String): Any? {
        val parser = Parser(text)
        val value = parser.readValue()

        parser.skipWhitespace()

        require(parser.atEnd()) { "json: trailing content at offset ${parser.offset}" }

        return value
    }

    fun write(value: Any?): String = StringBuilder().also { writeValue(it, value) }.toString()

    private fun writeValue(out: StringBuilder, value: Any?) {
        when (value) {
            null -> out.append("null")
            is Boolean -> out.append(if (value) "true" else "false")
            is Number -> out.append(Key.formatNumber(value.toDouble()))
            is String -> out.append(Key.jsonString(value))
            is List<*> -> {
                out.append('[')
                value.forEachIndexed { index, item ->
                    if (index > 0) out.append(',')
                    writeValue(out, item)
                }
                out.append(']')
            }
            is Map<*, *> -> {
                out.append('{')
                value.entries.forEachIndexed { index, entry ->
                    if (index > 0) out.append(',')
                    out.append(Key.jsonString(entry.key.toString()))
                    out.append(':')
                    writeValue(out, entry.value)
                }
                out.append('}')
            }
            else -> throw IllegalArgumentException("json: cannot write a ${value.javaClass.name}")
        }
    }

    private class Parser(private val text: String) {
        var offset: Int = 0
        private var depth: Int = 0

        fun atEnd(): Boolean = offset >= text.length

        fun skipWhitespace() {
            while (offset < text.length && text[offset].isWhitespace()) offset++
        }

        fun readValue(): Any? {
            skipWhitespace()
            require(!atEnd()) { "json: unexpected end of input" }

            // Bounded here, not after parsing. Wire.MAX_DEPTH applies to the
            // decoded tree and never sees the payload; without this a deeply
            // nested frame overflows the stack, and StackOverflowError is an
            // Error that handleFrame's RuntimeException catch cannot catch.
            require(depth <= MAX_DEPTH) { "json: nesting exceeds the $MAX_DEPTH-level limit" }

            return when (text[offset]) {
                '{' -> readObject()
                '[' -> readArray()
                '"' -> readString()
                't' -> readLiteral("true", true)
                'f' -> readLiteral("false", false)
                'n' -> readLiteral("null", null)
                else -> readNumber()
            }
        }

        private fun readLiteral(literal: String, value: Any?): Any? {
            require(text.startsWith(literal, offset)) { "json: invalid literal at offset $offset" }
            offset += literal.length

            return value
        }

        private fun readObject(): Map<String, Any?> {
            val fields = LinkedHashMap<String, Any?>()

            depth++
            offset++ // '{'
            skipWhitespace()

            if (!atEnd() && text[offset] == '}') {
                offset++
                depth--

                return fields
            }

            while (true) {
                skipWhitespace()

                val key = readString()

                skipWhitespace()
                require(!atEnd() && text[offset] == ':') { "json: expected ':' at offset $offset" }
                offset++
                fields[key] = readValue()
                skipWhitespace()
                require(!atEnd()) { "json: unterminated object" }

                when (val character = text[offset++]) {
                    '}' -> {
                        depth--

                        return fields
                    }
                    ',' -> Unit
                    else -> throw IllegalArgumentException("json: expected ',' or '}' but found '$character'")
                }
            }
        }

        private fun readArray(): List<Any?> {
            val items = mutableListOf<Any?>()

            depth++
            offset++ // '['
            skipWhitespace()

            if (!atEnd() && text[offset] == ']') {
                offset++
                depth--

                return items
            }

            while (true) {
                items.add(readValue())
                skipWhitespace()
                require(!atEnd()) { "json: unterminated array" }

                when (val character = text[offset++]) {
                    ']' -> {
                        depth--

                        return items
                    }
                    ',' -> Unit
                    else -> throw IllegalArgumentException("json: expected ',' or ']' but found '$character'")
                }
            }
        }

        private fun readString(): String {
            require(!atEnd() && text[offset] == '"') { "json: expected a string at offset $offset" }
            offset++

            val out = StringBuilder()

            while (true) {
                require(!atEnd()) { "json: unterminated string" }

                val character = text[offset++]

                if (character == '"') return out.toString()

                if (character != '\\') {
                    out.append(character)

                    continue
                }

                require(!atEnd()) { "json: truncated escape" }

                when (val escape = text[offset++]) {
                    '"' -> out.append('"')
                    '\\' -> out.append('\\')
                    '/' -> out.append('/')
                    'b' -> out.append('\b')
                    'f' -> out.append('\u000C')
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'u' -> {
                        // Surrogate pairs arrive as two consecutive \u escapes;
                        // JVM strings are UTF-16, so the pair reassembles itself.
                        require(offset + 4 <= text.length) { "json: truncated \\u escape" }

                        val code = text.substring(offset, offset + 4).toIntOrNull(16)

                        requireNotNull(code) { "json: invalid \\u escape" }
                        out.append(code.toChar())
                        offset += 4
                    }
                    else -> throw IllegalArgumentException("json: invalid escape \\$escape")
                }
            }
        }

        private fun readNumber(): Double {
            val start = offset

            if (!atEnd() && (text[offset] == '-' || text[offset] == '+')) offset++

            while (!atEnd() && (text[offset].isDigit() || text[offset] in ".eE+-")) offset++

            require(start != offset) { "json: expected a number at offset $start" }

            return text.substring(start, offset).toDouble()
        }
    }
}

/**
 * The stable subscription key, ported from `shared/stable-key.ts`.
 *
 * A key is compared verbatim against one produced by the reference TypeScript
 * client, so every spelling must match ECMAScript exactly — a mismatch silently
 * splits one subscription into two.
 */
object Key {
    /** Canonical JSON encoding: keys sorted at every depth, arrays keeping order. */
    fun stableStringify(value: Any?): String = StringBuilder().also { writeStable(it, value) }.toString()

    /** The stable cache/dedup key for [value]. */
    fun stableWireKey(value: WireValue): String = stableStringify(Wire.encode(value))

    private fun writeStable(out: StringBuilder, value: Any?) {
        when (value) {
            null -> out.append("null")
            is Boolean -> out.append(if (value) "true" else "false")
            is Number -> out.append(formatNumber(value.toDouble()))
            is String -> out.append(jsonString(value))
            is List<*> -> {
                out.append('[')
                value.forEachIndexed { index, item ->
                    if (index > 0) out.append(',')
                    writeStable(out, item)
                }
                out.append(']')
            }
            is Map<*, *> -> {
                // The JVM's String.compareTo already compares UTF-16 code units,
                // which is exactly JavaScript's ordering — the only runtime in
                // this set needing no conversion. Go, Ruby, Rust and Swift each
                // required an explicit one.
                val keys = value.keys.map { it.toString() }.sorted()

                out.append('{')
                keys.forEachIndexed { index, key ->
                    if (index > 0) out.append(',')
                    out.append(jsonString(key))
                    out.append(':')
                    writeStable(out, value[key])
                }
                out.append('}')
            }
            else -> out.append("null")
        }
    }

    /**
     * Renders a double exactly as `String(v)` does in JavaScript.
     *
     * Kotlin's `toString` keeps a ".0" on integral values and writes "1.0E-5";
     * ECMAScript drops the decimal, stays positional between 1e-7 and 1e21, and
     * writes "1e-7".
     */
    fun formatNumber(value: Double): String {
        if (value.isNaN() || value.isInfinite()) return "null"

        if (value == Math.rint(value) && Math.abs(value) < 1e21) {
            return BigDecimal.valueOf(value).setScale(0, java.math.RoundingMode.HALF_UP).toBigInteger().toString()
        }

        val magnitude = Math.abs(value)

        if (magnitude >= 1e-6 && magnitude < 1e21) {
            return trimTrailingZeros(BigDecimal(value.toString()).toPlainString())
        }

        return exponential(value)
    }

    private fun exponential(value: Double): String {
        for (precision in 0..17) {
            // Locale.ROOT is load-bearing: the default locale decides the
            // decimal separator, so a German-locale JVM formats 1.5e-7 as
            // "1,5e-07" and produces a different subscription key than the same
            // code elsewhere. The Java port shipped this bug until a test caught it.
            val candidate = String.format(Locale.ROOT, "%.${precision}e", value)

            if (candidate.toDouble() == value) return normaliseExponent(candidate)
        }

        return normaliseExponent(String.format(Locale.ROOT, "%.17e", value))
    }

    /** "1.000000e-07" -> "1e-7": ECMAScript pads neither mantissa nor exponent. */
    private fun normaliseExponent(text: String): String {
        val marker = text.indexOf('e')

        if (marker < 0) return text

        val mantissa = trimTrailingZeros(text.substring(0, marker))
        var exponent = text.substring(marker + 1)
        val sign = if (exponent.startsWith("-")) "-" else "+"

        exponent = exponent.removePrefix("-").removePrefix("+").trimStart('0').ifEmpty { "0" }

        return "${mantissa}e$sign$exponent"
    }

    private fun trimTrailingZeros(text: String): String = if (!text.contains('.')) text else text.trimEnd('0').trimEnd('.')

    /** Quotes a string the way `JSON.stringify` does: `<`, `>`, `&`, U+2028/9 stay raw. */
    fun jsonString(value: String): String {
        val out = StringBuilder(value.length + 2)

        out.append('"')

        for (character in value) {
            when (character) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                else ->
                    if (character < ' ') {
                        out.append(String.format(Locale.ROOT, "\\u%04x", character.code))
                    } else {
                        out.append(character)
                    }
            }
        }

        out.append('"')

        return out.toString()
    }
}
