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

private fun check(condition: Boolean, message: String) {
    checks++

    if (!condition) throw AssertionError(message)
}

private fun fixturesDir(): File {
    var directory = File("").absoluteFile

    repeat(8) {
        val candidate = File(directory, "protocol/fixtures")

        if (candidate.isDirectory) return candidate

        directory = directory.parentFile ?: return@repeat
    }

    error("could not locate protocol/fixtures")
}

private fun fixture(name: String): Map<*, *> = Json.parse(File(fixturesDir(), name).readText()) as Map<*, *>

/** Canonical text form so two structures compare independent of key order. */
private fun canonical(value: Any?): String = Key.stableStringify(value)

private fun wireCodecRoundTrip() {
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
    val overLong = "9".repeat(Wire.MAX_BIGINT_DIGITS + 1)

    check(rejects(listOf(Wire.TAG, "bigint", overLong)), "an over-long bigint must be rejected")
    check(rejects(listOf(Wire.TAG, "bigint", "12x4")), "a non-numeric bigint must be rejected")
    check(Wire.decode(listOf(Wire.TAG, "bigint", "-42")) == WireValue.BigInt(BigInteger("-42")), "-42 should decode")
}

private fun rejects(value: Any?): Boolean =
    try {
        Wire.decode(value)
        false
    } catch (error: WireFormatException) {
        true
    }

private fun depthCapEnforced() {
    var nested: Any? = "leaf"

    repeat(Wire.MAX_DEPTH + 2) { nested = listOf(nested) }

    check(rejects(nested), "decoding past the depth cap must be rejected")
}

private fun stableWireKeyFixtures() {
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
    // The JVM's String.compareTo already compares UTF-16 code units, which is
    // exactly JavaScript's ordering.
    val rendered = Key.stableStringify(linkedMapOf("�" to 4.0, "😀" to 3.0, " " to 2.0, "A" to 1.0))

    check(rendered == "{\"A\":1,\" \":2,\"😀\":3,\"�\":4}", "key order must follow UTF-16 code units")
}

private fun stringEscapingMatchesJsonStringify() {
    check(Key.jsonString("a<b>&c") == "\"a<b>&c\"", "angle brackets and ampersand stay raw")
    check(Key.jsonString("  ") == "\"  \"", "line separators stay raw")
    check(Key.jsonString("tab\there") == "\"tab\\there\"", "control characters are escaped")
}

private fun rpcRequestBodies() {
    val request = fixture("rpc.json")["request"] as Map<*, *>

    for (entry in request["cases"] as List<*>) {
        val testCase = entry as Map<*, *>
        val args = Wire.decode(if (testCase.containsKey("args")) testCase["args"] else testCase["argsWire"])
        val body = Client.buildRpcBody(testCase["functionPath"] as String, args, testCase["shardKey"] as? String)

        check(canonical(body) == canonical(testCase["body"]), "body for ${testCase["name"]}")
    }
}

private fun rpcResponses() {
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

private fun shapeSubscribeFrame() {
    val shape = fixture("ws-frames.json")["shape"] as Map<*, *>
    val args = WireValue.Obj(listOf("room" to WireValue.Text("general")))

    check(
        canonical(Client.buildShapeSubscribeFrame("shape_1", "roomMessages", args)) ==
            canonical(shape["shape-subscribe-cold"]),
        "shape-subscribe-cold",
    )
}

private fun pokeSequenceMaterialisesRows() {
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

fun main() {
    wireCodecRoundTrip()
    undefinedIsDistinctFromNull()
    overLongBigIntRejected()
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
    shapeSubscribeFrame()
    pokeSequenceMaterialisesRows()
    pokePartsDoNotApplyBeforePokeEnd()

    println("OK — $checks assertions")
}
