import Foundation
import XCTest

@testable import Lunora

/// A watch's subscription is released by `cancel()`, not by leaving the loop: a retained
/// `AsyncStream` keeps running after a `break`, so cancellation has to be explicit.
final class WatchCancelTests: XCTestCase {
    /// Frames are captured synchronously by the socket sender, so a plain class box is enough.
    private final class FrameBox {
        var frames: [[String: Any]] = []
    }

    func testCancelUnsubscribesAndEndsTheSequence() async throws {
        let box = FrameBox()
        let client = LunoraClient(url: "https://app.example")

        client.attachSocket { box.frames.append($0) }

        let watch = client.watch("messages:list", args: ["channel": "general"])

        let subscribe = try XCTUnwrap(box.frames.first { $0["type"] as? String == "subscribe" })
        let id = try XCTUnwrap(subscribe["id"] as? String)

        client.handleFrame(#"{"cursor":1,"data":{"n":1},"id":"\#(id)","type":"data"}"#)

        var iterator = watch.makeAsyncIterator()

        guard case .value? = await iterator.next() else {
            return XCTFail("the first data frame must be yielded before cancelling")
        }

        watch.cancel()

        let after = await iterator.next()

        XCTAssertNil(after, "cancel ends the sequence rather than yielding again")

        let unsubscribes = box.frames.filter { $0["type"] as? String == "unsubscribe" }

        XCTAssertEqual(unsubscribes.count, 1, "cancel sends exactly one unsubscribe")
        XCTAssertEqual(unsubscribes.first?["id"] as? String, id, "for the watch's own subscription")
    }

    func testCancelTwiceUnsubscribesOnce() throws {
        let box = FrameBox()
        let client = LunoraClient(url: "https://app.example")

        client.attachSocket { box.frames.append($0) }

        let watch = client.watch("messages:list", args: nil)

        watch.cancel()
        watch.cancel()

        let unsubscribes = box.frames.filter { $0["type"] as? String == "unsubscribe" }

        XCTAssertEqual(unsubscribes.count, 1, "a second cancel must not send a second unsubscribe")
    }
}
