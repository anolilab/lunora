package dev.lunora;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Protocol-conformance tests: drive the Java SDK against the shared golden fixtures in {@code
 * protocol/fixtures/}, the same files the TypeScript client and the Python, Go, Ruby, Swift and
 * Rust ports are tested against.
 *
 * <p>Plain assertions rather than JUnit, so the suite needs no dependency resolution — run it with
 * {@code java -ea}.
 */
public final class ConformanceTest {
    private static int checks;

    /**
     * Manifest case names recorded by the cases that actually ran. The evidence is produced by
     * executing the case, not by a hand-kept list of names this suite claims to cover.
     */
    private static final Set<String> covered = new LinkedHashSet<>();

    public static void main(String[] args) throws IOException, InterruptedException {
        if (!ConformanceTest.class.desiredAssertionStatus()) {
            throw new IllegalStateException("run with -ea, or every assertion silently passes");
        }

        wireCodecRoundTrip();
        undefinedIsDistinctFromNull();
        overLongBigIntRejected();
        malformedValuesRejected();
        depthCapEnforced();
        exactIntegerRangeEnforced();
        stableWireKeyFixtures();
        formatNumberMatchesEcmaScript();
        keyOrderMatchesUtf16();
        stringEscapingMatchesJsonStringify();
        emptyShardKeyIsOmitted();
        rpcRequestBodies();
        rpcResponses();
        non2xxWithoutEnvelopeThrows();
        clientFrameBuilders();
        serverFrameConsumer();
        subscriptionStreamYieldsFrameValuesInOrder();
        shapeSubscribeFrame();
        shapeSubscriptionsResendAfterReconnect();
        pokeSequenceMaterialisesRows();
        pokePartsDoNotApplyBeforePokeEnd();
        resetPokeReplacesShapeMembership();
        pendingPokeBuffersAreBounded();
        concurrentSubscribeAndHandleFrame();

        // The optimistic-layer and offline-queue cases, in their own file so this one
        // stays the wire-protocol suite it has always been.
        OptimisticOfflineTest.run();

        assertManifestCovered();

        System.out.println("OK — " + checks + " assertions");
    }

    /** Package-private so the sibling case files in this suite share one counter. */
    static void check(boolean condition, String message) {
        checks++;

        if (!condition) {
            throw new AssertionError(message);
        }
    }

    /** Records that the running case exercises the manifest case {@code name}. */
    static void covers(String name) {
        covered.add(name);
    }

    /**
     * Fails if this run did not exercise every case in {@code protocol/conformance-cases.json}.
     *
     * <p>The suite is a plain {@code main}, so the end of it is the after-all hook: the recorded
     * set comes from the cases that ran, the expected set from the manifest, and neither is
     * enumerated here.
     */
    @SuppressWarnings("unchecked")
    private static void assertManifestCovered() throws IOException {
        Path path = fixturesDir().getParent().resolve("conformance-cases.json");
        Map<String, Object> manifest = (Map<String, Object>) Json.parse(Files.readString(path));
        List<Object> required = (List<Object>) manifest.get("required");

        check(
                required != null && !required.isEmpty(),
                "the manifest must list at least one required case");

        List<Object> missing = new ArrayList<>();

        for (Object name : required) {
            if (!covered.contains(name)) {
                missing.add(name);
            }
        }

        check(
                missing.isEmpty(),
                "protocol/conformance-cases.json requires cases this suite did not run: "
                        + missing
                        + " (add a covers() call to the case that asserts it)");
    }

