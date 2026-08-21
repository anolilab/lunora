package dev.lunora

import java.io.File
import java.math.BigInteger

/**
 * Protocol-conformance tests: drive the Kotlin SDK against the shared golden
 * fixtures in `protocol/fixtures/`, the same files the TypeScript client and
 * every other Lunora port are tested against.
 *
 * Plain assertions rather than a test framework, so the suite needs no
 * dependency resolution — run it with `kotlin ConformanceTestKt`.
 */
private var checks = 0

/**
 * Manifest case names recorded by the cases that actually ran. The evidence is
 * produced by executing the case, not by a hand-kept list of names this suite
 * claims to cover.
 */
private val covered = linkedSetOf<String>()

/** Internal, not file-private, so the sibling case file shares one counter. */
internal fun check(condition: Boolean, message: String) {
    checks++

    if (!condition) throw AssertionError(message)
}

/** Records that the running case exercises the manifest case [name]. */
internal fun covers(name: String) {
    covered.add(name)
}

/**
 * Fails if this run did not exercise every case in
 * `protocol/conformance-cases.json`.
 *
 * The suite is a plain `main`, so the end of it is the after-all hook: the
 * recorded set comes from the cases that ran, the expected set from the
 * manifest, and neither is enumerated here.
 */
private fun assertManifestCovered() {
    val manifest = Json.parse(File(fixturesDir().parentFile, "conformance-cases.json").readText()) as Map<*, *>
    val required = manifest["required"] as? List<*>

    check(!required.isNullOrEmpty(), "the manifest must list at least one required case")

    val missing = required.orEmpty().filterNot { covered.contains(it) }

    check(
        missing.isEmpty(),
        "protocol/conformance-cases.json requires cases this suite did not run: $missing " +
            "(add a covers() call to the case that asserts it)",
    )
}

internal fun fixturesDir(): File {
    var directory = File("").absoluteFile

    repeat(8) {
        val candidate = File(directory, "protocol/fixtures")

        if (candidate.isDirectory) return candidate

        directory = directory.parentFile ?: return@repeat
    }

    error("could not locate protocol/fixtures")
}

internal fun fixture(name: String): Map<*, *> = Json.parse(File(fixturesDir(), name).readText()) as Map<*, *>

/** Canonical text form so two structures compare independent of key order. */
private fun canonical(value: Any?): String = Key.stableStringify(value)

private fun wireCodecRoundTrip() {
    covers("wire_codec_round_trip")

    val cases = fixture("wire-codec.json")["cases"] as List<*>

    check(cases.size > 10, "fixture should carry the full case set")

    for (entry in cases) {
        val testCase = entry as Map<*, *>
        val encoded = testCase["encoded"]
        val roundTripped = Wire.encode(Wire.decode(encoded))

        check(canonical(roundTripped) == canonical(encoded), "round-trip mismatch for ${testCase["name"]}")
    }
}

private fun undefinedIsDistinctFromNull() {
    covers("undefined_is_distinct_from_null")

    val encoded = Wire.encode(
        WireValue.Obj(listOf("dropped" to WireValue.Undefined, "kept" to WireValue.Null)),
    ) as Map<*, *>

    check(!encoded.containsKey("dropped"), "an Undefined object field must be dropped, matching JSON.stringify")
    check(encoded.containsKey("kept"), "a null object field must be kept")

    // In an array position the slot must survive, or every later element shifts.
    val inArray = Wire.encode(WireValue.Arr(listOf(WireValue.Undefined, WireValue.Num(1.0)))) as List<*>

    check((inArray[0] as List<*>)[1] == "undefined", "array-position undefined must stay tagged")
}

private fun overLongBigIntRejected() {
    covers("over_long_bigint_rejected")

    val overLong = "9".repeat(Wire.MAX_BIGINT_DIGITS + 1)

    check(rejects(listOf(Wire.TAG, "bigint", overLong)), "an over-long bigint must be rejected")
    check(rejects(listOf(Wire.TAG, "bigint", "12x4")), "a non-numeric bigint must be rejected")
    check(Wire.decode(listOf(Wire.TAG, "bigint", "-42")) == WireValue.BigInt(BigInteger("-42")), "-42 should decode")
}

private fun rejects(value: Any?): Boolean = try {
    Wire.decode(value)
    false
} catch (error: RuntimeException) {
    // Wire.decode's own bounds (bigint length, depth) throw its typed
    // WireFormatException; a nested decoder (Base64 on a malformed bytes tag)
    // throws its own unwrapped RuntimeException. Both are a rejection.
    true
}

