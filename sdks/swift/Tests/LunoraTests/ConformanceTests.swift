import Foundation
import XCTest

@testable import Lunora

/// Protocol-conformance tests: drive the Swift SDK against the shared golden
/// fixtures in `protocol/fixtures/`, the same files the TypeScript client and
/// the Python, Go and Ruby ports are tested against.
final class ConformanceTests: XCTestCase {
    /// Walks up from this source file to the repo's `protocol/fixtures`.
    private func fixturesDirectory() throws -> URL {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = directory.appendingPathComponent("protocol/fixtures")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            let parent = directory.deletingLastPathComponent()
            if parent.path == directory.path { break }
            directory = parent
        }
        throw XCTSkip("could not locate protocol/fixtures")
    }

    private func fixture(_ name: String) throws -> [String: Any] {
        let url = try fixturesDirectory().appendingPathComponent(name)
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// Re-serialises so two structures compare as text with a canonical key
    /// order, independent of the order the fixture file happens to use.
    private func canonical(_ value: Any?) -> String { Wire.stableStringify(value) }

    // MARK: - Manifest coverage

    /// Fails if this run did not exercise every case in the shared manifest.
    ///
    /// XCTest has no after-all hook that can record a failure — `class func
    /// tearDown()` runs outside any test's context — so the manifest DRIVES the
    /// run rather than auditing it afterwards: every name in
    /// `protocol/conformance-cases.json` is dispatched to the method that asserts
    /// it, and a name with no arm fails here. That is also why the cases are
    /// `caseX` rather than `testX`: this is their only entry point, so a case
    /// cannot be silently detached from its manifest name.
    func testConformanceManifestIsCovered() throws {
        let url = try fixturesDirectory().deletingLastPathComponent().appendingPathComponent("conformance-cases.json")
        let manifest = try XCTUnwrap(JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as? [String: Any])
        let required = try XCTUnwrap(manifest["required"] as? [String])

        XCTAssertFalse(required.isEmpty, "the manifest must list at least one required case")

        for name in required {
            switch name {
            case "wire_codec_round_trip": try caseWireCodecRoundTrip()
            case "undefined_is_distinct_from_null": try caseUndefinedIsDistinctFromNull()
            case "over_long_bigint_rejected": caseOverLongBigIntRejected()
            case "malformed_bytes_rejected": try caseMalformedBytesRejected()
            case "depth_cap_enforced": caseDepthCapEnforced()
            case "stable_wire_key_fixtures": try caseStableWireKeyFixtures()
            case "format_number_matches_ecmascript": caseFormatDoubleMatchesEcmaScript()
            case "key_order_matches_utf16": caseKeyOrderMatchesUTF16()
            case "string_escaping_matches_json_stringify": caseStringEscapingMatchesJSONStringify()
            case "rpc_request_bodies": try caseRPCRequestBodies()
            case "rpc_responses": try caseRPCResponses()
            case "non_2xx_without_error_envelope_fails": caseNon2xxWithoutErrorEnvelopeThrows()
            case "client_frame_builders": try caseClientFrameBuilders()
            case "server_frame_consumer": try caseServerFrameConsumer()
            case "shape_subscribe_frame": try caseShapeSubscribeFrame()
            case "poke_sequence_materialises_rows": try casePokeSequenceMaterialisesRows()
            case "poke_parts_do_not_apply_before_poke_end": try casePokePartsDoNotApplyBeforePokeEnd()
            default:
                XCTFail("protocol/conformance-cases.json requires case \(name), which this suite does not implement")
            }
        }
    }

    // MARK: - Wire codec

    func caseWireCodecRoundTrip() throws {
        let cases = try XCTUnwrap(fixture("wire-codec.json")["cases"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 10, "fixture should carry the full case set")

        for testCase in cases {
            let name = testCase["name"] as? String ?? "?"
            let encoded = testCase["encoded"]
            let roundTripped = try Wire.encode(Wire.decode(encoded))
            XCTAssertEqual(canonical(roundTripped), canonical(encoded), "round-trip mismatch for \(name)")
        }
    }

    func caseUndefinedIsDistinctFromNull() throws {
        let encoded = try XCTUnwrap(
            Wire.encode(["dropped": WireUndefined.shared, "kept": NSNull()]) as? [String: Any]
        )
        XCTAssertNil(encoded["dropped"], "an undefined object field must be dropped, matching JSON.stringify")
        XCTAssertNotNil(encoded["kept"], "a null object field must be kept")

        // In an array position the slot must survive, or every later element shifts.
        let inArray = try XCTUnwrap(Wire.encode([WireUndefined.shared, 1]) as? [Any])
        let first = try XCTUnwrap(inArray.first as? [Any])
        XCTAssertEqual(first[1] as? String, "undefined")
    }

    func caseOverLongBigIntRejected() {
        let overLong = String(repeating: "9", count: Wire.maxBigIntDigits + 1)
        XCTAssertThrowsError(try Wire.decode([Wire.tag, "bigint", overLong]))
        XCTAssertThrowsError(try Wire.decode([Wire.tag, "bigint", "12x4"]))
        XCTAssertNoThrow(try Wire.decode([Wire.tag, "bigint", "-42"]))
    }

    func caseMalformedBytesRejected() throws {
        XCTAssertThrowsError(try Wire.decode([Wire.tag, "bytes", "not@@base64!!"]))

        let decoded = try Wire.decode([Wire.tag, "bytes", "AQID"])
        XCTAssertEqual(try XCTUnwrap(decoded as? Data), Data([1, 2, 3]))
    }

    func caseDepthCapEnforced() {
        var nested: Any = "leaf"
        for _ in 0..<(Wire.maxDepth + 2) { nested = [nested] }
        XCTAssertThrowsError(try Wire.encode(nested))
        XCTAssertThrowsError(try Wire.decode(nested))
    }

    // MARK: - Stable key

    func caseStableWireKeyFixtures() throws {
        let document = try fixture("stable-wire-key.json")

        for testCase in try XCTUnwrap(document["cases"] as? [[String: Any]]) {
            let name = testCase["name"] as? String ?? "?"
            XCTAssertEqual(try Wire.stableWireKey(testCase["args"]), testCase["key"] as? String, name)
        }

        for testCase in try XCTUnwrap(document["typed"] as? [[String: Any]]) {
            let name = testCase["name"] as? String ?? "?"
            let decoded = try Wire.decode(testCase["wireArgs"])
            XCTAssertEqual(try Wire.stableWireKey(decoded), testCase["key"] as? String, name)
        }
    }

    /// Expected spellings captured from a real JS engine, not derived from the
    /// spec — the two disagreed for the Go and Ruby ports before this existed.
    func caseFormatDoubleMatchesEcmaScript() {
        let cases: [(Double, String)] = [
            (0, "0"), (3, "3"), (1.5, "1.5"), (-2.5, "-2.5"),
            (1e-5, "0.00001"), (1e-6, "0.000001"), (1e-7, "1e-7"), (1.5e-7, "1.5e-7"),
            (1e-21, "1e-21"), (1e20, "100000000000000000000"), (1e21, "1e+21"),
        ]
        for (value, want) in cases {
            XCTAssertEqual(Wire.formatDouble(value), want, "formatDouble(\(value))")
        }
    }

    /// JavaScript sorts by UTF-16 code unit, so an astral character is its high
    /// surrogate (0xD83D) and sorts after U+2028 but before U+FFFD. Swift's
    /// scalar-wise `<` puts it last — a different dedup key for identical args.
    func caseKeyOrderMatchesUTF16() {
        let rendered = Wire.stableStringify(["A": 1, "\u{2028}": 2, "\u{1F600}": 3, "\u{FFFD}": 4])
        let want = "{\"A\":1,\"\u{2028}\":2,\"\u{1F600}\":3,\"\u{FFFD}\":4}"
        XCTAssertEqual(rendered, want)
    }

    func caseStringEscapingMatchesJSONStringify() {
        // JSON.stringify leaves <, > and & raw and does not escape U+2028/U+2029.
        XCTAssertEqual(Wire.jsonString("a<b>&c"), "\"a<b>&c\"")
        XCTAssertEqual(Wire.jsonString("\u{2028}\u{2029}"), "\"\u{2028}\u{2029}\"")
        XCTAssertEqual(Wire.jsonString("tab\there"), "\"tab\\there\"")
    }

    // MARK: - RPC

    func caseRPCRequestBodies() throws {
        let request = try XCTUnwrap(fixture("rpc.json")["request"] as? [String: Any])

        for testCase in try XCTUnwrap(request["cases"] as? [[String: Any]]) {
            let name = testCase["name"] as? String ?? "?"
            let args: Any? = testCase["args"] ?? (testCase["argsWire"].map { try? Wire.decode($0) } ?? nil)
            let body = try LunoraClient.buildRPCBody(
                functionPath: try XCTUnwrap(testCase["functionPath"] as? String),
                args: args,
                shardKey: testCase["shardKey"] as? String
            )
            XCTAssertEqual(canonical(body), canonical(testCase["body"]), name)
        }
    }

    func caseRPCResponses() throws {
        let document = try fixture("rpc.json")

        for testCase in try XCTUnwrap(document["responseOk"] as? [[String: Any]]) {
            let name = testCase["name"] as? String ?? "?"
            let response = try XCTUnwrap(testCase["response"] as? [String: Any])
            let value = try LunoraClient.parseRPCResponse(response, status: 200)
            XCTAssertEqual(canonical(try Wire.encode(value)), canonical(response["result"]), name)
        }

        for testCase in try XCTUnwrap(document["responseError"] as? [[String: Any]]) {
            let name = testCase["name"] as? String ?? "?"
            let response = try XCTUnwrap(testCase["response"] as? [String: Any])
            XCTAssertThrowsError(try LunoraClient.parseRPCResponse(response, status: 400), name) { error in
                guard let apiError = error as? LunoraAPIError else { return XCTFail("expected LunoraAPIError") }
                XCTAssertEqual(apiError.code, testCase["code"] as? String)
                XCTAssertEqual(apiError.message, testCase["message"] as? String)
            }
        }
    }

    func caseNon2xxWithoutErrorEnvelopeThrows() {
        // protocol/README.md §4.2. Without the status check this returned a nil
        // result and threw nothing — the caller believes its mutation committed.
        XCTAssertThrowsError(try LunoraClient.parseRPCResponse(["message": "bad gateway"], status: 502))
    }

    // MARK: - WebSocket frames

    func caseClientFrameBuilders() throws {
        let frames = try XCTUnwrap(fixture("ws-frames.json")["clientFrames"] as? [String: Any])

        XCTAssertEqual(canonical(LunoraClient.buildConnectFrame(clientID: "client-test")), canonical(frames["connect"]))
        XCTAssertEqual(
            canonical(LunoraClient.buildConnectFrame(clientID: "client-test", context: ["roomId": "general"])),
            canonical(frames["connect-with-context"])
        )
        XCTAssertEqual(
            canonical(try LunoraClient.buildSubscribeFrame(id: "sub_1", functionPath: "messages:list", args: ["channel": "general"])),
            canonical(frames["subscribe-cold"])
        )
        XCTAssertEqual(
            canonical(
                try LunoraClient.buildSubscribeFrame(
                    id: "sub_1", functionPath: "messages:list", args: ["channel": "general"], sinceSeq: 12, sinceEpoch: "e1"
                )
            ),
            canonical(frames["subscribe-resume"])
        )
        XCTAssertEqual(canonical(LunoraClient.buildUnsubscribeFrame(id: "sub_1")), canonical(frames["unsubscribe"]))
    }

    func caseServerFrameConsumer() throws {
        for testCase in try XCTUnwrap(fixture("ws-frames.json")["serverFrames"] as? [[String: Any]]) {
            let name = testCase["name"] as? String ?? "?"
            let client = LunoraClient(url: "https://app.example")
            client.attachSocket { _ in }

            var seen: [Any] = []
            var errors: [LunoraSubscriptionError] = []
            client.subscribe("messages:list", args: ["channel": "general"], onData: { seen.append($0) }, onError: { errors.append($0) })

            let raw = try JSONSerialization.data(withJSONObject: try XCTUnwrap(testCase["frame"]))
            let kind = try client.handleFrame(try XCTUnwrap(String(data: raw, encoding: .utf8)))
            let expect = try XCTUnwrap(testCase["expect"] as? [String: Any])

            XCTAssertEqual(kind, expect["kind"] as? String, name)

            if let valueWire = expect["valueWire"] {
                XCTAssertEqual(seen.count, 1, "onData should fire once for \(name)")
                XCTAssertEqual(canonical(try Wire.encode(seen.first)), canonical(valueWire), name)
            }

            if expect["kind"] as? String == "error" {
                XCTAssertEqual(errors.count, 1)
                XCTAssertEqual(errors.first?.code, expect["code"] as? String)
            }
        }
    }

    // MARK: - Shapes

    func caseShapeSubscribeFrame() throws {
        let shape = try XCTUnwrap(fixture("ws-frames.json")["shape"] as? [String: Any])
        let frame = try LunoraClient.buildShapeSubscribeFrame(id: "shape_1", name: "roomMessages", args: ["room": "general"])
        XCTAssertEqual(canonical(frame), canonical(shape["shape-subscribe-cold"]))
    }

    func casePokeSequenceMaterialisesRows() throws {
        let shape = try XCTUnwrap(fixture("ws-frames.json")["shape"] as? [String: Any])
        let sequence = try XCTUnwrap(shape["pokeSequence"] as? [Any])

        let client = LunoraClient(url: "https://app.example")
        client.attachSocket { _ in }

        var delivered: [[Any]] = []
        client.subscribeShape("roomMessages", args: ["room": "general"], onRows: { delivered.append($0) })

        for entry in sequence {
            let raw = try JSONSerialization.data(withJSONObject: entry)
            try client.handleFrame(try XCTUnwrap(String(data: raw, encoding: .utf8)))
        }

        XCTAssertEqual(delivered.count, 1, "a poke applies atomically at pokeEnd")
        XCTAssertEqual(canonical(delivered.last), canonical(shape["expectedRows"]))
    }

    func casePokePartsDoNotApplyBeforePokeEnd() throws {
        let shape = try XCTUnwrap(fixture("ws-frames.json")["shape"] as? [String: Any])
        let sequence = try XCTUnwrap(shape["pokeSequence"] as? [Any])

        let client = LunoraClient(url: "https://app.example")
        client.attachSocket { _ in }

        var fired = 0
        client.subscribeShape("roomMessages", onRows: { _ in fired += 1 })

        for entry in sequence.dropLast() {
            let raw = try JSONSerialization.data(withJSONObject: entry)
            try client.handleFrame(try XCTUnwrap(String(data: raw, encoding: .utf8)))
        }

        XCTAssertEqual(fired, 0, "the view would be torn if parts applied before pokeEnd")
    }

    // MARK: - Concurrency

    /// The topology every real consumer has: a socket read loop on one thread,
    /// application code subscribing on another.
    ///
    /// The assertion is on the COUNT, not on the absence of a crash: an
    /// unsynchronised `nextID += 1` hands two threads the same id, the second
    /// insert replaces the first, and the client silently forgets a live
    /// subscription. A resend then emits fewer frames than there are subscribers —
    /// deterministic, unlike waiting for a `Dictionary` to corrupt. Run the suite
    /// with `--sanitize=thread` to also catch the unsynchronised access itself.
    func testConcurrentSubscribeAndHandleFrame() {
        let threads = 4
        let perThread = 250
        let client = LunoraClient(url: "https://app.example")
        let group = DispatchGroup()

        for _ in 0..<threads {
            DispatchQueue.global().async(group: group) {
                for _ in 0..<perThread {
                    client.subscribe("messages:list", args: nil, onData: { _ in })
                }
            }
        }

        DispatchQueue.global().async(group: group) {
            for call in 0..<(threads * perThread) {
                try? client.handleFrame("{\"type\":\"data\",\"id\":\"sub_1\",\"data\":1,\"cursor\":\(call)}")
            }
        }

        group.wait()

        // Attached only now, so the count below sees resend frames alone.
        let resent = ResentCounter()

        client.attachSocket { _ in resent.increment() }
        client.resendSubscriptions()

        XCTAssertEqual(resent.value, threads * perThread, "every concurrent subscribe survived with a distinct id")
    }
}

/// Counts frames from the resend, which runs on this thread — a plain `var`
/// captured by an `@escaping` closure would not compile under strict concurrency.
private final class ResentCounter {
    private var count = 0

    var value: Int { count }

    func increment() { count += 1 }
}
