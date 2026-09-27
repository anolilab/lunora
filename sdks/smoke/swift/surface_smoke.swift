// Calls every function of the `sdk-surface` spec through a generated SDK.
//
// `generated_smoke.swift` proves a call reaches the wire and one typed result
// decodes. This proves the surface handles every SHAPE a model backend renders
// differently: a no-arg function, id / number / array / record / null results,
// a nullable object, an array of objects, a union, an unset optional, bigint
// arguments and results (top level and nested), and keyword-named functions.
// It also only COMPILES if two functions sharing a non-struct result shape do
// not redeclare quicktype's per-shape helpers, and if a nullable-object result
// names no type that exists only in a comment.
//
// Run by `sdks/generated-check.sh swift` from a consumer package outside this
// repo, which copies it in as that package's `main.swift`.

import Foundation
import Lunora
import LunoraApi

let bigFive = #"["$lunora.wire$","bigint","5"]"#

var frames: [String] = []
var reply = "null"

let client = LunoraClient(url: "https://app.example") { _, _, body in
    // Canonicalised with sorted keys, NOT `Wire.stableStringify`: the body is
    // already wire-encoded, and the key function would escape its tagged arrays
    // a second time.
    let parsed = try JSONSerialization.jsonObject(with: body)
    let canonical = try JSONSerialization.data(withJSONObject: parsed, options: [.sortedKeys, .withoutEscapingSlashes])
    frames.append(String(decoding: canonical, as: UTF8.self))
    return (200, Data(#"{"result":\#(reply)}"#.utf8))
}

func expect(_ what: String, _ got: String, _ want: String) {
    guard got == want else {
        fatalError("\(what): got \(got), want \(want)")
    }
}

let api = API(client: client)
let items = api.items

reply = "2"
expect("count", "\(try items.count([:]))", "2.0")
reply = #"{"size":2,"title":"t"}"#
let summary = try items.summary([:])
expect("summary", "\(summary.size) \(summary.title)", "2.0 t")
reply = #"{"title":"t","value":"x"}"#
let detail = try items.detail([:])
guard detail.title == "t", case .string("x") = detail.value else {
    fatalError("detail decoded to \(detail)")
}
reply = #""items_1""#
expect("create", try items.create(ItemsCreateArgs(note: nil, title: "t")), "items_1")
reply = "null"
expect("clear", "\(String(describing: try items.clear([:])))", "nil")
reply = #"["a"]"#
expect("tags", "\(try items.tags([:]))", #"["a"]"#)
reply = #"["b"]"#
expect("labels", "\(try items.labels([:]))", #"["b"]"#)
reply = #"{"a":1}"#
expect("stats", "\(try items.stats([:]))", #"["a": 1.0]"#)
reply = #"{"b":2}"#
expect("totals", "\(try items.totals([:]))", #"["b": 2.0]"#)
reply = "null"
expect("find", Wire.stableStringify(try items.find(ItemsFindArgs(id: "items_1"))), "null")
reply = #"[{"kind":"a","title":"t"}]"#
let page = try items.page([:])
expect("page", "\(page.count) \(page[0].kind) \(page[0].title)", "1 a t")
reply = #""x""#
guard case .string("x") = try items.pick(ItemsPickArgs(choice: Choice(a: 1, kind: .x, b: nil))) else {
    fatalError("pick did not decode to .string(\"x\")")
}
reply = "1"
expect("match", "\(try items.match(ItemsMatchArgs(pattern: "p")))", "1.0")
expect("type", "\(try items.type([:]))", "1.0")
expect("self", "\(try items.`self`([:]))", "1.0")

let five = WireBigInt("5")
reply = bigFive
guard let charged = try api.ledger.charge(["amount": five]) as? WireBigInt, charged == five else {
    fatalError("charge did not decode to a WireBigInt 5")
}
reply = #"{"rows":[{"amount":\#(bigFive)}],"total":\#(bigFive)}"#
let balances = try api.ledger.balances(["accounts": [["id": "acc", "limit": five]]])
guard let tree = balances as? [String: Any], tree["total"] as? WireBigInt == five,
    let rows = tree["rows"] as? [[String: Any]], rows.first?["amount"] as? WireBigInt == five
else {
    fatalError("balances decoded to \(balances)")
}

let want = [
    #"{"args":{},"functionPath":"items:count"}"#,
    #"{"args":{},"functionPath":"items:summary"}"#,
    #"{"args":{},"functionPath":"items:detail"}"#,
    #"{"args":{"title":"t"},"functionPath":"items:create"}"#,
    #"{"args":{},"functionPath":"items:clear"}"#,
    #"{"args":{},"functionPath":"items:tags"}"#,
    #"{"args":{},"functionPath":"items:labels"}"#,
    #"{"args":{},"functionPath":"items:stats"}"#,
    #"{"args":{},"functionPath":"items:totals"}"#,
    #"{"args":{"id":"items_1"},"functionPath":"items:find"}"#,
    #"{"args":{},"functionPath":"items:page"}"#,
    #"{"args":{"choice":{"a":1,"kind":"x"}},"functionPath":"items:pick"}"#,
    #"{"args":{"pattern":"p"},"functionPath":"items:match"}"#,
    #"{"args":{},"functionPath":"items:type"}"#,
    #"{"args":{},"functionPath":"items:self"}"#,
    #"{"args":{"amount":\#(bigFive)},"functionPath":"ledger:charge"}"#,
    #"{"args":{"accounts":[{"id":"acc","limit":\#(bigFive)}]},"functionPath":"ledger:balances"}"#,
]

expect("frame count", "\(frames.count)", "\(want.count)")

for (index, (got, wanted)) in zip(frames, want).enumerated() {
    expect("frame \(index)", got, wanted)
}

print("OK — every sdk-surface shape reaches the wire and decodes")
