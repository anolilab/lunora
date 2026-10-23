import Foundation
import XCTest

@testable import Lunora

/// Credentials planted in the client, in the raw and the percent-encoded spelling
/// `wsURL` writes a hyphen as. A leak can show up in either.
private let secretForms = ["session-token", "session%2Dtoken", "bearer-rpc-secret", "bearer%2Drpc%2Dsecret"]

/// The socket session behaviour: `connect` goes first on every open, the close
/// codes drive token expiry, and whisper topics join and rejoin.
///
/// Each method is an ordinary XCTest and is also the body the manifest dispatch in
/// `testConformanceManifestIsCovered` runs for its name, so the same assertions run
/// whichever way a name is reached.
extension ConformanceTests {
    /// The `type` of each frame, in the order they were sent.
    private func frameTypes(_ frames: [[String: Any]]) -> [String] {
        frames.compactMap { $0["type"] as? String }
    }

    func testConnectFrameFirstAndCarriesSessionToken() throws {
        let frames = try XCTUnwrap(fixture("ws-frames.json")["clientFrames"] as? [String: Any])
        let client = LunoraClient(url: "https://app.example", authToken: "bearer-rpc-secret")
        client.clientID = "client-test"
        client.sessionToken = "session-token"

        // Subscribed before the socket opens: its subscribe frame must follow connect.
        client.subscribe("messages:list", args: [String: Any](), onData: nil)

        var sent: [[String: Any]] = []

        client.attachSocket { sent.append($0) }
        client.resendSubscriptions()

        XCTAssertEqual(frameTypes(sent), ["connect", "subscribe"])
        XCTAssertEqual(canonical(sent.first), canonical(frames["connect-with-token"]))
        XCTAssertEqual(canonical(LunoraClient.buildConnectFrame(clientID: "client-test", token: "session-token")), canonical(frames["connect-with-token"]))

        XCTAssertFalse(canonical(sent).contains("bearer-rpc-secret"), "the RPC bearer must never ride a socket frame")

        // wsURL percent-encodes hyphens, so a leak can appear in either form.
        for url in [client.wsURL(shardKey: "tenant_a", wsTicket: "ticket-abc"), client.wsURL()] {
            for secret in secretForms {
                XCTAssertFalse(url.contains(secret), "\(url) carries \(secret)")
            }
        }

        let bare = LunoraClient(url: "https://app.example")
        bare.clientID = "client-test"

        var bareSent: [[String: Any]] = []

        bare.attachSocket { bareSent.append($0) }

        XCTAssertEqual(canonical(bareSent.first), canonical(frames["connect"]))
        XCTAssertNil(bareSent.first?["token"], "no session credential means no token key")
    }

    func testWSURLCarriesOnlyTheAdminTicket() throws {
        let client = LunoraClient(url: "https://app.example", authToken: "bearer-rpc-secret")
        client.sessionToken = "session-token"

        let ticketed = client.wsURL(shardKey: "tenant_a", wsTicket: "ticket-abc")
        let query = try XCTUnwrap(URLComponents(string: ticketed)?.queryItems)

        XCTAssertEqual(query.filter { $0.name == "token" }.map(\.value), ["ticket-abc"])

        let untickets = client.wsURL(shardKey: "tenant_a")

        XCTAssertFalse(untickets.contains("token="), "no ticket means no token parameter, even with a session credential set")

        for url in [ticketed, untickets] {
            for secret in secretForms {
                XCTAssertFalse(url.contains(secret), "\(url) carries \(secret)")
            }
        }
    }

    func testAttachSocketCarriesConnectionContext() throws {
        let frames = try XCTUnwrap(fixture("ws-frames.json")["clientFrames"] as? [String: Any])

        let client = LunoraClient(url: "https://app.example")
        client.clientID = "client-test"
        client.sessionToken = "session-token"

        var sent: [[String: Any]] = []

        client.attachSocket({ sent.append($0) }, context: ["roomId": "general"])

        XCTAssertEqual(canonical(sent.first), canonical(frames["connect-with-token-and-context"]))

        let bare = LunoraClient(url: "https://app.example")
        bare.clientID = "client-test"

        var bareSent: [[String: Any]] = []

        bare.attachSocket { bareSent.append($0) }

        XCTAssertNil(bareSent.first?["context"], "no context given means no context key")
        XCTAssertEqual(canonical(bareSent.first), canonical(frames["connect"]))
    }

    func testCloseCodesDriveTokenExpiry() throws {
        let block = try XCTUnwrap(fixture("ws-frames.json")["closeSequences"] as? [String: Any])
        let cases = try XCTUnwrap(block["cases"] as? [[String: Any]])

        var driven: [String] = []
        var errorsChecked = 0

        for testCase in cases {
            let name = testCase["name"] as? String ?? "?"
            let client = LunoraClient(url: "https://app.example")
            var notifications = 0
            var subscriptionErrors = 0
            var credentialRevision = 0

            _ = client.onTokenExpired { notifications += 1 }
            client.subscribe("messages:list", args: [String: Any](), onData: nil, onError: { _ in subscriptionErrors += 1 })

            for step in try XCTUnwrap(testCase["steps"] as? [[String: Any]]) {
                if step["attach"] as? Bool == true {
                    client.attachSocket { _ in }
                } else if let close = step["close"] as? [String: Any] {
                    client.detachSocket(closeCode: LunoraClient.intValue(close["code"]), reason: close["reason"] as? String)
                } else if let frame = step["frame"] {
                    client.handleFrame(frameText(frame))
                } else if step["credentialChange"] as? Bool == true {
                    credentialRevision += 1
                    client.sessionToken = "credential-\(credentialRevision)"
                } else {
                    XCTFail("\(name): unknown step \(step)")
                }
            }

            if let expected = LunoraClient.intValue(testCase["tokenExpiredNotifications"]) {
                XCTAssertEqual(notifications, expected, "\(name): token-expired notifications")
            }

            if let expected = LunoraClient.intValue(testCase["subscriptionErrors"]) {
                XCTAssertEqual(subscriptionErrors, expected, "\(name): subscription errors")
                errorsChecked += 1
            }

            driven.append(name)
        }

        XCTAssertEqual(driven.count, cases.count, "every closeSequences case must be driven")
        // A renamed key must not pass as a smaller, green run. The superseded-socket
        // case is the one a port most often gets wrong, so its absence fails loudly.
        XCTAssertTrue(driven.contains("superseded_socket_refusal_is_not_notified"), "closeSequences must drive the superseded-socket case")
        // The subscription-error branch must run for the cases that carry one.
        XCTAssertEqual(errorsChecked, 2, "closeSequences must carry two cases with subscriptionErrors")
    }

