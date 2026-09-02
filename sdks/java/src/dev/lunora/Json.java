package dev.lunora;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A minimal JSON reader/writer.
 *
 * <p>Hand-rolled because Java SE ships no JSON at all, and pulling Jackson or Gson in would make
 * the transport's only dependency a parser it barely uses. The risk that usually makes hand-rolling
 * a bad idea does not apply here: the golden fixtures under {@code protocol/fixtures} are
 * themselves a demanding parser suite, so a mistake in this file fails the conformance tests rather
 * than hiding.
 *
 * <p>Values map to plain Java types, matching every other Lunora port: {@code null}, {@link
 * Boolean}, {@link Double}, {@link String}, {@code List<Object>} and {@code LinkedHashMap<String,
 * Object>} (insertion ordered, because object field order must survive a round trip).
 */
public final class Json {
    /**
     * Levels of ENVELOPE a wire value can sit under before its own nesting starts. Every payload
     * arrives wrapped: {@code {"result": V}} is one, and the two deepest — a batch response {@code
     * {"results":[{"result": V}]}} and a poke part {@code {"rowsPatch":[{"value": V}]}} — are
     * three.
     */
    private static final int MAX_ENVELOPE_DEPTH = 3;

    /**
     * The parser's own nesting cap, counted from the DOCUMENT root.
     *
     * <p>It cannot be {@link Wire#MAX_DEPTH} directly: that bounds a wire VALUE, whose root is
     * already {@link #MAX_ENVELOPE_DEPTH} levels into the frame carrying it, so charging the
     * envelope against the value's budget refused frames whose payload the reference encodes
     * happily. The cap is here to keep a hostile frame off the stack, and a few extra levels cost
     * nothing against that.
     */
    static final int MAX_DEPTH = Wire.MAX_DEPTH + MAX_ENVELOPE_DEPTH;

    private Json() {}

    public static Object parse(String text) {
        Parser parser = new Parser(text);
        Object value = parser.readValue();

        parser.skipWhitespace();

        if (!parser.atEnd()) {
            throw new IllegalArgumentException("json: trailing content at offset " + parser.offset);
        }

        return value;
    }

    public static String write(Object value) {
        StringBuilder out = new StringBuilder();

        writeValue(out, value);

        return out.toString();
    }

