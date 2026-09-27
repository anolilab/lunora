// Calls every function of the `sdk-surface` spec through a generated SDK.
//
// GeneratedSmoke proves a call reaches the wire. This proves the surface handles
// every SHAPE a model backend renders differently: a no-arg function, id /
// number / array / record / null results, a nullable object, an array of
// objects, a union, an unset optional, bigint arguments and results (top level
// and nested), and keyword-named functions.
//
// Run by `sdks/generated-check.sh kotlin`, compiled together with the generated
// tree and nothing else.
package dev.lunora

import lunoraapi.Api
import lunoraapi.models.ItemsClearArgs
import lunoraapi.models.ItemsCountArgs
import lunoraapi.models.ItemsCreateArgs
import lunoraapi.models.ItemsFindArgs
import lunoraapi.models.ItemsLabelsArgs
import lunoraapi.models.ItemsMatchArgs
import lunoraapi.models.ItemsPageArgs
import lunoraapi.models.ItemsPickArgs
import lunoraapi.models.ItemsSelfArgs
import lunoraapi.models.ItemsStatsArgs
import lunoraapi.models.ItemsSummaryArgs
import lunoraapi.models.ItemsTagsArgs
import lunoraapi.models.ItemsTotalsArgs
import lunoraapi.models.ItemsTypeArgs
import java.math.BigInteger

private const val BIG_FIVE = """["${'$'}lunora.wire${'$'}","bigint","5"]"""

private fun obj(vararg fields: Pair<String, WireValue>) = WireValue.Obj(fields.toList())

private fun text(value: String) = WireValue.Text(value)

private fun expect(what: String, got: Any?, want: Any?) {
    if (got != want) throw AssertionError("$what: got $got, want $want")
}

fun main() {
    val frames = mutableListOf<String>()
    var reply = "null"
    val client =
        Client("https://app.example", post = { _, _, body ->
            frames += Key.stableStringify(Json.parse(String(body, Charsets.UTF_8)))
            HttpResponse(200, """{"result":$reply}""")
        })
    val api = Api(client)
    val items = api.items
    val five = WireValue.BigInt(BigInteger.valueOf(5))

    reply = "2"
    expect("count", items.count(ItemsCountArgs()), WireValue.Num(2.0))
    reply = """{"size":2,"title":"t"}"""
    val summary = items.summary(ItemsSummaryArgs())
    expect("summary", summary.size to summary.title, 2.0 to "t")
    reply = "\"items_1\""
    expect("create", items.create(ItemsCreateArgs(title = "t")), text("items_1"))
    reply = "null"
    expect("clear", items.clear(ItemsClearArgs()), WireValue.Null)
    reply = """["a"]"""
    expect("tags", items.tags(ItemsTagsArgs()), WireValue.Arr(listOf(text("a"))))
    reply = """["b"]"""
    expect("labels", items.labels(ItemsLabelsArgs()), WireValue.Arr(listOf(text("b"))))
    reply = """{"a":1}"""
    expect("stats", items.stats(ItemsStatsArgs()), obj("a" to WireValue.Num(1.0)))
    reply = """{"b":2}"""
    expect("totals", items.totals(ItemsTotalsArgs()), obj("b" to WireValue.Num(2.0)))
    reply = "null"
    expect("find", items.find(ItemsFindArgs(id = "items_1")), WireValue.Null)
    reply = """[{"kind":"a","title":"t"}]"""
    expect("page", items.page(ItemsPageArgs()), WireValue.Arr(listOf(obj("kind" to text("a"), "title" to text("t")))))
    reply = "\"x\""
    val choice = obj("a" to WireValue.Num(1.0), "kind" to text("x"))
    expect("pick", items.pick(ItemsPickArgs(choice = choice)), text("x"))
    reply = "1"
    expect("match", items.match(ItemsMatchArgs(pattern = "p")), WireValue.Num(1.0))
    expect("type", items.type(ItemsTypeArgs()), WireValue.Num(1.0))
    expect("self", items.self(ItemsSelfArgs()), WireValue.Num(1.0))

    reply = BIG_FIVE
    expect("charge", api.ledger.charge(obj("amount" to five)), five)
    reply = """{"rows":[{"amount":$BIG_FIVE}],"total":$BIG_FIVE}"""
    val accounts = obj("accounts" to WireValue.Arr(listOf(obj("id" to text("acc"), "limit" to five))))
    expect("balances", api.ledger.balances(accounts), obj("rows" to WireValue.Arr(listOf(obj("amount" to five))), "total" to five))

    val want =
        listOf(
            """{"args":{},"functionPath":"items:count"}""",
            """{"args":{},"functionPath":"items:summary"}""",
            """{"args":{"title":"t"},"functionPath":"items:create"}""",
            """{"args":{},"functionPath":"items:clear"}""",
            """{"args":{},"functionPath":"items:tags"}""",
            """{"args":{},"functionPath":"items:labels"}""",
            """{"args":{},"functionPath":"items:stats"}""",
            """{"args":{},"functionPath":"items:totals"}""",
            """{"args":{"id":"items_1"},"functionPath":"items:find"}""",
            """{"args":{},"functionPath":"items:page"}""",
            """{"args":{"choice":{"a":1,"kind":"x"}},"functionPath":"items:pick"}""",
            """{"args":{"pattern":"p"},"functionPath":"items:match"}""",
            """{"args":{},"functionPath":"items:type"}""",
            """{"args":{},"functionPath":"items:self"}""",
            """{"args":{"amount":$BIG_FIVE},"functionPath":"ledger:charge"}""",
            """{"args":{"accounts":[{"id":"acc","limit":$BIG_FIVE}]},"functionPath":"ledger:balances"}""",
        )

    expect("frames", frames, want)

    println("OK — every sdk-surface shape reaches the wire and decodes")
}
