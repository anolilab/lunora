import Foundation
import XCTest

@testable import Lunora

/// A reconnect re-sends its query subscriptions a few at a time, as the reference client does.
///
/// `RESUBSCRIBE_CONCURRENCY` in `packages/client/src/client-tuning.ts` is the width: a re-sent
/// `subscribe` holds a slot until any frame bearing its id arrives, it is unsubscribed, or
/// `LunoraClient.resubscribeAckTimeout` passes with no reply.
final class ResubscribePacingTests: XCTestCase {
    private static let subscriptionCount = 7

    /// Frames the socket carried, in order.
    private final class Recorder {
        var frames: [[String: Any]] = []

        var subscribes: [String] {
            frames.filter { $0["type"] as? String == "subscribe" }.compactMap { $0["id"] as? String }
        }
    }

    private func ack(_ id: String) -> String {
        "{\"id\":\"\(id)\",\"type\":\"ack\"}"
    }

    @discardableResult
    private func subscribe(_ client: LunoraClient, _ index: Int) -> LunoraUnsubscribe {
        client.subscribe("messages:list", args: ["channel": "c\(index)"], onData: nil, onError: { _ in })
    }

    /// A client holding `count` query subscriptions, re-attached to `recorder` and resent.
    private func reconnected(_ recorder: Recorder, count: Int = subscriptionCount) -> LunoraClient {
        let client = LunoraClient(url: "https://app.example")

        client.attachSocket { _ in }

        for index in 0..<count {
            subscribe(client, index)
        }

        client.attachSocket { recorder.frames.append($0) }
        recorder.frames.removeAll()
        client.resendSubscriptions()

        return client
    }

    func testOnlyTheWindowGoesOutUntilAReplyArrives() {
        XCTAssertEqual(LunoraClient.resubscribeConcurrency, 3, "the reference client's width")

        let recorder = Recorder()
        _ = reconnected(recorder)

        XCTAssertEqual(recorder.subscribes.count, LunoraClient.resubscribeConcurrency)
    }

    func testAnyFrameBearingTheIdLetsTheNextOneOut() {
        let recorder = Recorder()
        let client = reconnected(recorder)
        let window = recorder.subscribes

        client.handleFrame(ack(window[0]))
        XCTAssertEqual(recorder.subscribes.count, 4, "an ack frees its slot")

        client.handleFrame("{\"cursor\":1,\"data\":[],\"id\":\"\(window[1])\",\"type\":\"data\"}")
        XCTAssertEqual(recorder.subscribes.count, 5, "a data frame that overtakes the ack frees it too")

        client.handleFrame(
            "{\"error\":{\"code\":\"FORBIDDEN\",\"message\":\"no\"},\"id\":\"\(window[2])\",\"type\":\"error\"}"
        )
        XCTAssertEqual(recorder.subscribes.count, 6, "so does the error that refuses it")

        client.handleFrame(ack(window[0]))
        XCTAssertEqual(recorder.subscribes.count, 6, "a second frame for a released id frees nothing")
    }

    func testEverySubscriptionGoesOutExactlyOnce() {
        let recorder = Recorder()
        let client = reconnected(recorder)
        var answered = 0

        while answered < recorder.subscribes.count {
            client.handleFrame(ack(recorder.subscribes[answered]))
            answered += 1
        }

        XCTAssertEqual(recorder.subscribes.count, Self.subscriptionCount)
        XCTAssertEqual(Set(recorder.subscribes).count, Self.subscriptionCount)
    }

    func testAnUnsubscribeSkipsAQueuedOneAndFreesAnOutstandingOne() {
        let client = LunoraClient(url: "https://app.example")

        client.attachSocket { _ in }

        let unsubscribes = (0..<5).map { subscribe(client, $0) }
        let recorder = Recorder()

        client.attachSocket { recorder.frames.append($0) }
        recorder.frames.removeAll()
        client.resendSubscriptions()

        let outstanding = recorder.subscribes

        XCTAssertEqual(outstanding, ["sub_1", "sub_2", "sub_3"], "the window goes out in subscribe order")

        unsubscribes[4]()
        XCTAssertEqual(recorder.subscribes.count, 3, "a queued one is dropped, and frees no slot")

        unsubscribes[0]()
        XCTAssertEqual(recorder.subscribes.count, 4, "an outstanding one will never be answered, so its slot goes on")
        XCTAssertFalse(recorder.subscribes.contains("sub_5"))

        client.handleFrame(ack(outstanding[1]))
        XCTAssertEqual(recorder.subscribes.count, 4, "nothing is left to send")
    }