    func testWhisperFramesJoinSendAndDeliver() throws {
        let frames = try XCTUnwrap(fixture("ws-frames.json")["clientFrames"] as? [String: Any])
        let block = try XCTUnwrap(fixture("ws-frames.json")["whisperFrames"] as? [String: Any])
        let serverFrames = try XCTUnwrap(block["serverFrames"] as? [[String: Any]])

        XCTAssertEqual(canonical(LunoraClient.buildWhisperSubscribeFrame(topic: "room:general")), canonical(frames["whisper-subscribe"]))
        XCTAssertEqual(canonical(LunoraClient.buildWhisperUnsubscribeFrame(topic: "room:general")), canonical(frames["whisper-unsubscribe"]))
        XCTAssertEqual(
            canonical(try LunoraClient.buildWhisperFrame(topic: "room:general", data: ["text": "hi"])),
            canonical(frames["whisper-send"])
        )

        let client = LunoraClient(url: "https://app.example")
        client.clientID = "client-test"

        var sent: [[String: Any]] = []

        let sentWhileDetached = try client.whisper("room:general", data: ["text": "hi"])

        XCTAssertFalse(sentWhileDetached, "with no socket attached nothing is sent, and nothing is queued")

        let leave = client.whisperSubscribe("room:general") { _ in }

        client.attachSocket { sent.append($0) }

        XCTAssertTrue(try client.whisper("room:general", data: ["text": "hi"]))

        leave()

        // Whole-array comparison: an index into a short array would trap instead of failing.
        let expected: [Any] = [
            frames["connect"] as Any,
            frames["whisper-subscribe"] as Any,
            frames["whisper-send"] as Any,
            frames["whisper-unsubscribe"] as Any,
        ]

        XCTAssertEqual(frameTypes(sent), ["connect", "whisper_subscribe", "whisper", "whisper_unsubscribe"])
        XCTAssertEqual(canonical(sent), canonical(expected))

        // Leaving the last listener forgets the topic: a reattach joins nothing.
        client.detachSocket()

        var reattached: [[String: Any]] = []

        client.attachSocket { reattached.append($0) }

        XCTAssertEqual(frameTypes(reattached), ["connect"])

        for testCase in serverFrames {
            let name = testCase["name"] as? String ?? "?"
            let receiver = LunoraClient(url: "https://app.example")
            var received: [Any] = []

            _ = receiver.whisperSubscribe("room:general") { received.append($0) }
            receiver.handleFrame(frameText(testCase["frame"]))

            let delivered = (testCase["delivered"] as? [[String: Any]] ?? [])
                .filter { $0["topic"] as? String == "room:general" }
                .map { $0["value"] }

            XCTAssertEqual(canonical(received), canonical(delivered), name)
        }
    }

    func testClosedRoomRefusesSends() throws {
        let client = LunoraClient(url: "https://app.example")
        client.clientID = "client-test"

        var sent: [[String: Any]] = []

        client.attachSocket { sent.append($0) }

        let room = client.connectRoom("general") { _ in }
        _ = client.whisperSubscribe("room:general") { _ in }
        room.close()

        XCTAssertFalse(try room.send("after close"), "a closed room must report its send as not sent")
        XCTAssertFalse(sent.contains { $0["type"] as? String == "whisper" }, "and must write no whisper frame")
    }

    func testAWhisperWithoutDataIsDropped() throws {
        let client = LunoraClient(url: "https://app.example")
        var delivered: [Any] = []

        _ = client.whisperSubscribe("room:general") { delivered.append($0) }
        client.handleFrame(#"{"type":"whisper","topic":"room:general"}"#)

        XCTAssertTrue(delivered.isEmpty, "a whisper with no data key must not reach a listener as null")
    }

    func testWhisperTopicsRejoinAfterReconnect() throws {
        let block = try XCTUnwrap(fixture("ws-frames.json")["whisperFrames"] as? [String: Any])
        let rejoin = try XCTUnwrap(block["rejoinOnReconnect"] as? [String])

        let client = LunoraClient(url: "https://app.example")
        client.clientID = "client-test"

        // Joined while no socket is attached: the join goes out on the next attach, not before.
        _ = client.connectRoom("general") { _ in }

        var first: [[String: Any]] = []

        client.attachSocket { first.append($0) }
        client.detachSocket()

        var second: [[String: Any]] = []

        client.attachSocket { second.append($0) }

        let expectedTypes = ["connect"] + rejoin.map { _ in "whisper_subscribe" }

        for sent in [first, second] {
            XCTAssertEqual(frameTypes(sent), expectedTypes)
            XCTAssertEqual(sent.dropFirst().compactMap { $0["topic"] as? String }, rejoin)
        }
    }
}
