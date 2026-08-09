package dev.lunora;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * A Lunora deployment client.
 *
 * <p>The HTTP poster and the socket frame sender are injected rather than
 * assumed, so the conformance suite runs with no network and a consumer keeps
 * its own HTTP stack, timeouts and WebSocket library instead of inheriting ours.
 */
public final class Client {
    /** The single endpoint every query/mutation/action posts to. */
    public static final String RPC_PATH = "/_lunora/rpc";
    /** The live-subscription endpoint. */
    public static final String WS_PATH = "/_lunora/ws";

    /**
     * Which RPC method a call dispatches to. Generated code emits these
     * constants rather than raw strings, so a typo in a target template is a
     * compile error instead of a read silently sent over the write path.
     */
    public enum Verb {
        QUERY,
        MUTATION,
        ACTION
    }

    /** Performs one POST. */
    public interface HttpPoster {
        Response post(String url, Map<String, String> headers, byte[] body);
    }

    /** One HTTP response: the status matters, see {@link #parseRpcResponse}. */
    public record Response(int status, String body) {}

    /** Writes one JSON frame to an open socket. */
    public interface FrameSender {
        void send(Map<String, Object> frame);
    }

    /** A coded error from an RPC error envelope. */
    public static final class ApiException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public final String code;
        public final transient Object data;