    func testAnUnansweredOneStopsHoldingItsSlotAfterTheTimeout() throws {
        let recorder = Recorder()
        let before = ProcessInfo.processInfo.systemUptime
        let client = reconnected(recorder)
        let after = ProcessInfo.processInfo.systemUptime

        let deadline = try XCTUnwrap(client.nextSubscriptionRetryAt)

        XCTAssertGreaterThanOrEqual(deadline, before + LunoraClient.resubscribeAckTimeout)
        XCTAssertLessThanOrEqual(deadline, after + LunoraClient.resubscribeAckTimeout)

        XCTAssertEqual(client.retryDueSubscriptions(now: deadline - 0.001), 0)
        XCTAssertEqual(recorder.subscribes.count, 3)

        XCTAssertEqual(client.retryDueSubscriptions(now: deadline), LunoraClient.resubscribeConcurrency)
        XCTAssertEqual(recorder.subscribes.count, 6)
    }

    func testAReconnectMidDrainStartsAFreshWindow() {
        let recorder = Recorder()
        let client = reconnected(recorder)

        client.detachSocket()
        XCTAssertNil(client.nextSubscriptionRetryAt, "a dropped socket's slots are gone")

        let resent = Recorder()

        client.attachSocket { resent.frames.append($0) }
        resent.frames.removeAll()
        client.resendSubscriptions()

        XCTAssertEqual(resent.subscribes.count, LunoraClient.resubscribeConcurrency)

        client.handleFrame(ack(recorder.subscribes[0]))
        XCTAssertEqual(resent.subscribes.count, 4)
    }

    func testAQueuedOneCarriesTheCursorItHasWhenItGoesOut() throws {
        let client = LunoraClient(url: "https://app.example")

        client.identity = "alice"
        client.attachSocket { _ in }

        for index in 0..<4 {
            subscribe(client, index)
            client.handleFrame("{\"cursor\":9,\"data\":[],\"id\":\"sub_\(index + 1)\",\"type\":\"data\"}")
        }

        let recorder = Recorder()

        client.attachSocket { recorder.frames.append($0) }
        recorder.frames.removeAll()
        client.resendSubscriptions()
        client.identity = "bob"
        client.handleFrame(ack("sub_1"))

        let late = try XCTUnwrap(recorder.frames.first { $0["id"] as? String == "sub_4" })
        let query = try XCTUnwrap(late["query"] as? [String: Any])

        XCTAssertNil(query["sinceSeq"], "the new identity must not resume the old one's position")
    }

    func testARetryAcrossASocketSwapLeavesTheNewQueueAlone() {
        let client = LunoraClient(url: "https://app.example")

        client.attachSocket { _ in }

        for index in 0..<5 {
            subscribe(client, index)
        }

        let old = Recorder()
        let fresh = Recorder()
        var swapped = false

        // The socket is replaced while the retry's own frame is being written to the old one.
        client.attachSocket { frame in
            old.frames.append(frame)

            if frame["id"] as? String == "sub_5", !swapped {
                swapped = true
                client.detachSocket()
                client.attachSocket { fresh.frames.append($0) }
                client.resendSubscriptions()
            }
        }
        client.resendSubscriptions()
        client.handleFrame(
            "{\"error\":{\"code\":\"OVERLOADED\",\"message\":\"busy\",\"retryAfterMs\":0},\"id\":\"sub_5\",\"type\":\"error\"}"
        )

        client.retryDueSubscriptions(now: ProcessInfo.processInfo.systemUptime + 2 * LunoraClient.resubscribeAckTimeout)

        XCTAssertTrue(swapped, "the retry must have reached the old socket")
        XCTAssertFalse(old.subscribes.contains("sub_4"), "the new socket's queue must not drain onto the old one, got \(old.subscribes)")
        XCTAssertTrue(fresh.subscribes.contains("sub_1"), "the new socket keeps its own window")
    }

    func testShapeSubscriptionsAreNotPaced() {
        let client = LunoraClient(url: "https://app.example")

        client.attachSocket { _ in }

        for index in 0..<5 {
            _ = client.subscribeShape("roomMessages", args: ["room": "r\(index)"], onRows: nil)
        }

        let recorder = Recorder()

        client.attachSocket { recorder.frames.append($0) }
        recorder.frames.removeAll()
        client.resendSubscriptions()

        XCTAssertEqual(recorder.frames.filter { $0["type"] as? String == "shape_subscribe" }.count, 5)
    }
}
