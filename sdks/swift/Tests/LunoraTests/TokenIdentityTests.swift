import Foundation
import XCTest

@testable import Lunora

/// `offline_unset_identity_stamps_token_digest`: dispatched from the manifest
/// driver in `ConformanceTests.swift`, its only entry point.
extension ConformanceTests {
    func caseOfflineUnsetIdentityStampsTokenDigest() throws {
        let queue = try XCTUnwrap(fixture("offline-optimistic.json")["offlineQueue"] as? [String: Any])
        let block = try XCTUnwrap(queue["tokenIdentity"] as? [String: Any])
        let code = try XCTUnwrap((queue["identityGate"] as? [String: Any])?["code"] as? String)
        let digests = try XCTUnwrap(block["digests"] as? [[String: Any]])

        XCTAssertGreaterThan(digests.count, 5, "the fixture carries the full vector set")

        for spec in digests {
            let token = try XCTUnwrap(spec["token"] as? String)

            XCTAssertEqual(lunoraTokenDigest(token), spec["digest"] as? String, "digest of a \(token.utf16.count)-unit token")
        }

        let accountSwitch = try XCTUnwrap(block["accountSwitch"] as? [String: Any])
        let queuedUnder = try XCTUnwrap(accountSwitch["queuedUnder"] as? String)
        let flushedUnder = try XCTUnwrap(accountSwitch["flushedUnder"] as? String)

        for (flushWith, sends) in [(flushedUnder, false), (queuedUnder, true)] {
            var headers: [String?] = []
            var codes: [String] = []
            let client = LunoraClient(
                url: "https://app.example",
                post: { _, sent, _ in
                    headers.append(sent["authorization"])

                    return (200, Data(#"{"result":null}"#.utf8))
                },
                authToken: queuedUnder
            )

            client.offlineQueue = LunoraOfflineQueue(queueBeforeFirstConnect: true)
            client.onMutationSettled { event in
                if let error = event.error as? LunoraAPIError { codes.append(error.code) }
            }
            _ = try client.submit(LunoraSubmitOptions(functionPath: "messages:send"))
            client.authToken = flushWith

            let report = client.flushOfflineQueue()

            if sends {
                XCTAssertEqual(headers, ["Bearer \(queuedUnder)"], "the same token replays the write")
                XCTAssertEqual(report.committed.count, 1)
            } else {
                XCTAssertEqual(headers, [], "user A's write is never sent with user B's bearer")
                XCTAssertEqual(report.rejected.count, 1)
                XCTAssertEqual(codes, [code])
            }
        }
    }
}

/// With no ``LunoraClient/identity`` set, a digest of the bearer token is who a
/// queued write belongs to. Every write goes through `submit` — the path that
/// stamps it — and every flush is the caller's own.
final class TokenIdentityTests: XCTestCase {
    private let helper = ConformanceTests()

    private func tokenIdentity() throws -> [String: Any] {
        let queue = try XCTUnwrap(helper.fixture("offline-optimistic.json")["offlineQueue"] as? [String: Any])

        return try XCTUnwrap(queue["tokenIdentity"] as? [String: Any])
    }

    /// The fixture's digest of `token`, so no vector is spelled out here.
    private func fixtureDigest(_ token: String) throws -> String {
        let digests = try XCTUnwrap(tokenIdentity()["digests"] as? [[String: Any]])

        return try XCTUnwrap(digests.first { $0["token"] as? String == token }?["digest"] as? String)
    }

    /// A client whose poster records every request's authorization header.
    private final class Recorder {
        var headers: [String?] = []
        var settled: [LunoraMutationSettled] = []
    }

    private func client(
        identity: String? = nil,
        token: String?,
        store: MemoryPersistence? = nil,
        reply: ((LunoraClient, [String: String], Data) -> (Int, Data))? = nil
    ) -> (LunoraClient, Recorder) {
        let recorder = Recorder()
        var owner: LunoraClient?
        let client = LunoraClient(
            url: "https://app.example",
            post: { _, headers, body in
                recorder.headers.append(headers["authorization"])

                if let reply, let owner { return reply(owner, headers, body) }

                return (200, Data(#"{"result":null}"#.utf8))
            },
            authToken: token
        )

        owner = client
        client.identity = identity
        client.offlineQueue = LunoraOfflineQueue(queueBeforeFirstConnect: true, persistence: store)
        client.onMutationSettled { recorder.settled.append($0) }

        return (client, recorder)
    }

    private func queueOne(_ client: LunoraClient) throws {
        XCTAssertEqual(try client.submit(LunoraSubmitOptions(functionPath: "messages:send")).status, .queued)
    }

    func testAWriteQueuedUnderOneTokenNeverTravelsWithAnother() throws {
        let (client, recorder) = client(token: "token-a")

        try queueOne(client)
        client.authToken = "token-b"

        let report = client.flushOfflineQueue()

        XCTAssertEqual(recorder.headers, [], "user A's write must not be sent with user B's bearer")
        XCTAssertEqual(report.rejected.count, 1)
        XCTAssertEqual((recorder.settled.first?.error as? LunoraAPIError)?.code, LunoraOfflineCode.identityChanged)
        XCTAssertEqual(client.pendingMutationCount, 0)
    }

    func testAWriteReplaysUnderTheTokenItWasQueuedWith() throws {
        let (client, recorder) = client(token: "token-a")

        try queueOne(client)

        let report = client.flushOfflineQueue()

        XCTAssertEqual(recorder.headers, ["Bearer token-a"])
        XCTAssertEqual(report.committed.count, 1)
    }

    func testAWriteQueuedWithNoTokenReplaysWithNone() throws {
        let (client, recorder) = client(token: nil)

        try queueOne(client)

        XCTAssertEqual(client.flushOfflineQueue().committed.count, 1)
        XCTAssertEqual(recorder.headers, [nil])
    }

    /// Nobody is signed in, so whose write it is cannot be told: held, neither
    /// sent nor dropped, until a token is back.
    func testAWriteIsHeldWhileNoTokenIsSet() throws {
        let store = MemoryPersistence()
        let (client, recorder) = client(token: "token-a", store: store)

        try queueOne(client)
        client.authToken = nil

        let report = client.flushOfflineQueue()

        XCTAssertEqual(recorder.headers, [], "nothing is sent")
        XCTAssertTrue(recorder.settled.isEmpty && report.rejected.isEmpty, "nothing settles")
        XCTAssertEqual(client.pendingMutationCount, 1, "the write is still queued")
        XCTAssertEqual(store.records.count, 1, "and still persisted")

        client.authToken = "token-a"
        XCTAssertEqual(client.flushOfflineQueue().committed.count, 1)
        XCTAssertEqual(recorder.headers, ["Bearer token-a"])
    }

    /// A token write is stamped as a token digest and an identity as itself, so
    /// neither can be taken for the other however the identity is spelled.
    func testAnIdentitySpelledLikeADigestNeverMatchesATokenStamp() throws {
        let digest = try fixtureDigest("token-a")

        let (first, firstPosts) = client(token: "token-a")

        try queueOne(first)
        first.identity = digest
        first.authToken = nil
        _ = first.flushOfflineQueue()
        XCTAssertEqual(firstPosts.headers, [], "a token write does not replay as an identity spelled like its digest")

        let (second, secondPosts) = client(identity: digest, token: nil)

        try queueOne(second)
        second.identity = nil
        second.authToken = "token-a"
        _ = second.flushOfflineQueue()
        XCTAssertEqual(secondPosts.headers, [], "an identity spelled like a digest does not replay as that token")
    }

    /// The typed stamp survives the JSON round trip every persistence adapter
    /// makes, and a restored write is judged against the token as before.
    func testATokenStampSurvivesPersistence() throws {
        let store = MemoryPersistence()
        let (client, _) = client(token: "token-a", store: store)

        try queueOne(client)

        let stamp = try XCTUnwrap(store.records.first?["identity"] as? [String: Any])

        XCTAssertEqual(stamp as? [String: String], ["tokenDigest": try fixtureDigest("token-a")])

        for (token, sends) in [("token-a", true), ("token-b", false)] {
            let (restored, recorder) = self.client(token: token, store: MemoryPersistence(records: store.records))

            _ = try restored.hydrateOfflineQueue()
            _ = restored.flushOfflineQueue()
            XCTAssertEqual(recorder.headers, sends ? ["Bearer token-a"] : [], "restored under \(token)")
        }
    }

    /// The gate judged the pass against token-a, so every request in that pass
    /// carries token-a: a later chunk must not go out with token-b.
    func testATokenSwappedMidFlushDoesNotCarryTheRestOfIt() throws {
        let (client, recorder) = client(token: "token-a") { owner, _, body in
            owner.authToken = "token-b"

            let calls = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["calls"] as? [[String: Any]] ?? []
            let results = calls.map { ["id": $0["id"] ?? 0, "body": ["commitCursor": 1, "result": NSNull()]] }

            return (200, try! JSONSerialization.data(withJSONObject: ["results": results]))
        }

        client.offlineQueue = LunoraOfflineQueue(maxItems: lunoraMaxBatchEntries + 1, queueBeforeFirstConnect: true)

        for _ in 0...lunoraMaxBatchEntries { try queueOne(client) }

        XCTAssertEqual(client.flushOfflineQueue().committed.count, lunoraMaxBatchEntries + 1)
        XCTAssertEqual(recorder.headers, ["Bearer token-a", "Bearer token-a"])
    }

    /// The halves of a 413 split belong to the same pass as the batch they split.
    func testASplitAfterATokenSwapKeepsThePassToken() throws {
        var first = true
        let (client, recorder) = client(token: "token-a") { owner, _, body in
            owner.authToken = "token-b"

            if first {
                first = false

                return (413, Data("too large".utf8))
            }

            let calls = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["calls"] as? [[String: Any]]

            if calls == nil { return (200, Data(#"{"result":null}"#.utf8)) }

            let results = calls!.map { ["id": $0["id"] ?? 0, "body": ["result": NSNull()]] }

            return (200, try! JSONSerialization.data(withJSONObject: ["results": results]))
        }

        for _ in 0..<4 { try queueOne(client) }

        XCTAssertEqual(client.flushOfflineQueue().committed.count, 4)
        XCTAssertEqual(recorder.headers, ["Bearer token-a", "Bearer token-a", "Bearer token-a"])
    }

    /// Before token digests a write queued with no identity was stamped signed
    /// out whatever token was held, so that stamp no longer says whose it is:
    /// under a token it is a mismatch. A record with no stamp still replays.
    func testLegacyStampsUnderAHeldToken() throws {
        let (client, recorder) = client(token: "token-b")
        let signedOut = LunoraQueuedMutation(id: "m1", functionPath: "messages:send", args: [String: Any]())

        signedOut.identity = .signedOut
        client.offlineQueue.enqueue(signedOut)

        XCTAssertEqual(client.flushOfflineQueue().rejected, ["m1"])
        XCTAssertEqual(recorder.headers, [])

        client.offlineQueue.enqueue(LunoraQueuedMutation(id: "m2", functionPath: "messages:send", args: [String: Any]()))

        XCTAssertEqual(client.flushOfflineQueue().committed, ["m2"])
        XCTAssertEqual(recorder.headers, ["Bearer token-b"])
    }

    /// With no identity the token's digest IS the identity, so a token change is
    /// a change of user for the session as it is for the queue. Only a change
    /// FROM a token evicts, as only a change from a set identity does.
    func testANewTokenWithoutAnIdentityEvictsThePreviousSession() throws {
        let frames = try helper.fixture("ws-frames.json")
        let block = try XCTUnwrap(frames["identityChange"] as? [String: Any])
        let shape = try XCTUnwrap(frames["shape"] as? [String: Any])
        let transitions: [(String?, String?, String?, Bool)] = [
            ("token-a", "token-b", nil, true),
            ("token-a", nil, nil, true),
            ("token-a", "token-a", nil, false),
            (nil, "token-a", nil, false),
            ("token-a", "token-b", "user-a", false),
        ]

        for (before, after, identity, evicts) in transitions {
            let name = "\(before ?? "nil") -> \(after ?? "nil"), identity \(identity ?? "nil")"
            let client = LunoraClient(url: "https://app.example", authToken: before)
            var told: [[Any]] = []

            client.identity = identity
            client.attachSocket { _ in }
            client.subscribe("messages:list", args: [String: Any](), onData: { _ in })
            client.handleFrame(helper.frameText(block["queryFrame"]))
            client.subscribeShape("roomMessages", args: ["room": "general"], onRows: { told.append($0) })

            for frame in try XCTUnwrap(shape["pokeSequence"] as? [Any]) {
                client.handleFrame(helper.frameText(frame))
            }

            told.removeAll()
            client.authToken = after

            var resent: [[String: Any]] = []

            client.attachSocket { resent.append($0) }
            client.resendSubscriptions()

            let query = try XCTUnwrap(resent.first { $0["type"] as? String == "subscribe" }?["query"] as? [String: Any])
            let shapeFrame = try XCTUnwrap(resent.first { $0["type"] as? String == "shape_subscribe" })

            XCTAssertEqual(query["sinceSeq"] == nil, evicts, name)
            XCTAssertEqual(shapeFrame["sinceCheckpoint"] == nil, evicts, name)
            XCTAssertEqual(told.count == 1 && told[0].isEmpty, evicts, "\(name): shape callbacks told []")
        }
    }

    func testTheReplayVerdicts() throws {
        let digest = try fixtureDigest("token-a")
        let tokenA = LunoraIdentity.token(digest: digest)
        let cases: [(LunoraIdentity, LunoraIdentity, String?, LunoraReplayVerdict)] = [
            (.subject("user-a"), .subject("user-a"), nil, .match),
            (.subject("user-a"), .subject("user-b"), nil, .mismatch),
            (.subject("user-a"), .signedOut, nil, .unknown),
            (.signedOut, .signedOut, nil, .match),
            (.signedOut, .subject("user-a"), nil, .mismatch),
            (.signedOut, .stamp(identity: nil, token: "token-b"), "token-b", .mismatch),
            (.absent, .subject("user-a"), nil, .match),
            (tokenA, .stamp(identity: nil, token: "token-a"), "token-a", .match),
            // Named by an identity since, the token held now still vouches for it.
            (tokenA, .subject("user-a"), "token-a", .match),
            (tokenA, .stamp(identity: nil, token: "token-b"), "token-b", .mismatch),
            (tokenA, .signedOut, nil, .unknown),
            // Neither can be taken for the other, however the identity is spelled.
            (tokenA, .subject(digest), nil, .mismatch),
            (.subject(digest), tokenA, "token-a", .mismatch),
        ]

        for (stamped, current, token, verdict) in cases {
            XCTAssertEqual(stamped.replayVerdict(current: current, token: token), verdict, "\(stamped) under \(current)")
        }

        XCTAssertEqual(LunoraIdentity.stamp(identity: nil, token: nil), .signedOut)
        XCTAssertEqual(LunoraIdentity.stamp(identity: "user-a", token: "token-a"), .subject("user-a"))
        XCTAssertEqual(LunoraIdentity.stamp(identity: nil, token: "token-a"), tokenA)
    }
}
