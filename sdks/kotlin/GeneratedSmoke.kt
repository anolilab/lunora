// Runs a generated call, rather than only compiling one.
//
// `kotlinc` proves the shapes line up. It does not prove a call reaches the wire:
// Java shipped a surface that compiled and threw on the first invocation, and
// Ruby one whose every method raised NoMethodError, both with the
// compile-or-parse gate green.

package dev.lunora

import lunoraapi.Api

fun main() {
    var captured: String? = null

    val client = Client("https://app.example", post = { _, _, body ->
        captured = String(body, Charsets.UTF_8)

        HttpResponse(200, """{"result":{"ok":true}}""")
    })

    Api(client).messages.list(WireValue.Obj(listOf("channelId" to WireValue.Text("chan_1"))))

    val want = """{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}"""
    val got = Key.stableStringify(Json.parse(captured ?: error("the poster was never called")))

    if (got != want) throw AssertionError("generated call produced $got, want $want")

    println("OK — the generated surface reaches the wire")
}
