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

    // MARK: - Wire codec

    func testWireCodecRoundTrip() throws {
        let cases = try XCTUnwrap(fixture("wire-codec.json")["cases"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 10, "fixture should carry the full case set")

        for testCase in cases {
            let name = testCase["name"] as? String ?? "?"
            let encoded = testCase["encoded"]
            let roundTripped = try Wire.encode(Wire.decode(encoded))
            XCTAssertEqual(canonical(roundTripped), canonical(encoded), "round-trip mismatch for \(name)")
        }
    }

    func testUndefinedIsDistinctFromNull() throws {
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

    func testOverLongBigIntRejected() {
        let overLong = String(repeating: "9", count: Wire.maxBigIntDigits + 1)
        XCTAssertThrowsError(try Wire.decode([Wire.tag, "bigint", overLong]))
        XCTAssertThrowsError(try Wire.decode([Wire.tag, "bigint", "12x4"]))
        XCTAssertNoThrow(try Wire.decode([Wire.tag, "bigint", "-42"]))
    }

    func testDepthCapEnforced() {
        var nested: Any = "leaf"
        for _ in 0..<(Wire.maxDepth + 2) { nested = [nested] }
        XCTAssertThrowsError(try Wire.encode(nested))
        XCTAssertThrowsError(try Wire.decode(nested))
    }

    // MARK: - Stable key

    func testStableWireKeyFixtures() throws {
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
    func testFormatDoubleMatchesEcmaScript() {
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
    func testKeyOrderMatchesUTF16() {
        let rendered = Wire.stableStringify(["A": 1, "\u{2028}": 2, "\u{1F600}": 3, "\u{FFFD}": 4])
        let want = "{\"A\":1,\"\u{2028}\":2,\"\u{1F600}\":3,\"\u{FFFD}\":4}"
        XCTAssertEqual(rendered, want)
    }

    func testStringEscapingMatchesJSONStringify() {
        // JSON.stringify leaves <, > and & raw and does not escape U+2028/U+2029.
        XCTAssertEqual(Wire.jsonString("a<b>&c"), "\"a<b>&c\"")
        XCTAssertEqual(Wire.jsonString("\u{2028}\u{2029}"), "\"\u{2028}\u{2029}\"")
        XCTAssertEqual(Wire.jsonString("tab\there"), "\"tab\\there\"")
    }

    // MARK: - RPC

    func testRPCRequestBodies() throws {
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

    func testRPCResponses() throws {
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

    func testNon2xxWithoutErrorEnvelopeThrows() {
        // protocol/README.md §4.2. Without the status check this returned a nil
        // result and threw nothing — the caller believes its mutation committed.
        XCTAssertThrowsError(try LunoraClient.parseRPCResponse(["message": "bad gateway"], status: 502))
    }

    // MARK: - WebSocket frames

    func testClientFrameBuilders() throws {
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

    func testServerFrameConsumer() throws {
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

    func testShapeSubscribeFrame() throws {
        let shape = try XCTUnwrap(fixture("ws-frames.json")["shape"] as? [String: Any])
        let frame = try LunoraClient.buildShapeSubscribeFrame(id: "shape_1", name: "roomMessages", args: ["room": "general"])
        XCTAssertEqual(canonical(frame), canonical(shape["shape-subscribe-cold"]))
    }

    func testPokeSequenceMaterialisesRows() throws {
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

    func testPokePartsDoNotApplyBeforePokeEnd() throws {
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
}