    private static void writeValue(StringBuilder out, Object value) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof Boolean bool) {
            out.append(bool ? "true" : "false");
        } else if (value instanceof Number number) {
            out.append(Key.formatNumber(number.doubleValue()));
        } else if (value instanceof String text) {
            out.append(Key.jsonString(text));
        } else if (value instanceof List<?> items) {
            out.append('[');

            for (int index = 0; index < items.size(); index++) {
                if (index > 0) {
                    out.append(',');
                }

                writeValue(out, items.get(index));
            }

            out.append(']');
        } else if (value instanceof Map<?, ?> fields) {
            out.append('{');

            boolean first = true;

            for (Map.Entry<?, ?> entry : fields.entrySet()) {
                if (!first) {
                    out.append(',');
                }

                first = false;
                out.append(Key.jsonString(String.valueOf(entry.getKey())));
                out.append(':');
                writeValue(out, entry.getValue());
            }

            out.append('}');
        } else {
            throw new IllegalArgumentException(
                    "json: cannot write a " + value.getClass().getName());
        }
    }

    private static final class Parser {
        private final String text;
        private int offset;
        private int depth;

        Parser(String text) {
            this.text = text;
        }

        boolean atEnd() {
            return offset >= text.length();
        }

        void skipWhitespace() {
            while (offset < text.length() && Character.isWhitespace(text.charAt(offset))) {
                offset++;
            }
        }

        Object readValue() {
            skipWhitespace();

            if (atEnd()) {
                throw new IllegalArgumentException("json: unexpected end of input");
            }

            // Bounded here, not after parsing. Wire.MAX_DEPTH is applied to the
            // decoded tree and so never sees the payload; without this, a deeply
            // nested frame overflows the stack — and StackOverflowError is an
            // Error, which Client.handleFrame's `catch (RuntimeException)`
            // cannot catch, so it escapes onto the socket reader thread.
            if (depth > MAX_DEPTH) {
                throw new IllegalArgumentException(
                        "json: nesting exceeds the " + MAX_DEPTH + "-level limit");
            }

            char character = text.charAt(offset);

            return switch (character) {
                case '{' -> readObject();
                case '[' -> readArray();
                case '"' -> readString();
                case 't' -> readLiteral("true", Boolean.TRUE);
                case 'f' -> readLiteral("false", Boolean.FALSE);
                case 'n' -> readLiteral("null", null);
                default -> readNumber();
            };
        }

        private Object readLiteral(String literal, Object value) {
            if (!text.startsWith(literal, offset)) {
                throw new IllegalArgumentException("json: invalid literal at offset " + offset);
            }

            offset += literal.length();

            return value;
        }

        private Map<String, Object> readObject() {
            Map<String, Object> fields = new LinkedHashMap<>();

            depth++;
            offset++; // '{'
            skipWhitespace();

            if (!atEnd() && text.charAt(offset) == '}') {
                offset++;
                depth--;

                return fields;
            }

            while (true) {
                skipWhitespace();

                String key = readString();

                skipWhitespace();

                if (atEnd() || text.charAt(offset) != ':') {
                    throw new IllegalArgumentException("json: expected ':' at offset " + offset);
                }

                offset++;
                fields.put(key, readValue());
                skipWhitespace();

                if (atEnd()) {
                    throw new IllegalArgumentException("json: unterminated object");
                }

                char character = text.charAt(offset++);

                if (character == '}') {
                    depth--;

                    return fields;
                }

                if (character != ',') {
                    throw new IllegalArgumentException(
                            "json: expected ',' or '}' at offset " + (offset - 1));
                }
            }
        }

        private List<Object> readArray() {
            List<Object> items = new ArrayList<>();

            depth++;
            offset++; // '['
            skipWhitespace();

            if (!atEnd() && text.charAt(offset) == ']') {
                offset++;
                depth--;

                return items;
            }

            while (true) {
                items.add(readValue());
                skipWhitespace();

                if (atEnd()) {
                    throw new IllegalArgumentException("json: unterminated array");
                }

                char character = text.charAt(offset++);

                if (character == ']') {
                    depth--;

                    return items;
                }

                if (character != ',') {
                    throw new IllegalArgumentException(
                            "json: expected ',' or ']' at offset " + (offset - 1));
                }
            }
        }

        private String readString() {
            if (atEnd() || text.charAt(offset) != '"') {
                throw new IllegalArgumentException("json: expected a string at offset " + offset);
            }

            offset++;

            StringBuilder out = new StringBuilder();

            while (true) {
                if (atEnd()) {
                    throw new IllegalArgumentException("json: unterminated string");
                }

                char character = text.charAt(offset++);

                if (character == '"') {
                    return out.toString();
                }

                if (character != '\\') {
                    out.append(character);

                    continue;
                }

                if (atEnd()) {
                    throw new IllegalArgumentException("json: truncated escape");
                }

                char escape = text.charAt(offset++);

                switch (escape) {
                    case '"' -> out.append('"');
                    case '\\' -> out.append('\\');
                    case '/' -> out.append('/');
                    case 'b' -> out.append('\b');
                    case 'f' -> out.append('\f');
                    case 'n' -> out.append('\n');
                    case 'r' -> out.append('\r');
                    case 't' -> out.append('\t');
                    case 'u' -> {
                        // Surrogate pairs arrive as two consecutive \\u escapes and
                        // are appended as-is; Java strings are UTF-16, so the pair
                        // reassembles itself.
                        if (offset + 4 > text.length()) {
                            throw new IllegalArgumentException("json: truncated \\u escape");
                        }

                        try {
                            out.append(
                                    (char)
                                            Integer.parseInt(
                                                    text.substring(offset, offset + 4), 16));
                        } catch (NumberFormatException error) {
                            throw new IllegalArgumentException("json: invalid \\u escape", error);
                        }

                        offset += 4;
                    }
                    default ->
                            throw new IllegalArgumentException("json: invalid escape \\" + escape);
                }
            }
        }

        private Double readNumber() {
            int start = offset;

            if (!atEnd() && (text.charAt(offset) == '-' || text.charAt(offset) == '+')) {
                offset++;
            }

            while (!atEnd()) {
                char character = text.charAt(offset);

                if (Character.isDigit(character)
                        || character == '.'
                        || character == 'e'
                        || character == 'E'
                        || character == '+'
                        || character == '-') {
                    offset++;
                } else {
                    break;
                }
            }

            if (start == offset) {
                throw new IllegalArgumentException("json: expected a number at offset " + start);
            }

            return Double.valueOf(text.substring(start, offset));
        }
    }
}
