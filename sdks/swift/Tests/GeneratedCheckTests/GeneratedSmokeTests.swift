import Foundation
import Lunora
import XCTest

@testable import GeneratedCheck

/// Runs a generated call, rather than only compiling one.
///
/// `swift build` proves the shapes line up. It does not prove a call reaches the
/// wire: Java shipped a surface that compiled and threw on the first invocation,
/// and Ruby one whose every method raised NoMethodError, both with the
/// compile-or-parse gate green.
final class GeneratedSmokeTests: XCTestCase {
    func testGeneratedCallReachesTheWire() throws {
        var captured: Data?

        let client = LunoraClient(url: "https://app.example") { _, _, body in
            captured = body

            return (200, Data(#"{"result":{"ok":true}}"#.utf8))
        }

        _ = try API(client: client).messages.list(MessagesListArgs(channelID: "chan_1", limit: nil))

        let body = try XCTUnwrap(captured, "the poster was never called")
        let parsed = try JSONSerialization.jsonObject(with: body)

        XCTAssertEqual(
            Wire.stableStringify(parsed),
            #"{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}"#
        )
    }
}
