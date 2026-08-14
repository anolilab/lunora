package dev.lunora;

import dev.lunora.Offline.Identity;
import dev.lunora.Offline.OfflineException;
import dev.lunora.Offline.OfflineQueue;
import dev.lunora.Offline.QueuedMutation;
import dev.lunora.Optimistic.LocalStore;
import dev.lunora.Optimistic.QueryEntry;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * A Lunora deployment client.
 *
 * <p>The HTTP poster and the socket frame sender are injected rather than assumed, so the
 * conformance suite runs with no network and a consumer keeps its own HTTP stack, timeouts and
 * WebSocket library instead of inheriting ours.
 */
public final class Client {
    /** The single endpoint every query/mutation/action posts to. */
    public static final String RPC_PATH = "/_lunora/rpc";

    /** The live-subscription endpoint. */
    public static final String WS_PATH = "/_lunora/ws";

    /**
     * Which RPC method a call dispatches to. Generated code emits these constants rather than raw
     * strings, so a typo in a target template is a compile error instead of a read silently sent
     * over the write path.
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

    /** Volatile so an app thread can rotate the token while a socket reader is mid-frame. */
    public volatile String authToken;

    /**
     * Guards every field below, and the {@code cursor}/{@code epoch}/row state hanging off {@link
     * Subscription} and {@link Shape}.
     *
     * <p>Two threads normally drive this client: a socket reader calling {@link #handleFrame} and
     * the app thread calling {@link #subscribe}. A {@link LinkedHashMap} resized from both corrupts
     * silently — its Go equivalent is what made this visible, because Go answers the same race with
     * an unrecoverable fatal error rather than a wrong answer.
     *
     * <p>Frames and user callbacks are dispatched OUTSIDE the lock: a sender writes a socket the
     * consumer owns, and holding the lock across a callback would let one slow consumer stall the
     * socket reader.
     */
    private final Object lock = new Object();

    private FrameSender sender;
    private final Map<String, Subscription> subscriptions = new LinkedHashMap<>();
    private final Map<String, Shape> shapes = new LinkedHashMap<>();
    private final Map<String, Map<String, List<Map<String, Object>>>> pokes = new LinkedHashMap<>();
    private int nextId;
    private int nextShapeId;

    private static final class Subscription {
        final String functionPath;
        final Object args;

        /**
         * The stable wire key of {@code args}, computed once at subscribe time so a write's
         * optimistic targeting can compare without re-serialising every subscription's args on
         * every write.
         */
        final String argsKey;

        final String shardKey;
        final Consumer<Object> onData;
        final Consumer<SubscriptionError> onError;
        Object cursor;
        Object epoch;

        /** The displayed value and its optimistic overlays. See {@link Optimistic}. */
        final Optimistic.State state = new Optimistic.State(null);

