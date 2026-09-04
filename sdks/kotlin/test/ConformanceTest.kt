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
        // A handful of shapes are legitimately not fixed points — a bare [TAG]
        // array is escaped on the way out, an Undefined object field is dropped
        // — and carry the expected re-encoding.
        val expected = if (testCase.containsKey("reencoded")) testCase["reencoded"] else encoded

        check(canonical(roundTripped) == canonical(expected), "round-trip mismatch for ${testCase["name"]}")
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
} catch (error: WireFormatException) {
    // ONLY the codec's own type counts. This used to catch RuntimeException,
    // which was wider than the codec — `decodeBytes` wraps Base64's
    // IllegalArgumentException — so a regression letting a raw JDK exception
    // escape `Wire.decode` still read as a rejection, while a caller catching
    // WireFormatException caught nothing.
    true
}

/**
 * Walks the shared rejection list.
 *
 * The list is data (`protocol/fixtures/wire-codec.json`), not a per-suite
 * invention: a rejection each port hard-codes for itself is a rejection only
 * some ports have, which is how one of them ended up accepting a truncated
 * base64 payload as valid short bytes.
 */
private fun malformedValuesRejected() {
    covers("malformed_values_rejected")

    val rejected = fixture("wire-codec.json")["rejected"] as? List<*>

    check(!rejected.isNullOrEmpty(), "the fixture must carry a rejection list")

    for (entry in rejected.orEmpty()) {
        val testCase = entry as Map<*, *>

        check(rejects(testCase["encoded"]), "${testCase["name"]} must be rejected")
    }

    val decoded = Wire.decode(listOf(Wire.TAG, "bytes", "AQID"))

    check(
        decoded is WireValue.Bytes && decoded.data.contentEquals(byteArrayOf(1, 2, 3)),
        "well-formed bytes must still decode",
    )

    // A bare [TAG] is NOT malformed: it is the forward-compat shape, and the
    // reference hands it back as an ordinary array.
    check(Wire.decode(listOf(Wire.TAG)) == WireValue.Arr(listOf(WireValue.Text(Wire.TAG))), "a bare tag array decodes as an array")
}

/**
 * An integer a `Double` cannot hold exactly must not silently become a
 * different integer on the wire.
 *
 * [WireValue.Num] IS a `Double`, so this port cannot carry such an integer
 * through the codec at all — the exposure is the decode side, where a JSON
 * parser could hand over a `Long`. That is refused rather than narrowed.
 */
private fun exactIntegerRangeEnforced() {
    covers("exact_integer_range_enforced")

    val maximum = 9007199254740991L

    check(Wire.encode(WireValue.Num(maximum.toDouble())) == maximum.toDouble(), "the largest exact integer encodes")
    check(rejects(maximum + 1), "a Long past the exact Double range must be refused, not narrowed")
    check(rejects(-maximum - 1), "a Long past the exact Double range must be refused, not narrowed")

    // BigInt is the way across, and it keeps every digit.
    check(
        canonical(Wire.encode(WireValue.BigInt(BigInteger("9007199254740992")))) ==
            canonical(listOf(Wire.TAG, "bigint", "9007199254740992")),
        "BigInt carries the value the number range refuses",
    )
}

/**
 * An EMPTY shard key is absent, not the shard named `""`.
 *
 * The runtime takes any string as a named shard and gives `""` its own Durable
 * Object, while this client treats `""` and null as one shard wherever it
 * matches a subscription or drains the queue. Sending it split those two views:
 * a single-call replay of a queued write landed on one Durable Object and a
 * BATCHED replay of that same write on another, with the optimistic overlay
 * tracking neither. Both builders that carry a shard key are asserted, because
 * normalising one and not the other is the same split.
 */
private fun emptyShardKeyIsOmitted() {
    covers("empty_shard_key_is_omitted")

    for (absent in listOf(null, "")) {
        check(
            !Client.buildRpcBody("messages:send", WireValue.Obj(emptyList()), absent).containsKey("shardKey"),
            "shard key $absent must not reach the RPC body",
        )
    }

    check(
        Client.buildRpcBody("messages:send", WireValue.Obj(emptyList()), "room-1")["shardKey"] == "room-1",
        "a real shard key still rides the body",
    )

    val client = Client("https://app.example", null)

    for (absent in listOf(null, "")) {
        check(!client.wsUrl(absent, null).contains("shard="), "shard key $absent must not name a shard on the socket")
    }

    check(client.wsUrl("", null) == client.wsUrl(null, null), "an empty shard key is byte-identical to sending none")
    check(client.wsUrl("room-1", null).contains("shard="), "a real shard key still rides the socket URL")
}

