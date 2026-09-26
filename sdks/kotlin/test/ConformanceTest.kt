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

/**
 * Renders a value the way `Client.kt` puts it on the socket, with `Json.write`. Separate from
 * [canonical], which is free to normalise: `stableStringify` spells every number the ECMAScript
 * way, so `1.0` and `1` compare EQUAL through it — the divergence a round-trip case exists to
 * catch. Dart's dates went out as `1700000000000.0` for exactly that reason, on a green suite.
 */
private fun wireText(value: Any?): String = Json.write(value)

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
        // And again as the BYTES the transport sends: a round-trip assertion
        // measured on a string the transport never sends cannot see the
        // divergence it exists to catch.
        check(wireText(roundTripped) == wireText(expected), "wire-text mismatch for ${testCase["name"]}")
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

    // A `data` frame is ONE envelope level, and measuring the cap only there is
    // how it shipped a level short. The deepest envelope the protocol has is the
    // batch response (protocol/README.md §4.3) at four, and an offline flush that
    // could not parse its own 200 body classified a committed batch as a
    // transport failure and replayed it forever.
    val slot = linkedMapOf<String, Any?>("id" to 0, "status" to 200, "body" to linkedMapOf("result" to deepest))
    val batch = Json.write(linkedMapOf("results" to listOf(slot)))

    check(Json.parse(batch) != null, "a MAX_DEPTH value must survive the batch-response envelope")
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

    // A lone surrogate is escaped the way JSON.stringify writes it — in the wire
    // BYTES and in the key — rather than reaching the UTF-8 encoder, which
    // substitutes `?`. A well-formed pair stays raw.
    val lone = WireValue.Obj(listOf("s" to WireValue.Text("a\uD800b"), "t" to WireValue.Text("\uDC00"), "u" to WireValue.Text("x\uD83D")))
    val wireBytes = String(Json.write(Wire.encode(lone)).toByteArray(Charsets.UTF_8), Charsets.UTF_8)

    check(wireBytes == "{\"s\":\"a\\ud800b\",\"t\":\"\\udc00\",\"u\":\"x\\ud83d\"}", "lone surrogates on the wire: $wireBytes")
    check(Key.stableWireKey(lone) == wireBytes, "and in the stable key: ${Key.stableWireKey(lone)}")
    check(Key.stableWireKey(WireValue.Text("a\uD800b")) != Key.stableWireKey(WireValue.Text("a?b")), "a lone surrogate does not key as '?'")
    check(Key.jsonString("a\uD83D\uDE00b") == "\"a\uD83D\uDE00b\"", "a well-formed pair is written as-is")
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

            // Undecodable `data` is dropped, never the codec's exception.
            if (testCase["dataDropped"] == true) check(error.data == null, "data dropped for ${testCase["name"]}")
        }
    }
}