        Subscription(
                String functionPath,
                Object args,
                String shardKey,
                Consumer<Object> onData,
                Consumer<SubscriptionError> onError) {
            this.functionPath = functionPath;
            this.args = args;
            this.argsKey =
                    Key.stableWireKey(args == null ? new LinkedHashMap<String, Object>() : args);
            this.shardKey = shardKey;
            this.onData = onData;
            this.onError = onError;

            if (onData != null) {
                state.callbacks.add(onData);
            }
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

    /**
     * Identifies this client to the shard. It rides every write that carries an idempotency key,
     * because an anonymous caller has no server-minted user id to namespace its de-duplication rows
     * by.
     */
    public volatile String clientId = "java-client";

    /**
     * An opaque, stable, NON-SECRET stamp for whoever is signed in — a user id, not a bearer token.
     * It is persisted alongside every queued write and re-checked before that write replays, so a
     * restart cannot push one user's queued writes as another. Null means signed out, which is
     * itself an identity a write can be stamped with.
     */
    public volatile String identity;

    private OfflineQueue offlineQueue = new OfflineQueue();
    private boolean wasEverConnected;
    private boolean closed;
    private final List<Consumer<MutationSettled>> settledListeners = new ArrayList<>();

    public Client(String baseUrl, HttpPoster poster) {
        this.baseUrl = baseUrl;
        this.poster = poster;
    }

    /**
     * Registers the sender used for subscription frames. Call once the socket is open.
     *
     * <p>It also latches "has connected at least once", which is what the write queue gates on: a
     * write made before the FIRST connect fails fast by default, so a misconfigured endpoint
     * surfaces on the first write instead of silently filling a queue that will never flush.
     */
    public void attachSocket(FrameSender sender) {
        synchronized (lock) {
            this.sender = sender;
            this.wasEverConnected = true;
        }
    }

    /** Forgets the sender, so subsequent writes queue rather than fail. */
    public void detachSocket() {
        synchronized (lock) {
            this.sender = null;
        }
    }

    /** Whether a socket is currently attached. */
    public boolean online() {
        synchronized (lock) {
            return sender != null;
        }
    }

    /** The durable write queue backing {@link #submit}. */
    public OfflineQueue offlineQueue() {
        synchronized (lock) {
            return offlineQueue;
        }
    }

    /** Replaces the write queue — to configure capacity, persistence, or an app version. */
    public void offlineQueue(OfflineQueue queue) {
        synchronized (lock) {
            this.offlineQueue = queue;
        }
    }

    /** How many writes are waiting for the socket. */
    public int pendingMutationCount() {
        synchronized (lock) {
            return offlineQueue.size();
        }
    }

    /**
     * Observes every queued write's terminal verdict; returns an unsubscribe.
     *
     * <p>This is the ONLY report a write restored from durable storage produces — its original
     * caller did not survive the restart.
     */
    public Runnable onMutationSettled(Consumer<MutationSettled> listener) {
        synchronized (lock) {
            settledListeners.add(listener);
        }

        return () -> {
            synchronized (lock) {
                settledListeners.remove(listener);
            }
        };
    }

    /**
     * Rejects every queued write so no caller waits on a dead client. Durable storage is untouched:
     * the next session restores those writes.
     */
    public void close() {
        OfflineQueue queue;

        synchronized (lock) {
            closed = true;
            sender = null;
            queue = offlineQueue;
        }

        queue.clear();
    }

    /** Builds the {@code POST /_lunora/rpc} body. {@code shardKey} is omitted when null. */
    public static Map<String, Object> buildRpcBody(
            String functionPath, Object args, String shardKey) {
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
     * <p>{@code status} is required for correctness, not diagnostics: {@code protocol/README.md}
     * §4.2 says a non-2xx whose body carries no {@code error} envelope surfaces as an INTERNAL
     * transport error. Without it a 502 with body {@code {"message":"…"}} returns null and throws
     * nothing — the caller believes its mutation committed.
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
            throw new ApiException(
                    "INTERNAL", "HTTP " + status + " without an error envelope", null);
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
     * Same envelope as a mutation, but never an idempotency key: an action performs external side
     * effects and is not replayed against the shard, so claiming mutation-style de-duplication for
     * it would be a lie.
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

    private Object rpc(String functionPath, Object args, String shardKey, String mutationId) {
        return rpcFull(functionPath, args, shardKey, mutationId, null).result();
    }

    /** One RPC round-trip: the decoded result plus the commit cursor the response echoed. */
    public record RpcReply(Object result, Long commitCursor) {}

    /**
     * One round-trip, keeping the echoed {@code commitCursor}.
     *
     * <p>The cursor is what gates an optimistic overlay's removal, so it has to survive the call
     * rather than be discarded by {@link #parseRpcResponse}. {@code clientId} overrides this
     * session's, so a replayed write namespaces server-side under the id that ISSUED it.
     */
    @SuppressWarnings("unchecked")
    RpcReply rpcFull(
            String functionPath,
            Object args,
            String shardKey,
            String mutationId,
            String issuingClientId) {
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
            // Rides WITH the idempotency key, never alone. An anonymous caller has no
            // server-minted user id, so the shard namespaces its de-duplication rows by this
            // client id instead; without one every anonymous client shares a single key space and
            // a colliding mutation id suppresses another client's write.
            headers.put("x-lunora-client-id", issuingClientId != null ? issuingClientId : clientId);
        }

        String payload = Json.write(buildRpcBody(functionPath, args, shardKey));
        Response response =
                poster.post(join(RPC_PATH), headers, payload.getBytes(StandardCharsets.UTF_8));
        Map<String, Object> body = (Map<String, Object>) Json.parse(response.body());

        return new RpcReply(parseRpcResponse(body, response.status()), parseCommitCursor(body));
    }

    /**
     * The CDC cursor a write committed at, echoed on a mutation's response.
     *
     * <p>Null when the call was a read, or when the shard has CDC off — the degraded case the
     * optimistic engine falls back to one-shot behaviour for.
     */
    public static Long parseCommitCursor(Map<String, Object> body) {
        Object cursor = body.get("commitCursor");

        return cursor instanceof Number number ? number.longValue() : null;
    }

    public static Map<String, Object> buildConnectFrame(
            String clientId, Map<String, Object> context) {
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
            String id,
            String functionPath,
            Object args,
            String table,
            Object sinceSeq,
            Object sinceEpoch) {
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
     * <p>{@code shardKey} does NOT ride the subscribe frame: the protocol selects a shard per
     * SOCKET, via the {@code ?shard=} parameter {@link #wsUrl} builds. It is accepted so the
     * generated surface is identical across languages, and is otherwise unused — this client holds
     * one socket, so it must already be the shard that socket was opened against.
     */
    public Runnable subscribe(
            String functionPath,
            Object args,
            Consumer<Object> onData,
            Consumer<SubscriptionError> onError,
            String shardKey) {
        String id;
        FrameSender socket;

        synchronized (lock) {
            nextId++;
            id = "sub_" + nextId;

            subscriptions.put(id, new Subscription(functionPath, args, shardKey, onData, onError));
            socket = sender;
        }

        if (socket != null) {
            socket.send(buildSubscribeFrame(id, functionPath, args, null, null, null));
        }

        return () -> {
            FrameSender current;

            synchronized (lock) {
                subscriptions.remove(id);
                current = sender;
            }

            if (current != null) {
                current.send(buildUnsubscribeFrame(id));
            }
        };
    }

    /**
     * Opens a partially-replicated keyed view. {@code onRows} fires once per applied poke with the
     * view's full contents, in insertion order.
     */
    public Runnable subscribeShape(
            String name,
            Object args,
            Consumer<List<Object>> onRows,
            Consumer<SubscriptionError> onError) {
        String id;
        FrameSender socket;

        synchronized (lock) {
            nextShapeId++;
            id = "shape_" + nextShapeId;

            shapes.put(id, new Shape(onRows, onError));
            socket = sender;
        }

        if (socket != null) {
            socket.send(buildShapeSubscribeFrame(id, name, args, null, null));
        }

        return () -> {
            FrameSender current;

            synchronized (lock) {
                shapes.remove(id);
                current = sender;
            }

            if (current != null) {
                current.send(buildShapeUnsubscribeFrame(id));
            }
        };
    }

    /** Re-subscribes everything after a reconnect, carrying each resume cursor. */
    public void resendSubscriptions() {
        FrameSender socket;
        List<Map<String, Object>> frames = new ArrayList<>();

        // The frames are BUILT under the lock, not just the iteration: each one
        // reads `cursor`/`epoch`, which the frame handler writes. Snapshotting the
        // entries and reading their cursors afterwards resends a torn one.
        synchronized (lock) {
            socket = sender;

            if (socket == null) {
                return;
            }

            for (Map.Entry<String, Subscription> entry : subscriptions.entrySet()) {
                Subscription subscription = entry.getValue();

                frames.add(
                        buildSubscribeFrame(
                                entry.getKey(),
                                subscription.functionPath,
                                subscription.args,
                                null,
                                subscription.cursor,
                                subscription.epoch));
            }
        }

        for (Map<String, Object> frame : frames) {
            socket.send(frame);
        }
    }

    /**
     * Applies one server frame and returns its type. Unknown types are ignored, per the protocol's
     * forward-compatibility rule.
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

        // Each case resolves the subscription UNDER the lock and hands the
        // callback back out, rather than looking `entry` up once up here: the app
        // thread can unsubscribe in between, and `advance` writes the very state
        // the lock exists to protect.
        switch (kind) {
            case "data", "delta" -> {
                Object payload = frame.get("data") != null ? frame.get("data") : frame.get("delta");
                Object value;

                try {
                    value = Wire.decode(payload);
                } catch (RuntimeException error) {
                    // Same shape as the Json.parse guard above: Wire.decode can throw a
                    // Wire.WireFormatException OR an unwrapped RuntimeException from a
                    // nested decoder (e.g. Base64's IllegalArgumentException on a
                    // malformed bytes tag), and either must reach the consumer's error
                    // callback rather than vanish or escape handleFrame — silently
                    // dropping the frame trades a crash for a subscription that goes
                    // quietly stale.
                    Consumer<SubscriptionError> onError;

                    synchronized (lock) {
                        Subscription entry = subscriptions.get(id);
                        onError = entry != null ? entry.onError : null;
                    }

                    if (onError != null) {
                        onError.accept(
                                new SubscriptionError(
                                        null, "malformed wire value: " + error.getMessage()));
                    }

                    return kind;
                }

                List<Runnable> deferred = new ArrayList<>();

                synchronized (lock) {
                    Subscription entry = subscriptions.get(id);

                    if (entry == null) {
                        return kind;
                    }

                    advance(entry, frame);
                    entry.state.serverBase = value;
                    entry.state.serverCursor =
                            frame.get("cursor") instanceof Number number
                                    ? number.longValue()
                                    : null;
                    // Drop the overlays this frame has caught up with, then RE-FOLD the rest onto
                    // the new authoritative base rather than clobbering them: a still-queued
                    // write's predicted value has to survive an unrelated delta on this query.
                    Optimistic.dropConfirmedLayers(entry.state, entry.state.serverCursor);
                    Optimistic.notifySubscription(
                            entry.state,
                            Optimistic.fold(entry.state.serverBase, entry.state.layers),
                            deferred);
                }

                runDeferred(deferred);
            }
            case "resume", "settled" -> {
                synchronized (lock) {
                    Subscription entry = subscriptions.get(id);

                    if (entry != null) {
                        advance(entry, frame);
                    }
                }
            }
            case "error" -> {
                Map<String, Object> envelope =
                        frame.get("error") instanceof Map<?, ?> map
                                ? (Map<String, Object>) map
                                : new LinkedHashMap<>();
                String message =
                        frame.get("message") instanceof String text
                                ? text
                                : envelope.get("message") instanceof String inner
                                        ? inner
                                        : "subscription error";
                SubscriptionError error =
                        new SubscriptionError(
                                envelope.get("code") instanceof String code ? code : null, message);
                List<Consumer<SubscriptionError>> handlers = new ArrayList<>();

                synchronized (lock) {
                    Subscription entry = subscriptions.get(id);
                    Shape shape = shapes.get(id);

                    if (entry != null && entry.onError != null) {
                        handlers.add(entry.onError);
                    }

                    if (shape != null && shape.onError != null) {
                        handlers.add(shape.onError);
                    }
                }

                for (Consumer<SubscriptionError> handler : handlers) {
                    handler.accept(error);
                }
            }
            case "complete" -> {
                synchronized (lock) {
                    subscriptions.remove(id);
                }
            }
            case "pokeStart" -> {
                synchronized (lock) {
                    pokes.put(String.valueOf(frame.get("pokeId")), new LinkedHashMap<>());
                }
            }
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
     * Parts buffer until {@code pokeEnd}: a poke is an atomic batch, so applying them as they
     * arrive would expose a torn view, and a socket dropping mid-poke would leave it permanently
     * half-applied.
     */
    @SuppressWarnings("unchecked")
    private void bufferPokePart(Map<String, Object> frame) {
        List<Map<String, Object>> operations = new ArrayList<>();

        if (frame.get("rowsPatch") instanceof List<?> rows) {
            for (Object row : rows) {
                if (row instanceof Map<?, ?> operation) {
                    operations.add((Map<String, Object>) operation);
                }
            }
        }

        synchronized (lock) {
            Map<String, List<Map<String, Object>>> buffer =
                    pokes.get(String.valueOf(frame.get("pokeId")));

            // A part for an unknown poke is dropped: without its pokeStart there
            // is no batch to join, and guessing would apply a fragment of one.
            if (buffer == null) {
                return;
            }

            buffer.computeIfAbsent(String.valueOf(frame.get("shapeId")), key -> new ArrayList<>())
                    .addAll(operations);
        }
    }

    /** One `onRows` callback plus the rows it is to be handed, snapshotted. */
    private record Delivery(Consumer<List<Object>> onRows, List<Object> rows) {}

    /** One `onError` callback plus the error it is to be handed. */
    private record ErrorDelivery(Consumer<SubscriptionError> onError, SubscriptionError error) {}

    private void applyPoke(Map<String, Object> frame) {
        List<Delivery> deliveries = new ArrayList<>();
        List<ErrorDelivery> errorDeliveries = new ArrayList<>();

        // The view is mutated under the lock; `onRows`/`onError` fire after it is
        // released, with the row snapshot taken while still holding it — so a
        // callback sees one consistent poke even if the next one lands mid-delivery.
        synchronized (lock) {
            Map<String, List<Map<String, Object>>> buffer =
                    pokes.remove(String.valueOf(frame.get("pokeId")));

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

                    Object decoded;

                    try {
                        decoded = Wire.decode(value);
                    } catch (RuntimeException error) {
                        // Same rationale as the "data"/"delta" guard above: catch
                        // broadly, not just Wire.WireFormatException. A malformed row
                        // must reach the shape's error callback, not vanish or corrupt
                        // the view — skip only this row rather than dropping the whole
                        // poke or throwing out of handleFrame.
                        if (shape.onError != null) {
                            errorDeliveries.add(
                                    new ErrorDelivery(
                                            shape.onError,
                                            new SubscriptionError(
                                                    null,
                                                    "malformed wire value: "
                                                            + error.getMessage())));
                        }

                        continue;
                    }

                    if (!shape.rows.containsKey(key)) {
                        shape.order.add(key);
                    }

                    shape.rows.put(key, decoded);
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

                    deliveries.add(new Delivery(shape.onRows, rows));
                }
            }
        }

        for (Delivery delivery : deliveries) {
            delivery.onRows().accept(delivery.rows());
        }

        for (ErrorDelivery errorDelivery : errorDeliveries) {
            errorDelivery.onError().accept(errorDelivery.error());
        }
    }

    /**
     * The socket URL: the origin with its scheme swapped, plus the shard and credential query
     * parameters when present.
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

    // --- Offline-capable writes ------------------------------------------------------------

    /** What {@link #submit} did with a write. */
    public enum MutationStatus {
        /** The write went out and the server answered. */
        COMMITTED,
        /** The socket was down and the write was enqueued for replay. */
        QUEUED,
        /** A settled verdict, never a submit outcome. */
        REJECTED
    }

    /**
     * What {@link #submit} did with a write.
     *
     * <p>This is the deliberate divergence from {@code @lunora/client}, whose {@code mutation()}
     * returns a promise that stays PENDING until a queued write finally replays. A pending promise
     * is a fine thing to hold in a browser event loop and a bad thing to hold on a pooled JVM
     * thread, so the ports return the outcome immediately and report the eventual verdict through
     * {@code onSettled} (per write) or {@link #onMutationSettled} (per client). A caller that must
     * not report success early checks {@code status}.
     */
    public record MutationOutcome(
            MutationStatus status, String mutationId, Object value, Long commitCursor) {}

    /**
     * The terminal verdict on a queued write, once it replays.
     *
     * <p>{@code hadAwaiter} is false for a write restored from durable storage: the caller that
     * submitted it is gone, so this event is the ONLY report it produces.
     */
    public record MutationSettled(
            String mutationId,
            MutationStatus status,
            Object value,
            RuntimeException error,
            boolean hadAwaiter) {}

    /** What one {@link #flushOfflineQueue} pass achieved. */
    public static final class FlushReport {
        /** The ids the server accepted. */
        public final List<String> committed = new ArrayList<>();

        /** The ids dropped on a verdict, an identity change, or a stale precondition. */
        public final List<String> rejected = new ArrayList<>();

        /** The ids left queued for the next reconnect. */
        public final List<String> requeued = new ArrayList<>();

        /** The ids dropped because their precondition no longer held. */
        public final List<String> conflicted = new ArrayList<>();
    }

    /** One offline-capable write. */
    public static final class SubmitOptions {
        public final String functionPath;
        public final Object args;

        /** Null routes to the default shard. */
        public String shardKey;

        /** The idempotency key; minted when null. */
        public String mutationId;

        /**
         * The single-query shortcut: the transform is layered onto every subscription registered
         * under the SAME (functionPath, args, shardKey) as this write, mirroring {@code
         * @lunora/client}'s per-call {@code optimistic}.
         */
        public Optimistic.Transform optimistic;

        /**
         * The general form — it receives a {@link LocalStore} and may patch any number of
         * subscribed queries. Both settle together, against the same commit cursor.
         */
        public BiConsumer<LocalStore, Object> optimisticUpdate;

        /**
         * Re-evaluated just before a QUEUED write replays; false drops it rather than replaying a
         * write that can only fail.
         */
        public Supplier<Boolean> precondition;

        /** Reports the eventual verdict on a queued write. */
        public Consumer<MutationSettled> onSettled;

        public SubmitOptions(String functionPath, Object args) {
            this.functionPath = functionPath;
            this.args = args;
        }

        public SubmitOptions shardKey(String shardKey) {
            this.shardKey = shardKey;

            return this;
        }

        public SubmitOptions optimistic(Optimistic.Transform optimistic) {
            this.optimistic = optimistic;

            return this;
        }

        public SubmitOptions optimisticUpdate(BiConsumer<LocalStore, Object> optimisticUpdate) {
            this.optimisticUpdate = optimisticUpdate;

            return this;
        }

        public SubmitOptions precondition(Supplier<Boolean> precondition) {
            this.precondition = precondition;

            return this;
        }

        public SubmitOptions onSettled(Consumer<MutationSettled> onSettled) {
            this.onSettled = onSettled;

            return this;
        }
    }

    /**
     * Writes, sending it now or queueing it until the socket is back.
     *
     * <p>It returns as soon as the write is either committed or durably queued. A queued write's
     * optimistic overlay stays displayed until the replay's commit cursor is reached by a server
     * frame; a failed one rolls back.
     */
    public MutationOutcome submit(SubmitOptions options) {
        List<BiConsumer<Long, List<Runnable>>> confirms;
        List<Consumer<List<Runnable>>> rollbacks;
        boolean queueIt;
        String stamp;
        OfflineQueue queue;
        String issuingClientId;
        List<Runnable> deferred = new ArrayList<>();

        synchronized (lock) {
            if (closed) {
                throw new OfflineException(Offline.CLIENT_CLOSED, "client is closed");
            }

            LayerSettlers settlers = applyOptimistic(options, deferred);

            confirms = settlers.confirms();
            rollbacks = settlers.rollbacks();
            queueIt = sender == null && (wasEverConnected || offlineQueue.queueBeforeFirstConnect);
            stamp = identity;
            queue = offlineQueue;
            issuingClientId = clientId;
        }

        runDeferred(deferred);

        String writeId = options.mutationId != null ? options.mutationId : Offline.randomId();

        if (queueIt) {
            enqueueWrite(queue, options, writeId, issuingClientId, stamp, confirms, rollbacks);

            return new MutationOutcome(MutationStatus.QUEUED, writeId, null, null);
        }

        RpcReply reply;

        try {
            reply = rpcFull(options.functionPath, options.args, options.shardKey, writeId, null);
        } catch (RuntimeException error) {
            settleLayers(List.of(), rollbacks, null);

            throw error;
        }

        // Confirmed against the write's COMMITTED cursor, so the overlay drops when (or once) a
        // frame at that cursor lands — never on this call's return, which races the broadcast.
        settleLayers(confirms, List.of(), reply.commitCursor());

        return new MutationOutcome(
                MutationStatus.COMMITTED, writeId, reply.result(), reply.commitCursor());
    }

    /**
     * Restores writes persisted in a prior session; returns their shard keys.
     *
     * <p>Open a socket for each returned key and flush it to replay them. A restored write has no
     * live caller, so its verdict arrives only through {@link #onMutationSettled}.
     */
    public List<String> hydrateOfflineQueue() {
        OfflineQueue queue = offlineQueue();
        List<String> restored = queue.hydrate();

        for (QueuedMutation item : queue.items()) {
            if (item.resolve == null && item.reject == null) {
                attachHydratedSettlers(item);
            }
        }

        return restored;
    }

    /**
     * Replays one shard's queued writes, in order, over HTTP. Call it when that shard's socket
     * comes back.
     *
     * <p>Each write replays under its own idempotency key, so one the server already committed is
     * de-duplicated rather than applied twice. Per write: success confirms its optimistic overlay
     * against the ECHOED commit cursor; a coded verdict is terminal; a transient failure — a raw
     * transport error, or one of {@link Offline#TRANSIENT_ERROR_CODES} — stops the flush and
     * re-queues that write and every unreplayed one, in order, for the next attempt.
     */
    public FlushReport flushOfflineQueue(String shardKey) {
        FlushReport report = new FlushReport();
        OfflineQueue queue;
        String current;

        synchronized (lock) {
            queue = offlineQueue;
            current = identity;
        }

        for (QueuedMutation item : queue.drainConflict()) {
            queue.unpersist(item.id);
            report.conflicted.add(item.id);
            report.rejected.add(item.id);
        }

        List<QueuedMutation> drained =
                queue.drain(
                        item ->
                                shardKey == null
                                        ? item.shardKey == null
                                        : shardKey.equals(item.shardKey));

        if (drained.isEmpty()) {
            return report;
        }

        // Gated against ONE identity snapshot: a flush is a single authenticated burst, so every
        // write in it necessarily runs under one identity.
        List<QueuedMutation> sendable = new ArrayList<>();

        for (QueuedMutation item : drained) {
            if (Offline.identityAllowsReplay(item.identity, current)) {
                sendable.add(item);

                continue;
            }

            queue.unpersist(item.id);
            settleRejected(
                    item,
                    new OfflineException(
                            Offline.OFFLINE_IDENTITY_CHANGED,
                            "offline mutation skipped: auth identity changed before replay"));
            report.rejected.add(item.id);
        }

        replay(queue, sendable, report);

        return report;
    }

    private void replay(OfflineQueue queue, List<QueuedMutation> sendable, FlushReport report) {
        for (int index = 0; index < sendable.size(); index++) {
            QueuedMutation item = sendable.get(index);
            RpcReply reply;

            try {
                reply =
                        rpcFull(
                                item.functionPath,
                                item.args,
                                item.shardKey,
                                item.id,
                                item.clientId);
            } catch (RuntimeException error) {
                if (!isTransient(error)) {
                    queue.unpersist(item.id);
                    settleRejected(item, error);
                    report.rejected.add(item.id);

                    continue;
                }

                // Nothing after this write may go out ahead of it: replaying out of order is how a
                // durable queue corrupts the data it was protecting.
                List<QueuedMutation> pending =
                        new ArrayList<>(sendable.subList(index, sendable.size()));

                queue.requeue(pending);

                for (QueuedMutation entry : pending) {
                    report.requeued.add(entry.id);
                }

                return;
            }

            queue.unpersist(item.id);
            settleCommitted(item, reply.result(), reply.commitCursor());
            report.committed.add(item.id);
        }
    }

    /**
     * Whether a failed replay may be retried rather than dropped.
     *
     * <p>A raw exception from the injected poster is the network, not the server: no verdict was
     * reached, so the write is still good.
     */
    static boolean isTransient(RuntimeException error) {
        if (error instanceof ApiException api) {
            return Offline.TRANSIENT_ERROR_CODES.contains(api.code);
        }

        return !(error instanceof OfflineException);
    }

    /** The settle closures one write's optimistic layers produced. */
    private record LayerSettlers(
            List<BiConsumer<Long, List<Runnable>>> confirms,
            List<Consumer<List<Runnable>>> rollbacks) {}

    /** Registers both optimistic APIs' layers. Runs with the monitor held. */
    private LayerSettlers applyOptimistic(SubmitOptions options, List<Runnable> deferred) {
        List<BiConsumer<Long, List<Runnable>>> confirms = new ArrayList<>();
        List<Consumer<List<Runnable>>> rollbacks = new ArrayList<>();

        if (options.optimistic != null) {
            for (Subscription entry :
                    findSubscriptions(options.functionPath, options.args, options.shardKey)) {
                Optimistic.Handle handle =
                        Optimistic.applyLayer(entry.state, options.optimistic, deferred);

                if (handle != null) {
                    confirms.add(handle::confirm);
                    rollbacks.add(handle::rollback);
                }
            }
        }

        if (options.optimisticUpdate == null) {
            return new LayerSettlers(confirms, rollbacks);
        }

        LocalStore store =
                new LocalStore(
                        target ->
                                findSubscriptions(
                                                target.functionPath(),
                                                target.args(),
                                                options.shardKey)
                                        .stream()
                                        .map(entry -> entry.state)
                                        .toList(),
                        path -> matchingQueries(path, options.shardKey),
                        deferred);

        try {
            options.optimisticUpdate.accept(store, options.args);
            confirms.addAll(store.confirms);
            rollbacks.addAll(store.rollbacks);
        } catch (RuntimeException ignored) {
            // A throwing update unwinds only its OWN writes, so the cache is left exactly as it was
            // found, and the write itself proceeds.
            Optimistic.rollbackAll(store.rollbacks, deferred);
        }

        return new LayerSettlers(confirms, rollbacks);
    }

    /**
     * The live subscriptions registered under exactly this (path, args, shard).
     *
     * <p>A linear scan, unlike {@code @lunora/client}'s keyed registry, and deliberately: this
     * client does not de-duplicate subscriptions, so several can share one triple and all of them
     * must receive the overlay. The scan is over a handful of entries on the write path, never the
     * frame path.
     */
    private List<Subscription> findSubscriptions(
            String functionPath, Object args, String shardKey) {
        String argsKey =
                Key.stableWireKey(args == null ? new LinkedHashMap<String, Object>() : args);
        List<Subscription> matches = new ArrayList<>();

        for (Subscription entry : subscriptions.values()) {
            if (entry.functionPath.equals(functionPath)
                    && entry.argsKey.equals(argsKey)
                    && java.util.Objects.equals(entry.shardKey, shardKey)) {
                matches.add(entry);
            }
        }

        return matches;
    }

    private List<QueryEntry> matchingQueries(String functionPath, String shardKey) {
        List<QueryEntry> matches = new ArrayList<>();

        for (Subscription entry : subscriptions.values()) {
            if (entry.functionPath.equals(functionPath)
                    && java.util.Objects.equals(entry.shardKey, shardKey)) {
                matches.add(new QueryEntry(entry.args, entry.state.lastValue));
            }
        }

        return matches;
    }

    private void enqueueWrite(
            OfflineQueue queue,
            SubmitOptions options,
            String writeId,
            String issuingClientId,
            String stamp,
            List<BiConsumer<Long, List<Runnable>>> confirms,
            List<Consumer<List<Runnable>>> rollbacks) {
        QueuedMutation entry =
                new QueuedMutation(options.functionPath, options.args, options.shardKey, writeId);

        entry.clientId = issuingClientId;
        // Bound at enqueue time, so the write can only ever replay as whoever made it.
        entry.identity = stamp == null ? Identity.signedOut() : Identity.of(stamp);
        entry.liveAwaiter = true;
        entry.precondition = options.precondition;
        entry.onCommit = cursor -> settleLayers(confirms, List.of(), cursor);
        entry.resolve =
                value ->
                        emitSettled(
                                new MutationSettled(
                                        writeId, MutationStatus.COMMITTED, value, null, true),
                                options.onSettled);
        entry.reject =
                error -> {
                    settleLayers(List.of(), rollbacks, null);
                    emitSettled(
                            new MutationSettled(
                                    writeId, MutationStatus.REJECTED, null, error, true),
                            options.onSettled);
                };

        synchronized (lock) {
            queue.enqueue(entry);
        }
    }

    /** Gives a restored write the observer-only settlers it lost in the restart. */
    private void attachHydratedSettlers(QueuedMutation item) {
        String id = item.id;

        item.liveAwaiter = false;
        item.resolve =
                value ->
                        emitSettled(
                                new MutationSettled(
                                        id, MutationStatus.COMMITTED, value, null, false),
                                null);
        item.reject =
                error ->
                        emitSettled(
                                new MutationSettled(
                                        id, MutationStatus.REJECTED, null, error, false),
                                null);
    }

    /**
     * Confirms the overlay BEFORE the caller is told, so the gapless drop is already in place when
     * the confirming frame lands.
     */
    private static void settleCommitted(QueuedMutation item, Object value, Long commitCursor) {
        if (item.onCommit != null) {
            item.onCommit.accept(commitCursor);
        }

        if (item.resolve != null) {
            item.resolve.accept(value);
        }
    }

    private static void settleRejected(QueuedMutation item, RuntimeException error) {
        if (item.reject != null) {
            item.reject.accept(error);
        }
    }

    /**
     * Runs a write's confirms or rollbacks under the monitor and delivers the resulting
     * notifications outside it.
     */
    private void settleLayers(
            List<BiConsumer<Long, List<Runnable>>> confirms,
            List<Consumer<List<Runnable>>> rollbacks,
            Long commitCursor) {
        List<Runnable> deferred = new ArrayList<>();

        synchronized (lock) {
            Optimistic.confirmAll(confirms, commitCursor, deferred);
            Optimistic.rollbackAll(rollbacks, deferred);
        }

        runDeferred(deferred);
    }

    private void emitSettled(MutationSettled event, Consumer<MutationSettled> onSettled) {
        List<Consumer<MutationSettled>> listeners = new ArrayList<>();

        if (onSettled != null) {
            listeners.add(onSettled);
        }

        synchronized (lock) {
            listeners.addAll(settledListeners);
        }

        for (Consumer<MutationSettled> listener : listeners) {
            try {
                listener.accept(event);
            } catch (RuntimeException ignored) {
                // A write's terminal verdict is the only report a restored write ever produces, so
                // one bad observer must not stop the rest being told.
            }
        }
    }

    /** Runs the notifications queued while the monitor was held. */
    private static void runDeferred(List<Runnable> deferred) {
        for (Runnable call : deferred) {
            call.run();
        }
    }

    private String join(String path) {
        return (baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl)
                + path;
    }
}
