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
var reply = #"{"result":{"ok":true}}"#

let client = LunoraClient(url: "https://app.example") { _, _, body in
    captured = body

    return (200, Data(reply.utf8))
}
let api = API(client: client)

_ = try api.messages.list(MessagesListArgs(channelID: "chan_1", limit: nil))

guard let body = captured else {
    fatalError("the poster was never called")
}

let parsed = try JSONSerialization.jsonObject(with: body)
let got = Wire.stableStringify(parsed)
let want = #"{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}"#

guard got == want else {
    fatalError("generated call produced \(got), want \(want)")
}

// A typed result is re-read into its model through `Wire.stableStringify` and
// `JSONDecoder`, and this is the only place that generated call site runs.
// `extra-methods.json` adds the method; the shared fixture has no typed result.
reply = #"{"result":{"total":3}}"#

let summary = try api.stats.summary()

guard summary.total == 3 else {
    fatalError("typed result decoded total \(summary.total), want 3")
}

// Two keys differing only by a lone surrogate are one Swift `String`, so the
// transport hands this result back as a `[WireKey: Any]`.
// `JSONSerialization.data(withJSONObject:)` crashed the process on that, past
// any `catch`. A model cannot hold a lone surrogate and `JSONDecoder` refuses the
// escape, so the documented outcome is a DecodingError the caller can catch.
reply = #"{"result":{"total":3,"\ud800":1,"\ud801":2}}"#

guard try client.query("stats:summary", args: nil, shardKey: nil) is [WireKey: Any] else {
    fatalError("the reply no longer decodes to [WireKey: Any], so this no longer exercises that path")
}

expectDecodingError("a result with lone-surrogate keys")

// A result the model cannot hold is the same thrown DecodingError.
reply = #"{"result":{"total":"three"}}"#
expectDecodingError("a result whose total is not a number")

func expectDecodingError(_ what: String) {
    do {
        _ = try api.stats.summary()
        fatalError("\(what) decoded into the model")
    } catch is DecodingError {
        // The documented failure.
    } catch {
        fatalError("\(what) threw \(error), want a DecodingError")
    }
}

print("OK — the generated surface reaches the wire and decodes its typed result")