        public ApiException(String code, String message, Object data) {
            super(message);
            this.code = code;
            this.data = data;
        }
    }

    /** A subscription-scoped error the server pushed. */
    public record SubscriptionError(String code, String message) {}

    private final String baseUrl;
    private final HttpPoster poster;
    public String authToken;

    private FrameSender sender;
    private final Map<String, Subscription> subscriptions = new LinkedHashMap<>();
    private final Map<String, Shape> shapes = new LinkedHashMap<>();
    private final Map<String, Map<String, List<Map<String, Object>>>> pokes = new LinkedHashMap<>();
    private int nextId;
    private int nextShapeId;

    private static final class Subscription {
        final String functionPath;
        final Object args;
        final Consumer<Object> onData;
        final Consumer<SubscriptionError> onError;
        Object cursor;
        Object epoch;

        Subscription(String functionPath, Object args, Consumer<Object> onData, Consumer<SubscriptionError> onError) {
            this.functionPath = functionPath;
            this.args = args;
            this.onData = onData;
            this.onError = onError;
        }
    }

    private static final class Shape {
        final Map<String, Object> rows = new LinkedHashMap<>();
        final List<String> order = new ArrayList<>();
        final Consumer<List<Object>> onRows;
        final Consumer<SubscriptionError> onError;
        Object checkpoint;
        Object epoch;

        Shape(Consumer<List<Object>> onRows, Consumer<SubscriptionError> onError) {
            this.onRows = onRows;
            this.onError = onError;
        }
    }

    public Client(String baseUrl, HttpPoster poster) {
        this.baseUrl = baseUrl;
        this.poster = poster;
    }

    /** Registers the sender used for subscription frames. Call once the socket is open. */
    public void attachSocket(FrameSender sender) {
        this.sender = sender;
    }

    /** Builds the {@code POST /_lunora/rpc} body. {@code shardKey} is omitted when null. */
    public static Map<String, Object> buildRpcBody(String functionPath, Object args, String shardKey) {
        Map<String, Object> body = new LinkedHashMap<>();

        body.put("args", Wire.encode(args == null ? new LinkedHashMap<String, Object>() : args));
        body.put("functionPath", functionPath);

        if (shardKey != null) {
            body.put("shardKey", shardKey);
        }

        return body;
    }

    /**
     * Returns the decoded result, or throws {@link ApiException}.
     *
     * <p>{@code status} is required for correctness, not diagnostics:
     * {@code protocol/README.md} §4.2 says a non-2xx whose body carries no
     * {@code error} envelope surfaces as an INTERNAL transport error. Without it
     * a 502 with body {@code {"message":"…"}} returns null and throws nothing —
     * the caller believes its mutation committed.
     */
    @SuppressWarnings("unchecked")
    public static Object parseRpcResponse(Map<String, Object> body, int status) {
        Object envelope = body.get("error");

        if (envelope instanceof Map<?, ?> error) {
            Object rawData = ((Map<String, Object>) error).get("data");
            Object data = rawData == null ? null : Wire.decode(rawData);
            Object code = ((Map<String, Object>) error).get("code");
            Object message = ((Map<String, Object>) error).get("message");

            throw new ApiException(
                    code instanceof String text ? text : "INTERNAL",
                    message instanceof String text ? text : "request failed",
                    data);
        }

        if (status < 200 || status > 299) {
            throw new ApiException("INTERNAL", "HTTP " + status + " without an error envelope", null);
        }

        return Wire.decode(body.get("result"));
    }

    public Object query(String functionPath, Object args, String shardKey) {
        return rpc(functionPath, args, shardKey, null);
    }

    public Object mutation(String functionPath, Object args, String shardKey, String mutationId) {
        return rpc(functionPath, args, shardKey, mutationId);
    }

    /**
     * Same envelope as a mutation, but never an idempotency key: an action
     * performs external side effects and is not replayed against the shard, so
     * claiming mutation-style de-duplication for it would be a lie.
     */
    public Object action(String functionPath, Object args, String shardKey) {
        return rpc(functionPath, args, shardKey, null);
    }

    /** Dispatches on {@code verb}, which is what lets generated code stay uniform. */
    public Object call(Verb verb, String functionPath, Object args, String shardKey) {
        return switch (verb) {
            case QUERY -> query(functionPath, args, shardKey);
            case ACTION -> action(functionPath, args, shardKey);
            case MUTATION -> mutation(functionPath, args, shardKey, null);
        };
    }

    @SuppressWarnings("unchecked")
    private Object rpc(String functionPath, Object args, String shardKey, String mutationId) {
        if (poster == null) {
            throw new ApiException("INTERNAL", "no HTTP poster configured", null);
        }

        Map<String, String> headers = new LinkedHashMap<>();

        headers.put("content-type", "application/json");

        if (authToken != null) {
            headers.put("authorization", "Bearer " + authToken);
        }

        if (mutationId != null) {
            headers.put("x-lunora-mutation-id", mutationId);
        }

        String payload = Json.write(buildRpcBody(functionPath, args, shardKey));
        Response response = poster.post(join(RPC_PATH), headers, payload.getBytes(StandardCharsets.UTF_8));

        return parseRpcResponse((Map<String, Object>) Json.parse(response.body()), response.status());
    }

    public static Map<String, Object> buildConnectFrame(String clientId, Map<String, Object> context) {
        Map<String, Object> frame = new LinkedHashMap<>();

        frame.put("id", "connect");
        frame.put("type", "connect");

        if (clientId != null) {
            frame.put("clientId", clientId);
        }

        if (context != null) {
            frame.put("context", context);
        }

        return frame;
    }

    public static Map<String, Object> buildSubscribeFrame(
            String id, String functionPath, Object args, String table, Object sinceSeq, Object sinceEpoch) {
        Map<String, Object> query = new LinkedHashMap<>();

        query.put("args", Wire.encode(args == null ? new LinkedHashMap<String, Object>() : args));
        query.put("functionPath", functionPath);
        query.put("table", table == null ? functionPath : table);

        if (sinceSeq != null) {
            query.put("sinceSeq", sinceSeq);
        }

        if (sinceEpoch != null) {
            query.put("sinceEpoch", sinceEpoch);
        }

        Map<String, Object> frame = new LinkedHashMap<>();

        frame.put("id", id);
        frame.put("query", query);
        frame.put("type", "subscribe");

        return frame;
    }

    public static Map<String, Object> buildUnsubscribeFrame(String id) {
        Map<String, Object> frame = new LinkedHashMap<>();

        frame.put("id", id);
        frame.put("type", "unsubscribe");

        return frame;
    }

    public static Map<String, Object> buildShapeSubscribeFrame(
            String id, String name, Object args, Object sinceCheckpoint, Object sinceEpoch) {
        Map<String, Object> shape = new LinkedHashMap<>();

        shape.put("name", name);

        if (args != null) {
            shape.put("args", Wire.encode(args));
        }

        Map<String, Object> frame = new LinkedHashMap<>();

        frame.put("id", id);
        frame.put("shape", shape);
        frame.put("type", "shape_subscribe");

        if (sinceCheckpoint != null) {
            frame.put("sinceCheckpoint", sinceCheckpoint);
        }

        if (sinceEpoch != null) {
            frame.put("sinceEpoch", sinceEpoch);
        }

        return frame;
    }

    public static Map<String, Object> buildShapeUnsubscribeFrame(String id) {
        Map<String, Object> frame = new LinkedHashMap<>();

        frame.put("id", id);
        frame.put("type", "shape_unsubscribe");

        return frame;
    }

    /**
     * Opens a live query.
     *
     * <p>{@code shardKey} does NOT ride the subscribe frame: the protocol
     * selects a shard per SOCKET, via the {@code ?shard=} parameter
     * {@link #wsUrl} builds. It is accepted so the generated surface is
     * identical across languages, and is otherwise unused — this client holds
     * one socket, so it must already be the shard that socket was opened
     * against.
     */
    public Runnable subscribe(
            String functionPath, Object args, Consumer<Object> onData, Consumer<SubscriptionError> onError, String shardKey) {
        nextId++;

        String id = "sub_" + nextId;

        subscriptions.put(id, new Subscription(functionPath, args, onData, onError));

        if (sender != null) {
            sender.send(buildSubscribeFrame(id, functionPath, args, null, null, null));
        }

        return () -> {
            subscriptions.remove(id);

            if (sender != null) {
                sender.send(buildUnsubscribeFrame(id));
            }
        };
    }

    /**
     * Opens a partially-replicated keyed view. {@code onRows} fires once per
     * applied poke with the view's full contents, in insertion order.
     */
    public Runnable subscribeShape(String name, Object args, Consumer<List<Object>> onRows, Consumer<SubscriptionError> onError) {
        nextShapeId++;

        String id = "shape_" + nextShapeId;

        shapes.put(id, new Shape(onRows, onError));

        if (sender != null) {
            sender.send(buildShapeSubscribeFrame(id, name, args, null, null));
        }

        return () -> {
            shapes.remove(id);

            if (sender != null) {
                sender.send(buildShapeUnsubscribeFrame(id));
            }
        };
    }

    /** Re-subscribes everything after a reconnect, carrying each resume cursor. */
    public void resendSubscriptions() {
        if (sender == null) {
            return;
        }

        for (Map.Entry<String, Subscription> entry : subscriptions.entrySet()) {
            Subscription subscription = entry.getValue();

            sender.send(buildSubscribeFrame(
                    entry.getKey(), subscription.functionPath, subscription.args, null, subscription.cursor, subscription.epoch));
        }
    }

    /**
     * Applies one server frame and returns its type. Unknown types are ignored,
     * per the protocol's forward-compatibility rule.
     */
    @SuppressWarnings("unchecked")
    public String handleFrame(String raw) {
        if ("lunora-ping".equals(raw) || "lunora-pong".equals(raw)) {
            return null;
        }

        Map<String, Object> frame;

        try {
            frame = (Map<String, Object>) Json.parse(raw);
        } catch (RuntimeException error) {
            // Non-JSON frames are ignored by the client parser, not fatal.
            return null;
        }

        String kind = frame.get("type") instanceof String text ? text : "";
        String id = frame.get("id") instanceof String text ? text : "";
        Subscription entry = subscriptions.get(id);

        switch (kind) {
            case "data", "delta" -> {
                Object payload = frame.get("data") != null ? frame.get("data") : frame.get("delta");
                Object value = Wire.decode(payload);

                if (entry != null) {
                    advance(entry, frame);

                    if (entry.onData != null) {
                        entry.onData.accept(value);
                    }
                }
            }
            case "resume", "settled" -> {
                if (entry != null) {
                    advance(entry, frame);
                }
            }
            case "error" -> {
                Map<String, Object> envelope =
                        frame.get("error") instanceof Map<?, ?> map ? (Map<String, Object>) map : new LinkedHashMap<>();
                String message = frame.get("message") instanceof String text
                        ? text
                        : envelope.get("message") instanceof String inner ? inner : "subscription error";
                SubscriptionError error =
                        new SubscriptionError(envelope.get("code") instanceof String code ? code : null, message);

                if (entry != null && entry.onError != null) {
                    entry.onError.accept(error);
                }

                Shape shape = shapes.get(id);

                if (shape != null && shape.onError != null) {
                    shape.onError.accept(error);
                }
            }
            case "complete" -> subscriptions.remove(id);
            case "pokeStart" -> pokes.put(String.valueOf(frame.get("pokeId")), new LinkedHashMap<>());
            case "pokePart" -> bufferPokePart(frame);
            case "pokeEnd" -> applyPoke(frame);
            default -> {
                // Ignored.
            }
        }

        return kind;
    }

    private static void advance(Subscription entry, Map<String, Object> frame) {
        if (frame.containsKey("cursor")) {
            entry.cursor = frame.get("cursor");
        }

        if (frame.containsKey("epoch")) {
            entry.epoch = frame.get("epoch");
        }
    }

    /**
     * Parts buffer until {@code pokeEnd}: a poke is an atomic batch, so applying
     * them as they arrive would expose a torn view, and a socket dropping
     * mid-poke would leave it permanently half-applied.
     */
    @SuppressWarnings("unchecked")
    private void bufferPokePart(Map<String, Object> frame) {
        Map<String, List<Map<String, Object>>> buffer = pokes.get(String.valueOf(frame.get("pokeId")));

        // A part for an unknown poke is dropped: without its pokeStart there is
        // no batch to join, and guessing would apply a fragment of one.
        if (buffer == null) {
            return;
        }

        List<Map<String, Object>> operations = new ArrayList<>();

        if (frame.get("rowsPatch") instanceof List<?> rows) {
            for (Object row : rows) {
                if (row instanceof Map<?, ?> operation) {
                    operations.add((Map<String, Object>) operation);
                }
            }
        }

        buffer.computeIfAbsent(String.valueOf(frame.get("shapeId")), key -> new ArrayList<>()).addAll(operations);
    }

    private void applyPoke(Map<String, Object> frame) {
        Map<String, List<Map<String, Object>>> buffer = pokes.remove(String.valueOf(frame.get("pokeId")));

        if (buffer == null) {
            return;
        }

        for (Map.Entry<String, List<Map<String, Object>>> entry : buffer.entrySet()) {
            Shape shape = shapes.get(entry.getKey());

            if (shape == null) {
                continue;
            }

            for (Map<String, Object> operation : entry.getValue()) {
                String key = String.valueOf(operation.get("key"));

                if ("delete".equals(operation.get("op"))) {
                    if (shape.rows.remove(key) != null) {
                        shape.order.remove(key);
                    }

                    continue;
                }

                Object value = operation.get("value");

                // A value-less upsert is membership-only; it must not blank an
                // existing row.
                if (value == null) {
                    continue;
                }

                if (!shape.rows.containsKey(key)) {
                    shape.order.add(key);
                }

                shape.rows.put(key, Wire.decode(value));
            }

            if (frame.containsKey("checkpoint")) {
                shape.checkpoint = frame.get("checkpoint");
            }

            if (frame.containsKey("epoch")) {
                shape.epoch = frame.get("epoch");
            }

            if (shape.onRows != null) {
                List<Object> rows = new ArrayList<>();

                for (String key : shape.order) {
                    rows.add(shape.rows.get(key));
                }

                shape.onRows.accept(rows);
            }
        }
    }

    /**
     * The socket URL: the origin with its scheme swapped, plus the shard and
     * credential query parameters when present.
     */
    public String wsUrl(String shardKey, String token) {
        String endpoint = join(WS_PATH);

        if (endpoint.startsWith("https://")) {
            endpoint = "wss://" + endpoint.substring("https://".length());
        } else if (endpoint.startsWith("http://")) {
            endpoint = "ws://" + endpoint.substring("http://".length());
        }

        List<String> params = new ArrayList<>();

        if (shardKey != null) {
            params.add("shard=" + URLEncoder.encode(shardKey, StandardCharsets.UTF_8));
        }

        if (token != null) {
            params.add("token=" + URLEncoder.encode(token, StandardCharsets.UTF_8));
        }

        if (params.isEmpty()) {
            return endpoint;
        }

        return endpoint + (endpoint.contains("?") ? "&" : "?") + String.join("&", params);
    }

    private String join(String path) {
        return (baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl) + path;
    }
}
