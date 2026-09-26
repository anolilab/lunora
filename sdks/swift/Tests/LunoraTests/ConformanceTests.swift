import Foundation
import XCTest

@testable import Lunora

/// Protocol-conformance tests: drive the Swift SDK against the shared golden
/// fixtures in `protocol/fixtures/`, the same files the TypeScript client and
/// the Python, Go and Ruby ports are tested against.
/// The golden fixtures are not optional: without them this suite asserts
/// nothing, so their absence is a failure rather than a reason to skip.
struct FixturesUnreachable: Error, CustomStringConvertible {
    var description: String { "could not locate protocol/fixtures" }
}

final class ConformanceTests: XCTestCase {
    /// Walks up from this source file to the repo's `protocol/fixtures`.
    ///
    /// Not `private`: the optimistic-layer and offline-queue cases live in an
    /// extension in their own file and share these helpers.
    func fixturesDirectory() throws -> URL {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = directory.appendingPathComponent("protocol/fixtures")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            let parent = directory.deletingLastPathComponent()
            if parent.path == directory.path { break }
            directory = parent
        }
        // NOT `XCTSkip`: a skipped test still exits 0, and this helper is what
        // the manifest driver calls, so unreachable fixtures would have printed
        // `Executed 11 tests, with 2 skipped` — a PASS with 0 of the 40 manifest
        // cases run. Every sibling port raises here (Python FileNotFoundError,
        // Go error, Ruby raise, Rust panic, JVM IllegalStateException, Dart
        // StateError); a thrown Error fails the test the same way.
        throw FixturesUnreachable()
    }

    /// Loaded through the TRANSPORT's reader, not `JSONSerialization`: a case
    /// like `number-decode-correctly-rounded` otherwise tests the harness's
    /// parser rather than the one the port reads frames and bodies with.
    func fixture(_ name: String) throws -> [String: Any] {
        let url = try fixturesDirectory().appendingPathComponent(name)
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(LunoraJSON.parse(data) as? [String: Any])
    }

    /// Re-serialises so two structures compare as text with a canonical key
    /// order, independent of the order the fixture file happens to use.
    func canonical(_ value: Any?) -> String { Wire.stableStringify(value) }

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
        let manifest = try XCTUnwrap(LunoraJSON.parse(try Data(contentsOf: url)) as? [String: Any])
        let required = try XCTUnwrap(manifest["required"] as? [String])

        XCTAssertFalse(required.isEmpty, "the manifest must list at least one required case")

        for name in required {
            switch name {
            case "wire_codec_round_trip": try caseWireCodecRoundTrip()
            case "undefined_is_distinct_from_null": try caseUndefinedIsDistinctFromNull()
            case "over_long_bigint_rejected": caseOverLongBigIntRejected()
            case "malformed_values_rejected": try caseMalformedValuesRejected()
            case "depth_cap_enforced": caseDepthCapEnforced()
            case "exact_integer_range_enforced": caseExactIntegerRangeEnforced()
            case "stable_wire_key_fixtures": try caseStableWireKeyFixtures()
            case "format_number_matches_ecmascript": caseFormatDoubleMatchesEcmaScript()
            case "key_order_matches_utf16": caseKeyOrderMatchesUTF16()
            case "string_escaping_matches_json_stringify": caseStringEscapingMatchesJSONStringify()
            case "empty_shard_key_is_omitted": try caseEmptyShardKeyIsOmitted()
            case "rpc_request_bodies": try caseRPCRequestBodies()
            case "rpc_responses": try caseRPCResponses()
            case "non_2xx_without_error_envelope_fails": try caseNon2xxWithoutErrorEnvelopeThrows()
            case "client_frame_builders": try caseClientFrameBuilders()
            case "server_frame_consumer": try caseServerFrameConsumer()
            // The `complete` case lives inside the `serverFrames` loop, which is
            // where every other frame's expectations already are. Two manifest
            // names, one dispatch: the loop asserts both.
            case "complete_frame_cancels_without_dropping_the_subscription": try caseServerFrameConsumer()
            case "subscription_stream_yields_frame_values_in_order": try caseSubscriptionStreamYieldsFrameValuesInOrder()
            case "shape_subscribe_frame": try caseShapeSubscribeFrame()
            case "shape_subscriptions_resend_after_reconnect": try caseShapeSubscriptionsResendAfterReconnect()
            case "poke_sequence_materialises_rows": try casePokeSequenceMaterialisesRows()
            case "poke_parts_do_not_apply_before_poke_end": try casePokePartsDoNotApplyBeforePokeEnd()
            case "shape_reset_poke_replaces_membership": try testResetPokeReplacesShapeMembership()
            case "pending_poke_buffers_are_bounded": try testPendingPokeBuffersAreBounded()
            case "optimistic_layer_rebases_onto_server_frame": try caseOptimisticLayerRebasesOntoServerFrame()
            case "optimistic_layer_drops_on_commit_cursor": try caseOptimisticLayerDropsOnCommitCursor()
            case "optimistic_layer_drops_on_settled_frame": try caseOptimisticLayerDropsOnSettledFrame()
            case "optimistic_layer_rolls_back_on_failure": try caseOptimisticLayerRollsBackOnFailure()
            case "offline_queue_fifo_replay_order": try caseOfflineQueueFifoReplayOrder()
            case "offline_queue_drains_only_the_named_shard": try caseOfflineQueueDrainsOnlyTheNamedShard()
            case "offline_queue_overflow_evicts_oldest": try caseOfflineQueueOverflowEvictsOldest()
            case "offline_queue_precondition_drops_stale_write": try caseOfflineQueuePreconditionDropsStaleWrite()
            case "offline_queue_hydrates_persisted_writes": try caseOfflineQueueHydratesPersistedWrites()
            case "offline_queue_identity_gate_rejects_replay": try caseOfflineQueueIdentityGateRejectsReplay()
            case "offline_flush_replays_and_confirms_optimistic": try caseOfflineFlushReplaysAndConfirmsOptimistic()
            case "offline_flush_batches_multiple_writes": try caseOfflineFlushBatchesMultipleWrites()
            case "offline_flush_unreadable_slot_is_retried": try caseOfflineFlushBatchesMultipleWrites()
            case "offline_flush_batch_splits_on_payload_too_large": try caseOfflineFlushBatchSplitsOnPayloadTooLarge()
            case "optimistic_cursorless_frame_preserves_cursor": try caseOptimisticCursorlessFramePreservesCursor()
            case "offline_queue_hydrate_overflow_settles_discarded": try caseOfflineQueueHydrateOverflowSettlesDiscarded()
            case "offline_flush_unencodable_write_settles_terminal": try caseOfflineFlushUnencodableWriteSettlesTerminal()
            case "batch_entry_cap_matches_protocol": try caseBatchEntryCapMatchesProtocol()
            case "offline_flush_empty_shard_key_routes_to_default": try caseOfflineFlushEmptyShardKeyRoutesToDefault()
            case "offline_flush_undecodable_result_settles_committed": try caseOfflineFlushUndecodableResultSettlesCommitted()
            case "offline_flush_classifies_single_and_batch_alike": try caseOfflineFlushClassifiesSingleAndBatchAlike()
            case "offline_flush_batch_splits_on_envelopeless_413": try caseOfflineFlushBatchSplitsOnEnvelopeless413()
            case "shape_poke_with_undecodable_row_is_refused_whole": try caseShapePokeWithUndecodableRowIsRefusedWhole()
            case "malformed_frames_are_ignored_without_raising": try caseMalformedFramesAreIgnoredWithoutRaising()
            case "rpc_unreadable_success_body_raises_sdk_error": try caseRPCUnreadableSuccessBodyRaisesSDKError()
            case "subscription_stream_ends_on_close": try caseSubscriptionStreamEndsOnClose()
            case "identity_change_evicts_previous_session": try caseIdentityChangeEvictsPreviousSession()
            case "auth_token_redacted_when_printed": caseAuthTokenRedactedWhenPrinted()
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
            // A handful of shapes are legitimately not fixed points — a bare
            // [tag] array is escaped on the way out, an `undefined` object field
            // is dropped — and carry the expected re-encoding.
            let expected = testCase["reencoded"] ?? encoded
            // `canonical` IS the transport's body writer (`Client.swift` posts
            // `Wire.stableStringify`), so this compares the bytes it sends.
            XCTAssertEqual(canonical(roundTripped), canonical(expected), "round-trip mismatch for \(name)")
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

    /// Walks the shared rejection list.
    ///
    /// The list is data (`protocol/fixtures/wire-codec.json`), not a per-suite
    /// invention: a rejection each port hard-codes for itself is a rejection
    /// only some ports have, which is how one of them ended up accepting a
    /// truncated base64 payload as valid short bytes.
    func caseMalformedValuesRejected() throws {
        let rejected = try XCTUnwrap(fixture("wire-codec.json")["rejected"] as? [[String: Any]])
        XCTAssertFalse(rejected.isEmpty, "the fixture must carry a rejection list")

        for testCase in rejected {
            let name = testCase["name"] as? String ?? "?"
            XCTAssertThrowsError(try Wire.decode(testCase["encoded"]), name)
        }

        let decoded = try Wire.decode([Wire.tag, "bytes", "AQID"])
        XCTAssertEqual(try XCTUnwrap(decoded as? Data), Data([1, 2, 3]))

        // A bare [tag] is NOT malformed: it is the forward-compat shape, and the
        // reference hands it back as an ordinary array.
        XCTAssertEqual(try XCTUnwrap(Wire.decode([Wire.tag]) as? [Any]).count, 1)
    }

    /// An integer a `Double` cannot hold exactly must not silently become a
    /// different integer on the wire. Swift's `Int` is 64-bit, so passing one
    /// through left the SERVER's own `JSON.parse` to round it.
    func caseExactIntegerRangeEnforced() {
        let maximum = 9_007_199_254_740_991

        XCTAssertNoThrow(try Wire.encode(maximum))
        XCTAssertNoThrow(try Wire.encode(-maximum))
        XCTAssertThrowsError(try Wire.encode(maximum + 1))
        XCTAssertThrowsError(try Wire.encode(-maximum - 1))
        // Unsigned too, including past Int64.max, where no Int path could see it.
        XCTAssertThrowsError(try Wire.encode(UInt64(maximum) + 1))
        XCTAssertThrowsError(try Wire.encode(UInt64.max))

        // WireBigInt is the way across, and it keeps every digit.
        XCTAssertEqual(
            canonical(try? Wire.encode(WireBigInt("9007199254740992"))),
            canonical([Wire.tag, "bigint", "9007199254740992"])
        )
    }

    /// An EMPTY shard key is absent, not the shard named `""`.
    ///
    /// The runtime takes any string as a named shard and gives `""` its own
    /// Durable Object, while this client treats `""` and nil as one shard
    /// wherever it matches a subscription or drains the queue. Sending it split
    /// those two views: a single-call replay of a queued write landed on one
    /// Durable Object and a BATCHED replay of that same write on another, with
    /// the optimistic overlay tracking neither. Both builders that carry a shard
    /// key are asserted, because normalising one and not the other is the same
    /// split.
    func caseEmptyShardKeyIsOmitted() throws {
        for absent in [nil, ""] as [String?] {
            let body = try LunoraClient.buildRPCBody(functionPath: "messages:send", args: [String: Any](), shardKey: absent)
            XCTAssertNil(body["shardKey"], "shard key \(String(describing: absent))")
        }

        let named = try LunoraClient.buildRPCBody(functionPath: "messages:send", args: [String: Any](), shardKey: "room-1")
        XCTAssertEqual(named["shardKey"] as? String, "room-1")

        let client = LunoraClient(url: "https://app.example")

        for absent in [nil, ""] as [String?] {
            XCTAssertFalse(client.wsURL(shardKey: absent).contains("shard="), "ws shard key \(String(describing: absent))")
        }

        XCTAssertEqual(client.wsURL(shardKey: ""), client.wsURL(shardKey: nil))
        XCTAssertTrue(client.wsURL(shardKey: "room-1").contains("shard="))
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
            // An integral double past 2^53: ECMAScript prints the SHORTEST
            // digits that read back as the same double and zero-pads, so this
            // is not the exact expansion 1152921504606846976 that %.0f writes.
            (1.152_921_504_606_847e18, "1152921504606847000"),
            // Negative zero keeps its sign in a key.
            (-0.0, "-0"),
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

        // A LONE surrogate is written `\udXXX`, lowercase, as JSON.stringify
        // writes it; a well-formed pair is written raw. The truncated emoji is
        // the realistic source: a bridged NSString keeps the unit even though
        // Swift's own views repair it to U+FFFD.
        let truncated = ("\u{1F600} hello" as NSString).substring(to: 1)
        XCTAssertEqual(Wire.jsonString(truncated), #""\ud83d""#)
        XCTAssertEqual(Wire.jsonString("\u{1F600}"), "\"\u{1F600}\"")
        // Keys and members differing only by a lone surrogate are distinct to
        // JavaScript. A Map and a Set keep them apart; a `[String: Any]` cannot
        // (Swift compares them as U+FFFD), so such an object is refused rather
        // than silently merged.
        let lone = #"["\ud800",1],["\ud801",2],["�",3]"#
        let map = try? Wire.decode(LunoraJSON.parse(#"["$lunora.wire$","map",[\#(lone)]]"#)) as? WireMap
        let set = try? Wire.decode(LunoraJSON.parse(#"["$lunora.wire$","set",["\ud800","\ud801","�"]]"#)) as? WireSet

        XCTAssertEqual(map?.entries.count, 3, "map keys stay distinct")
        XCTAssertEqual(set?.items.count, 3, "set members stay distinct")
        XCTAssertThrowsError(try LunoraJSON.parse(#"{"\ud800":1,"\ud801":2}"#), "an object that cannot hold both keys is refused")
        XCTAssertEqual(
            (try? LunoraJSON.parse(#"{"a":1,"a":2}"#) as? [String: Any])?["a"] as? Int,
            2,
            "a true duplicate still takes the last value"
        )

        // And the reader keeps one it is sent, so a relayed value round-trips.
        XCTAssertEqual(Wire.jsonString((try? LunoraJSON.parse(#""a\uD800b""#)) as? String ?? ""), #""a\ud800b""#)
    }

    /// A write carrying a lone surrogate reaches the wire the way JSON.stringify
    /// writes it, alone and queued.
    ///
    /// `JSONSerialization` refused the string ("failed to convert to UTF8"), the
    /// direct call threw a raw `NSError`, and the offline flush classified that
    /// as transport — so the write, and every write queued behind it, was
    /// re-queued on every flush, forever.
    func testALoneSurrogateReachesTheWire() throws {
        let truncated = ("\u{1F600} hello" as NSString).substring(to: 1)
        var bodies: [String] = []
        let client = LunoraClient(
            url: "https://app.example",
            post: { _, _, body in
                bodies.append(String(decoding: body, as: UTF8.self))

                return (200, echoBatchSlots(body, result: "\"ok\""))
            }
        )

        client.attachSocket { _ in }
        _ = try client.mutation("messages:send", args: ["text": truncated])

        XCTAssertEqual(bodies, [#"{"args":{"text":"\ud83d"},"functionPath":"messages:send"}"#])

        client.detachSocket()
        try client.submit(LunoraSubmitOptions(functionPath: "messages:send", args: ["text": truncated], mutationID: "poison"))
        try client.submit(LunoraSubmitOptions(functionPath: "messages:send", args: ["text": "fine"], mutationID: "innocent"))

        let report = client.flushOfflineQueue()

        XCTAssertEqual(report.committed, ["poison", "innocent"], "nothing is parked behind the surrogate")
        XCTAssertEqual(client.pendingMutationCount, 0)
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

                if testCase["dataDropped"] as? Bool == true {
                    XCTAssertNil(apiError.data, "\(name): undecodable data is dropped, the coded error kept")
                }
            }
        }

        commitCursorExcludesBooleans()
    }

    /// `NSNumber` bridges JSON `true` to `1`, so a peer sending a boolean cursor
    /// would otherwise confirm every pending optimistic layer at cursor 1.
    private func commitCursorExcludesBooleans() {
        XCTAssertEqual(LunoraClient.parseCommitCursor(["commitCursor": 4]), 4)
        XCTAssertNil(LunoraClient.parseCommitCursor(["commitCursor": true]))
        XCTAssertNil(LunoraClient.parseCommitCursor(["commitCursor": "4"]))
        XCTAssertNil(LunoraClient.parseCommitCursor([:]))
    }

    func caseNon2xxWithoutErrorEnvelopeThrows() throws {
        // protocol/README.md §4.2. Without the status check this returned a nil
        // result and threw nothing — the caller believes its mutation committed.
        // The fixture's non-object `error` slots are the other half: a slot
        // holding a string, a null or an array is not an envelope either, and a
        // port reading one without a type check raises its LANGUAGE's error
        // rather than the SDK's, escaping every handler the caller wrote.
        let cases = try XCTUnwrap(try fixture("rpc.json")["responseTransportError"] as? [[String: Any]])

        for testCase in cases {
            let name = testCase["name"] as? String ?? "?"
            let response = try XCTUnwrap(testCase["response"] as? [String: Any])
            let status = try XCTUnwrap(testCase["status"] as? Int)

            XCTAssertThrowsError(try LunoraClient.parseRPCResponse(response, status: status), name) { error in
                guard let apiError = error as? LunoraAPIError else { return XCTFail("expected LunoraAPIError for \(name)") }
                XCTAssertEqual(apiError.code, testCase["code"] as? String, name)
                // Nothing reached the shard, so a queued write must be replayed
                // rather than dropped — the batch path already says so.
                XCTAssertTrue(apiError.transient, name)
            }
        }
    }

    /// A body the RPC call can read neither a result nor an envelope out of — not
    /// JSON, or JSON that is not an object — fails with THIS SDK's error, never a
    /// reader error escaping every handler the caller wrote, and never a silent
    /// nil result the caller takes for a committed write.
    func caseRPCUnreadableSuccessBodyRaisesSDKError() throws {
        for testCase in try XCTUnwrap(fixture("rpc.json")["unreadableSuccessBody"] as? [[String: Any]]) {
            let name = testCase["name"] as? String ?? "?"
            let status = try XCTUnwrap((testCase["status"] as? NSNumber)?.intValue)
            let body = Data(try XCTUnwrap(testCase["rawBody"] as? String).utf8)
            let client = LunoraClient(url: "https://app.example", post: { _, _, _ in (status, body) })
            let calls: [(String, () throws -> Any)] = [
                ("query", { try client.query("messages:list") }),
                ("mutation", { try client.mutation("messages:send") }),
                ("action", { try client.action("messages:notify") }),
            ]

            for (verb, call) in calls {
                XCTAssertThrowsError(try call(), "\(verb) \(name)") { error in
                    XCTAssertEqual((error as? LunoraAPIError)?.code, testCase["code"] as? String, "\(verb) \(name): \(error)")
                }
            }
        }

        // `{}` is how a function returning nothing is answered.
        let void = LunoraClient(url: "https://app.example", post: { _, _, _ in (200, Data("{}".utf8)) })

        XCTAssertTrue(try void.query("messages:list") is NSNull, "an empty object is a void result")
    }

    // MARK: - WebSocket frames

    /// A frame the read loop hands over, as the text it arrived as.
    func frameText(_ frame: Any?) -> String { Wire.stableStringify(frame) }

    /// No frame shaped unlike any server frame may raise out of the handler —
    /// `handleFrame` cannot throw at all — or touch a live subscription: its
    /// callback stays silent and its resume cursor stays where it was. A STRING
    /// cursor is not a cursor; resending it asked the server to resume from `"9"`.
    func caseMalformedFramesAreIgnoredWithoutRaising() throws {
        let block = try XCTUnwrap(fixture("ws-frames.json")["malformedFrames"] as? [String: Any])
        let frames = try XCTUnwrap(block["frames"] as? [Any])

        XCTAssertFalse(frames.isEmpty)

        for (index, frame) in frames.enumerated() {
            let client = LunoraClient(url: "https://app.example")
            var fired = 0

            client.attachSocket { _ in }
            client.subscribe("messages:list", args: [String: Any](), onData: { _ in fired += 1 })
            client.handleFrame(frameText(block["setupFrame"]))
            fired = 0

            client.handleFrame(frameText(frame))

            XCTAssertEqual(fired, 0, "frame \(index) must not reach sub_1")

            var resent: [[String: Any]] = []

            client.attachSocket { resent.append($0) }
            client.resendSubscriptions()

            let query = try XCTUnwrap(resent.first?["query"] as? [String: Any])

            XCTAssertEqual(canonical(query["sinceSeq"]), canonical(block["resendSinceSeq"]), "frame \(index) sinceSeq")
            XCTAssertEqual(query["sinceEpoch"] as? String, block["resendSinceEpoch"] as? String, "frame \(index) sinceEpoch")
        }
    }

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
        var cancellations = 0

        for testCase in try XCTUnwrap(fixture("ws-frames.json")["serverFrames"] as? [[String: Any]]) {
            let name = testCase["name"] as? String ?? "?"
            let client = LunoraClient(url: "https://app.example")
            var sent: [[String: Any]] = []
            client.attachSocket { sent.append($0) }

            var seen: [Any] = []
            var errors: [LunoraSubscriptionError] = []
            client.subscribe("messages:list", args: ["channel": "general"], onData: { seen.append($0) }, onError: { errors.append($0) })
            sent.removeAll()

            let raw = try JSONSerialization.data(withJSONObject: try XCTUnwrap(testCase["frame"]))
            let kind = client.handleFrame(try XCTUnwrap(String(data: raw, encoding: .utf8)))
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

            // Cancelled AND kept. Removing the entry takes it out of the
            // dictionary `resendSubscriptions` walks, which froze the query
            // across every future reconnect with nothing reported.
            if expect["resendsAfterReconnect"] as? Bool == true {
                cancellations += 1
                XCTAssertEqual(errors.count, 1, name)
                XCTAssertEqual(errors.first?.code, expect["code"] as? String, name)
                XCTAssertEqual(errors.first?.message, expect["message"] as? String, name)
                client.resendSubscriptions()
                XCTAssertEqual(
                    sent.filter { $0["type"] as? String == "subscribe" }.map { $0["id"] as? String },
                    [expect["id"] as? String],
                    name
                )
            }
        }

        // A conditional assertion that never runs is worse than none: without
        // this, renaming the fixture key would leave every suite green.
        XCTAssertEqual(cancellations, 1, "serverFrames must carry one cancelling case")
    }

    /// The `AsyncStream` form of a live query: same subscription, same decode,
    /// same order as the callback form.
    func caseSubscriptionStreamYieldsFrameValuesInOrder() throws {
        let testCase = try XCTUnwrap(fixture("ws-frames.json")["stream"] as? [String: Any])
        let frames = try XCTUnwrap(testCase["frames"] as? [Any])
        let client = LunoraClient(url: "https://app.example")
        client.attachSocket { _ in }

        let events = client.stream("messages:list", args: ["channel": "general"])
        var iterator = events.makeAsyncIterator()
        var seen: [Any] = []

        // Frames are fed from this same thread, so the loop is driven one `next()`
        // at a time rather than with `for await`.
        for frame in frames {
            let raw = try JSONSerialization.data(withJSONObject: frame)

            _ = client.handleFrame(try XCTUnwrap(String(data: raw, encoding: .utf8)))

            switch runBlocking({ await iterator.next() }) {
            case .value(let value): seen.append(value)
            case .failure(let error): XCTFail("stream error: \(error.message)")
            case nil: XCTFail("the stream ended early")
            }
        }

        XCTAssertEqual(canonical(try Wire.encode(seen)), canonical(testCase["yielded"]), "the stream yields the frames' values, in order")
    }

    /// `close()` ENDS a live stream: the value already delivered is yielded, and
    /// then the `for await` loop finishes instead of waiting forever on a client
    /// that will never deliver again.
    func caseSubscriptionStreamEndsOnClose() throws {
        let testCase = try XCTUnwrap(fixture("ws-frames.json")["stream"] as? [String: Any])
        let frame = try XCTUnwrap((testCase["frames"] as? [Any])?.first)
        let client = LunoraClient(url: "https://app.example")

        client.attachSocket { _ in }

        var iterator = client.stream("messages:list", args: ["channel": "general"]).makeAsyncIterator()

        client.handleFrame(frameText(frame))

        guard case .value(let value)?? = runBlocking(timeout: 2, { await iterator.next() }) else {
            return XCTFail("the delivered value must be yielded")
        }

        XCTAssertEqual(canonical(try Wire.encode(value)), canonical((testCase["yielded"] as? [Any])?.first))

        client.close()

        guard let after = runBlocking(timeout: 2, { await iterator.next() }) else {
            return XCTFail("the stream must end within 2 s of close(), not hang")
        }

        XCTAssertNil(after, "and it ENDS rather than yielding again")
    }

    /// Runs one `async` step to completion from a synchronous test.
    ///
    /// The suite is driven by the manifest through synchronous `case…` methods,
    /// and this is the only asynchronous surface in it — a semaphore here is
    /// cheaper than making every dispatch arm `async`.
    private func runBlocking<T>(_ operation: @escaping () async -> T) -> T {
        runBlocking(timeout: nil, operation)!
    }

    /// The same, giving up after `timeout` seconds: nil means it did not finish.
    private func runBlocking<T>(timeout: TimeInterval?, _ operation: @escaping () async -> T) -> T? {
        let ready = DispatchSemaphore(value: 0)
        let box = ResultBox<T>()

        Task {
            box.value = await operation()
            ready.signal()
        }

        if let timeout {
            guard ready.wait(timeout: .now() + timeout) == .success else { return nil }
        } else {
            ready.wait()
        }

        return box.value
    }

    // MARK: - Shapes

    func caseShapeSubscribeFrame() throws {
        let shape = try XCTUnwrap(fixture("ws-frames.json")["shape"] as? [String: Any])
        let frame = try LunoraClient.buildShapeSubscribeFrame(id: "shape_1", name: "roomMessages", args: ["room": "general"])
        XCTAssertEqual(canonical(frame), canonical(shape["shape-subscribe-cold"]))
    }

    /// A reconnect re-subscribes the SHAPE registry too.
    ///
    /// Walking only the queries leaves every shape view attached to a socket that
    /// no longer exists — silently, and for the rest of the process's life.
    func caseShapeSubscriptionsResendAfterReconnect() throws {
        let client = LunoraClient(url: "https://app.example")

        client.attachSocket { _ in }
        client.subscribe("messages:list", args: ["channel": "general"], onData: { _ in })
        client.subscribeShape("roomMessages", args: ["room": "general"], onRows: { _ in })

        // The cursors a resume carries are written by the frame handler, so they
        // have to exist before the resend is built.
        for frame in [
            ["cursor": 9, "data": [], "epoch": "e1", "id": "sub_1", "type": "data"] as [String: Any],
            ["epoch": "e1", "pokeId": "poke-1", "type": "pokeStart"],
            ["pokeId": "poke-1", "reset": true, "rowsPatch": [], "shapeId": "shape_1", "type": "pokePart"],
            ["checkpoint": 5, "epoch": "e1", "pokeId": "poke-1", "type": "pokeEnd"],
        ] {
            let raw = try JSONSerialization.data(withJSONObject: frame)

            client.handleFrame(try XCTUnwrap(String(data: raw, encoding: .utf8)))
        }

        var resent: [[String: Any]] = []

        client.attachSocket { resent.append($0) }
        client.resendSubscriptions()

        XCTAssertEqual(resent.map { $0["type"] as? String }, ["subscribe", "shape_subscribe"])
        XCTAssertEqual((resent[0]["query"] as? [String: Any])?["sinceSeq"] as? Int, 9)

        let shape = try XCTUnwrap(resent[1]["shape"] as? [String: Any])

        XCTAssertEqual(resent[1]["id"] as? String, "shape_1")
        XCTAssertEqual(shape["name"] as? String, "roomMessages")
        XCTAssertEqual(canonical(shape["args"]), canonical(["room": "general"]))
        XCTAssertEqual(resent[1]["sinceCheckpoint"] as? Int, 5)
        XCTAssertEqual(resent[1]["sinceEpoch"] as? String, "e1")
    }

    /// A payload the codec refuses is that subscription's error, not the socket's.
    ///
    /// Throwing out of `handleFrame` ends the caller's read loop, which takes
    /// every OTHER subscription on the client down with it.
    func testARefusedPayloadStaysScopedToItsSubscription() throws {
        let client = LunoraClient(url: "https://app.example")

        client.attachSocket { _ in }

        var errors: [LunoraSubscriptionError] = []
        var delivered: [Any] = []

        client.subscribe("messages:list", args: ["channel": "a"], onData: { _ in }, onError: { errors.append($0) })
        client.subscribe("messages:list", args: ["channel": "b"], onData: { delivered.append($0) })

        let refused = try JSONSerialization.data(
            withJSONObject: ["data": ["amount": [Wire.tag, "bigint", "not-a-number"]], "id": "sub_1", "type": "data"]
        )
        var kind: String?

        XCTAssertNoThrow(kind = client.handleFrame(try XCTUnwrap(String(data: refused, encoding: .utf8))))
        XCTAssertEqual(kind, "error", "the frame is reported, not thrown")
        XCTAssertEqual(errors.first?.code, "INVALID_FRAME")

        let good = try JSONSerialization.data(withJSONObject: ["data": ["ok": true], "id": "sub_2", "type": "data"])

        client.handleFrame(try XCTUnwrap(String(data: good, encoding: .utf8)))

        XCTAssertEqual(delivered.count, 1, "the other subscription is still live")
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
            client.handleFrame(try XCTUnwrap(String(data: raw, encoding: .utf8)))
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
            client.handleFrame(try XCTUnwrap(String(data: raw, encoding: .utf8)))
        }

        XCTAssertEqual(fired, 0, "the view would be torn if parts applied before pokeEnd")
    }

    /// The rows a shape view holds right now, read black-box: an empty poke for
    /// the shape re-delivers its view unchanged.
    private func probeShapeView(_ client: LunoraClient, _ delivered: () -> [[Any]]) -> [Any]? {
        client.handleFrame(#"{"type":"pokeStart","pokeId":"probe"}"#)
        client.handleFrame(#"{"type":"pokePart","pokeId":"probe","shapeId":"shape_1","rowsPatch":[]}"#)
        client.handleFrame(#"{"type":"pokeEnd","pokeId":"probe"}"#)

        return delivered().last
    }

    /// A poke applies WHOLE or not at all per shape: a reset carrying one row the
    /// codec refuses leaves the view, the checkpoint and the epoch untouched,
    /// fires no rows callback, and reports `INVALID_FRAME` to the shape.
    func caseShapePokeWithUndecodableRowIsRefusedWhole() throws {
        let shape = try XCTUnwrap(fixture("ws-frames.json")["shape"] as? [String: Any])
        let client = LunoraClient(url: "https://app.example")
        var delivered: [[Any]] = []
        var errors: [LunoraSubscriptionError] = []

        client.attachSocket { _ in }
        client.subscribeShape(
            "roomMessages",
            args: ["room": "general"],
            onRows: { delivered.append($0) },
            onError: { errors.append($0) }
        )

        for entry in try XCTUnwrap(shape["pokeSequence"] as? [Any]) {
            client.handleFrame(frameText(entry))
        }

        delivered.removeAll()

        for entry in try XCTUnwrap(shape["undecodableRowPokeSequence"] as? [Any]) {
            client.handleFrame(frameText(entry))
        }

        XCTAssertTrue(delivered.isEmpty, "no rows callback fires for a refused poke")
        XCTAssertEqual(errors.map(\.code), [shape["undecodableRowErrorCode"] as? String], "the shape hears the refusal once")

        var resent: [[String: Any]] = []

        client.attachSocket { resent.append($0) }
        client.resendSubscriptions()

        let resend = try XCTUnwrap(resent.first { $0["type"] as? String == "shape_subscribe" })

        XCTAssertEqual(canonical(resend["sinceCheckpoint"]), canonical(shape["undecodableRowResendCheckpoint"]), "checkpoint not advanced")
        XCTAssertEqual(resend["sinceEpoch"] as? String, "e1")
        XCTAssertEqual(canonical(probeShapeView(client, { delivered })), canonical(shape["expectedRows"]), "the view is untouched")

        // The server believes it delivered the refused rows, so its next part is
        // based on a checkpoint this view is not at: that must re-seed the shape,
        // not splice onto the stale view.
        resent.removeAll()
        delivered.removeAll()

        for entry in try XCTUnwrap(shape["gapPokeSequence"] as? [Any]) {
            client.handleFrame(frameText(entry))
        }

        XCTAssertEqual(delivered.map { canonical($0) }, [canonical(shape["gapExpectedRows"])], "the callback is told []")

        let cold = resent.filter { $0["type"] as? String == "shape_subscribe" }

        XCTAssertEqual(cold.map { $0["id"] as? String }, ["shape_1"], "a cold shape_subscribe goes out at once")
        XCTAssertNil(cold.first?["sinceCheckpoint"])
        XCTAssertNil(cold.first?["sinceEpoch"])

        resent.removeAll()
        client.resendSubscriptions()

        let later = try XCTUnwrap(resent.first { $0["type"] as? String == "shape_subscribe" })

        XCTAssertNil(later["sinceCheckpoint"], "and a later resend is cold too")
        XCTAssertNil(later["sinceEpoch"])
        XCTAssertEqual(canonical(probeShapeView(client, { delivered })), canonical(shape["gapExpectedRows"]))

        // The counterweight: a part based on the checkpoint the view IS at applies.
        let contiguous = LunoraClient(url: "https://app.example")
        var contiguousRows: [[Any]] = []
        var contiguousSent: [[String: Any]] = []

        contiguous.attachSocket { contiguousSent.append($0) }
        contiguous.subscribeShape("roomMessages", args: ["room": "general"], onRows: { contiguousRows.append($0) })

        for entry in try XCTUnwrap(shape["pokeSequence"] as? [Any]) + XCTUnwrap(shape["contiguousPokeSequence"] as? [Any]) {
            contiguous.handleFrame(frameText(entry))
        }

        XCTAssertEqual(canonical(contiguousRows.last), canonical(shape["contiguousExpectedRows"]), "a contiguous poke applies")
        XCTAssertEqual(contiguousSent.filter { $0["type"] as? String == "shape_subscribe" }.count, 1, "and re-seeds nothing")
    }

    /// An identity change FROM a set value evicts the previous session: cursors
    /// and epochs dropped, shape views emptied with their callbacks told `[]`. A
    /// first sign-in and a same-value set evict nothing.
    func caseIdentityChangeEvictsPreviousSession() throws {
        let frames = try fixture("ws-frames.json")
        let block = try XCTUnwrap(frames["identityChange"] as? [String: Any])
        let shape = try XCTUnwrap(frames["shape"] as? [String: Any])
        let retained = try XCTUnwrap(block["retained"] as? [String: Any])
        let evicted = try XCTUnwrap(block["evicted"] as? [String: Any])
        let transitions = try XCTUnwrap(block["transitions"] as? [[String: Any]])

        XCTAssertEqual(transitions.count, 4)

        for transition in transitions {
            let from = transition["from"] as? String
            let to = transition["to"] as? String
            let name = "\(from ?? "nil") -> \(to ?? "nil")"
            let client = LunoraClient(url: "https://app.example")
            var shapeRows: [[Any]] = []

            client.identity = from
            client.attachSocket { _ in }
            client.subscribe("messages:list", args: [String: Any](), onData: { _ in })
            client.handleFrame(frameText(block["queryFrame"]))
            client.subscribeShape("roomMessages", args: ["room": "general"], onRows: { shapeRows.append($0) })

            for entry in try XCTUnwrap(shape["pokeSequence"] as? [Any]) {
                client.handleFrame(frameText(entry))
            }

            shapeRows.removeAll()
            client.identity = to

            let told = shapeRows
            var resent: [[String: Any]] = []

            client.attachSocket { resent.append($0) }
            client.resendSubscriptions()

            let query = try XCTUnwrap(resent.first { $0["type"] as? String == "subscribe" }?["query"] as? [String: Any])
            let shapeFrame = try XCTUnwrap(resent.first { $0["type"] as? String == "shape_subscribe" })
            let view = try XCTUnwrap(probeShapeView(client, { shapeRows }))

            if transition["evicts"] as? Bool == true {
                XCTAssertNil(query["sinceSeq"], name)
                XCTAssertNil(query["sinceEpoch"], name)
                XCTAssertNil(shapeFrame["sinceCheckpoint"], name)
                XCTAssertNil(shapeFrame["sinceEpoch"], name)
                XCTAssertEqual(told.map { canonical($0) }, [canonical(evicted["shapeCallbackRows"])], "\(name): callbacks told")
                XCTAssertEqual(canonical(view), canonical(evicted["shapeRows"]), "\(name): view emptied")
            } else {
                XCTAssertEqual(canonical(query["sinceSeq"]), canonical(retained["sinceSeq"]), name)
                XCTAssertEqual(query["sinceEpoch"] as? String, retained["sinceEpoch"] as? String, name)
                XCTAssertEqual(canonical(shapeFrame["sinceCheckpoint"]), canonical(retained["sinceCheckpoint"]), name)
                XCTAssertTrue(told.isEmpty, "\(name): nothing evicted, nothing told")
                XCTAssertEqual(view.count, (retained["shapeRowCount"] as? NSNumber)?.intValue, "\(name): view kept")
            }
        }
    }

    /// The bearer token never reaches a printed or dumped client.
    func caseAuthTokenRedactedWhenPrinted() {
        let token = "lunora-secret-7f3a9c"
        let client = LunoraClient(url: "https://app.example", authToken: token)
        var dumped = ""

        dump(client, to: &dumped)

        for rendered in [String(describing: client), String(reflecting: client), dumped, "\(client)"] {
            XCTAssertFalse(rendered.contains(token), "the token leaked: \(rendered)")
        }

        XCTAssertFalse(dumped.isEmpty)
    }

    /// A `reset` part carries the shape's COMPLETE membership, so the view has to
    /// be dropped before the ops are applied.
    ///
    /// Not a manifest case — the shared manifest does not name one — so it is a
    /// `test` method rather than a `case` one, but the shared fixture carries the
    /// sequence and this is the same assertion every port makes. It starts from
    /// the cold-seed state on purpose: a re-seed is inserts-only, so `m1` leaves
    /// the shape with no delete op behind it, and a client that merges renders it
    /// for the rest of its life.
    func testResetPokeReplacesShapeMembership() throws {
        let shape = try XCTUnwrap(fixture("ws-frames.json")["shape"] as? [String: Any])

        let client = LunoraClient(url: "https://app.example")
        client.attachSocket { _ in }

        var delivered: [[Any]] = []
        client.subscribeShape("roomMessages", args: ["room": "general"], onRows: { delivered.append($0) })

        for entry in try XCTUnwrap(shape["pokeSequence"] as? [Any]) {
            let raw = try JSONSerialization.data(withJSONObject: entry)
            client.handleFrame(try XCTUnwrap(String(data: raw, encoding: .utf8)))
        }

        XCTAssertEqual(canonical(delivered.last), canonical(shape["expectedRows"]), "the cold seed lands before the re-seed")

        for entry in try XCTUnwrap(shape["resetPokeSequence"] as? [Any]) {
            let raw = try JSONSerialization.data(withJSONObject: entry)
            client.handleFrame(try XCTUnwrap(String(data: raw, encoding: .utf8)))
        }

        XCTAssertEqual(
            canonical(delivered.last),
            canonical(shape["resetExpectedRows"]),
            "a reset poke replaces the shape's membership rather than merging into it"
        )
    }

    /// A buffer is only released at its `pokeEnd`. A socket that drops mid-poke
    /// never sends one, so its buffer would be retained for the life of the
    /// client — one leak per reconnect, and unbounded against a peer that opens
    /// pokes it never closes.
    ///
    /// Asserted black-box: an evicted poke behaves exactly like one that was
    /// never opened, which is the only form of this all eight ports can share.
    func testPendingPokeBuffersAreBounded() throws {
        let client = LunoraClient(url: "https://app.example")
        client.attachSocket { _ in }

        var delivered: [[Any]] = []
        client.subscribeShape("roomMessages", args: ["room": "general"], onRows: { delivered.append($0) })

        // A poke opened, part-filled, then abandoned when the socket dropped.
        client.handleFrame(#"{"type":"pokeStart","pokeId":"stale"}"#)
        client.handleFrame(
            #"{"type":"pokePart","pokeId":"stale","shapeId":"shape_1","rowsPatch":[{"op":"insert","key":"ghost","value":"ghost-row"}]}"#
        )

        for index in 0..<lunoraMaxPendingPokes {
            client.handleFrame(#"{"type":"pokeStart","pokeId":"filler-\#(index)"}"#)
        }

        // The abandoned buffer is gone, so its late pokeEnd is a no-op.
        client.handleFrame(#"{"type":"pokeEnd","pokeId":"stale"}"#)

        XCTAssertTrue(delivered.isEmpty, "the ghost row of an evicted poke must never reach the view")

        // ...and eviction is oldest-first, not a blanket drop: a live poke still applies.
        let newest = "filler-\(lunoraMaxPendingPokes - 1)"

        client.handleFrame(
            #"{"type":"pokePart","pokeId":"\#(newest)","shapeId":"shape_1","rowsPatch":[{"op":"insert","key":"m1","value":"kept"}]}"#
        )
        client.handleFrame(#"{"type":"pokeEnd","pokeId":"\#(newest)"}"#)

        XCTAssertEqual(delivered.count, 1, "the newest buffer must survive and apply")
        XCTAssertEqual(canonical(delivered.first), canonical(["kept"]), "the surviving poke applies its rows")
    }

    // MARK: - Generated-model projection

    /// `wireValue` must restore the nulls synthesized `Codable` drops.
    ///
    /// Not a manifest case: it asserts how a GENERATED MODEL reaches the wire,
    /// which is this port's own business rather than a frame every SDK shares.
    /// The pairing it protects is the one no blanket rule gets right — an unset
    /// `v.optional()` must be an absent key, a required `v.nullable()` a present
    /// null — and `JSONEncoder` omits a nil for both.
    func testWireValueRestoresRequiredNulls() throws {
        struct Model: Encodable {
            let id: String
            let limit: Double?
            let nickname: String?
        }

        let model = Model(id: "r1", limit: nil, nickname: nil)

        // Without the paths, both nils are gone — the bug this fixes.
        let bare = try XCTUnwrap(LunoraClient.wireValue(model) as? [String: Any])
        XCTAssertNil(bare["nickname"])
        XCTAssertNil(bare["limit"])

        let restored = try XCTUnwrap(LunoraClient.wireValue(model, nullablePaths: [["nickname"]]) as? [String: Any])
        XCTAssertTrue(restored["nickname"] is NSNull, "a required nullable must reach the wire AS null")
        XCTAssertNil(restored["limit"], "an unset optional must stay an absent key")
    }

    /// A path names a run of keys, not a key anywhere, and it restores only into
    /// an object that is actually there.
    func testWireValueRestoresOnlyAtTheNamedPath() throws {
        struct Inner: Encodable {
            let bio: String?
        }
        struct Model: Encodable {
            let outer: Inner
            let bio: String?
        }

        let projected = try XCTUnwrap(
            LunoraClient.wireValue(Model(outer: Inner(bio: nil), bio: nil), nullablePaths: [["outer", "bio"]]) as? [String: Any]
        )
        let outer = try XCTUnwrap(projected["outer"] as? [String: Any])

        XCTAssertTrue(outer["bio"] is NSNull, "the nested path is restored")
        XCTAssertNil(projected["bio"], "the same key at the top level is a different path")
    }

    /// A `*` is never restored: a record's absent key was never sent, and
    /// inventing one would put a null where the caller had nothing at all.
    func testWireValueNeverInventsARecordKey() throws {
        struct Model: Encodable {
            let tags: [String: String]
        }

        let projected = try XCTUnwrap(LunoraClient.wireValue(Model(tags: [:]), nullablePaths: [["tags", "*"]]) as? [String: Any])
        let tags = try XCTUnwrap(projected["tags"] as? [String: Any])

        XCTAssertTrue(tags.isEmpty, "an empty record must stay empty")
    }

    /// The restore must reach inside array elements, which is where a starred
    /// path leads.
    func testWireValueRestoresInsideArrayElements() throws {
        struct Row: Encodable {
            let note: String?
        }
        struct Model: Encodable {
            let rows: [Row]
        }

        let projected = try XCTUnwrap(
            LunoraClient.wireValue(Model(rows: [Row(note: nil), Row(note: "n")]), nullablePaths: [["rows", "*", "note"]]) as? [String: Any]
        )
        let rows = try XCTUnwrap(projected["rows"] as? [[String: Any]])

        XCTAssertTrue(rows[0]["note"] is NSNull)
        XCTAssertEqual(rows[1]["note"] as? String, "n")
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
                client.handleFrame("{\"type\":\"data\",\"id\":\"sub_1\",\"data\":1,\"cursor\":\(call)}")
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

/// Carries a `runBlocking` result off the task: written once inside it and read
/// once after the semaphore, which orders the two.
private final class ResultBox<T>: @unchecked Sendable {
    var value: T?
}

/// Counts frames from the resend, which runs on this thread — a plain `var`
/// captured by an `@escaping` closure would not compile under strict concurrency.
private final class ResentCounter {
    private var count = 0

    var value: Int { count }

    func increment() { count += 1 }
}
