// Runs a generated call, rather than only compiling one.
//
// `swift build` proves the shapes line up. It does not prove a call reaches the
// wire: Java shipped a surface that compiled and threw on the first invocation,
// and Ruby one whose every method raised NoMethodError, both with the
// compile-or-parse gate green.
//
// An executable rather than an XCTest case, because `sdks/generated-check.sh
// swift` builds it as a throwaway consumer PACKAGE that depends on the generated
// one by path — `.package(path: "../sdk")` — which is exactly what a consumer
// writes. A test target inside the generated package would instead need that
// package's own manifest to declare it, and the generated manifest deliberately
// declares only the two library targets it ships.
//
// `import LunoraApi` is the generated module and `import Lunora` the transport
// vendored beside it. Neither resolves through this repo.

import Foundation
import Lunora
import LunoraApi

var captured: Data?

let client = LunoraClient(url: "https://app.example") { _, _, body in
    captured = body

    return (200, Data(#"{"result":{"ok":true}}"#.utf8))
}

_ = try API(client: client).messages.list(MessagesListArgs(channelID: "chan_1", limit: nil))

guard let body = captured else {
    fatalError("the poster was never called")
}

let parsed = try JSONSerialization.jsonObject(with: body)
let got = Wire.stableStringify(parsed)
let want = #"{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}"#

guard got == want else {
    fatalError("generated call produced \(got), want \(want)")
}

print("OK — the generated surface reaches the wire")