private fun malformedBytesRejected() {
    covers("malformed_bytes_rejected")

    check(rejects(listOf(Wire.TAG, "bytes", "not@@base64!!")), "malformed base64 in a bytes tag must be rejected")

    val decoded = Wire.decode(listOf(Wire.TAG, "bytes", "AQID"))

    check(
        decoded is WireValue.Bytes && decoded.data.contentEquals(byteArrayOf(1, 2, 3)),
        "well-formed bytes must still decode",
    )
}

private fun depthCapEnforced() {
    covers("depth_cap_enforced")

    var nested: Any? = "leaf"

    repeat(Wire.MAX_DEPTH + 2) { nested = listOf(nested) }

    check(rejects(nested), "decoding past the depth cap must be rejected")
}

private fun stableWireKeyFixtures() {
    covers("stable_wire_key_fixtures")

    val document = fixture("stable-wire-key.json")

    for (entry in document["cases"] as List<*>) {
        val testCase = entry as Map<*, *>

        check(
            Key.stableWireKey(Wire.decode(testCase["args"])) == testCase["key"],
            "key for ${testCase["name"]}",
        )
    }

    for (entry in document["typed"] as List<*>) {
        val testCase = entry as Map<*, *>

        check(
            Key.stableWireKey(Wire.decode(testCase["wireArgs"])) == testCase["key"],
            "typed key for ${testCase["name"]}",
        )
    }
}

/** Expected spellings captured from a real JS engine, not derived from the spec. */
private fun formatNumberMatchesEcmaScript() {
    covers("format_number_matches_ecmascript")

    val cases = listOf(
        0.0 to "0", 3.0 to "3", 1.5 to "1.5", -2.5 to "-2.5",
        1e-5 to "0.00001", 1e-6 to "0.000001", 1e-7 to "1e-7", 1.5e-7 to "1.5e-7",
        1e-21 to "1e-21", 1e20 to "100000000000000000000", 1e21 to "1e+21",
    )

    for ((value, want) in cases) {
        check(Key.formatNumber(value) == want, "formatNumber($value) = ${Key.formatNumber(value)}, want $want")
    }
}

private fun keyOrderMatchesUtf16() {
    covers("key_order_matches_utf16")

    // The JVM's String.compareTo already compares UTF-16 code units, which is
    // exactly JavaScript's ordering.
    val rendered = Key.stableStringify(linkedMapOf("�" to 4.0, "😀" to 3.0, " " to 2.0, "A" to 1.0))

    check(rendered == "{\"A\":1,\" \":2,\"😀\":3,\"�\":4}", "key order must follow UTF-16 code units")
}

private fun stringEscapingMatchesJsonStringify() {
    covers("string_escaping_matches_json_stringify")

    check(Key.jsonString("a<b>&c") == "\"a<b>&c\"", "angle brackets and ampersand stay raw")
    check(Key.jsonString("  ") == "\"  \"", "line separators stay raw")
    check(Key.jsonString("tab\there") == "\"tab\\there\"", "control characters are escaped")
}

private fun rpcRequestBodies() {
    covers("rpc_request_bodies")

    val request = fixture("rpc.json")["request"] as Map<*, *>

    for (entry in request["cases"] as List<*>) {
        val testCase = entry as Map<*, *>
        val args = Wire.decode(if (testCase.containsKey("args")) testCase["args"] else testCase["argsWire"])
        val body = Client.buildRpcBody(testCase["functionPath"] as String, args, testCase["shardKey"] as? String)

        check(canonical(body) == canonical(testCase["body"]), "body for ${testCase["name"]}")
    }
}

private fun rpcResponses() {
    covers("rpc_responses")

    val document = fixture("rpc.json")

    for (entry in document["responseOk"] as List<*>) {
        val testCase = entry as Map<*, *>
        val response = testCase["response"] as Map<*, *>
        val value = Client.parseRpcResponse(response, 200)

        check(canonical(Wire.encode(value)) == canonical(response["result"]), "result for ${testCase["name"]}")
    }

    for (entry in document["responseError"] as List<*>) {
        val testCase = entry as Map<*, *>
        val response = testCase["response"] as Map<*, *>

        try {
            Client.parseRpcResponse(response, 400)
            check(false, "expected an ApiException for ${testCase["name"]}")
        } catch (error: ApiException) {
            check(error.code == testCase["code"], "code for ${testCase["name"]}")
            check(error.message == testCase["message"], "message for ${testCase["name"]}")
        }
    }
}

private fun non2xxWithoutEnvelopeThrows() {
    covers("non_2xx_without_error_envelope_fails")

    // protocol/README.md §4.2. Without the status check this returned null and
    // threw nothing — the caller believes its mutation committed.
    try {
        Client.parseRpcResponse(mapOf("message" to "bad gateway"), 502)
        check(false, "a 502 without an error envelope must throw")
    } catch (error: ApiException) {
        check(error.code == "INTERNAL", "the transport error is INTERNAL")
    }
}