private fun non2xxWithoutEnvelopeThrows() {
    covers("non_2xx_without_error_envelope_fails")

    // protocol/README.md §4.2. Without the status check this returned null and
    // threw nothing — the caller believes its mutation committed. The fixture's
    // non-object `error` slots are the other half: a slot holding a string, a
    // null or an array is not an envelope either, and a port reading one without
    // a type check throws its LANGUAGE's exception rather than ApiException,
    // escaping every handler the caller wrote.
    for (entry in fixture("rpc.json")["responseTransportError"] as List<*>) {
        val testCase = entry as Map<*, *>
        val response = testCase["response"] as Map<*, *>
        val status = (testCase["status"] as Number).toInt()

        try {
            Client.parseRpcResponse(response, status)
            check(false, "expected an ApiException for ${testCase["name"]}")
        } catch (error: ApiException) {
            check(error.code == testCase["code"], "code for ${testCase["name"]}")
            // Nothing reached the shard, so a queued write must be replayed
            // rather than dropped — the batch path already says so.
            check(error.transient, "transient for ${testCase["name"]}")
        }
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
    covers("complete_frame_cancels_without_dropping_the_subscription")

    var cancellations = 0

    for (entry in fixture("ws-frames.json")["serverFrames"] as List<*>) {
        val testCase = entry as Map<*, *>
        val client = Client("https://app.example")
        val sent = mutableListOf<Map<String, Any?>>()

        client.attachSocket { sent.add(it) }

        val seen = mutableListOf<WireValue>()
        val errors = mutableListOf<SubscriptionError>()

        client.subscribe(
            "messages:list",
            WireValue.Obj(listOf("channel" to WireValue.Text("general"))),
            { seen.add(it) },
            { errors.add(it) },
        )
        sent.clear()

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

        // Cancelled AND kept. Removing the entry takes it out of the map
        // `resendSubscriptions` walks, which froze the query across every future
        // reconnect with nothing reported.
        if (expect["resendsAfterReconnect"] == true) {
            cancellations++
            check(errors.size == 1, "a complete frame cancels once")
            check(errors[0].code == expect["code"], "cancellation code")
            check(errors[0].message == expect["message"], "cancellation message")
            client.resendSubscriptions()
            check(
                sent.filter { it["type"] == "subscribe" }.map { it["id"] } == listOf(expect["id"]),
                "the cancelled subscription is resent on reconnect",
            )
        }
    }

    // A conditional assertion that never runs is worse than none: without this,
    // renaming the fixture key would leave every suite green.
    check(cancellations == 1, "serverFrames must carry one cancelling case")
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

/** A frame fixture delivered as the raw text a socket read loop hands [Client.handleFrame]. */
private fun deliver(client: Client, frames: Any?) {
    for (frame in frames as List<*>) client.handleFrame(Json.write(frame))
}

/** The frames [Client.resendSubscriptions] sends, captured through a fresh socket. */
private fun resent(client: Client): List<Map<String, Any?>> {
    val frames = mutableListOf<Map<String, Any?>>()

    client.attachSocket { frames.add(it) }
    client.resendSubscriptions()

    return frames
}

private fun number(value: Any?): Double? = (value as? Number)?.toDouble()

/**
 * A poke is applied whole or not at all, per shape: a row the codec refuses leaves
 * the view, its checkpoint and its epoch exactly as they were and reaches the
 * shape's error callback — while another shape in the same poke still applies.
 */
private fun shapePokeWithUndecodableRowIsRefusedWhole() {
    covers("shape_poke_with_undecodable_row_is_refused_whole")

    val shape = fixture("ws-frames.json")["shape"] as Map<*, *>
    val client = Client("https://app.example")
    val delivered = mutableListOf<List<WireValue>>()
    val errors = mutableListOf<SubscriptionError>()
    val other = mutableListOf<List<WireValue>>()

    client.attachSocket { }
    client.subscribeShape("roomMessages", WireValue.Obj(listOf("room" to WireValue.Text("general"))), { delivered.add(it) }, { errors.add(it) })
    client.subscribeShape("other", null, { other.add(it) })
    deliver(client, shape["pokeSequence"])

    check(delivered.size == 1, "the seed applies")

    // The fixture's sequence, plus a good part for a SECOND shape in the same poke.
    val sequence = (shape["undecodableRowPokeSequence"] as List<*>).toMutableList()
    val good = mapOf(
        "type" to "pokePart",
        "pokeId" to "p3",
        "shapeId" to "shape_2",
        "rowsPatch" to listOf(mapOf("op" to "insert", "key" to "k", "value" to "kept")),
    )

    sequence.add(sequence.size - 1, good)

    try {
        deliver(client, sequence)
    } catch (error: RuntimeException) {
        check(false, "a refused poke must not throw out of handleFrame: $error")
    }

    check(delivered.size == 1, "no rows callback fires for the refused shape")
    check(errors.map { it.code } == listOf(shape["undecodableRowErrorCode"]), "its error callback hears ${shape["undecodableRowErrorCode"]} once: $errors")
    check(other == listOf(listOf(WireValue.Text("kept"))), "the other shape in the same poke still applies")

    val frame = resent(client).first { it["id"] == "shape_1" }

    check(number(frame["sinceCheckpoint"]) == number(shape["undecodableRowResendCheckpoint"]), "the checkpoint does not advance: ${frame["sinceCheckpoint"]}")
    check(frame["sinceEpoch"] == "e1", "nor the epoch")

    // The view itself is untouched: an empty poke re-delivers it unchanged.
    deliver(
        client,
        listOf(
            mapOf("type" to "pokeStart", "pokeId" to "p-empty"),
            mapOf(
                "type" to "pokePart",
                "pokeId" to "p-empty",
                "shapeId" to "shape_1",
                "rowsPatch" to emptyList<Any?>(),
            ),
            mapOf("type" to "pokeEnd", "pokeId" to "p-empty"),
        ),
    )

    check(canonical(Wire.encode(WireValue.Arr(delivered.last()))) == canonical(shape["expectedRows"]), "the view is exactly the seed: ${delivered.last()}")

    // The server believes the refused poke landed, so the NEXT one is based on a
    // checkpoint this view never reached. It must re-seed, not splice.
    val sent = mutableListOf<Map<String, Any?>>()

    client.attachSocket { sent.add(it) }

    val before = delivered.size

    deliver(client, shape["gapPokeSequence"])

    check(delivered.size == before + 1, "the gap tells the rows callback once")
    check(canonical(Wire.encode(WireValue.Arr(delivered.last()))) == canonical(shape["gapExpectedRows"]), "that the view is empty: ${delivered.last()}")

    val cold = sent.filter { it["type"] == "shape_subscribe" && it["id"] == "shape_1" }

    check(cold.size == 1, "a shape_subscribe for shape_1 goes out right away: $sent")
    check(!cold[0].containsKey("sinceCheckpoint") && !cold[0].containsKey("sinceEpoch"), "and it is cold: ${cold[0]}")

    val later = resent(client).first { it["id"] == "shape_1" }

    check(!later.containsKey("sinceCheckpoint") && !later.containsKey("sinceEpoch"), "a later resend is cold too: $later")

    // The counterweight: a poke based on the checkpoint the view IS at applies.
    val contiguous = Client("https://app.example")
    val applied = mutableListOf<List<WireValue>>()
    val contiguousSent = mutableListOf<Map<String, Any?>>()

    contiguous.attachSocket { contiguousSent.add(it) }
    contiguous.subscribeShape("roomMessages", WireValue.Obj(listOf("room" to WireValue.Text("general"))), { applied.add(it) })
    deliver(contiguous, shape["pokeSequence"])
    contiguousSent.clear()
    deliver(contiguous, shape["contiguousPokeSequence"])

    check(
        canonical(Wire.encode(WireValue.Arr(applied.last()))) == canonical(shape["contiguousExpectedRows"]),
        "a contiguous poke applies: ${applied.last()}",
    )
    check(contiguousSent.isEmpty(), "without a re-seed: $contiguousSent")

    // A based poke on a view that has NO checkpoint yet is not a gap.
    val fresh = Client("https://app.example")
    val seeded = mutableListOf<List<WireValue>>()

    fresh.attachSocket { }
    fresh.subscribeShape("roomMessages", null, { seeded.add(it) })
    fresh.handleFrame("{\"type\":\"pokeStart\",\"pokeId\":\"b0\",\"baseCheckpoint\":0}")
    fresh.handleFrame(
        "{\"type\":\"pokePart\",\"pokeId\":\"b0\",\"shapeId\":\"shape_1\",\"rowsPatch\":[{\"op\":\"insert\",\"key\":\"a\",\"value\":1}]}",
    )
    fresh.handleFrame("{\"type\":\"pokeEnd\",\"pokeId\":\"b0\",\"checkpoint\":1}")

    check(seeded == listOf(listOf(WireValue.Num(1.0))), "a base on an unchecked view applies: $seeded")
}

/**
 * Frames shaped like nothing the server sends are ignored: none raises out of the
 * handler the read loop calls, and none touches a live subscription.
 */
private fun malformedFramesAreIgnoredWithoutRaising() {
    covers("malformed_frames_are_ignored_without_raising")

    val case = fixture("ws-frames.json")["malformedFrames"] as Map<*, *>
    val client = Client("https://app.example")
    val seen = mutableListOf<WireValue>()
    val errors = mutableListOf<SubscriptionError>()

    client.attachSocket { }
    client.subscribe("messages:list", WireValue.Obj(emptyList()), { seen.add(it) }, { errors.add(it) })
    client.handleFrame(Json.write(case["setupFrame"]))
    seen.clear()

    for (frame in case["frames"] as List<*>) {
        try {
            client.handleFrame(Json.write(frame))
        } catch (error: Throwable) {
            check(false, "handleFrame(${Json.write(frame)}) raised $error")
        }
    }

    check(seen.isEmpty() && errors.isEmpty(), "no frame reached sub_1: $seen $errors")

    val query = resent(client).first { it["id"] == "sub_1" }["query"] as Map<*, *>

    check(number(query["sinceSeq"]) == number(case["resendSinceSeq"]), "the resend still carries sinceSeq ${case["resendSinceSeq"]}: ${query["sinceSeq"]}")
    check(query["sinceEpoch"] == case["resendSinceEpoch"], "and sinceEpoch ${case["resendSinceEpoch"]}")
}

/**
 * A reply the call can read neither a result nor an envelope out of fails with the
 * SDK's own error, never the JSON parser's or a cast's.
 */
private fun rpcUnreadableSuccessBodyRaisesSdkError() {
    covers("rpc_unreadable_success_body_raises_sdk_error")

    for (entry in fixture("rpc.json")["unreadableSuccessBody"] as List<*>) {
        val case = entry as Map<*, *>
        val response = HttpResponse(count(case["status"]), case["rawBody"] as String)
        val client = Client("https://app.example", { _, _, _ -> response })

        for (verb in Verb.values()) {
            val raised = try {
                client.call(verb, "messages:list")
                null
            } catch (error: Throwable) {
                error
            }

            check(raised is ApiException && raised.code == case["code"], "${case["name"]} ($verb) raises ApiException ${case["code"]}, got $raised")
        }

        // On the offline replay the same reply is transport-shaped: re-queued.
        client.offlineQueue.enqueue(QueuedMutation("w-${case["name"]}", "messages:send", WireValue.Obj(emptyList())))

        check(client.flushOfflineQueue().requeued == listOf("w-${case["name"]}"), "${case["name"]}: a queued write is re-queued")
    }

    // `{}` stays the void result.
    check(Client("https://app.example", { _, _, _ -> HttpResponse(200, "{}") }).query("x:y") == WireValue.Null, "{} is a void result")
}

private fun count(value: Any?): Int = (value as Number).toInt()

/** `close()` ends an open pull stream: the loop yields what was delivered, then returns. */
private fun subscriptionStreamEndsOnClose() {
    covers("subscription_stream_ends_on_close")

    val client = Client("https://app.example")

    client.attachSocket { }

    val stream = client.stream("messages:list")
    val yielded = java.util.Collections.synchronizedList(mutableListOf<WireValue?>())
    val consumer = Thread { for (event in stream) yielded.add(event.value) }

    consumer.isDaemon = true
    consumer.start()
    client.handleFrame("{\"type\":\"data\",\"id\":\"sub_1\",\"data\":1}")
    client.close()
    consumer.join(2000)

    check(!consumer.isAlive, "the stream ends within 2 s of close() instead of blocking forever")
    check(yielded == listOf(WireValue.Num(1.0)), "after yielding the delivered value: $yielded")
}

/**
 * A change FROM a set identity evicts the previous session's resume cursors and
 * shape views; a first set and a same-value set evict nothing.
 */
private fun identityChangeEvictsPreviousSession() {
    covers("identity_change_evicts_previous_session")

    val case = fixture("ws-frames.json")["identityChange"] as Map<*, *>
    val shape = fixture("ws-frames.json")["shape"] as Map<*, *>
    val retained = case["retained"] as Map<*, *>
    val evicted = case["evicted"] as Map<*, *>

    for (raw in case["transitions"] as List<*>) {
        val transition = raw as Map<*, *>
        val label = "${transition["from"]} -> ${transition["to"]}"
        val client = Client("https://app.example", identity = transition["from"] as String?)
        val rows = mutableListOf<List<WireValue>>()

        client.attachSocket { }
        client.subscribe("messages:list", WireValue.Obj(emptyList()), { })
        client.subscribeShape("roomMessages", WireValue.Obj(listOf("room" to WireValue.Text("general"))), { rows.add(it) })
        client.handleFrame(Json.write(case["queryFrame"]))
        deliver(client, shape["pokeSequence"])

        val before = rows.size

        client.identity = transition["to"] as String?

        val frames = resent(client)
        val query = frames.first { it["id"] == "sub_1" }["query"] as Map<*, *>
        val shapeFrame = frames.first { it["id"] == "shape_1" }

        if (transition["evicts"] == true) {
            check(!query.containsKey("sinceSeq") && !query.containsKey("sinceEpoch"), "$label: the query resubscribes cold: $query")
            check(!shapeFrame.containsKey("sinceCheckpoint") && !shapeFrame.containsKey("sinceEpoch"), "$label: and the shape: $shapeFrame")
            check(rows.size == before + 1, "$label: the shape callback is told")
            check(canonical(Wire.encode(WireValue.Arr(rows.last()))) == canonical(evicted["shapeCallbackRows"]), "$label: that its view is empty")
        } else {
            check(
                number(query["sinceSeq"]) == number(retained["sinceSeq"]) && query["sinceEpoch"] == retained["sinceEpoch"],
                "$label: the query keeps its cursor: $query",
            )
            check(number(shapeFrame["sinceCheckpoint"]) == number(retained["sinceCheckpoint"]), "$label: the shape keeps its checkpoint: $shapeFrame")
            check(rows.size == before && rows.last().size == count(retained["shapeRowCount"]), "$label: and its rows")
        }
    }
}

/** The bearer token never reaches a printed value. */
private fun authTokenRedactedWhenPrinted() {
    covers("auth_token_redacted_when_printed")

    val token = "lunora-secret-7f3a9c"
    val client = Client("https://app.example", authToken = token)
    val options = SubmitOptions("messages:send")

    for (rendered in listOf(client.toString(), "$client", String.format("%s", client), options.toString(), client.offlineQueue.toString())) {
        check(!rendered.contains(token), "the token leaked into $rendered")
    }
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
    shapePokeWithUndecodableRowIsRefusedWhole()
    malformedFramesAreIgnoredWithoutRaising()
    rpcUnreadableSuccessBodyRaisesSdkError()
    subscriptionStreamEndsOnClose()
    identityChangeEvictsPreviousSession()
    authTokenRedactedWhenPrinted()

    // The optimistic-layer and offline-queue cases, in their own file so this one
    // stays the wire-protocol suite it has always been.
    runOptimisticOfflineCases()

    assertManifestCovered()

    println("OK — $checks assertions")
}
