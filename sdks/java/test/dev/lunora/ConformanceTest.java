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
        shapePokeWithUndecodableRowIsRefusedWhole();
        malformedFramesAreIgnoredWithoutRaising();
        rpcUnreadableSuccessBodyRaisesSdkError();
        subscriptionStreamEndsOnClose();
        identityChangeEvictsPreviousSession();
        authTokenRedactedWhenPrinted();

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

    /**
     * Renders a value the way {@link Client} puts it on the socket, with {@link Json#write}.
     * Separate from {@link #canonical}, which is free to normalise: {@code stableStringify} spells
     * every number the ECMAScript way, so {@code 1.0} and {@code 1} compare EQUAL through it — the
     * divergence a round-trip case exists to catch. Dart's dates went out as {@code
     * 1700000000000.0} for exactly that reason, on a green suite.
     */
    private static String wireText(Object value) {
        return Json.write(value);
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
            // And again as the BYTES the transport sends: a round-trip
            // assertion measured on a string the transport never sends cannot
            // see the divergence it exists to catch.
            check(
                    wireText(roundTripped).equals(wireText(expected)),
                    "wire-text mismatch for " + testCase.get("name"));
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

        // A `data` frame is ONE envelope level, and measuring the cap only there
        // is how it shipped a level short. The deepest envelope the protocol has
        // is the batch response (protocol/README.md §4.3) at four, and an offline
        // flush that could not parse its own 200 body classified a committed
        // batch as a transport failure and replayed it forever.
        Map<String, Object> slotBody = new LinkedHashMap<>();

        slotBody.put("result", deepest);

        Map<String, Object> slot = new LinkedHashMap<>();

        slot.put("id", 0);
        slot.put("status", 200);
        slot.put("body", slotBody);

        Map<String, Object> batch = new LinkedHashMap<>();

        batch.put("results", List.of(slot));

        check(
                Json.parse(Json.write(batch)) != null,
                "a MAX_DEPTH value must survive the batch-response envelope");
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

        // A lone surrogate is escaped lowercase, as JSON.stringify writes it; a well-formed pair
        // stays raw. Left raw, the transport's UTF-8 encoder put a lone one on the wire as `?`.
        check(
                Key.jsonString("a\uD800b").equals("\"a\\ud800b\""),
                "a lone high surrogate is escaped, got " + Key.jsonString("a\uD800b"));
        check(
                Key.jsonString("\uDC00\uD800").equals("\"\\udc00\\ud800\""),
                "a reversed pair is two lone surrogates");
        check(Key.jsonString("x\uD83D\uDE00").equals("\"x\uD83D\uDE00\""), "a pair stays raw");
        check(
                Key.jsonString("\uD83D").equals("\"\\ud83d\"")
                        && Key.jsonString("\uDE00").equals("\"\\ude00\""),
                "a surrogate at either end of the string is escaped");

        byte[] wire =
                Json.write(Client.buildRpcBody("m:f", Map.of("s", "a\uD800b"), null))
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8);

        check(
                new String(wire, java.nio.charset.StandardCharsets.UTF_8)
                        .equals("{\"args\":{\"s\":\"a\\ud800b\"},\"functionPath\":\"m:f\"}"),
                "the request body carries the escape, not a replacement character");
        check(
                !Key.stableWireKey(List.of("a\uD800b")).equals(Key.stableWireKey(List.of("a?b"))),
                "a lone surrogate and a question mark key apart");
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

                // Data the codec refuses is dropped; the coded verdict still stands.
                if (Boolean.TRUE.equals(testCase.get("dataDropped"))) {
                    check(error.data == null, "data is dropped for " + testCase.get("name"));
                }
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static void non2xxWithoutEnvelopeThrows() throws IOException {
        covers("non_2xx_without_error_envelope_fails");

        // protocol/README.md §4.2. Without the status check this returned null
        // and threw nothing — the caller believes its mutation committed. The
        // fixture's non-object `error` slots are the other half: a slot holding
        // a string, a null or an array is not an envelope either, and a port
        // reading one without a type check throws its LANGUAGE's exception
        // rather than ApiException, escaping every handler the caller wrote.
        for (Object entry : (List<Object>) fixture("rpc.json").get("responseTransportError")) {
            Map<String, Object> testCase = (Map<String, Object>) entry;
            Map<String, Object> response = (Map<String, Object>) testCase.get("response");
            int status = ((Number) testCase.get("status")).intValue();

            try {
                Client.parseRpcResponse(response, status);
                check(false, "expected an ApiException for " + testCase.get("name"));
            } catch (Client.ApiException error) {
                check(error.code.equals(testCase.get("code")), "code for " + testCase.get("name"));
                // Nothing reached the shard, so a queued write must be replayed
                // rather than dropped — the batch path already says so.
                check(error.transientFailure, "transient for " + testCase.get("name"));
            }
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
        covers("complete_frame_cancels_without_dropping_the_subscription");

        int cancellations = 0;

        for (Object entry : (List<Object>) fixture("ws-frames.json").get("serverFrames")) {
            Map<String, Object> testCase = (Map<String, Object>) entry;
            Client client = new Client("https://app.example", null);
            List<Map<String, Object>> sent = new ArrayList<>();

            client.attachSocket(sent::add);

            List<Object> seen = new ArrayList<>();
            List<Client.SubscriptionError> errors = new ArrayList<>();
            Map<String, Object> args = new LinkedHashMap<>();

            args.put("channel", "general");
            client.subscribe("messages:list", args, seen::add, errors::add, null);
            sent.clear();

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

            // Cancelled AND kept. Removing the entry takes it out of the map
            // resendSubscriptions walks, which froze the query across every future reconnect
            // with nothing reported.
            if (Boolean.TRUE.equals(expect.get("resendsAfterReconnect"))) {
                cancellations++;
                check(errors.size() == 1, "a complete frame cancels once");
                check(
                        java.util.Objects.equals(errors.get(0).code(), expect.get("code")),
                        "cancellation code");
                check(
                        java.util.Objects.equals(errors.get(0).message(), expect.get("message")),
                        "cancellation message");
                client.resendSubscriptions();

                List<Object> resubscribed = new ArrayList<>();

                for (Map<String, Object> frame : sent) {
                    if ("subscribe".equals(frame.get("type"))) {
                        resubscribed.add(frame.get("id"));
                    }
                }

                check(
                        resubscribed.equals(List.of(expect.get("id"))),
                        "the cancelled subscription is resent on reconnect");
            }
        }

        // A conditional assertion that never runs is worse than none: without this,
        // renaming the fixture key would leave every suite green.
        check(cancellations == 1, "serverFrames must carry one cancelling case");
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

    /** The frame {@code resendSubscriptions} sent for {@code id}. */
    private static Map<String, Object> resent(List<Map<String, Object>> sent, String id) {
        for (Map<String, Object> frame : sent) {
            if (id.equals(frame.get("id"))) {
                return frame;
            }
        }

        throw new AssertionError("nothing was resent for " + id);
    }

    /** Numeric equality across the parser's Double and a fixture's integral value. */
    private static boolean sameNumber(Object left, Object right) {
        return left instanceof Number a
                && right instanceof Number b
                && a.doubleValue() == b.doubleValue();
    }

    /**
     * What the first shape's view holds right now, read through the real poke path: an empty poke
     * fires {@code onRows} with the whole view.
     */
    private static List<Object> shapeView(Client client, List<List<Object>> delivered) {
        int before = delivered.size();

        client.handleFrame("{\"type\":\"pokeStart\",\"pokeId\":\"view\"}");
        client.handleFrame(
                "{\"type\":\"pokePart\",\"pokeId\":\"view\",\"shapeId\":\"shape_1\","
                        + "\"rowsPatch\":[]}");
        client.handleFrame("{\"type\":\"pokeEnd\",\"pokeId\":\"view\"}");
        check(delivered.size() == before + 1, "an empty poke reports the view");

        return delivered.get(delivered.size() - 1);
    }

    /**
     * A poke carrying a row that will not decode is refused WHOLE for that shape: nothing of it is
     * applied (not even the reset's clear), the resume checkpoint stays where it was, no rows
     * callback fires, and the shape's error callback gets {@code INVALID_FRAME}. Another shape in
     * the same poke still applies.
     */
    @SuppressWarnings("unchecked")
    private static void shapePokeWithUndecodableRowIsRefusedWhole() throws IOException {
        covers("shape_poke_with_undecodable_row_is_refused_whole");

        Map<String, Object> shape = (Map<String, Object>) fixture("ws-frames.json").get("shape");
        Client client = new Client("https://app.example", null);
        List<Map<String, Object>> sent = new ArrayList<>();

        client.attachSocket(sent::add);

        List<List<Object>> delivered = new ArrayList<>();
        List<List<Object>> otherDelivered = new ArrayList<>();
        List<Client.SubscriptionError> errors = new ArrayList<>();
        Map<String, Object> args = new LinkedHashMap<>();

        args.put("room", "general");
        client.subscribeShape("roomMessages", args, delivered::add, errors::add);
        client.subscribeShape("roomMessages", args, otherDelivered::add, null);

        for (Object frame : (List<Object>) shape.get("pokeSequence")) {
            client.handleFrame(Json.write(frame));
        }

        delivered.clear();

        List<Object> sequence =
                new ArrayList<>((List<Object>) shape.get("undecodableRowPokeSequence"));
        // A second shape rides the same poke with a row that decodes: its part must still apply.
        Map<String, Object> otherPart = new LinkedHashMap<>();
        Map<String, Object> otherRow = new LinkedHashMap<>();

        otherRow.put("op", "insert");
        otherRow.put("key", "o1");
        otherRow.put("value", Map.of("_id", "o1"));
        otherPart.put("type", "pokePart");
        otherPart.put("pokeId", ((Map<String, Object>) sequence.get(0)).get("pokeId"));
        otherPart.put("shapeId", "shape_2");
        otherPart.put("rowsPatch", List.of(otherRow));
        sequence.add(sequence.size() - 1, otherPart);

        for (Object frame : sequence) {
            client.handleFrame(Json.write(frame));
        }

        check(delivered.isEmpty(), "no rows callback fires for the refused shape");
        check(
                errors.size() == 1
                        && shape.get("undecodableRowErrorCode").equals(errors.get(0).code()),
                "the shape's error callback gets the fixture's code once, got " + errors);
        check(
                otherDelivered.size() == 1
                        && canonical(otherDelivered.get(0))
                                .equals(canonical(List.of(Map.of("_id", "o1")))),
                "the other shape in the same poke still applies");

        sent.clear();
        client.resendSubscriptions();

        Map<String, Object> resend = resent(sent, "shape_1");

        check(
                sameNumber(
                        resend.get("sinceCheckpoint"), shape.get("undecodableRowResendCheckpoint")),
                "the checkpoint is not advanced past a row the view never held, got "
                        + resend.get("sinceCheckpoint"));
        check("e1".equals(resend.get("sinceEpoch")), "nor is the epoch");
        check(
                canonical(shapeView(client, delivered))
                        .equals(canonical(shape.get("expectedRows"))),
                "the view is exactly what it was before the refused poke");

        // The server believes it delivered the refused rows, so its next part is based on a
        // checkpoint this view never reached: the shape must re-seed rather than splice onto it.
        delivered.clear();
        sent.clear();

        for (Object frame : (List<Object>) shape.get("gapPokeSequence")) {
            client.handleFrame(Json.write(frame));
        }

        check(
                canonical(delivered).equals(canonical(List.of(List.of()))),
                "a diverged base empties the view and tells the callback [], got " + delivered);

        Map<String, Object> cold = resent(sent, "shape_1");

        check(
                "shape_subscribe".equals(cold.get("type"))
                        && !cold.containsKey("sinceCheckpoint")
                        && !cold.containsKey("sinceEpoch"),
                "and re-subscribes the shape cold at once, sent " + sent);

        sent.clear();
        client.resendSubscriptions();

        Map<String, Object> resubscribe = resent(sent, "shape_1");

        check(
                !resubscribe.containsKey("sinceCheckpoint")
                        && !resubscribe.containsKey("sinceEpoch"),
                "a later resend is cold too, got " + resubscribe);
        check(
                canonical(shapeView(client, delivered))
                        .equals(canonical(shape.get("gapExpectedRows"))),
                "the gapped rows were never spliced on");

        // The counterweight: a poke based on the checkpoint the view IS at applies normally.
        Client contiguous = new Client("https://app.example", null);
        List<Map<String, Object>> contiguousSent = new ArrayList<>();
        List<List<Object>> contiguousDelivered = new ArrayList<>();

        contiguous.attachSocket(contiguousSent::add);
        contiguous.subscribeShape("roomMessages", args, contiguousDelivered::add, null);

        for (Object frame : (List<Object>) shape.get("pokeSequence")) {
            contiguous.handleFrame(Json.write(frame));
        }

        contiguousSent.clear();

        for (Object frame : (List<Object>) shape.get("contiguousPokeSequence")) {
            contiguous.handleFrame(Json.write(frame));
        }

        check(
                canonical(contiguousDelivered.get(contiguousDelivered.size() - 1))
                        .equals(canonical(shape.get("contiguousExpectedRows"))),
                "a contiguous based poke applies, got " + contiguousDelivered);
        check(contiguousSent.isEmpty(), "and re-seeds nothing");
    }

    /**
     * Frames shaped like no server frame are ignored: nothing raises out of the read loop's entry
     * point, and the live subscription is untouched — including by a string where a cursor goes.
     */
    @SuppressWarnings("unchecked")
    private static void malformedFramesAreIgnoredWithoutRaising() throws IOException {
        covers("malformed_frames_are_ignored_without_raising");

        Map<String, Object> testCase =
                (Map<String, Object>) fixture("ws-frames.json").get("malformedFrames");
        List<Object> frames = (List<Object>) testCase.get("frames");

        check(frames.size() > 10, "malformedFrames must carry its frames");

        for (Object frame : frames) {
            String raw = Json.write(frame);
            Client client = new Client("https://app.example", null);
            List<Map<String, Object>> sent = new ArrayList<>();
            List<Object> seen = new ArrayList<>();
            List<Client.SubscriptionError> errors = new ArrayList<>();

            client.attachSocket(sent::add);
            client.subscribe("messages:list", new LinkedHashMap<>(), seen::add, errors::add, null);
            client.handleFrame(Json.write(testCase.get("setupFrame")));
            seen.clear();

            try {
                client.handleFrame(raw);
            } catch (RuntimeException error) {
                check(false, "handleFrame(" + raw + ") threw " + error);
            }

            check(seen.isEmpty() && errors.isEmpty(), raw + " must not reach sub_1");

            sent.clear();
            client.resendSubscriptions();

            Map<String, Object> query = (Map<String, Object>) resent(sent, "sub_1").get("query");

            check(
                    sameNumber(query.get("sinceSeq"), testCase.get("resendSinceSeq"))
                            && testCase.get("resendSinceEpoch").equals(query.get("sinceEpoch")),
                    raw + " must leave the resume cursor alone, resent " + query);
        }
    }

    /**
     * A response the call can read neither a result nor an error envelope out of fails with the
     * SDK's own error type, coded — never a parse, cast or null exception from the JDK.
     */
    @SuppressWarnings("unchecked")
    private static void rpcUnreadableSuccessBodyRaisesSdkError() throws IOException {
        covers("rpc_unreadable_success_body_raises_sdk_error");

        List<Object> cases = (List<Object>) fixture("rpc.json").get("unreadableSuccessBody");

        check(cases.size() >= 3, "unreadableSuccessBody must carry its cases");

        for (Object entry : cases) {
            Map<String, Object> testCase = (Map<String, Object>) entry;
            int status = ((Number) testCase.get("status")).intValue();
            String rawBody = (String) testCase.get("rawBody");
            Client client =
                    new Client(
                            "https://app.example",
                            (url, headers, body) -> new Client.Response(status, rawBody));

            for (Client.Verb verb : Client.Verb.values()) {
                try {
                    client.call(verb, "messages:list", null, null);
                    check(false, verb + " must fail for " + testCase.get("name"));
                } catch (Client.ApiException error) {
                    check(
                            testCase.get("code").equals(error.code),
                            verb + " code for " + testCase.get("name"));
                } catch (RuntimeException error) {
                    check(false, verb + " " + testCase.get("name") + " threw " + error);
                }
            }
        }

        Client empty =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> new Client.Response(200, "{}"));

        check(empty.query("messages:list", null, null) == null, "{} is a void result");
    }

    /** Closing the client ends a pull stream after the value it already delivered. */
    @SuppressWarnings("unchecked")
    private static void subscriptionStreamEndsOnClose() throws IOException, InterruptedException {
        covers("subscription_stream_ends_on_close");

        Map<String, Object> testCase =
                (Map<String, Object>) fixture("ws-frames.json").get("stream");
        Client client = new Client("https://app.example", null);

        client.attachSocket(frame -> {});

        Client.Stream stream = client.stream("messages:list", Map.of("channel", "general"), null);
        List<Object> seen = java.util.Collections.synchronizedList(new ArrayList<>());
        Thread consumer =
                new Thread(
                        () -> {
                            for (Client.StreamEvent event : stream) {
                                seen.add(event.value());
                            }
                        });

        consumer.setDaemon(true);
        consumer.start();
        client.handleFrame(Json.write(((List<Object>) testCase.get("frames")).get(0)));
        client.close();
        consumer.join(2_000);

        check(!consumer.isAlive(), "the stream ends within 2 s of close()");
        check(
                canonical(Wire.encode(seen))
                        .equals(
                                canonical(
                                        List.of(((List<Object>) testCase.get("yielded")).get(0)))),
                "after yielding the value already delivered");
    }

    /**
     * Changing identity from a set value evicts that identity's session: every resume cursor and
     * epoch is dropped and every shape view emptied, with its callback told. A first set and a
     * same-value set evict nothing.
     */
    @SuppressWarnings("unchecked")
    private static void identityChangeEvictsPreviousSession() throws IOException {
        covers("identity_change_evicts_previous_session");

        Map<String, Object> document = fixture("ws-frames.json");
        Map<String, Object> testCase = (Map<String, Object>) document.get("identityChange");
        Map<String, Object> shape = (Map<String, Object>) document.get("shape");
        Map<String, Object> retained = (Map<String, Object>) testCase.get("retained");
        Map<String, Object> evicted = (Map<String, Object>) testCase.get("evicted");
        List<Object> transitions = (List<Object>) testCase.get("transitions");

        check(transitions.size() == 4, "identityChange must carry its transitions");

        for (Object raw : transitions) {
            Map<String, Object> transition = (Map<String, Object>) raw;
            String label = transition.get("from") + " -> " + transition.get("to");
            Client client = new Client("https://app.example", null);
            List<Map<String, Object>> sent = new ArrayList<>();
            List<List<Object>> delivered = new ArrayList<>();

            client.identity((String) transition.get("from"));
            client.attachSocket(sent::add);
            client.subscribe("messages:list", new LinkedHashMap<>(), value -> {}, null, null);
            client.handleFrame(Json.write(testCase.get("queryFrame")));
            client.subscribeShape("roomMessages", Map.of("room", "general"), delivered::add, null);

            for (Object frame : (List<Object>) shape.get("pokeSequence")) {
                client.handleFrame(Json.write(frame));
            }

            delivered.clear();
            client.identity((String) transition.get("to"));
            check(
                    java.util.Objects.equals(client.identity(), transition.get("to")),
                    "the identity is set, " + label);

            sent.clear();
            client.resendSubscriptions();

            Map<String, Object> query = (Map<String, Object>) resent(sent, "sub_1").get("query");
            Map<String, Object> shapeFrame = resent(sent, "shape_1");

            if (Boolean.TRUE.equals(transition.get("evicts"))) {
                check(
                        !query.containsKey("sinceSeq") && !query.containsKey("sinceEpoch"),
                        "the query resumes cold, " + label + ": " + query);
                check(
                        !shapeFrame.containsKey("sinceCheckpoint")
                                && !shapeFrame.containsKey("sinceEpoch"),
                        "the shape resumes cold, " + label + ": " + shapeFrame);
                check(
                        canonical(delivered)
                                .equals(canonical(List.of(evicted.get("shapeCallbackRows")))),
                        "the shape callback is told its view is empty, " + label);
                check(
                        canonical(shapeView(client, delivered))
                                .equals(canonical(evicted.get("shapeRows"))),
                        "the shape view is emptied, " + label);
            } else {
                check(
                        sameNumber(query.get("sinceSeq"), retained.get("sinceSeq"))
                                && retained.get("sinceEpoch").equals(query.get("sinceEpoch")),
                        "the query keeps its cursor, " + label + ": " + query);
                check(
                        sameNumber(
                                        shapeFrame.get("sinceCheckpoint"),
                                        retained.get("sinceCheckpoint"))
                                && retained.get("sinceEpoch").equals(shapeFrame.get("sinceEpoch")),
                        "the shape keeps its checkpoint, " + label + ": " + shapeFrame);
                check(delivered.isEmpty(), "no shape callback fires, " + label);
                check(
                        shapeView(client, delivered).size()
                                == ((Number) retained.get("shapeRowCount")).intValue(),
                        "the shape keeps its rows, " + label);
            }
        }
    }

    /** The bearer token never reaches a printed client. */
    private static void authTokenRedactedWhenPrinted() {
        covers("auth_token_redacted_when_printed");

        String token = "lunora-secret-7f3a9c";
        Client client = new Client("https://app.example", null);

        client.authToken = token;

        for (String printed : List.of(client.toString(), String.valueOf(client))) {
            check(!printed.contains(token), "the token leaked into " + printed);
        }
    }
}