private fun clientFrameBuilders() {
    covers("client_frame_builders")

    val frames = fixture("ws-frames.json")["clientFrames"] as Map<*, *>
    val args = WireValue.Obj(listOf("channel" to WireValue.Text("general")))

    check(canonical(Client.buildConnectFrame("client-test")) == canonical(frames["connect"]), "connect")
    check(
        canonical(Client.buildConnectFrame("client-test", mapOf("roomId" to "general"))) ==
            canonical(frames["connect-with-context"]),
        "connect-with-context",
    )
    check(
        canonical(Client.buildSubscribeFrame("sub_1", "messages:list", args)) == canonical(frames["subscribe-cold"]),
        "subscribe-cold",
    )
    check(
        canonical(Client.buildSubscribeFrame("sub_1", "messages:list", args, null, 12.0, "e1")) ==
            canonical(frames["subscribe-resume"]),
        "subscribe-resume",
    )
    check(canonical(Client.buildUnsubscribeFrame("sub_1")) == canonical(frames["unsubscribe"]), "unsubscribe")
}

private fun serverFrameConsumer() {
    covers("server_frame_consumer")

    for (entry in fixture("ws-frames.json")["serverFrames"] as List<*>) {
        val testCase = entry as Map<*, *>
        val client = Client("https://app.example")

        client.attachSocket { }

        val seen = mutableListOf<WireValue>()
        val errors = mutableListOf<SubscriptionError>()

        client.subscribe(
            "messages:list",
            WireValue.Obj(listOf("channel" to WireValue.Text("general"))),
            { seen.add(it) },
            { errors.add(it) },
        )

        val kind = client.handleFrame(Json.write(testCase["frame"]))
        val expect = testCase["expect"] as Map<*, *>

        check(kind == expect["kind"], "kind for ${testCase["name"]}")

        if (expect.containsKey("valueWire")) {
            check(seen.size == 1, "onData should fire once for ${testCase["name"]}")
            check(canonical(Wire.encode(seen[0])) == canonical(expect["valueWire"]), "value for ${testCase["name"]}")
        }

        if (expect["kind"] == "error") {
            check(errors.size == 1, "onError should fire once")
            check(errors[0].code == expect["code"], "error code")
        }
    }
}

/**
 * The Sequence form of a live query: same subscription, same decode, same order
 * as the callback form.
 */
private fun subscriptionStreamYieldsFrameValuesInOrder() {
    covers("subscription_stream_yields_frame_values_in_order")

    val case = fixture("ws-frames.json")["stream"] as Map<*, *>
    val client = Client("https://app.example")

    client.attachSocket { }

    // Closed at the end rather than in a `use { }`: the frames are fed from this
    // same thread, so the loop has to be driven one `next()` at a time.
    val stream = client.stream("messages:list", WireValue.Obj(listOf("channel" to WireValue.Text("general"))))
    val events = stream.iterator()
    val seen = mutableListOf<WireValue>()

    for (frame in case["frames"] as List<*>) {
        client.handleFrame(Json.write(frame))

        val event = events.next()

        check(event.error == null, "a streamed event carries a value, not an error")
        seen.add(checkNotNull(event.value))
    }

    stream.close()

    check(canonical(Wire.encode(WireValue.Arr(seen))) == canonical(case["yielded"]), "the stream yields the frames' values, in order")
    check(!events.hasNext(), "and closing ends the loop rather than blocking it forever")
}

private fun shapeSubscribeFrame() {
    covers("shape_subscribe_frame")

    val shape = fixture("ws-frames.json")["shape"] as Map<*, *>
    val args = WireValue.Obj(listOf("room" to WireValue.Text("general")))

    check(
        canonical(Client.buildShapeSubscribeFrame("shape_1", "roomMessages", args)) ==
            canonical(shape["shape-subscribe-cold"]),
        "shape-subscribe-cold",
    )
}

private fun pokeSequenceMaterialisesRows() {
    covers("poke_sequence_materialises_rows")

    val shape = fixture("ws-frames.json")["shape"] as Map<*, *>
    val client = Client("https://app.example")

    client.attachSocket { }

    val delivered = mutableListOf<List<WireValue>>()

    client.subscribeShape("roomMessages", WireValue.Obj(listOf("room" to WireValue.Text("general"))), { delivered.add(it) })

    for (frame in shape["pokeSequence"] as List<*>) {
        client.handleFrame(Json.write(frame))
    }

    check(delivered.size == 1, "a poke applies atomically at pokeEnd")
    check(
        canonical(Wire.encode(WireValue.Arr(delivered.last()))) == canonical(shape["expectedRows"]),
        "materialised rows",
    )
}

