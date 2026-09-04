package dev.lunora;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The stable subscription key, ported from {@code shared/stable-key.ts}.
 *
 * <p>A key is compared verbatim against one produced by the reference TypeScript client, so every
 * spelling here must match ECMAScript exactly — a mismatch silently splits one subscription into
 * two.
 */
public final class Key {
    private Key() {}

    /**
     * Canonical JSON encoding of a pure-JSON tree: object keys sorted at every depth, arrays
     * keeping their order, null fields kept, {@link Wire#UNDEFINED} object fields dropped.
     *
     * <p>Runs on the OUTPUT of {@link Wire#encode}, so it only ever sees
     * null/Boolean/Double/String/List/Map.
     */
    public static String stableStringify(Object value) {
        StringBuilder out = new StringBuilder();

        writeStable(out, value);

        return out.toString();
    }

    /** The stable cache/dedup key for {@code value}. */
    public static String stableWireKey(Object value) {
        return stableStringify(Wire.encode(value));
    }

    private static void writeStable(StringBuilder out, Object value) {
        if (value == null || value == Wire.UNDEFINED) {
            out.append("null");
        } else if (value instanceof Boolean bool) {
            out.append(bool ? "true" : "false");
        } else if (value instanceof Number number) {
            out.append(formatNumber(number.doubleValue()));
        } else if (value instanceof String text) {
            out.append(jsonString(text));
        } else if (value instanceof List<?> items) {
            out.append('[');

            for (int index = 0; index < items.size(); index++) {
                if (index > 0) {
                    out.append(',');
                }

                writeStable(out, items.get(index));
            }

            out.append(']');
        } else if (value instanceof Map<?, ?> fields) {
            writeStableObject(out, fields);
        } else {
            out.append("null");
        }
    }

    private static void writeStableObject(StringBuilder out, Map<?, ?> fields) {
        List<String> keys = new ArrayList<>();

        for (Map.Entry<?, ?> entry : fields.entrySet()) {
            if (entry.getValue() == Wire.UNDEFINED) {
                continue;
            }

            keys.add(String.valueOf(entry.getKey()));
        }

        // Java's String.compareTo already compares UTF-16 code units, which is
        // exactly JavaScript's ordering — the one place the JVM needs no
        // adjustment where Go, Ruby, Rust and Swift all did.
        keys.sort(String::compareTo);
        out.append('{');

        for (int index = 0; index < keys.size(); index++) {
            if (index > 0) {
                out.append(',');
            }

            String key = keys.get(index);

            out.append(jsonString(key));
            out.append(':');
            writeStable(out, fields.get(key));
        }

        out.append('}');
    }

    /**
     * Renders a double exactly as {@code String(v)} does in JavaScript, which is what {@code
     * JSON.stringify} emits for a finite number.
     *
     * <p>Java's {@code Double.toString} always keeps a ".0" on integral values and switches to
     * exponent form outside 1e-3..1e7 spelled "1.0E-5"; ECMAScript drops the decimal, stays
     * positional between 1e-7 and 1e21, and writes "1e-7". The spellings must match or the key
     * differs.
     */
    static String formatNumber(double value) {
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            return "null";
        }

        // Negative zero keeps its sign in a key — stableStringify emits the bare
        // token "-0" — and every integer conversion below drops it.
        if (value == 0.0 && 1.0 / value < 0.0) {
            return "-0";
        }

        if (value == Math.rint(value) && Math.abs(value) < 1e21) {
            return BigDecimal.valueOf(value)
                    .setScale(0, java.math.RoundingMode.HALF_UP)
                    .toBigInteger()
                    .toString();
        }

        double magnitude = Math.abs(value);

        if (magnitude >= 1e-6 && magnitude < 1e21) {
            return trimTrailingZeros(new BigDecimal(Double.toString(value)).toPlainString());
        }

        return exponential(value);
    }

    private static String exponential(double value) {
        for (int precision = 0; precision <= 17; precision++) {
            // Locale.ROOT is load-bearing, not tidiness: the default locale
            // decides the decimal separator, so on a German-locale JVM this
            // formats 1.5e-7 as "1,5e-07" — which then fails to parse back and,
            // worse, would produce a different subscription key than the same
            // code on an English-locale machine.
            String candidate = String.format(Locale.ROOT, "%." + precision + "e", value);

            if (Double.parseDouble(candidate) == value) {
                return normaliseExponent(candidate);
            }
        }

        return normaliseExponent(String.format(Locale.ROOT, "%.17e", value));
    }

    /** "1.000000e-07" -&gt; "1e-7": ECMAScript pads neither the mantissa nor the exponent. */
    private static String normaliseExponent(String text) {
        int marker = text.indexOf('e');

        if (marker < 0) {
            return text;
        }

        String mantissa = trimTrailingZeros(text.substring(0, marker));
        String exponent = text.substring(marker + 1);
        String sign = exponent.startsWith("-") ? "-" : "+";

        if (exponent.startsWith("-") || exponent.startsWith("+")) {
            exponent = exponent.substring(1);
        }

        exponent = exponent.replaceFirst("^0+(?=\\d)", "");

        return mantissa + "e" + sign + exponent;
    }

    private static String trimTrailingZeros(String text) {
        if (!text.contains(".")) {
            return text;
        }

        String trimmed = text.replaceFirst("0+$", "");

        return trimmed.endsWith(".") ? trimmed.substring(0, trimmed.length() - 1) : trimmed;
    }

    /**
     * Quotes a string the way {@code JSON.stringify} does: {@code <}, {@code >}, {@code &}, U+2028
     * and U+2029 all stay raw.
     */
    static String jsonString(String value) {
        StringBuilder out = new StringBuilder(value.length() + 2);

        out.append('"');

        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);

            switch (character) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                default -> {
                    if (character < 0x20) {
                        out.append(String.format(Locale.ROOT, "\\u%04x", (int) character));
                    } else {
                        out.append(character);
                    }
                }
            }
        }

        out.append('"');

        return out.toString();
    }
}
