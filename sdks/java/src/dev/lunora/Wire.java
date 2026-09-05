package dev.lunora;

import java.math.BigInteger;
import java.util.AbstractMap;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The tagged value codec for Lunora's client↔server wire, ported from {@code shared/wire-codec.ts}.
 *
 * <p>The wire is JSON with no reviver; values JSON cannot carry (big integers, bytes, dates,
 * maps/sets, ±Infinity/NaN, {@code undefined} in an array position) become self-delimiting tagged
 * arrays whose first element is {@link #TAG}. Pure-JSON values encode to a structurally identical
 * tree.
 *
 * <p>{@link #decode} returns the wrapper types below so {@code encode(decode(x)) == x} holds for
 * every golden fixture — the conformance contract, asserted in {@code ConformanceTest}.
 *
 * <p>See {@code protocol/README.md} §2 for the normative grammar.
 */
public final class Wire {
    private Wire() {}

    /** Marks a JSON array as a tagged wire value. */
    public static final String TAG = "$lunora.wire$";

    /** Bounds recursion so a hostile deeply-nested payload cannot exhaust the stack. */
    public static final int MAX_DEPTH = 64;

    /**
     * Bounds a decoded big integer. Decimal parsing is superlinear, so an unbounded digit string
     * from an untrusted peer is a denial of service. Applied only on decode — the untrusted
     * direction.
     */
    public static final int MAX_BIGINT_DIGITS = 1024;

    /**
     * Largest integer a double holds exactly (2^53 - 1). JSON numbers are doubles, so an integer
     * past this cannot cross the wire as a number without changing value — {@link WireBigInt} and
     * its tag exist for that case.
     */
    public static final long MAX_EXACT_INTEGER = (1L << 53) - 1;

    /**
     * Largest epoch a Date holds (ECMAScript TimeClip). Past this, and for any non-finite epoch,
     * {@code new Date(v)} is an Invalid Date.
     */
    public static final double MAX_TIME_VALUE = 8.64e15;

    /**
     * {@code new Date(epoch).getTime()} — ECMAScript TimeClip.
     *
     * <p>A Date truncates its argument toward zero, and anything non-finite or past ±8.64e15
     * becomes an Invalid Date, which the reference re-encodes as a NaN tag. Kept verbatim, the
     * epoch went back on the wire as a date the reference's own Date can never hold.
     */
    static double timeClip(double epoch) {
        if (Double.isNaN(epoch) || Double.isInfinite(epoch) || Math.abs(epoch) > MAX_TIME_VALUE) {
            return Double.NaN;
        }

        double truncated = epoch < 0 ? Math.ceil(epoch) : Math.floor(epoch);

        // TimeClip is ToIntegerOrInfinity, not truncation, and the two differ on exactly one
        // window: an epoch in (-1, 0] gives +0 there and -0 here, because Math.ceil keeps the
        // sign of zero. The window is one value wide, and the stable subscription key spells
        // -0 as the bare token `-0`, distinct from `0` — so without this a Date built from
        // -0.5 opens a different subscription than the TS client's does.
        return truncated == 0 ? 0 : truncated;
    }

    /**
     * Whether an href carries a URL scheme, per RFC 3986: an ASCII letter followed by letters,
     * digits, {@code +}, {@code -} or {@code .}, then {@code :}.
     *
     * <p>The reference builds a real {@code URL}, which throws on anything unparseable, while every
     * port stored the string verbatim and accepted {@code "not a url"} — a frame that kills a JS
     * peer's subscription and is waved through here. Reproducing WHATWG URL parsing in eight
     * languages is not on offer (their own parsers disagree with it in the deep end), so the
     * contract, and {@code protocol/README.md} §2.1, is the floor of it: an href must be ABSOLUTE.
     */
    static boolean isAbsoluteHref(String href) {
        for (int index = 0; index < href.length(); index++) {
            char character = href.charAt(index);

            if (character == ':') {
                return index > 0;
            }

            boolean letter =
                    character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z';
            boolean tail =
                    index > 0
                            && (character >= '0' && character <= '9'
                                    || character == '+'
                                    || character == '-'
                                    || character == '.');

            if (!letter && !tail) {
                return false;
            }
        }

        return false;
    }

    /**
     * Bytes per element for the typed-array views the codec round-trips. A view whose payload is
     * not a whole number of elements is not a view the reference can rebuild — {@code new
     * Float32Array(buffer)} raises a RangeError there — so accepting it would hand the consumer
     * bytes it cannot reconstruct. {@code ArrayBuffer} is absent deliberately: it is untyped, so
     * there is nothing to align.
     */
    private static final Map<String, Integer> TYPED_ARRAY_ELEMENT_SIZES =
            Map.ofEntries(
                    Map.entry("BigInt64Array", 8),
                    Map.entry("BigUint64Array", 8),
                    Map.entry("Float32Array", 4),
                    Map.entry("Float64Array", 8),
                    Map.entry("Int16Array", 2),
                    Map.entry("Int32Array", 4),
                    Map.entry("Int8Array", 1),
                    Map.entry("Uint16Array", 2),
                    Map.entry("Uint32Array", 4),
                    Map.entry("Uint8Array", 1),
                    Map.entry("Uint8ClampedArray", 1));

    /**
     * JavaScript's {@code undefined}, distinct from JSON null.
     *
     * <p>As an object field it is dropped on encode (matching {@code JSON.stringify}); in an array
     * position it is preserved, because dropping it there would silently shift every later element.
     */
    public static final Object UNDEFINED =
            new Object() {
                @Override
                public String toString() {
                    return "UNDEFINED";
                }
            };

    /** A {@code v.bigint()}. {@link BigInteger} is arbitrary-precision, so no range is lost. */
    public record WireBigInt(BigInteger value) {}

    /** A Date, as epoch milliseconds. An invalid Date carries NaN and round-trips exactly. */
    public record WireDate(double epochMs) {}

    /** A URL, carried as its href. */
    public record WireUrl(String href) {}

    /** A Map: ordered pairs whose keys may be non-string. */
    public record WireMap(List<Map.Entry<Object, Object>> entries) {}

    /** A Set: ordered items. */
    public record WireSet(List<Object> items) {}

    /**
     * A typed-array view that is NOT a plain Uint8Array, carrying its constructor name so the exact
     * view type survives. Plain Uint8Array bytes use {@code byte[]} and the 2-element wire form.
     */
    public record WireBytes(byte[] data, String ctor) {}

    /** An Error: name, message, own props, optional cause. {@code stack} is deliberately absent. */
    public record WireError(String name, String message, Map<String, Object> props, Object cause) {}

    public static final class WireFormatException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public WireFormatException(String message) {
            super(message);
        }
    }

    /** Encode {@code value} into a JSON-safe tree, tagging the leaves JSON cannot carry. */
    public static Object encode(Object value) {
        return encode(value, 0);
    }

    private static Object encode(Object value, int depth) {
        if (depth > MAX_DEPTH) {
            throw new WireFormatException(
                    "wire-codec: value nesting exceeds the " + MAX_DEPTH + "-level limit");
        }

        if (value == UNDEFINED) {
            return List.of(TAG, "undefined");
        }

        if (value == null) {
            return null;
        }

        if (value instanceof Boolean || value instanceof String) {
            return value;
        }

        if (value instanceof WireBigInt bigInt) {
            return List.of(TAG, "bigint", bigInt.value().toString());
        }

        if (value instanceof WireDate date) {
            return listOf(TAG, "date", encode(date.epochMs(), depth + 1));
        }

        if (value instanceof WireUrl url) {
            return List.of(TAG, "url", url.href());
        }

        if (value instanceof WireError error) {
            return encodeError(error, depth);
        }

        if (value instanceof WireMap map) {
            List<Object> entries = new ArrayList<>();

            for (Map.Entry<Object, Object> entry : map.entries()) {
                entries.add(
                        listOf(
                                encode(entry.getKey(), depth + 1),
                                encode(entry.getValue(), depth + 1)));
            }

            return listOf(TAG, "map", entries);
        }

        if (value instanceof WireSet set) {
            List<Object> items = new ArrayList<>();

            for (Object item : set.items()) {
                items.add(encode(item, depth + 1));
            }

            return listOf(TAG, "set", items);
        }

        if (value instanceof WireBytes bytes) {
            return List.of(
                    TAG, "bytes", Base64.getEncoder().encodeToString(bytes.data()), bytes.ctor());
        }

        if (value instanceof byte[] data) {
            return List.of(TAG, "bytes", Base64.getEncoder().encodeToString(data));
        }

        if (value instanceof Double || value instanceof Float) {
            return encodeDouble(((Number) value).doubleValue());
        }

        if (value instanceof Number number) {
            return encodeInteger(number);
        }

        if (value instanceof List<?> items) {
            List<Object> encoded = new ArrayList<>(items.size());

            for (Object item : items) {
                encoded.add(encode(item, depth + 1));
            }

            // Escape a user array whose first element is literally the sentinel,
            // or the decoder would mistake it for a tagged value.
            if (!encoded.isEmpty() && TAG.equals(encoded.get(0))) {
                return listOf(TAG, "arr", encoded);
            }

            return encoded;
        }

        if (value instanceof Map<?, ?> fields) {
            Map<String, Object> result = new LinkedHashMap<>();

            for (Map.Entry<?, ?> entry : fields.entrySet()) {
                // Drop undefined fields, matching JSON.stringify, so a pure-JSON
                // object stays byte-identical across the codec.
                if (entry.getValue() == UNDEFINED) {
                    continue;
                }

                result.put(String.valueOf(entry.getKey()), encode(entry.getValue(), depth + 1));
            }

            return result;
        }

        throw new WireFormatException(
                "wire-codec: cannot encode a "
                        + value.getClass().getName()
                        + " over the Lunora wire — only plain values, List/Map, byte[], and the"
                        + " Wire* wrappers round-trip");
    }

    /**
     * A whole-number {@link Number} onto the wire.
     *
     * <p>A {@code long} holds integers a {@code double} cannot, so narrowing one silently changed
     * its value — the server received a different integer than the caller sent and neither end
     * could tell. Refuse, as the Go port does, and name the way across.
     */
    private static Object encodeInteger(Number number) {
        if (number instanceof BigInteger big) {
            if (big.bitLength() > 53) {
                throw outOfExactRange(big);
            }

            return big.doubleValue();
        }

        long value = number.longValue();

        if (value > MAX_EXACT_INTEGER || value < -MAX_EXACT_INTEGER) {
            throw outOfExactRange(value);
        }

        return (double) value;
    }

    private static WireFormatException outOfExactRange(Object value) {
        return new WireFormatException(
                "wire-codec: integer "
                        + value
                        + " exceeds the exact double range — wrap it in WireBigInt so it crosses"
                        + " the wire as a bigint tag");
    }

    private static Object encodeDouble(double value) {
        if (Double.isNaN(value)) {
            return List.of(TAG, "nan");
        }

        if (value == Double.POSITIVE_INFINITY) {
            return List.of(TAG, "inf");
        }

        if (value == Double.NEGATIVE_INFINITY) {
            return List.of(TAG, "-inf");
        }

        return value;
    }

    private static Object encodeError(WireError error, int depth) {
        Map<String, Object> props = new LinkedHashMap<>();

        if (error.props() != null) {
            for (Map.Entry<String, Object> entry : error.props().entrySet()) {
                if (entry.getValue() == UNDEFINED) {
                    continue;
                }

                props.put(entry.getKey(), encode(entry.getValue(), depth + 1));
            }
        }

        List<Object> encoded =
                new ArrayList<>(List.of(TAG, "error", error.name(), error.message(), props));

        // `cause` rides a positional slot; absent when unset, keeping the
        // 5-element form. UNDEFINED alone means unset — gating on null as well
        // conflated it with an explicitly-null cause, which the reference
        // encodes (it tests `cause !== undefined`), so `new Error(m, { cause:
        // null })` lost its 6th slot and came back as an error that never had
        // a cause. Decode supplies UNDEFINED for the 5-element form, so the
        // two stay distinguishable across a round trip.
        if (error.cause() != UNDEFINED) {
            encoded.add(encode(error.cause(), depth + 1));
        }

        return encoded;
    }

    /** Inverse of {@link #encode}: revive tagged leaves into the wrapper types. */
    public static Object decode(Object value) {
        return decode(value, 0);
    }

    private static Object decode(Object value, int depth) {
        if (depth > MAX_DEPTH) {
            throw new WireFormatException(
                    "wire-codec: value nesting exceeds the " + MAX_DEPTH + "-level limit");
        }

        if (value instanceof List<?> items) {
            if (!items.isEmpty() && TAG.equals(items.get(0))) {
                return decodeTagged(items, depth);
            }

            List<Object> decoded = new ArrayList<>(items.size());

            for (Object item : items) {
                decoded.add(decode(item, depth + 1));
            }

            return decoded;
        }

        if (value instanceof Map<?, ?> fields) {
            Map<String, Object> result = new LinkedHashMap<>();

            for (Map.Entry<?, ?> entry : fields.entrySet()) {
                result.put(String.valueOf(entry.getKey()), decode(entry.getValue(), depth + 1));
            }

            return result;
        }

        return value;
    }

    private static Object decodeTagged(List<?> items, int depth) {
        String name = items.size() > 1 && items.get(1) instanceof String text ? text : "";

        switch (name) {
            case "undefined":
                return UNDEFINED;
            case "nan":
                return Double.NaN;
            case "inf":
                return Double.POSITIVE_INFINITY;
            case "-inf":
                return Double.NEGATIVE_INFINITY;
            case "bigint":
                return decodeBigInt(items);
            case "date":
                return new WireDate(
                        timeClip(
                                asNumber(decode(payload(items, "date"), depth + 1), "date")
                                        .doubleValue()));
            case "url":
                {
                    String href = asString(payload(items, "url"), "url");

                    if (!isAbsoluteHref(href)) {
                        throw new WireFormatException("wire-codec: url href is not absolute");
                    }

                    return new WireUrl(href);
                }
            case "map":
                return decodeMap(items, depth);
            case "set":
                {
                    // The reference builds a real Set, which de-duplicates by
                    // SameValueZero and keeps the FIRST occurrence's position —
                    // the same rule as a Map's keys, so the same identity helper
                    // decides it. Carrying both copies re-encoded a set the
                    // reference would never emit.
                    List<Object> decoded = new ArrayList<>();
                    Set<String> seen = new HashSet<>();

                    for (Object item : asList(payload(items, "set"), "set")) {
                        Object value = decode(item, depth + 1);
                        String identity = mapKeyIdentity(value);

                        if (identity != null && !seen.add(identity)) {
                            continue;
                        }

                        decoded.add(value);
                    }

                    return new WireSet(decoded);
                }
            case "error":
                return decodeError(items, depth);
            case "bytes":
                return decodeBytes(items);
            case "arr":
                {
                    List<Object> decoded = new ArrayList<>();

                    for (Object item : asList(payload(items, "arr"), "arr")) {
                        decoded.add(decode(item, depth + 1));
                    }

                    return decoded;
                }
            default:
                {
                    // Unknown tag (forward compatibility): an ordinary array.
                    List<Object> decoded = new ArrayList<>();

                    for (Object item : items) {
                        decoded.add(decode(item, depth + 1));
                    }

                    return decoded;
                }
        }
    }

    private static Object decodeBigInt(List<?> items) {
        Object raw = items.size() > 2 ? items.get(2) : null;

        if (!(raw instanceof String digits)
                || digits.length() > MAX_BIGINT_DIGITS
                || !isBigIntLiteral(digits)) {
            throw new WireFormatException(
                    "wire-codec: invalid or over-long bigint (max "
                            + MAX_BIGINT_DIGITS
                            + " digits)");
        }

        return new WireBigInt(new BigInteger(digits));
    }

    private static Object decodeMap(List<?> items, int depth) {
        List<Map.Entry<Object, Object>> entries = new ArrayList<>();
        Map<String, Integer> seen = new HashMap<>();

        for (Object item : asList(payload(items, "map"), "map")) {
            // A truncated entry is a rejection, not a pair with a missing half:
            // `pair.get(1)` threw a bare IndexOutOfBoundsException straight out
            // of Wire.decode, so a caller catching WireFormatException around a
            // decode caught nothing at all. A LONGER entry is refused for the
            // same reason: the reference reads neither.
            if (!(item instanceof List<?> pair) || pair.size() != 2) {
                throw new WireFormatException("wire-codec: malformed map entry");
            }

            Object key = decode(pair.get(0), depth + 1);
            // SimpleEntry, not Map.entry: the latter is documented as rejecting
            // nulls in EITHER slot, and JSON carries null in both. `new Map([["k",
            // null]])` is an ordinary return value that the DO encodes and seven
            // clients decode, so this threw a NullPointerException on every frame
            // carrying one — and an NPE is not a WireFormatException, so it was
            // not even the rejection type the ports were aligned onto. It
            // surfaced as CODE_INVALID_FRAME "malformed wire value: null",
            // permanently, naming nothing.
            Map.Entry<Object, Object> entry =
                    new AbstractMap.SimpleEntry<>(key, decode(pair.get(1), depth + 1));
            String identity = mapKeyIdentity(key);

            // Last write wins, at the FIRST occurrence's position — the reference
            // builds a real Map, and Map.prototype.set on a key already present
            // overwrites the value in place rather than appending. Keeping both
            // entries left two peers of one deployment reading a different value from
            // identical bytes.
            if (identity != null) {
                Integer index = seen.get(identity);

                if (index != null) {
                    // Only the VALUE. Map.prototype.set on a key already present
                    // keeps the key it holds, so a later -0 never replaces the 0
                    // stored under it.
                    entries.set(
                            index,
                            new AbstractMap.SimpleEntry<>(
                                    entries.get(index).getKey(), entry.getValue()));

                    continue;
                }

                seen.put(identity, entries.size());
            }

            entries.add(entry);
        }

        return new WireMap(entries);
    }

    /**
     * A map key's collapse identity, or {@code null} when it never collapses.
     *
     * <p>The reference's {@code Map} compares keys by SameValueZero: primitives by value (NaN equal
     * to itself), everything else by reference — so two structurally identical {@code
     * WireDate}/bytes keys stay two entries there and must stay two here.
     */
    private static String mapKeyIdentity(Object key) {
        if (key == null) {
            return "null";
        }

        if (key == UNDEFINED) {
            return "undefined";
        }

        if (key instanceof Boolean flag) {
            return "bool:" + flag;
        }

        if (key instanceof String text) {
            return "str:" + text;
        }

        if (key instanceof WireBigInt bigInt) {
            return "big:" + bigInt.value();
        }

        if (key instanceof Number number) {
            // `+ 0.0` clears the sign of a zero and changes nothing else:
            // SameValueZero holds -0 equal to 0, while Double.toString keeps the
            // sign ("-0.0"), which made a signed zero its own key.
            double numeric = number.doubleValue() + 0.0;

            return Double.isNaN(numeric) ? "num:nan" : "num:" + numeric;
        }

        return null;
    }

    /** The tag's payload slot, or a typed rejection when the array is too short. */
    private static Object payload(List<?> items, String tag) {
        if (items.size() < 3) {
            throw new WireFormatException("wire-codec: malformed " + tag + " tag");
        }

        return items.get(2);
    }

    private static List<?> asList(Object value, String tag) {
        if (!(value instanceof List<?> items)) {
            throw new WireFormatException("wire-codec: malformed " + tag + " tag");
        }

        return items;
    }

    private static String asString(Object value, String tag) {
        if (!(value instanceof String text)) {
            throw new WireFormatException("wire-codec: malformed " + tag + " tag");
        }

        return text;
    }

    private static Number asNumber(Object value, String tag) {
        if (!(value instanceof Number number)) {
            throw new WireFormatException("wire-codec: malformed " + tag + " tag");
        }

        return number;
    }

    @SuppressWarnings("unchecked")
    private static Object decodeError(List<?> items, int depth) {
        if (items.size() < 4) {
            throw new WireFormatException("wire-codec: malformed error tag");
        }

        // The props slot is NOT optional, NOT nullable and NOT a primitive: the reference
        // reads it with Object.keys, which throws on a null or missing slot and ENUMERATES a
        // string/number/boolean/array — so [TAG,"error","E","m","ab"] would decode there with
        // the invented props {0:"a",1:"b"} while substituting an empty map accepted the same
        // frame here.
        if (items.size() < 5 || items.get(4) == null) {
            throw new WireFormatException("wire-codec: malformed error tag");
        }

        Object decodedProps = decode(items.get(4), depth + 1);

        if (!(decodedProps instanceof Map<?, ?>)) {
            throw new WireFormatException(
                    "wire-codec: malformed error tag — props must be an object");
        }

        Map<String, Object> props = (Map<String, Object>) decodedProps;
        Object cause = items.size() > 5 ? decode(items.get(5), depth + 1) : UNDEFINED;

        // Both label slots are type-CHECKED, like every other slot. Defaulting to "" accepted
        // the frame while erasing the error's identity, and the ports did not even agree on
        // that: two carried the non-string through verbatim. A slot that must hold a string
        // and does not is a malformed frame.
        if (!(items.get(2) instanceof String name) || !(items.get(3) instanceof String message)) {
            throw new WireFormatException(
                    "wire-codec: malformed error tag — name and message must be strings");
        }

        return new WireError(name, message, props, cause);
    }

    private static Object decodeBytes(List<?> items) {
        String encoded = asString(payload(items, "bytes"), "bytes");
        byte[] data;

        try {
            data = Base64.getDecoder().decode(encoded);
        } catch (IllegalArgumentException error) {
            // The JDK decoder's own unwrapped IllegalArgumentException escaped
            // Wire.decode, so the codec's rejection was not one of the codec's
            // own error types and a caller could not catch the set.
            throw new WireFormatException("wire-codec: invalid base64 in bytes tag");
        }

        // The payload must be CANONICAL, not merely decodable. The JDK's basic decoder infers
        // missing padding and ignores the unused low bits of a short final quantum, so "AQI"
        // and "AQJ=" both decoded here — the second one silently, into two bytes that re-encode
        // as "AQI=", different bytes than the peer wrote. Re-encoding and comparing is the whole
        // rule: the payload must be exactly what a conforming encoder would have written.
        if (!Base64.getEncoder().encodeToString(data).equals(encoded)) {
            throw new WireFormatException(
                    "wire-codec: bytes payload is not canonical padded base64");
        }

        String ctor = items.size() > 3 && items.get(3) instanceof String name ? name : "Uint8Array";

        // A plain Uint8Array is byte[] and re-encodes to the 2-element form;
        // every other view keeps its constructor name.
        if ("Uint8Array".equals(ctor)) {
            return data;
        }

        if (!"ArrayBuffer".equals(ctor)) {
            Integer size = TYPED_ARRAY_ELEMENT_SIZES.get(ctor);

            // An UNKNOWN ctor name decodes to raw bytes, dropping the name — the
            // forward-compat rule in protocol/README.md §2.1. Keeping it re-encoded a
            // 4-element form the reference emits as 3, so the same value relayed through
            // JS and through here produced different bytes, and therefore different
            // stable subscription keys.
            if (size == null) {
                return data;
            }

            if (data.length % size != 0) {
                throw new WireFormatException(
                        "wire-codec: "
                                + ctor
                                + " payload of "
                                + data.length
                                + " bytes is not a multiple of its "
                                + size
                                + "-byte element");
            }
        }

        return new WireBytes(data, ctor);
    }

    /** Whether {@code raw} is an optionally-negative run of ASCII digits. */
    private static boolean isBigIntLiteral(String raw) {
        String body = raw.startsWith("-") ? raw.substring(1) : raw;

        if (body.isEmpty()) {
            return false;
        }

        for (int index = 0; index < body.length(); index++) {
            if (body.charAt(index) < '0' || body.charAt(index) > '9') {
                return false;
            }
        }

        return true;
    }

    /** {@link List#of} rejects nulls, which a tagged date payload can legitimately be. */
    private static List<Object> listOf(Object... values) {
        List<Object> items = new ArrayList<>(values.length);

        for (Object value : values) {
            items.add(value);
        }

        return items;
    }
}
