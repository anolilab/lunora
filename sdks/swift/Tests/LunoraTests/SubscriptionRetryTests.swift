import Foundation
import XCTest

@testable import Lunora

/// A subscription error's `retryAfterMs` schedules exactly one cold re-subscribe, which the caller
/// fires through `retryDueSubscriptions(now:)`. Checked against the `subscriptionRetry` golden in
/// `protocol/fixtures/ws-frames.json`.
final class SubscriptionRetryTests: XCTestCase {
    /// Frames and errors the client's callbacks deliver, in arrival order.
    private final class Recorder {
        var frames: [[String: Any]] = []
        var errors: [LunoraSubscriptionError] = []
    }

    private func fixturesDirectory() throws -> URL {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()

        for _ in 0..<8 {
            let candidate = directory.appendingPathComponent("protocol/fixtures")

            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }

            let parent = directory.deletingLastPathComponent()

            if parent.path == directory.path { break }

            directory = parent
        }

        throw FixturesUnreachable()
    }

    private func retryGolden() throws -> [String: Any] {
        let url = try fixturesDirectory().appendingPathComponent("ws-frames.json")
        let data = try Data(contentsOf: url)
        let document = try XCTUnwrap(LunoraJSON.parse(data) as? [String: Any])

        return try XCTUnwrap(document["subscriptionRetry"] as? [String: Any])
    }

    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }

    private func canonical(_ value: Any?) -> String { Wire.stableStringify(value) }

    /// A client with `sub_1` subscribed on an open socket, holding the golden seed frame and
    /// nothing else. The socket's frames are recorded from the first open onward.
    private func openSubscribed(_ retry: [String: Any], _ recorder: Recorder) throws -> LunoraClient {
        let client = LunoraClient(url: "https://app.example")

        client.attachSocket { recorder.frames.append($0) }
        _ = client.subscribe(
            "messages:list",
            args: ["channel": "general"],
            onData: nil,
            onError: { recorder.errors.append($0) }
        )
        _ = client.handleFrame(try json(try XCTUnwrap(retry["seedFrame"])))
        recorder.frames.removeAll()

        return client
    }

    /// `openSubscribed`, then the golden hint: returns the client with one retry pending.
    private func hinted(_ retry: [String: Any], _ recorder: Recorder) throws -> LunoraClient {
        let client = try openSubscribed(retry, recorder)

        _ = client.handleFrame(try json(try XCTUnwrap(retry["hintFrame"])))

        XCTAssertNotNil(client.nextSubscriptionRetryAt, "the golden hint must schedule a retry")

        return client
    }

    func testHintSchedulesOneColdResubscribeAtTheHint() throws {
        let retry = try retryGolden()
        let recorder = Recorder()
        let client = try openSubscribed(retry, recorder)

        let t0 = ProcessInfo.processInfo.systemUptime
        _ = client.handleFrame(try json(try XCTUnwrap(retry["hintFrame"])))
        let t1 = ProcessInfo.processInfo.systemUptime

        let due = try XCTUnwrap(client.nextSubscriptionRetryAt)

        XCTAssertGreaterThanOrEqual(due, t0 + 5, "the retry must not be due before retryAfterMs")
        XCTAssertLessThanOrEqual(due, t1 + 5, "the retry must be due by retryAfterMs after the hint")

        XCTAssertEqual(client.retryDueSubscriptions(now: due - 0.001), 0)
        XCTAssertTrue(recorder.frames.isEmpty, "nothing may be sent before the retry is due")

        XCTAssertEqual(client.retryDueSubscriptions(now: due), 1)
        XCTAssertEqual(recorder.frames.count, 1)
        XCTAssertEqual(
            canonical(recorder.frames.first),
            canonical(retry["retryFrame"]),
            "the retry frame must be the cold subscribe golden, with no resume cursor"
        )

        XCTAssertEqual(client.retryDueSubscriptions(now: due + 60), 0, "a fired retry must not fire again")
        XCTAssertNil(client.nextSubscriptionRetryAt)
    }

    func testHintLeavesErrorCallbackAsBefore() throws {
        let retry = try retryGolden()
        let recorder = Recorder()
        let client = try openSubscribed(retry, recorder)

        _ = client.handleFrame(try json(try XCTUnwrap(retry["hintFrame"])))

        XCTAssertEqual(recorder.errors.count, 1, "the error callback must still fire once for a hinted error")
        XCTAssertEqual(recorder.errors.first?.code, "SUBSCRIPTION_REFRESH_FAILED")
    }

    func testLaterHintReplacesPendingRetry() throws {
        let retry = try retryGolden()
        let recorder = Recorder()
        let client = try hinted(retry, recorder)

        let first = try XCTUnwrap(client.nextSubscriptionRetryAt)

        _ = client.handleFrame(try json(try XCTUnwrap(retry["laterHintFrame"])))

        let second = try XCTUnwrap(client.nextSubscriptionRetryAt)

        XCTAssertGreaterThan(second, first, "a later hint must push the pending retry later")
        XCTAssertEqual(client.retryDueSubscriptions(now: first), 0, "the replaced retry must not fire at its old deadline")
        XCTAssertTrue(recorder.frames.isEmpty)
        XCTAssertEqual(client.retryDueSubscriptions(now: second), 1, "the replacing retry must fire at its new deadline")
    }

    func testAnsweringFramesCancelRetry() throws {
        let retry = try retryGolden()

        for entry in try XCTUnwrap(retry["cancelFrames"] as? [[String: Any]]) {
            let recorder = Recorder()
            let client = try hinted(retry, recorder)

            _ = client.handleFrame(try json(try XCTUnwrap(entry["frame"])))

            let name = entry["name"] as? String ?? "?"

            XCTAssertNil(client.nextSubscriptionRetryAt, "a \(name) frame must cancel the pending retry")
            XCTAssertEqual(
                client.retryDueSubscriptions(now: ProcessInfo.processInfo.systemUptime + 60), 0,
                "a cancelled retry must never send, even far past its deadline"
            )
            XCTAssertTrue(recorder.frames.isEmpty)
        }
    }

    func testFramesWithoutAValidHintScheduleNothing() throws {
        let retry = try retryGolden()

        for entry in try XCTUnwrap(retry["noRetryFrames"] as? [[String: Any]]) {
            let recorder = Recorder()
            let client = try openSubscribed(retry, recorder)

            _ = client.handleFrame(try json(try XCTUnwrap(entry["frame"])))

            let name = entry["name"] as? String ?? "?"

            XCTAssertNil(client.nextSubscriptionRetryAt, "a \(name) error must schedule no retry")
        }
    }

    func testUnsubscribeSocketChangesAndCloseCancelRetry() throws {
        let retry = try retryGolden()

        let unsubscribing = LunoraClient(url: "https://app.example")
        let unsubscribingRecorder = Recorder()

        unsubscribing.attachSocket { unsubscribingRecorder.frames.append($0) }

        let unsubscribe = unsubscribing.subscribe(
            "messages:list",
            args: ["channel": "general"],
            onData: nil,
            onError: nil
        )

        _ = unsubscribing.handleFrame(try json(try XCTUnwrap(retry["seedFrame"])))
        _ = unsubscribing.handleFrame(try json(try XCTUnwrap(retry["hintFrame"])))
        unsubscribe()

        XCTAssertNil(unsubscribing.nextSubscriptionRetryAt, "an unsubscribe must cancel the pending retry")

        let detached = try hinted(retry, Recorder())

        detached.detachSocket()

        XCTAssertNil(detached.nextSubscriptionRetryAt, "a socket detach must cancel the pending retry")

        let reattached = try hinted(retry, Recorder())

        reattached.attachSocket { _ in }

        XCTAssertNil(reattached.nextSubscriptionRetryAt, "a socket attach must cancel the pending retry")

        let closed = try hinted(retry, Recorder())

        closed.close()

        XCTAssertNil(closed.nextSubscriptionRetryAt, "closing the client must cancel the pending retry")
    }

    func testShapeErrorSchedulesNothing() throws {
        let client = LunoraClient(url: "https://app.example")

        client.attachSocket { _ in }
        _ = client.subscribeShape("messages:list", args: ["channel": "general"], onRows: nil, onError: nil)

        _ = client.handleFrame(
            try json(
                [
                    "id": "shape_1",
                    "type": "error",
                    "error": [
                        "code": "SUBSCRIPTION_REFRESH_FAILED",
                        "message": "refresh failed",
                        "retryAfterMs": 5000,
                    ],
                ] as [String: Any])
        )

        XCTAssertNil(client.nextSubscriptionRetryAt, "a shape error must not schedule a query re-subscribe")
    }

    func testHintIsClampedToMaxRetryAfter() throws {
        let retry = try retryGolden()
        let recorder = Recorder()
        let client = try openSubscribed(retry, recorder)

        let t0 = ProcessInfo.processInfo.systemUptime

        _ = client.handleFrame(
            try json(
                [
                    "id": "sub_1",
                    "type": "error",
                    "error": [
                        "code": "SUBSCRIPTION_REFRESH_FAILED",
                        "message": "refresh failed",
                        "retryAfterMs": 3_600_000,
                    ],
                ] as [String: Any])
        )

        let t1 = ProcessInfo.processInfo.systemUptime
        let due = try XCTUnwrap(client.nextSubscriptionRetryAt)

        XCTAssertGreaterThanOrEqual(due, t0 + 60, "a hint above the 60000ms cap must wait the cap")
        XCTAssertLessThanOrEqual(due, t1 + 60, "a hint above the 60000ms cap must not wait longer than it")
    }

    func testUnsubscribeThatOvertakesRetryIsFollowedByAnother() throws {
        let retry = try retryGolden()
        let recorder = Recorder()
        let client = LunoraClient(url: "https://app.example")
        var unsubscribe: LunoraUnsubscribe?
        var armed = false

        client.attachSocket { frame in
            // Another thread unsubscribes after the retry was selected but before its frame is written.
            if armed, frame["type"] as? String == "subscribe" {
                armed = false
                unsubscribe?()
            }
            recorder.frames.append(frame)
        }
        unsubscribe = client.subscribe("messages:list", args: ["channel": "general"], onData: nil)
        _ = client.handleFrame(try json(try XCTUnwrap(retry["seedFrame"])))
        _ = client.handleFrame(try json(try XCTUnwrap(retry["hintFrame"])))
        let due = try XCTUnwrap(client.nextSubscriptionRetryAt)
        recorder.frames.removeAll()
        armed = true

        client.retryDueSubscriptions(now: due)

        XCTAssertEqual(recorder.frames.map { $0["type"] as? String }, ["unsubscribe", "subscribe", "unsubscribe"])
    }
}
