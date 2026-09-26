package dev.lunora;

import dev.lunora.Offline.OfflineQueue;
import dev.lunora.Optimistic.QueryEntry;
import dev.lunora.Submit.FlushReport;
import dev.lunora.Submit.MutationOutcome;
import dev.lunora.Submit.MutationSettled;
import dev.lunora.Submit.SubmitOptions;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

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

    /** Where a flush of two or more queued writes goes: one hop carrying independent calls. */
    public static final String RPC_BATCH_PATH = "/_lunora/rpc-batch";

    /** The live-subscription endpoint. */
    public static final String WS_PATH = "/_lunora/ws";

    /**
     * How many un-applied poke buffers to retain before evicting the oldest. A buffer is only
     * released at its {@code pokeEnd}; a socket that drops mid-poke never sends one, so without a
     * bound the abandoned buffers accumulate for the life of the client — one per reconnect, and
     * unbounded against a peer that opens pokes it never closes. Concurrent in-flight pokes number
     * in the low single digits, so this is far above any legitimate working set.
     */
    public static final int MAX_PENDING_POKES = 64;

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
    public static class ApiException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public final String code;
        public final transient Object data;

        /**
         * Whether the call reached no verdict: a reply carrying no readable error envelope at all
         * (an edge error page, a WAF block, a proxy, a body that is not a JSON object) — except a
         * 413, which is a verdict on the request whatever its body.
         *
         * <p>Set where the reply's SHAPE is still in scope, because nothing downstream can recover
         * it: {@code code} alone cannot tell an {@code INTERNAL} the function returned from the
         * {@code INTERNAL} this client synthesises for a body that never came from one. A CODED
         * envelope never sets it, whatever its HTTP status: the server reached a verdict, and its
         * code alone classifies it (see {@link Submit#isTransient}).
         */
        public final boolean transientFailure;

        public ApiException(String code, String message, Object data, boolean transientFailure) {
            super(message);
            this.code = code;
            this.data = data;
            this.transientFailure = transientFailure;
        }
    }

    /** A subscription-scoped error the server pushed. */
    public record SubscriptionError(String code, String message) {}

    /**
     * The code every port reports for a frame whose payload will not decode. Shared spelling
     * matters: this reaches the consumer's {@code onError}, which switches on it.
     */
    public static final String CODE_INVALID_FRAME = "INVALID_FRAME";

    /**
     * The code of the {@link ApiException} a call raises when the server answered SUCCESS but its
     * {@code result} does not decode. The write behind it committed: a replay settles it {@code
     * COMMITTED} carrying this error rather than retrying a result that can only come back the
     * same.
     */
    public static final String CODE_WIRE_DECODE_FAILED = "WIRE_DECODE_FAILED";

    /**
     * A success whose {@code result} would not decode. It keeps the commit cursor the reply echoed,
     * because the write DID commit and its optimistic overlay confirms against that cursor.
     */
    static final class ResultDecodeException extends ApiException {
        private static final long serialVersionUID = 1L;

        final transient Long commitCursor;

        ResultDecodeException(RuntimeException cause, Long commitCursor) {
            super(
                    CODE_WIRE_DECODE_FAILED,
                    "result does not decode: " + cause.getMessage(),
                    null,
                    false);
            this.commitCursor = commitCursor;
        }
    }

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
    final Object lock = new Object();

    FrameSender sender;
    private final Map<String, Subscription> subscriptions = new LinkedHashMap<>();
    private final Map<String, Shape> shapes = new LinkedHashMap<>();
    private final Map<String, PokeBuffer> pokes = new LinkedHashMap<>();

    /** The streams {@link #close} ends. */
    private final Set<Stream> streams = new LinkedHashSet<>();

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

    /**
     * One in-flight poke: the row ops buffered per shape, plus the shapes whose part carried {@code
     * reset: true}.
     *
     * <p>The flag is tracked per SHAPE, not per poke: one poke can re-seed one shape while
     * delivering an ordinary diff to another on the same socket.
     */
    private static final class PokeBuffer {
        final Map<String, List<Map<String, Object>>> parts = new LinkedHashMap<>();

        /**
         * Shapes whose {@code rowsPatch} is the shape's COMPLETE membership rather than a diff, so
         * the view has to be dropped before it is applied. A seed carries inserts only, so merging
         * one leaves every row that left the shape while the socket was down on screen for the life
         * of the client.
         */
        final Set<String> resets = new LinkedHashSet<>();

        /**
         * The checkpoint each shape's diff was computed against: its part's {@code baseCheckpoint},
         * else the {@code pokeStart}'s.
         */
        final Map<String, Object> bases = new LinkedHashMap<>();

        /** The {@code pokeStart}'s {@code baseCheckpoint}, the default for every part. */
        final Object startBase;

        /** The {@code pokeStart}'s epoch, or null. */
        final String epoch;

        PokeBuffer(Object startBase, String epoch) {
            this.startBase = startBase;
            this.epoch = epoch;
        }
    }

    private static final class Shape {
        /**
         * The shape's name and args, kept so {@link #resendSubscriptions} can rebuild its subscribe
         * frame. Without them a reconnect has nothing to re-subscribe WITH, and every shape view
         * goes silent for the life of the client.
         */
        final String name;

        final Object args;

        final Map<String, Object> rows = new LinkedHashMap<>();
        final List<String> order = new ArrayList<>();
        final Consumer<List<Object>> onRows;
        final Consumer<SubscriptionError> onError;
        Object checkpoint;
        Object epoch;

        Shape(
                String name,
                Object args,
                Consumer<List<Object>> onRows,
                Consumer<SubscriptionError> onError) {
            this.name = name;
            this.args = args;
            this.onRows = onRows;
            this.onError = onError;
        }
    }

    /**
     * Identifies this client to the shard. It rides every write that carries an idempotency key,
     * because an anonymous caller has no server-minted user id to namespace its de-duplication rows
     * by.
     *
     * <p>Minted PER INSTANCE, from the same generator that mints mutation ids. A per-language
     * constant would put every anonymous client in the process — and in every other process running
     * this SDK — into ONE de-duplication namespace: two signed-out users calling the same mutation
     * with the same caller-supplied mutation id would collide, and the second write would
     * short-circuit to the first user's cached result without ever running.
     *
     * <p>Assign it to pin a stable per-device id, which a consumer using a DURABLE offline queue
     * should do: a write replays under the id that ISSUED it, so an id that changes every process
     * start makes each restored write its own namespace.
     */
    public volatile String clientId = Offline.randomId();

    /**
     * An opaque, stable, NON-SECRET stamp for whoever is signed in — a user id, not a bearer token.
     * It is persisted alongside every queued write and re-checked before that write replays, so a
     * restart cannot push one user's queued writes as another. Null means signed out, which is
     * itself an identity a write can be stamped with.
     *
     * <p>Behind a setter because changing it is not just a store: see {@link #identity(String)}.
     */
    private volatile String identity;

    /** Who is signed in, as last set by {@link #identity(String)}; null when signed out. */
    public String identity() {
        return identity;
    }

    /**
     * Sets who is signed in. Changing it FROM a set value to a different one (another user, or
     * signed out) evicts the previous identity's session: every query and shape subscription drops
     * its resume cursor and epoch, so the next resubscribe is a cold one, and every shape view is
     * emptied with its callback told ({@code []}).
     *
     * <p>Those cursors were the previous identity's position in the changelog and those rows were
     * the rows IT could see; resuming from them under the new identity asks the server for a diff
     * against a view this identity never held and splices it onto someone else's rows. A first
     * sign-in (from unset) and re-asserting the same identity evict nothing.
     */
    public void identity(String next) {
        List<Delivery> deliveries = new ArrayList<>();

        synchronized (lock) {
            String previous = identity;

            identity = next;

            if (previous == null || previous.equals(next)) {
                return;
            }

            for (Subscription subscription : subscriptions.values()) {
                subscription.cursor = null;
                subscription.epoch = null;
            }

            for (Shape shape : shapes.values()) {
                shape.rows.clear();
                shape.order.clear();
                shape.checkpoint = null;
                shape.epoch = null;

                if (shape.onRows != null) {
                    deliveries.add(new Delivery(shape.onRows, new ArrayList<>()));
                }
            }
        }

        for (Delivery delivery : deliveries) {
            delivery.onRows().accept(delivery.rows());
        }
    }

    OfflineQueue offlineQueue = new OfflineQueue();

    /**
     * The {@link System#nanoTime} reading before which a flush is a no-op, set when a replay came
     * back rate-limited and the envelope named a delay. Monotonic, so a wall-clock adjustment
     * cannot strand a queue for hours. Guarded by {@link #lock}.
     */
    long flushNotBefore = System.nanoTime();

    boolean wasEverConnected;
    boolean closed;
    final List<Consumer<MutationSettled>> settledListeners = new ArrayList<>();

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
        List<Offline.Discarded> discarded;
        List<Stream> open;

        // Emptied under the monitor, settled outside it: `clear` mutates the same list every other
        // queue call does, while settling rolls optimistic layers back and notifies listeners.
        synchronized (lock) {
            closed = true;
            sender = null;
            discarded = offlineQueue.clear();
            open = new ArrayList<>(streams);
        }

        // Every open stream ends: a consumer blocked in its loop would otherwise wait forever on a
        // client that will never deliver again.
        for (Stream stream : open) {
            stream.close();
        }

        Submit.reportDiscarded(this, discarded);
    }

    /**
     * Builds the {@code POST /_lunora/rpc} body. {@code shardKey} is omitted when absent OR empty.
     *
     * <p>Empty as well as null, because the two are the same shard to this client (see {@link
     * Offline#sameShard}) but NOT to the runtime, which treats {@code ""} as a valid named shard
     * and routes it to its own Durable Object. Sending it through would mean a write that drains on
     * the default shard's flush lands on a different shard from the subscription whose overlay it
     * just updated — so the client resolves the ambiguity at the wire boundary, once, where every
     * call goes past.
     */
    public static Map<String, Object> buildRpcBody(
            String functionPath, Object args, String shardKey) {
        Map<String, Object> body = new LinkedHashMap<>();

        body.put("args", Wire.encode(args == null ? new LinkedHashMap<String, Object>() : args));
        body.put("functionPath", functionPath);

        if (shardKey != null && !shardKey.isEmpty()) {
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
            Object data = decodeErrorData(rawData);
            Object code = ((Map<String, Object>) error).get("code");
            Object message = ((Map<String, Object>) error).get("message");

            // Classified by its CODE alone, whatever the HTTP status: a coded 5xx is the server's
            // verdict exactly as a coded 4xx is, and the batch path — which never sees a slot's
            // status — already classified it that way. One predicate for both paths, so a durable
            // write's fate cannot depend on how many siblings shared its flush.
            throw new ApiException(
                    code instanceof String text ? text : "INTERNAL",
                    message instanceof String text ? text : "request failed",
                    data,
                    false);
        }

        if (status < 200 || status > 299) {
            throw envelopeless(status);
        }

        try {
            return Wire.decode(body.get("result"));
        } catch (RuntimeException error) {
            // A SUCCESS whose result is unreadable: the call committed, so this is not a transport
            // failure to retry but a coded error carrying the cursor the write committed at.
            throw new ResultDecodeException(error, parseCommitCursor(body));
        }
    }

    /**
     * The error for a reply that carries no readable envelope: {@code body} is not a JSON object,
     * or it is a non-2xx object without an {@code error} envelope.
     *
     * <p>Such a body never came from a Lunora function — an edge error page, a WAF block, a proxy —
     * so it is transport rather than a verdict ({@code transientFailure}), and a queued write is
     * replayed. Except a 413: that is a verdict on the REQUEST whatever its body, since an edge
     * refuses an oversized body with its own page long before the worker could write its coded
     * {@code PAYLOAD_TOO_LARGE}. Re-queueing it sent the identical body into the identical refusal
     * forever.
     */
    static ApiException envelopeless(int status) {
        if (status == 413) {
            return new ApiException(
                    Offline.PAYLOAD_TOO_LARGE, "HTTP 413 without an error envelope", null, false);
        }

        return new ApiException(
                "INTERNAL", "HTTP " + status + " without a readable error envelope", null, true);
    }

    /**
     * An error envelope's {@code data}, decoded — or null when the codec refuses it. The envelope
     * is still the server's coded verdict: letting the codec's exception escape instead made it
     * read as a transport failure, or escape past every handler written for this SDK's errors.
     */
    static Object decodeErrorData(Object raw) {
        try {
            return raw == null ? null : Wire.decode(raw);
        } catch (RuntimeException error) {
            return null;
        }
    }

    /** {@code text} parsed, when it is a JSON object; null for anything else, never a throw. */
    @SuppressWarnings("unchecked")
    static Map<String, Object> parseObject(String text) {
        try {
            return text != null && Json.parse(text) instanceof Map<?, ?> map
                    ? (Map<String, Object>) map
                    : null;
        } catch (RuntimeException error) {
            return null;
        }
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
    RpcReply rpcFull(
            String functionPath,
            Object args,
            String shardKey,
            String mutationId,
            String issuingClientId) {
        if (poster == null) {
            throw new ApiException("INTERNAL", "no HTTP poster configured", null, false);
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
        // A body that is not a JSON object — an HTML page, `null`, `[]` — is an error of THIS
        // SDK's type, never the parser's, cast's or a null dereference escaping every handler the
        // caller wrote for this SDK's errors.
        Map<String, Object> body = parseObject(response.body());

        if (body == null) {
            throw envelopeless(response.status());
        }

        return new RpcReply(parseRpcResponse(body, response.status()), parseCommitCursor(body));
    }

    /**
     * One {@code /_lunora/rpc-batch} reply: its status, and its body when that is a JSON object (an
     * empty map otherwise). The status is kept because a 413 is a verdict on the request whether or
     * not its body carries an envelope.
     */
    record BatchReply(int status, Map<String, Object> body) {}

    /**
     * POST one {@code /_lunora/rpc-batch} chunk.
     *
     * <p>No {@code x-lunora-mutation-id} on the request: a batch is ONE transport hop carrying
     * independent calls, so each entry carries its own idempotency key and client id in the body. A
     * single outer header would name one write and de-duplicate the whole chunk against it.
     */
    BatchReply rpcBatch(List<Object> calls) {
        if (poster == null) {
            throw new ApiException("INTERNAL", "no HTTP poster configured", null, false);
        }

        Map<String, String> headers = new LinkedHashMap<>();

        headers.put("content-type", "application/json");

        if (authToken != null) {
            headers.put("authorization", "Bearer " + authToken);
        }

        Map<String, Object> envelope = new LinkedHashMap<>();

        envelope.put("calls", calls);

        Response response =
                poster.post(
                        join(RPC_BATCH_PATH),
                        headers,
                        Json.write(envelope).getBytes(StandardCharsets.UTF_8));
        Map<String, Object> body = parseObject(response.body());

        return new BatchReply(response.status(), body == null ? new LinkedHashMap<>() : body);
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
     * One item delivered by {@link #stream}: a value, or the subscription error the server pushed.
     *
     * <p>One queue carrying both, rather than a value queue plus an error queue: a consumer polling
     * two of them can read them out of order, and the whole point of a stream is that what arrived
     * first is delivered first.
     */
    public record StreamEvent(Object value, SubscriptionError error) {}

    /**
     * A live query as a closeable {@link Iterable}, for {@code for (var event : stream)}.
     *
     * <p>{@link #iterator} BLOCKS waiting for the next frame, which is what makes the loop the
     * whole consumer. {@link #close} unsubscribes and ends the loop, so it belongs in a
     * try-with-resources — otherwise the subscription outlives the loop and the iterator blocks
     * forever.
     */
    public static final class Stream implements Iterable<StreamEvent>, AutoCloseable {
        // Unbounded, so the frame dispatcher never blocks on a slow consumer; the trade is that one
        // which stops reading without closing grows the buffer.
        private final LinkedBlockingQueue<StreamEvent> events = new LinkedBlockingQueue<>();
        // The sentinel the iterator stops on. A distinct instance rather than a null, because
        // LinkedBlockingQueue rejects nulls outright.
        private final StreamEvent end = new StreamEvent(null, null);
        private final AtomicBoolean closed = new AtomicBoolean();
        private Runnable unsubscribe = () -> {};

        private Stream() {}

        @Override
        public Iterator<StreamEvent> iterator() {
            return new Iterator<>() {
                private StreamEvent next;

                @Override
                public boolean hasNext() {
                    if (next != null) {
                        return true;
                    }

                    try {
                        next = events.take();
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();

                        return false;
                    }

                    return next != end;
                }

                @Override
                public StreamEvent next() {
                    if (!hasNext()) {
                        throw new NoSuchElementException("the stream is closed");
                    }

                    StreamEvent value = next;

                    next = null;

                    return value;
                }
            };
        }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                unsubscribe.run();
                // Wakes a consumer blocked in `take()` so the loop ends instead of hanging on a
                // subscription nothing will ever deliver to again.
                events.add(end);
            }
        }
    }

    /**
     * Opens a live query as a {@link Stream}.
     *
     * <p>Each call opens its OWN subscription — at CALL time, so a frame arriving before the loop
     * starts is not lost — and {@link Stream#close} tears it down. Use {@link #subscribe} directly
     * when the value outlives one loop.
     */
    public Stream stream(String functionPath, Object args, String shardKey) {
        Stream stream = new Stream();
        Runnable unsubscribe =
                subscribe(
                        functionPath,
                        args,
                        value -> stream.events.add(new StreamEvent(value, null)),
                        error -> stream.events.add(new StreamEvent(null, error)),
                        shardKey);

        synchronized (lock) {
            streams.add(stream);
        }

        stream.unsubscribe =
                () -> {
                    synchronized (lock) {
                        streams.remove(stream);
                    }

                    unsubscribe.run();
                };

        return stream;
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

            shapes.put(id, new Shape(name, args, onRows, onError));
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

            // BOTH registries. A resend that walks only the queries leaves every shape view
            // subscribed to a socket that no longer exists — silently, and for the rest of the
            // process's life, because a shape only ever hears from the server through a poke.
            for (Map.Entry<String, Shape> entry : shapes.entrySet()) {
                Shape shape = entry.getValue();

                frames.add(
                        buildShapeSubscribeFrame(
                                entry.getKey(),
                                shape.name,
                                shape.args,
                                shape.checkpoint,
                                shape.epoch));
            }
        }

        for (Map<String, Object> frame : frames) {
            socket.send(frame);
        }
    }

    /**
     * Applies one server frame and returns its type — {@code "error"} for a frame whose payload
     * would not decode, since that one was not delivered. Unknown types are ignored, per the
     * protocol's forward-compatibility rule.
     */
    @SuppressWarnings("unchecked")
    public String handleFrame(String raw) {
        if ("lunora-ping".equals(raw) || "lunora-pong".equals(raw)) {
            return null;
        }

        // Non-JSON frames, and JSON that is not an object (`null`, `[]`, `42`), are ignored rather
        // than fatal: an exception out of here ends the socket read loop, and with it every
        // subscription on the client.
        Map<String, Object> frame = parseObject(raw);

        if (frame == null) {
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
                        // Same code and same kind as the other seven ports: a
                        // consumer switching on error.code() got null from here
                        // alone, and a frame reported as "data" reads as one that
                        // was delivered.
                        onError.accept(
                                new SubscriptionError(
                                        CODE_INVALID_FRAME,
                                        "malformed wire value: " + error.getMessage()));
                    }

                    return "error";
                }

                List<Runnable> deferred = new ArrayList<>();

                synchronized (lock) {
                    Subscription entry = subscriptions.get(id);

                    if (entry == null) {
                        return kind;
                    }

                    advance(entry, frame);
                    entry.state.serverBase = value;

                    // `cursor` is OPTIONAL on data/delta frames, so a frame without one LEAVES the
                    // tracked cursor where it was. Nulling it strands every pending layer: the
                    // tracked cursor is what a write's commitCursor is compared against, so a
                    // confirm that should drop the overlay keeps it instead and the write renders
                    // twice until some later cursored frame happens to land.
                    if (frame.get("cursor") instanceof Number number) {
                        entry.state.serverCursor = number.longValue();
                    }

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
                List<Runnable> deferred = new ArrayList<>();

                synchronized (lock) {
                    Subscription entry = subscriptions.get(id);

                    if (entry == null) {
                        return kind;
                    }

                    advance(entry, frame);

                    // A resume/settled frame advances the cursor without a value change — but a
                    // write whose result was byte-identical for this query still committed at or
                    // under this cursor, so its overlay is confirmed. Sweep here too, not just on
                    // data frames, or a no-visible-change write leaves its prediction on screen
                    // until some unrelated write happens to produce a data frame — indefinitely on
                    // a quiet query.
                    if (frame.get("cursor") instanceof Number number) {
                        entry.state.serverCursor = number.longValue();
                    }

                    if (Optimistic.dropConfirmedLayers(entry.state, entry.state.serverCursor)) {
                        Optimistic.notifySubscription(
                                entry.state,
                                Optimistic.fold(entry.state.serverBase, entry.state.layers),
                                deferred);
                    }
                }

                runDeferred(deferred);
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
                // NON-DESTRUCTIVE, and that is the whole point: removing the entry takes it out
                // of the map resendSubscriptions walks, so the query froze for the life of the
                // process across every future reconnect, with nothing reported. Fan a
                // cancellation to the listener and leave the registration in place; the next
                // reconnect resubscribes it.
                Consumer<SubscriptionError> cancelled;

                synchronized (lock) {
                    Subscription entry = subscriptions.get(id);

                    cancelled = entry == null ? null : entry.onError;
                }

                if (cancelled != null) {
                    cancelled.accept(
                            new SubscriptionError(
                                    "SUBSCRIPTION_CANCELLED",
                                    "subscription was cancelled by the server"));
                }
            }
            case "pokeStart" -> {
                // A poke without a string id opens nothing: its parts and its end could never name
                // it, and a buffer keyed "null" would be joined by the next id-less frame.
                if (!(frame.get("pokeId") instanceof String)) {
                    return kind;
                }

                synchronized (lock) {
                    // Evict oldest-first at the cap. A LinkedHashMap iterates in insertion
                    // order, so the first key is the oldest buffer; one that old is no
                    // longer going to see its pokeEnd.
                    Iterator<String> oldest = pokes.keySet().iterator();

                    while (pokes.size() >= MAX_PENDING_POKES && oldest.hasNext()) {
                        oldest.next();
                        oldest.remove();
                    }

                    pokes.put(
                            String.valueOf(frame.get("pokeId")),
                            new PokeBuffer(
                                    frame.get("baseCheckpoint") instanceof Number base
                                            ? base
                                            : null,
                                    frame.get("epoch") instanceof String epoch ? epoch : null));
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

    /**
     * Advances the resume position to what the frame carries — but only a cursor that IS one (an
     * integer) and an epoch that is a string. Anything else is not a position: resending a string
     * cursor verbatim asked the server to resume from {@code "9"}.
     */
    private static void advance(Subscription entry, Map<String, Object> frame) {
        if (frame.get("cursor") instanceof Number cursor
                && Double.isFinite(cursor.doubleValue())
                && cursor.doubleValue() == Math.rint(cursor.doubleValue())) {
            entry.cursor = cursor;
        }

        if (frame.get("epoch") instanceof String epoch) {
            entry.epoch = epoch;
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
            PokeBuffer buffer = pokes.get(String.valueOf(frame.get("pokeId")));

            // A part for an unknown poke is dropped: without its pokeStart there
            // is no batch to join, and guessing would apply a fragment of one.
            if (buffer == null) {
                return;
            }

            String shapeId = String.valueOf(frame.get("shapeId"));

            buffer.parts.computeIfAbsent(shapeId, key -> new ArrayList<>()).addAll(operations);

            Object base =
                    frame.get("baseCheckpoint") instanceof Number number
                            ? number
                            : buffer.startBase;

            if (base != null) {
                buffer.bases.put(shapeId, base);
            }

            // Recorded sticky (never cleared) so a server that splits one seed across
            // several parts still replaces rather than merges. `reset` is the ONLY
            // signal: a missing `baseCheckpoint` does not imply a seed, and a
            // retention re-seed arrives with the epoch unchanged.
            if (Boolean.TRUE.equals(frame.get("reset"))) {
                buffer.resets.add(shapeId);
            }
        }
    }

    /** One `onRows` callback plus the rows it is to be handed, snapshotted. */
    private record Delivery(Consumer<List<Object>> onRows, List<Object> rows) {}

    /** One `onError` callback plus the error it is to be handed. */
    private record ErrorDelivery(Consumer<SubscriptionError> onError, SubscriptionError error) {}

    private void applyPoke(Map<String, Object> frame) {
        List<Delivery> deliveries = new ArrayList<>();
        List<ErrorDelivery> errorDeliveries = new ArrayList<>();
        List<Map<String, Object>> reseeds = new ArrayList<>();
        FrameSender socket;

        // The view is mutated under the lock; `onRows`/`onError` fire after it is
        // released, with the row snapshot taken while still holding it — so a
        // callback sees one consistent poke even if the next one lands mid-delivery.
        synchronized (lock) {
            socket = sender;

            PokeBuffer buffer = pokes.remove(String.valueOf(frame.get("pokeId")));

            if (buffer == null) {
                return;
            }

            for (Map.Entry<String, List<Map<String, Object>>> entry : buffer.parts.entrySet()) {
                Shape shape = shapes.get(entry.getKey());

                if (shape == null) {
                    continue;
                }

                // An epoch mismatch means the changelog forked since this view last applied; a
                // base mismatch means the diff was computed against a checkpoint the view is not
                // at (a dropped or refused poke). Splicing it on would corrupt the view, so drop
                // it, clear its position, skip the ops and re-subscribe COLD so the server
                // re-seeds it. A reset part is its complete membership, and settles either.
                Object base = buffer.bases.get(entry.getKey());
                boolean epochForked =
                        buffer.epoch != null
                                && shape.epoch != null
                                && !buffer.epoch.equals(shape.epoch);
                boolean baseDiverged =
                        base instanceof Number expected
                                && shape.checkpoint instanceof Number actual
                                && expected.doubleValue() != actual.doubleValue();

                if (!buffer.resets.contains(entry.getKey()) && (epochForked || baseDiverged)) {
                    shape.rows.clear();
                    shape.order.clear();
                    shape.checkpoint = null;
                    shape.epoch = null;

                    if (shape.onRows != null) {
                        deliveries.add(new Delivery(shape.onRows, new ArrayList<>()));
                    }

                    reseeds.add(
                            buildShapeSubscribeFrame(
                                    entry.getKey(), shape.name, shape.args, null, null));

                    continue;
                }

                // Every row is decoded BEFORE the view is touched: a poke is applied whole or
                // not at all. Clearing for a reset and then failing on a row left the view
                // half-applied (or empty), and skipping the row while applying the rest advanced
                // the checkpoint past a row the view never held — so no resume would send it
                // again. Refused, the view, checkpoint and epoch all stay put and the shape's
                // error callback is told; the other shapes in the poke still apply.
                Map<Map<String, Object>, Object> decoded = new java.util.IdentityHashMap<>();
                RuntimeException failure = null;

                for (Map<String, Object> operation : entry.getValue()) {
                    Object value = operation.get("value");

                    if ("delete".equals(operation.get("op")) || value == null) {
                        continue;
                    }

                    try {
                        // Caught broadly, not just Wire.WireFormatException: a nested decoder
                        // throws its own unchecked exceptions (Base64's, say).
                        decoded.put(operation, Wire.decode(value));
                    } catch (RuntimeException error) {
                        failure = error;

                        break;
                    }
                }

                if (failure != null) {
                    if (shape.onError != null) {
                        errorDeliveries.add(
                                new ErrorDelivery(
                                        shape.onError,
                                        new SubscriptionError(
                                                CODE_WIRE_DECODE_FAILED,
                                                "malformed wire value: " + failure.getMessage())));
                    }

                    continue;
                }

                // A reset part is the shape's complete membership, so it is authoritative
                // on its own: drop what we hold before applying it. `.global()` shapes
                // re-seed in full on EVERY reconnect and an op-log shape past changelog
                // retention does too, so without this a row deleted while the socket was
                // down is never removed.
                if (buffer.resets.contains(entry.getKey())) {
                    shape.rows.clear();
                    shape.order.clear();
                }

                for (Map<String, Object> operation : entry.getValue()) {
                    String key = String.valueOf(operation.get("key"));

                    if ("delete".equals(operation.get("op"))) {
                        if (shape.rows.remove(key) != null) {
                            shape.order.remove(key);
                        }

                        continue;
                    }

                    // A value-less upsert is membership-only; it must not blank an
                    // existing row.
                    if (!decoded.containsKey(operation)) {
                        continue;
                    }

                    if (!shape.rows.containsKey(key)) {
                        shape.order.add(key);
                    }

                    shape.rows.put(key, decoded.get(operation));
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

        if (socket != null) {
            for (Map<String, Object> reseed : reseeds) {
                socket.send(reseed);
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
     *
     * <p>{@code shard=} is omitted for an empty key as well as an absent one, for the same reason
     * {@link #buildRpcBody} omits it: {@code ""} is the default shard here and a distinct named
     * shard to the runtime, and a socket opened against the wrong one would deliver frames for a
     * shard the writes never reach.
     */
    public String wsUrl(String shardKey, String token) {
        String endpoint = join(WS_PATH);

        if (endpoint.startsWith("https://")) {
            endpoint = "wss://" + endpoint.substring("https://".length());
        } else if (endpoint.startsWith("http://")) {
            endpoint = "ws://" + endpoint.substring("http://".length());
        }

        List<String> params = new ArrayList<>();

        if (shardKey != null && !shardKey.isEmpty()) {
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
    //
    // The write path itself lives in {@link Submit}; what follows is the client-facing surface it
    // hangs off, plus the two lookups it needs into the subscription registry.

    /**
     * Writes, sending it now or queueing it until the socket is back.
     *
     * <p>It returns as soon as the write is either committed or durably queued. A queued write's
     * optimistic overlay stays displayed until the replay's commit cursor is reached by a server
     * frame; a failed one rolls back.
     */
    public MutationOutcome submit(SubmitOptions options) {
        return Submit.submit(this, options);
    }

    /**
     * Restores writes persisted in a prior session; returns their shard keys.
     *
     * <p>Open a socket for each returned key and flush it to replay them. A restored write has no
     * live caller, so its verdict arrives only through {@link #onMutationSettled}.
     */
    public List<String> hydrateOfflineQueue() {
        return Submit.hydrate(this);
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
        return Submit.flush(this, shardKey);
    }

    /** One matching subscription's layer state, paired with the value it displays right now. */
    record StateSnapshot(Optimistic.State state, Object value) {}

    /**
     * Every subscription registered under exactly this (path, args, shard), with what it displays.
     *
     * <p>A linear scan, unlike {@code @lunora/client}'s keyed registry, and deliberately: this
     * client does not de-duplicate subscriptions, so several can share one triple and all of them
     * must receive the overlay. The scan is over a handful of entries on the write path, never the
     * frame path.
     *
     * <p>The displayed value is read HERE, under the monitor, rather than by the caller afterwards:
     * the write path runs a consumer's transform against it with the monitor released, and a value
     * read outside would be torn against a concurrent frame rather than merely stale.
     */
    List<StateSnapshot> snapshotStates(String functionPath, Object args, String shardKey) {
        String argsKey =
                Key.stableWireKey(args == null ? new LinkedHashMap<String, Object>() : args);
        List<StateSnapshot> matches = new ArrayList<>();

        synchronized (lock) {
            for (Subscription entry : subscriptions.values()) {
                if (entry.functionPath.equals(functionPath)
                        && entry.argsKey.equals(argsKey)
                        && Offline.sameShard(entry.shardKey, shardKey)) {
                    matches.add(new StateSnapshot(entry.state, entry.state.lastValue));
                }
            }
        }

        return matches;
    }

    /** Every subscribed query on {@code functionPath}, whatever args it was subscribed under. */
    List<QueryEntry> matchingQueries(String functionPath, String shardKey) {
        List<QueryEntry> matches = new ArrayList<>();

        synchronized (lock) {
            for (Subscription entry : subscriptions.values()) {
                if (entry.functionPath.equals(functionPath)
                        && Offline.sameShard(entry.shardKey, shardKey)) {
                    matches.add(new QueryEntry(entry.args, entry.state.lastValue));
                }
            }
        }

        return matches;
    }

    /**
     * The layered value behind one subscription id, or null when it is gone.
     *
     * <p>Package-private, for the conformance suite: the tracked cursor and the pending-layer count
     * are internal state with no consumer-facing accessor, and asserting on them is what holds the
     * real frame handler to the shared fixture rather than a transcription of it.
     */
    Optimistic.State subscriptionState(String id) {
        synchronized (lock) {
            Subscription entry = subscriptions.get(id);

            return entry == null ? null : entry.state;
        }
    }

    /** Runs the notifications queued while the monitor was held. */
    static void runDeferred(List<Runnable> deferred) {
        for (Runnable call : deferred) {
            call.run();
        }
    }

    private String join(String path) {
        return (baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl)
                + path;
    }
}
