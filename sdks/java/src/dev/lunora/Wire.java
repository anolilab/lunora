package dev.lunora;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The tagged value codec for Lunora's client↔server wire, ported from
 * {@code shared/wire-codec.ts}.
 *
 * <p>The wire is JSON with no reviver; values JSON cannot carry (big integers,
 * bytes, dates, maps/sets, ±Infinity/NaN, {@code undefined} in an array
 * position) become self-delimiting tagged arrays whose first element is
 * {@link #TAG}. Pure-JSON values encode to a structurally identical tree.
 *
 * <p>{@link #decode} returns the wrapper types below so
 * {@code encode(decode(x)) == x} holds for every golden fixture — the
 * conformance contract, asserted in {@code ConformanceTest}.
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
     * Bounds a decoded big integer. Decimal parsing is superlinear, so an
     * unbounded digit string from an untrusted peer is a denial of service.
     * Applied only on decode — the untrusted direction.
     */
    public static final int MAX_BIGINT_DIGITS = 1024;

    /**
     * JavaScript's {@code undefined}, distinct from JSON null.
     *
     * <p>As an object field it is dropped on encode (matching
     * {@code JSON.stringify}); in an array position it is preserved, because
     * dropping it there would silently shift every later element.
     */
    public static final Object UNDEFINED = new Object() {
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
     * A typed-array view that is NOT a plain Uint8Array, carrying its
     * constructor name so the exact view type survives. Plain Uint8Array bytes
     * use {@code byte[]} and the 2-element wire form.
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
            throw new WireFormatException("wire-codec: value nesting exceeds the " + MAX_DEPTH + "-level limit");
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
                entries.add(listOf(encode(entry.getKey(), depth + 1), encode(entry.getValue(), depth + 1)));
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
            return List.of(TAG, "bytes", Base64.getEncoder().encodeToString(bytes.data()), bytes.ctor());
        }

        if (value instanceof byte[] data) {
            return List.of(TAG, "bytes", Base64.getEncoder().encodeToString(data));
        }

        if (value instanceof Double || value instanceof Float) {
            return encodeDouble(((Number) value).doubleValue());
        }

        if (value instanceof Number number) {
            return number.doubleValue();
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

        throw new WireFormatException("wire-codec: cannot encode a " + value.getClass().getName()
                + " over the Lunora wire — only plain values, List/Map, byte[], and the Wire* wrappers round-trip");
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

        List<Object> encoded = new ArrayList<>(List.of(TAG, "error", error.name(), error.message(), props));

        // `cause` rides a positional slot; absent when unset, keeping the
        // 5-element form.
        if (error.cause() != null && error.cause() != UNDEFINED) {
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
            throw new WireFormatException("wire-codec: value nesting exceeds the " + MAX_DEPTH + "-level limit");
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
                return new WireDate(((Number) decode(items.get(2), depth + 1)).doubleValue());
            case "url":
                return new WireUrl((String) items.get(2));
            case "map":
                return decodeMap(items, depth);
            case "set": {
                List<Object> decoded = new ArrayList<>();

                for (Object item : (List<?>) items.get(2)) {
                    decoded.add(decode(item, depth + 1));
                }

                return new WireSet(decoded);
            }
            case "error":
                return decodeError(items, depth);
            case "bytes":
                return decodeBytes(items);
            case "arr": {
                List<Object> decoded = new ArrayList<>();

                for (Object item : (List<?>) items.get(2)) {
                    decoded.add(decode(item, depth + 1));
                }

                return decoded;
            }
            default: {
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

        if (!(raw instanceof String digits) || digits.length() > MAX_BIGINT_DIGITS || !isBigIntLiteral(digits)) {
            throw new WireFormatException("wire-codec: invalid or over-long bigint (max " + MAX_BIGINT_DIGITS + " digits)");
        }

        return new WireBigInt(new BigInteger(digits));
    }

    private static Object decodeMap(List<?> items, int depth) {
        List<Map.Entry<Object, Object>> entries = new ArrayList<>();

        for (Object item : (List<?>) items.get(2)) {
            List<?> pair = (List<?>) item;

            entries.add(Map.entry(decode(pair.get(0), depth + 1), decode(pair.get(1), depth + 1)));
        }

        return new WireMap(entries);
    }

    @SuppressWarnings("unchecked")
    private static Object decodeError(List<?> items, int depth) {
        Map<String, Object> props = items.size() > 4
                ? (Map<String, Object>) decode(items.get(4), depth + 1)
                : new LinkedHashMap<>();
        Object cause = items.size() > 5 ? decode(items.get(5), depth + 1) : UNDEFINED;

        return new WireError((String) items.get(2), (String) items.get(3), props, cause);
    }

    private static Object decodeBytes(List<?> items) {
        byte[] data = Base64.getDecoder().decode((String) items.get(2));
        String ctor = items.size() > 3 && items.get(3) instanceof String name ? name : "Uint8Array";

        // A plain Uint8Array is byte[] and re-encodes to the 2-element form;
        // every other view keeps its constructor name.
        return "Uint8Array".equals(ctor) ? data : new WireBytes(data, ctor);
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