private fun pokePartsDoNotApplyBeforePokeEnd() {
    covers("poke_parts_do_not_apply_before_poke_end")

    val shape = fixture("ws-frames.json")["shape"] as Map<*, *>
    val client = Client("https://app.example")

    client.attachSocket { }

    var fired = 0

    client.subscribeShape("roomMessages", null, { fired++ })

    val sequence = shape["pokeSequence"] as List<*>

    for (index in 0 until sequence.size - 1) {
        client.handleFrame(Json.write(sequence[index]))
    }

    check(fired == 0, "the view would be torn if parts applied before pokeEnd")
}

/**
 * A `reset` part carries the shape's COMPLETE membership, so the view has to be
 * dropped before the ops are applied.
 *
 * Not a manifest case — the shared manifest does not name one — but the shared
 * fixture carries the sequence, so this is the same assertion every port makes.
 * It starts from the cold-seed state on purpose: a re-seed is inserts-only, so
 * `m1` leaves the shape with no delete op behind it, and a client that merges
 * renders it for the rest of its life.
 */
private fun resetPokeReplacesShapeMembership() {
    covers("shape_reset_poke_replaces_membership")

    val shape = fixture("ws-frames.json")["shape"] as Map<*, *>
    val client = Client("https://app.example")

    client.attachSocket { }

    val delivered = mutableListOf<List<WireValue>>()

    client.subscribeShape("roomMessages", WireValue.Obj(listOf("room" to WireValue.Text("general"))), { delivered.add(it) })

    for (frame in shape["pokeSequence"] as List<*>) {
        client.handleFrame(Json.write(frame))
    }

    check(
        canonical(Wire.encode(WireValue.Arr(delivered.last()))) == canonical(shape["expectedRows"]),
        "the cold seed lands before the re-seed",
    )

    for (frame in shape["resetPokeSequence"] as List<*>) {
        client.handleFrame(Json.write(frame))
    }

    check(
        canonical(Wire.encode(WireValue.Arr(delivered.last()))) == canonical(shape["resetExpectedRows"]),
        "a reset poke replaces the shape's membership rather than merging into it",
    )
}

/**
 * The topology every real consumer has: a socket read loop on one thread,
 * application code subscribing on another.
 *
 * The assertion is on the COUNT, not on the absence of a crash: an
 * unsynchronised `nextId++` hands two threads the same id, the second put
 * replaces the first, and the client silently forgets a live subscription. A
 * resend then emits fewer frames than there are subscribers — deterministic,
 * unlike waiting for a LinkedHashMap to corrupt.
 */
private fun concurrentSubscribeAndHandleFrame() {
    val threads = 4
    val perThread = 250
    val client = Client("https://app.example")

    val workers = (0 until threads).map {
        Thread { repeat(perThread) { client.subscribe("messages:list", null, {}) } }
    }

    val reader = Thread {
        repeat(threads * perThread) { call ->
            client.handleFrame("""{"type":"data","id":"sub_1","data":1,"cursor":$call}""")
        }
    }

    workers.forEach { it.start() }
    reader.start()
    workers.forEach { it.join() }
    reader.join()

    // Attached only now, so the count below sees resend frames alone.
    val resent = java.util.concurrent.atomic.AtomicInteger()

    client.attachSocket { resent.incrementAndGet() }
    client.resendSubscriptions()

    check(resent.get() == threads * perThread, "every concurrent subscribe survived with a distinct id")
}

fun main() {
    wireCodecRoundTrip()
    undefinedIsDistinctFromNull()
    overLongBigIntRejected()
    malformedBytesRejected()
    depthCapEnforced()
    stableWireKeyFixtures()
    formatNumberMatchesEcmaScript()
    keyOrderMatchesUtf16()
    stringEscapingMatchesJsonStringify()
    rpcRequestBodies()
    rpcResponses()
    non2xxWithoutEnvelopeThrows()
    clientFrameBuilders()
    serverFrameConsumer()
    subscriptionStreamYieldsFrameValuesInOrder()
    shapeSubscribeFrame()
    pokeSequenceMaterialisesRows()
    pokePartsDoNotApplyBeforePokeEnd()
    resetPokeReplacesShapeMembership()
    concurrentSubscribeAndHandleFrame()

    // The optimistic-layer and offline-queue cases, in their own file so this one
    // stays the wire-protocol suite it has always been.
    runOptimisticOfflineCases()

    assertManifestCovered()

    println("OK — $checks assertions")
}