    static Path fixturesDir() {
        Path directory = Path.of("").toAbsolutePath();

        for (int depth = 0; depth < 8; depth++) {
            Path candidate = directory.resolve("protocol/fixtures");

            if (Files.isDirectory(candidate)) {
                return candidate;
            }

            Path parent = directory.getParent();

            if (parent == null) {
                break;
            }

            directory = parent;
        }

        throw new IllegalStateException("could not locate protocol/fixtures");
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> fixture(String name) throws IOException {
        return (Map<String, Object>) Json.parse(Files.readString(fixturesDir().resolve(name)));
    }

    /** Canonical text form so two structures compare independent of key order. */
    private static String canonical(Object value) {
        return Key.stableStringify(value);
    }

    @SuppressWarnings("unchecked")
    private static void wireCodecRoundTrip() throws IOException {
        covers("wire_codec_round_trip");

        List<Object> cases = (List<Object>) fixture("wire-codec.json").get("cases");

        check(cases.size() > 10, "fixture should carry the full case set");

        for (Object entry : cases) {
            Map<String, Object> testCase = (Map<String, Object>) entry;
            Object encoded = testCase.get("encoded");
            Object roundTripped = Wire.encode(Wire.decode(encoded));
            // A handful of shapes are legitimately not fixed points — a bare
            // [TAG] array is escaped on the way out, an UNDEFINED object field
            // is dropped — and carry the expected re-encoding.
            Object expected =
                    testCase.containsKey("reencoded") ? testCase.get("reencoded") : encoded;

            check(
                    canonical(roundTripped).equals(canonical(expected)),
                    "round-trip mismatch for " + testCase.get("name"));
        }
    }

    @SuppressWarnings("unchecked")
    private static void undefinedIsDistinctFromNull() {
        covers("undefined_is_distinct_from_null");

        Map<String, Object> source = new LinkedHashMap<>();

        source.put("dropped", Wire.UNDEFINED);
        source.put("kept", null);

        Map<String, Object> encoded = (Map<String, Object>) Wire.encode(source);

        check(
                !encoded.containsKey("dropped"),
                "an UNDEFINED object field must be dropped, matching JSON.stringify");
        check(encoded.containsKey("kept"), "a null object field must be kept");

        // In an array position the slot must survive, or every later element shifts.
        List<Object> inArray = (List<Object>) Wire.encode(List.of(Wire.UNDEFINED, 1.0));

        check(
                canonical(inArray.get(0)).contains("undefined"),
                "array-position undefined must stay tagged");
    }

    private static void overLongBigIntRejected() {
        covers("over_long_bigint_rejected");

        String overLong = "9".repeat(Wire.MAX_BIGINT_DIGITS + 1);

        check(
                throwsWireError(List.of(Wire.TAG, "bigint", overLong)),
                "an over-long bigint must be rejected");
        check(
                throwsWireError(List.of(Wire.TAG, "bigint", "12x4")),
                "a non-numeric bigint must be rejected");

        Object decoded = Wire.decode(List.of(Wire.TAG, "bigint", "-42"));

        check(
                decoded instanceof Wire.WireBigInt bigInt && bigInt.value().intValue() == -42,
                "-42 should decode");
    }

    /**
     * A malformed {@code bytes} tag must be rejected at decode, and the rejection must reach a live
     * subscription's error callback rather than escape {@link Client#handleFrame} — a bare {@code
     * Wire.decode} throw out of the frame dispatcher would crash whatever thread runs the caller's
     * socket read loop instead of surfacing a recoverable error.
     */
    @SuppressWarnings("unchecked")
    private static void malformedValuesRejected() throws IOException {
        covers("malformed_values_rejected");

        // The list is data (protocol/fixtures/wire-codec.json), not a per-suite
        // invention: a rejection each port hard-codes for itself is a rejection
        // only some ports have, which is how one of them ended up accepting a
        // truncated base64 payload as valid short bytes.
        List<Object> rejected = (List<Object>) fixture("wire-codec.json").get("rejected");

        check(rejected != null && !rejected.isEmpty(), "the fixture must carry a rejection list");

        for (Object entry : rejected) {
            Map<String, Object> testCase = (Map<String, Object>) entry;

            check(
                    throwsWireError(testCase.get("encoded")),
                    testCase.get("name") + " must be rejected");
        }

        Object decoded = Wire.decode(List.of(Wire.TAG, "bytes", "AQID"));

        check(
                decoded instanceof byte[] bytes && bytes.length == 3,
                "well-formed bytes must still decode");

        // A bare [TAG] is NOT malformed: it is the forward-compat shape, and the
        // reference hands it back as an ordinary array.
        check(
                Wire.decode(List.of(Wire.TAG)) instanceof List<?> passthrough
                        && passthrough.size() == 1,
                "a bare tag array must decode as an ordinary array");

        Client client = new Client("https://app.example", null);

        client.attachSocket(frame -> {});

        List<Object> seen = new ArrayList<>();
        List<Client.SubscriptionError> errors = new ArrayList<>();

        client.subscribe("messages:list", null, seen::add, errors::add, null);

        Map<String, Object> frame = new LinkedHashMap<>();

        frame.put("type", "data");
        frame.put("id", "sub_1");
        frame.put("data", List.of(Wire.TAG, "bytes", "not@@base64!!"));

        String kind = client.handleFrame(Json.write(frame));

        // "error", not "data": the frame was NOT delivered, and the other seven
        // ports say so. This test used to pin the divergence it was meant to
        // catch by asserting "data" and never looking at the code.
        check("error".equals(kind), "a frame that would not decode is reported as an error");
        check(seen.isEmpty(), "a malformed value must not reach onData");
        check(errors.size() == 1, "a malformed value must surface via onError");
        check(
                Client.CODE_INVALID_FRAME.equals(errors.get(0).code()),
                "the error carries the shared INVALID_FRAME code, not null");
    }

    /**
     * Only {@link Wire.WireFormatException} counts as a rejection.
     *
     * <p>This used to catch {@link RuntimeException}, which hid that the codec let the JDK's own
     * unwrapped {@code IllegalArgumentException}, {@code IndexOutOfBoundsException} and {@code
     * ClassCastException} escape {@code Wire.decode} — so a caller catching the codec's own error
     * type caught none of them.
     */
    private static boolean throwsWireError(Object value) {
        try {
            Wire.decode(value);

            return false;
        } catch (Wire.WireFormatException error) {
            return true;
        }
    }

    /**
     * An integer a {@code double} cannot hold exactly must not silently become a different integer
     * on the wire. A Java {@code long} holds integers a {@code double} does not, so narrowing one
     * here changed its value with neither end able to tell.
     */
    private static void exactIntegerRangeEnforced() {
        covers("exact_integer_range_enforced");

        check(
                Double.valueOf(9007199254740991.0).equals(Wire.encode(Wire.MAX_EXACT_INTEGER)),
                "the largest exact integer must encode");
        check(
                throwsOnEncode(Wire.MAX_EXACT_INTEGER + 1),
                "an integer past the exact range must be refused");
        check(
                throwsOnEncode(-Wire.MAX_EXACT_INTEGER - 1),
                "an integer past the exact range must be refused");
        check(
                throwsOnEncode(
                        java.math.BigInteger.valueOf(Wire.MAX_EXACT_INTEGER)
                                .add(java.math.BigInteger.ONE)),
                "a BigInteger past the exact range must be refused too");

        // WireBigInt is the way across, and it keeps every digit.
        check(
                canonical(
                                Wire.encode(
                                        new Wire.WireBigInt(
                                                new java.math.BigInteger("9007199254740992"))))
                        .equals(canonical(List.of(Wire.TAG, "bigint", "9007199254740992"))),
                "WireBigInt carries the value the number range refuses");
    }

    private static boolean throwsOnEncode(Object value) {
        try {
            Wire.encode(value);

            return false;
        } catch (Wire.WireFormatException error) {
            return true;
        }
    }

    /**
     * An EMPTY shard key is absent, not the shard named {@code ""}.
     *
     * <p>The runtime takes any string as a named shard and gives {@code ""} its own Durable Object,
     * while this client treats {@code ""} and null as one shard wherever it matches a subscription
     * or drains the queue. Sending it split those two views: a single-call replay of a queued write
     * landed on one Durable Object and a BATCHED replay of that same write on another, with the
     * optimistic overlay tracking neither. Both builders that carry a shard key are asserted,
     * because normalising one and not the other is the same split.
     */
    private static void emptyShardKeyIsOmitted() {
        covers("empty_shard_key_is_omitted");

        for (String absent : new String[] {null, ""}) {
            check(
                    !Client.buildRpcBody(
                                    "messages:send", new LinkedHashMap<String, Object>(), absent)
                            .containsKey("shardKey"),
                    "an empty or absent shard key must not reach the RPC body");
        }

        check(
                "room-1"
                        .equals(
                                Client.buildRpcBody(
                                                "messages:send",
                                                new LinkedHashMap<String, Object>(),
                                                "room-1")
                                        .get("shardKey")),
                "a real shard key still rides the body");

        Client client = new Client("https://app.example", null);

        for (String absent : new String[] {null, ""}) {
            check(
                    !client.wsUrl(absent, null).contains("shard="),
                    "an empty or absent shard key must not name a shard on the socket");
        }

        check(
                client.wsUrl("", null).equals(client.wsUrl(null, null)),
                "an empty shard key is byte-identical to sending none");
        check(
                client.wsUrl("room-1", null).contains("shard="),
                "a real shard key still rides the socket URL");
    }

    private static void depthCapEnforced() {
        covers("depth_cap_enforced");

        Object nested = "leaf";

        for (int depth = 0; depth < Wire.MAX_DEPTH + 2; depth++) {
            nested = List.of(nested);
        }

        check(throwsWireError(nested), "decoding past the depth cap must be rejected");

        // The PARSER's cap is counted from the document root, and every payload
        // arrives inside an envelope — so charging the envelope against the wire
        // value's own budget refused a frame whose payload the reference encodes
        // happily. A value nested exactly MAX_DEPTH deep must still reach onData.
        Object deepest = "leaf";

        for (int depth = 0; depth < Wire.MAX_DEPTH; depth++) {
            deepest = List.of(deepest);
        }

        Client client = new Client("https://app.example", null);

        client.attachSocket(frame -> {});

        List<Object> seen = new ArrayList<>();

        client.subscribe("messages:list", null, seen::add, null, null);

        Map<String, Object> envelope = new LinkedHashMap<>();

        envelope.put("type", "data");
        envelope.put("id", "sub_1");
        envelope.put("data", deepest);

        check(
                "data".equals(client.handleFrame(Json.write(envelope))),
                "a MAX_DEPTH value must survive its frame envelope");
        check(seen.size() == 1, "and reach onData");
    }

    @SuppressWarnings("unchecked")
    private static void stableWireKeyFixtures() throws IOException {
        covers("stable_wire_key_fixtures");

        Map<String, Object> document = fixture("stable-wire-key.json");

        for (Object entry : (List<Object>) document.get("cases")) {
            Map<String, Object> testCase = (Map<String, Object>) entry;

            check(
                    Key.stableWireKey(testCase.get("args")).equals(testCase.get("key")),
                    "key for " + testCase.get("name"));
        }

        for (Object entry : (List<Object>) document.get("typed")) {
            Map<String, Object> testCase = (Map<String, Object>) entry;
            Object decoded = Wire.decode(testCase.get("wireArgs"));

            check(
                    Key.stableWireKey(decoded).equals(testCase.get("key")),
                    "typed key for " + testCase.get("name"));
        }
    }

    /** Expected spellings captured from a real JS engine, not derived from the spec. */
    private static void formatNumberMatchesEcmaScript() {
        covers("format_number_matches_ecmascript");

        Object[][] cases = {
            {0.0, "0"},
            {3.0, "3"},
            {1.5, "1.5"},
            {-2.5, "-2.5"},
            {1e-5, "0.00001"},
            {1e-6, "0.000001"},
            {1e-7, "1e-7"},
            {1.5e-7, "1.5e-7"},
            {1e-21, "1e-21"},
            {1e20, "100000000000000000000"},
            {1e21, "1e+21"},
            // An integral double past 2^53 keeps ECMAScript's shortest-digits
            // spelling rather than the exact expansion 1152921504606846976.
            {1.152921504606847e18, "1152921504606847000"},
            // Negative zero keeps its sign; every integer conversion drops it.
            {-0.0, "-0"},
        };

        for (Object[] testCase : cases) {
            String actual = Key.formatNumber((Double) testCase[0]);

            check(
                    actual.equals(testCase[1]),
                    "formatNumber(" + testCase[0] + ") = " + actual + ", want " + testCase[1]);
        }
    }

    private static void keyOrderMatchesUtf16() {
        covers("key_order_matches_utf16");

        // JavaScript sorts by UTF-16 code unit, and Java's String.compareTo does
        // too — the one language in this set that needs no adjustment.
        Map<String, Object> source = new LinkedHashMap<>();

        source.put("�", 4.0);
        source.put("😀", 3.0);
        source.put(" ", 2.0);
        source.put("A", 1.0);

        check(
                Key.stableStringify(source).equals("{\"A\":1,\" \":2,\"😀\":3,\"�\":4}"),
                "key order must follow UTF-16 code units");
    }

    private static void stringEscapingMatchesJsonStringify() {
        covers("string_escaping_matches_json_stringify");

        // JSON.stringify leaves <, > and & raw and does not escape U+2028/U+2029.
        check(
                Key.jsonString("a<b>&c").equals("\"a<b>&c\""),
                "angle brackets and ampersand stay raw");
        check(Key.jsonString("  ").equals("\"  \""), "line separators stay raw");
        check(
                Key.jsonString("tab\there").equals("\"tab\\there\""),
                "control characters are escaped");
    }

    @SuppressWarnings("unchecked")
    private static void rpcRequestBodies() throws IOException {
        covers("rpc_request_bodies");

        Map<String, Object> request = (Map<String, Object>) fixture("rpc.json").get("request");

        for (Object entry : (List<Object>) request.get("cases")) {
            Map<String, Object> testCase = (Map<String, Object>) entry;
            Object args =
                    testCase.containsKey("args")
                            ? testCase.get("args")
                            : Wire.decode(testCase.get("argsWire"));
            Map<String, Object> body =
                    Client.buildRpcBody(
                            (String) testCase.get("functionPath"),
                            args,
                            (String) testCase.get("shardKey"));

            check(
                    canonical(body).equals(canonical(testCase.get("body"))),
                    "body for " + testCase.get("name"));
        }
    }

    @SuppressWarnings("unchecked")
    private static void rpcResponses() throws IOException {
        covers("rpc_responses");

        Map<String, Object> document = fixture("rpc.json");

        for (Object entry : (List<Object>) document.get("responseOk")) {
            Map<String, Object> testCase = (Map<String, Object>) entry;
            Map<String, Object> response = (Map<String, Object>) testCase.get("response");
            Object value = Client.parseRpcResponse(response, 200);

            check(
                    canonical(Wire.encode(value)).equals(canonical(response.get("result"))),
                    "result for " + testCase.get("name"));
        }

        for (Object entry : (List<Object>) document.get("responseError")) {
            Map<String, Object> testCase = (Map<String, Object>) entry;
            Map<String, Object> response = (Map<String, Object>) testCase.get("response");

            try {
                Client.parseRpcResponse(response, 400);
                check(false, "expected an ApiException for " + testCase.get("name"));
            } catch (Client.ApiException error) {
                check(error.code.equals(testCase.get("code")), "code for " + testCase.get("name"));
                check(
                        error.getMessage().equals(testCase.get("message")),
                        "message for " + testCase.get("name"));
            }
        }
    }

    private static void non2xxWithoutEnvelopeThrows() {
        covers("non_2xx_without_error_envelope_fails");

        // protocol/README.md §4.2. Without the status check this returned null
        // and threw nothing — the caller believes its mutation committed.
        Map<String, Object> body = new LinkedHashMap<>();

        body.put("message", "bad gateway");

        try {
            Client.parseRpcResponse(body, 502);
            check(false, "a 502 without an error envelope must throw");
        } catch (Client.ApiException error) {
            check("INTERNAL".equals(error.code), "the transport error is INTERNAL");
        }
    }

    @SuppressWarnings("unchecked")
    private static void clientFrameBuilders() throws IOException {
        covers("client_frame_builders");

        Map<String, Object> frames =
                (Map<String, Object>) fixture("ws-frames.json").get("clientFrames");
        Map<String, Object> args = new LinkedHashMap<>();

        args.put("channel", "general");

        Map<String, Object> context = new LinkedHashMap<>();

        context.put("roomId", "general");

        check(
                canonical(Client.buildConnectFrame("client-test", null))
                        .equals(canonical(frames.get("connect"))),
                "connect");
        check(
                canonical(Client.buildConnectFrame("client-test", context))
                        .equals(canonical(frames.get("connect-with-context"))),
                "connect-with-context");
        check(
                canonical(
                                Client.buildSubscribeFrame(
                                        "sub_1", "messages:list", args, null, null, null))
                        .equals(canonical(frames.get("subscribe-cold"))),
                "subscribe-cold");
        check(
                canonical(
                                Client.buildSubscribeFrame(
                                        "sub_1", "messages:list", args, null, 12.0, "e1"))
                        .equals(canonical(frames.get("subscribe-resume"))),
                "subscribe-resume");
        check(
                canonical(Client.buildUnsubscribeFrame("sub_1"))
                        .equals(canonical(frames.get("unsubscribe"))),
                "unsubscribe");
    }

    @SuppressWarnings("unchecked")
    private static void serverFrameConsumer() throws IOException {
        covers("server_frame_consumer");

        for (Object entry : (List<Object>) fixture("ws-frames.json").get("serverFrames")) {
            Map<String, Object> testCase = (Map<String, Object>) entry;
            Client client = new Client("https://app.example", null);

            client.attachSocket(frame -> {});

            List<Object> seen = new ArrayList<>();
            List<Client.SubscriptionError> errors = new ArrayList<>();
            Map<String, Object> args = new LinkedHashMap<>();

            args.put("channel", "general");
            client.subscribe("messages:list", args, seen::add, errors::add, null);

            String kind = client.handleFrame(Json.write(testCase.get("frame")));
            Map<String, Object> expect = (Map<String, Object>) testCase.get("expect");

            check(expect.get("kind").equals(kind), "kind for " + testCase.get("name"));

            if (expect.containsKey("valueWire")) {
                check(seen.size() == 1, "onData should fire once for " + testCase.get("name"));
                check(
                        canonical(Wire.encode(seen.get(0)))
                                .equals(canonical(expect.get("valueWire"))),
                        "value for " + testCase.get("name"));
            }

            if ("error".equals(expect.get("kind"))) {
                check(errors.size() == 1, "onError should fire once");
                check(
                        java.util.Objects.equals(errors.get(0).code(), expect.get("code")),
                        "error code");
            }
        }
    }

    /**
     * The Iterable form of a live query: same subscription, same decode, same order as the callback
     * form.
     */
    @SuppressWarnings("unchecked")
    private static void subscriptionStreamYieldsFrameValuesInOrder() throws IOException {
        covers("subscription_stream_yields_frame_values_in_order");

        Map<String, Object> testCase =
                (Map<String, Object>) fixture("ws-frames.json").get("stream");
        Client client = new Client("https://app.example", null);

        client.attachSocket(frame -> {});

        Map<String, Object> args = new LinkedHashMap<>();

        args.put("channel", "general");

        List<Object> seen = new ArrayList<>();

        // Closed at the end rather than in a try-with-resources: the frames are fed from this same
        // thread, so the loop has to be driven one `next()` at a time.
        Client.Stream stream = client.stream("messages:list", args, null);
        Iterator<Client.StreamEvent> events = stream.iterator();

        for (Object raw : (List<Object>) testCase.get("frames")) {
            client.handleFrame(Json.write(raw));

            Client.StreamEvent event = events.next();

            check(event.error() == null, "a streamed event carries a value, not an error");
            seen.add(event.value());
        }

        stream.close();

        check(
                canonical(Wire.encode(seen)).equals(canonical(testCase.get("yielded"))),
                "the stream yields the frames' values, in order");
        check(!events.hasNext(), "and closing ends the loop rather than blocking it forever");
    }

    @SuppressWarnings("unchecked")
    private static void shapeSubscribeFrame() throws IOException {
        covers("shape_subscribe_frame");

        Map<String, Object> shape = (Map<String, Object>) fixture("ws-frames.json").get("shape");
        Map<String, Object> args = new LinkedHashMap<>();

        args.put("room", "general");

        check(
                canonical(
                                Client.buildShapeSubscribeFrame(
                                        "shape_1", "roomMessages", args, null, null))
                        .equals(canonical(shape.get("shape-subscribe-cold"))),
                "shape-subscribe-cold");
    }

    /**
     * A reconnect re-subscribes SHAPES as well as queries, each carrying its resume checkpoint.
     *
     * <p>A resend that walks only the query registry leaves every shape view subscribed to a socket
     * that no longer exists — silently, and for the rest of the process's life, because a shape
     * only ever hears from the server through a poke.
     */
    @SuppressWarnings("unchecked")
    private static void shapeSubscriptionsResendAfterReconnect() {
        covers("shape_subscriptions_resend_after_reconnect");

        Client client = new Client("https://app.example", null);
        Map<String, Object> args = new LinkedHashMap<>();

        args.put("room", "general");
        client.attachSocket(frame -> {});
        client.subscribe("messages:list", new LinkedHashMap<>(), value -> {}, null, null);
        client.subscribeShape("roomMessages", args, rows -> {}, null);

        // The cursors a resume carries are written by the frame handler, so they have to exist
        // before the resend is built.
        client.handleFrame(
                "{\"cursor\":9,\"data\":[],\"epoch\":\"e1\",\"id\":\"sub_1\",\"type\":\"data\"}");
        client.handleFrame("{\"epoch\":\"e1\",\"pokeId\":\"poke-1\",\"type\":\"pokeStart\"}");
        client.handleFrame(
                "{\"pokeId\":\"poke-1\",\"reset\":true,\"rowsPatch\":[],\"shapeId\":\"shape_1\",\"type\":\"pokePart\"}");
        client.handleFrame(
                "{\"checkpoint\":5,\"epoch\":\"e1\",\"pokeId\":\"poke-1\",\"type\":\"pokeEnd\"}");

        List<Map<String, Object>> resent = new ArrayList<>();

        client.attachSocket(resent::add);
        client.resendSubscriptions();

        check(resent.size() == 2, "both registries are walked");
        check("subscribe".equals(resent.get(0).get("type")), "the query frame goes out first");
        check(
                ((Number) ((Map<String, Object>) resent.get(0).get("query")).get("sinceSeq"))
                                .intValue()
                        == 9,
                "carrying the tracked query cursor");

        Map<String, Object> frame = resent.get(1);
        Map<String, Object> shape = (Map<String, Object>) frame.get("shape");

        check("shape_subscribe".equals(frame.get("type")), "and the shape frame after it");
        check("shape_1".equals(frame.get("id")), "addressed at the live shape id");
        check("roomMessages".equals(shape.get("name")), "naming the shape it subscribed to");
        check(
                canonical(shape.get("args")).equals(canonical(Wire.encode(args))),
                "with the args it subscribed under");
        check(
                ((Number) frame.get("sinceCheckpoint")).intValue() == 5,
                "resuming from the tracked checkpoint");
        check("e1".equals(frame.get("sinceEpoch")), "and the tracked epoch");
    }

    @SuppressWarnings("unchecked")
    private static void pokeSequenceMaterialisesRows() throws IOException {
        covers("poke_sequence_materialises_rows");

        Map<String, Object> shape = (Map<String, Object>) fixture("ws-frames.json").get("shape");
        Client client = new Client("https://app.example", null);

        client.attachSocket(frame -> {});

        List<List<Object>> delivered = new ArrayList<>();
        Map<String, Object> args = new LinkedHashMap<>();

        args.put("room", "general");
        client.subscribeShape("roomMessages", args, delivered::add, null);

        for (Object frame : (List<Object>) shape.get("pokeSequence")) {
            client.handleFrame(Json.write(frame));
        }

        check(delivered.size() == 1, "a poke applies atomically at pokeEnd");
        check(
                canonical(delivered.get(delivered.size() - 1))
                        .equals(canonical(shape.get("expectedRows"))),
                "materialised rows");
    }

    @SuppressWarnings("unchecked")
    private static void pokePartsDoNotApplyBeforePokeEnd() throws IOException {
        covers("poke_parts_do_not_apply_before_poke_end");

        Map<String, Object> shape = (Map<String, Object>) fixture("ws-frames.json").get("shape");
        Client client = new Client("https://app.example", null);

        client.attachSocket(frame -> {});

        int[] fired = {0};

        client.subscribeShape("roomMessages", null, rows -> fired[0]++, null);

        List<Object> sequence = (List<Object>) shape.get("pokeSequence");

        for (int index = 0; index < sequence.size() - 1; index++) {
            client.handleFrame(Json.write(sequence.get(index)));
        }

        check(fired[0] == 0, "the view would be torn if parts applied before pokeEnd");
    }

    /**
     * A {@code reset} part carries the shape's COMPLETE membership, so the view has to be dropped
     * before the ops are applied.
     *
     * <p>A manifest case, asserted by every port against the shared fixture's {@code
     * resetPokeSequence}. It starts from the cold-seed state on purpose: a re-seed is inserts-only,
     * so {@code m1} leaves the shape with no delete op behind it, and a client that merges renders
     * it for the rest of its life.
     */
    @SuppressWarnings("unchecked")
    private static void resetPokeReplacesShapeMembership() throws IOException {
        covers("shape_reset_poke_replaces_membership");

        Map<String, Object> shape = (Map<String, Object>) fixture("ws-frames.json").get("shape");
        Client client = new Client("https://app.example", null);

        client.attachSocket(frame -> {});

        List<List<Object>> delivered = new ArrayList<>();
        Map<String, Object> args = new LinkedHashMap<>();

        args.put("room", "general");
        client.subscribeShape("roomMessages", args, delivered::add, null);

        for (Object frame : (List<Object>) shape.get("pokeSequence")) {
            client.handleFrame(Json.write(frame));
        }

        check(
                canonical(delivered.get(delivered.size() - 1))
                        .equals(canonical(shape.get("expectedRows"))),
                "the cold seed lands before the re-seed");

        for (Object frame : (List<Object>) shape.get("resetPokeSequence")) {
            client.handleFrame(Json.write(frame));
        }

        check(
                canonical(delivered.get(delivered.size() - 1))
                        .equals(canonical(shape.get("resetExpectedRows"))),
                "a reset poke replaces the shape's membership rather than merging into it");
    }

    /**
     * A buffer is only released at its {@code pokeEnd}. A socket that drops mid-poke never sends
     * one, so its buffer would be retained for the life of the client — one leak per reconnect, and
     * unbounded against a peer that opens pokes it never closes.
     *
     * <p>Asserted black-box: an evicted poke behaves exactly like one that was never opened, which
     * is the only form of this assertion all eight ports can share.
     */
    private static void pendingPokeBuffersAreBounded() {
        covers("pending_poke_buffers_are_bounded");

        Client client = new Client("https://app.example", null);

        client.attachSocket(frame -> {});

        List<List<Object>> delivered = new ArrayList<>();
        Map<String, Object> args = new LinkedHashMap<>();

        args.put("room", "general");
        client.subscribeShape("roomMessages", args, delivered::add, null);

        // A poke opened, part-filled, then abandoned when the socket dropped.
        client.handleFrame("{\"type\":\"pokeStart\",\"pokeId\":\"stale\"}");
        client.handleFrame(
                "{\"type\":\"pokePart\",\"pokeId\":\"stale\",\"shapeId\":\"shape_1\","
                    + "\"rowsPatch\":[{\"op\":\"insert\",\"key\":\"ghost\",\"value\":\"ghost-row\"}]}");

        for (int index = 0; index < Client.MAX_PENDING_POKES; index++) {
            client.handleFrame("{\"type\":\"pokeStart\",\"pokeId\":\"filler-" + index + "\"}");
        }

        // The abandoned buffer is gone, so its late pokeEnd is a no-op.
        client.handleFrame("{\"type\":\"pokeEnd\",\"pokeId\":\"stale\"}");

        check(delivered.isEmpty(), "the ghost row of an evicted poke must never reach the view");

        // ...and eviction is oldest-first, not a blanket drop: a live poke still applies.
        String newest = "filler-" + (Client.MAX_PENDING_POKES - 1);

        client.handleFrame(
                "{\"type\":\"pokePart\",\"pokeId\":\""
                        + newest
                        + "\",\"shapeId\":\"shape_1\","
                        + "\"rowsPatch\":[{\"op\":\"insert\",\"key\":\"m1\",\"value\":\"kept\"}]}");
        client.handleFrame("{\"type\":\"pokeEnd\",\"pokeId\":\"" + newest + "\"}");

        check(delivered.size() == 1, "the newest buffer must survive and apply");
        check(
                canonical(delivered.get(0)).equals(canonical(List.of("kept"))),
                "the surviving poke applies its rows");
    }

    /**
     * The topology every real consumer has: a socket read loop on one thread, application code
     * subscribing on another.
     *
     * <p>The assertion is on the COUNT, not on the absence of a crash: an unsynchronised {@code
     * nextId++} hands two threads the same id, the second {@code put} replaces the first, and the
     * client silently forgets a live subscription. A resend then emits fewer frames than there are
     * subscribers — deterministic, unlike waiting for a {@link LinkedHashMap} to corrupt.
     */
    private static void concurrentSubscribeAndHandleFrame() throws InterruptedException {
        final int threads = 4;
        final int perThread = 250;

        Client client = new Client("https://app.example", null);
        List<Thread> workers = new ArrayList<>();

        for (int index = 0; index < threads; index++) {
            Thread worker =
                    new Thread(
                            () -> {
                                for (int call = 0; call < perThread; call++) {
                                    client.subscribe(
                                            "messages:list", null, value -> {}, null, null);
                                }
                            });

            workers.add(worker);
            worker.start();
        }

        Thread reader =
                new Thread(
                        () -> {
                            for (int call = 0; call < threads * perThread; call++) {
                                client.handleFrame(
                                        "{\"type\":\"data\",\"id\":\"sub_1\",\"data\":1,\"cursor\":"
                                                + call
                                                + "}");
                            }
                        });

        reader.start();

        for (Thread worker : workers) {
            worker.join();
        }

        reader.join();

        // Attached only now, so the count below sees resend frames alone.
        AtomicInteger resent = new AtomicInteger();

        client.attachSocket(frame -> resent.incrementAndGet());
        client.resendSubscriptions();

        check(
                resent.get() == threads * perThread,
                "every concurrent subscribe survived with a distinct id");
    }
}