private fun depthCapEnforced() {
    covers("depth_cap_enforced")

    var nested: Any? = "leaf"

    repeat(Wire.MAX_DEPTH + 2) { nested = listOf(nested) }

    check(rejects(nested), "decoding past the depth cap must be rejected")

    // The PARSER's cap is counted from the document root, and every payload
    // arrives inside an envelope — so charging the envelope against the wire
    // value's own budget refused a frame whose payload the reference encodes
    // happily. A value nested exactly MAX_DEPTH deep must still reach onData.
    var deepest: Any? = "leaf"

    repeat(Wire.MAX_DEPTH) { deepest = listOf(deepest) }

    val client = Client("https://app.example")

    client.attachSocket { }

    val seen = mutableListOf<WireValue>()

    client.subscribe("messages:list", null, seen::add)

    val envelope = linkedMapOf<String, Any?>("type" to "data", "id" to "sub_1", "data" to deepest)

    check(client.handleFrame(Json.write(envelope)) == "data", "a MAX_DEPTH value must survive its frame envelope")
    check(seen.size == 1, "and reach onData")
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
        // An integral double past 2^53 keeps ECMAScript's shortest-digits
        // spelling rather than the exact expansion 1152921504606846976.
        1.152921504606847e18 to "1152921504606847000",
        // Negative zero keeps its sign; every integer conversion drops it.
        -0.0 to "-0",
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

/**
 * A reconnect re-subscribes the SHAPES as well as the queries.
 *
 * A resend that walks only the query registry leaves every shape view subscribed
 * to a socket that no longer exists — silently, and for the rest of the process's
 * life, because a shape only ever learns of new rows through a poke.
 */
private fun shapeSubscriptionsResendAfterReconnect() {
    covers("shape_subscriptions_resend_after_reconnect")

    val client = Client("https://app.example")
    val args = WireValue.Obj(listOf("room" to WireValue.Text("general")))

    client.attachSocket { }
    client.subscribe("messages:list", WireValue.Obj(listOf("channel" to WireValue.Text("general"))), { })
    client.subscribeShape("roomMessages", args, { })

    // The cursors a resume carries are written by the frame handler, so they have
    // to exist before the resend is built.
    client.handleFrame(Json.write(mapOf("cursor" to 9, "data" to emptyList<Any?>(), "epoch" to "e1", "id" to "sub_1", "type" to "data")))
    client.handleFrame(Json.write(mapOf("epoch" to "e1", "pokeId" to "poke-1", "type" to "pokeStart")))
    client.handleFrame(Json.write(mapOf("pokeId" to "poke-1", "reset" to true, "rowsPatch" to emptyList<Any?>(), "shapeId" to "shape_1", "type" to "pokePart")))
    client.handleFrame(Json.write(mapOf("checkpoint" to 5, "epoch" to "e1", "pokeId" to "poke-1", "type" to "pokeEnd")))

    val resent = mutableListOf<Map<String, Any?>>()

    client.attachSocket { resent.add(it) }
    client.resendSubscriptions()

    check(resent.map { it["type"] } == listOf("subscribe", "shape_subscribe"), "both registries resend, queries first")
    check(((resent[0]["query"] as Map<*, *>)["sinceSeq"] as Number).toInt() == 9, "the query resumes from its tracked cursor")
    check(resent[1]["id"] == "shape_1", "the shape frame carries the registered id")

    val shape = resent[1]["shape"] as Map<*, *>

    // Name and args are only available because `subscribeShape` keeps them; a
    // registry holding the callbacks alone cannot build this frame at all.
    check(shape["name"] == "roomMessages", "and the shape's name")
    check(canonical(shape["args"]) == canonical(Wire.encode(args)), "and its args")
    check((resent[1]["sinceCheckpoint"] as Number).toInt() == 5, "resuming from the tracked checkpoint")
    check(resent[1]["sinceEpoch"] == "e1", "and the tracked epoch")
}

/**
 * A payload the codec refuses reaches the addressed subscription's error
 * callback, and goes no further.
 *
 * Thrown out of [Client.handleFrame] it ends the caller's read loop, taking every
 * OTHER subscription on the client down with it — one malformed row on one query
 * silences the whole client.
 */
private fun refusedPayloadStaysOnItsOwnSubscription() {
    val errors = mutableListOf<SubscriptionError>()
    val second = mutableListOf<WireValue>()
    val client = Client("https://app.example")

    client.attachSocket { }
    client.subscribe("messages:list", null, { }, { errors.add(it) })
    client.subscribe("messages:other", null, { second.add(it) })

    val kind = client.handleFrame("{\"data\":[\"${Wire.TAG}\",\"bigint\",\"not-a-number\"],\"id\":\"sub_1\",\"type\":\"data\"}")

    check(kind == "error", "the refused frame is reported as an error rather than thrown")
    check(errors.map { it.code } == listOf("INVALID_FRAME"), "the addressed subscription's error callback fires")

    client.handleFrame("{\"data\":[1],\"id\":\"sub_2\",\"type\":\"data\"}")

    check(second.size == 1, "and a later good frame on another subscription still delivers")
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
 * A manifest case, asserted by every port against the shared fixture's
 * `resetPokeSequence`.
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
 * A buffer is only released at its `pokeEnd`. A socket that drops mid-poke never
 * sends one, so its buffer would be retained for the life of the client — one
 * leak per reconnect, and unbounded against a peer that opens pokes it never
 * closes.
 *
 * Asserted black-box: an evicted poke behaves exactly like one that was never
 * opened, which is the only form of this assertion all eight ports can share.
 */
private fun pendingPokeBuffersAreBounded() {
    covers("pending_poke_buffers_are_bounded")

    val client = Client("https://app.example")

    client.attachSocket { }

    val delivered = mutableListOf<List<WireValue>>()

    client.subscribeShape("roomMessages", WireValue.Obj(listOf("room" to WireValue.Text("general"))), { delivered.add(it) })

    // A poke opened, part-filled, then abandoned when the socket dropped.
    client.handleFrame("{\"type\":\"pokeStart\",\"pokeId\":\"stale\"}")
    client.handleFrame(
        "{\"type\":\"pokePart\",\"pokeId\":\"stale\",\"shapeId\":\"shape_1\"," +
            "\"rowsPatch\":[{\"op\":\"insert\",\"key\":\"ghost\",\"value\":\"ghost-row\"}]}",
    )

    for (index in 0 until MAX_PENDING_POKES) {
        client.handleFrame("{\"type\":\"pokeStart\",\"pokeId\":\"filler-" + index + "\"}")
    }

    // The abandoned buffer is gone, so its late pokeEnd is a no-op.
    client.handleFrame("{\"type\":\"pokeEnd\",\"pokeId\":\"stale\"}")

    check(delivered.isEmpty(), "the ghost row of an evicted poke must never reach the view")

    // ...and eviction is oldest-first, not a blanket drop: a live poke still applies.
    val newest = "filler-" + (MAX_PENDING_POKES - 1)

    client.handleFrame(
        "{\"type\":\"pokePart\",\"pokeId\":\"" + newest + "\",\"shapeId\":\"shape_1\"," +
            "\"rowsPatch\":[{\"op\":\"insert\",\"key\":\"m1\",\"value\":\"kept\"}]}",
    )
    client.handleFrame("{\"type\":\"pokeEnd\",\"pokeId\":\"" + newest + "\"}")

    check(delivered.size == 1, "the newest buffer must survive and apply")
    check(delivered[0] == listOf(WireValue.Text("kept")), "the surviving poke applies its rows")
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
    malformedValuesRejected()
    depthCapEnforced()
    exactIntegerRangeEnforced()
    stableWireKeyFixtures()
    formatNumberMatchesEcmaScript()
    keyOrderMatchesUtf16()
    stringEscapingMatchesJsonStringify()
    emptyShardKeyIsOmitted()
    rpcRequestBodies()
    rpcResponses()
    non2xxWithoutEnvelopeThrows()
    clientFrameBuilders()
    serverFrameConsumer()
    subscriptionStreamYieldsFrameValuesInOrder()
    shapeSubscribeFrame()
    shapeSubscriptionsResendAfterReconnect()
    refusedPayloadStaysOnItsOwnSubscription()
    pokeSequenceMaterialisesRows()
    pokePartsDoNotApplyBeforePokeEnd()
    resetPokeReplacesShapeMembership()
    pendingPokeBuffersAreBounded()
    concurrentSubscribeAndHandleFrame()

    // The optimistic-layer and offline-queue cases, in their own file so this one
    // stays the wire-protocol suite it has always been.
    runOptimisticOfflineCases()

    assertManifestCovered()

    println("OK — $checks assertions")
}
