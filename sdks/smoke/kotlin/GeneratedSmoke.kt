// Runs generated calls, rather than only compiling them.
//
// `kotlinc` proves the shapes line up. It does not prove a call reaches the wire:
// Java shipped a surface that compiled and threw on the first invocation, and
// Ruby one whose every method raised NoMethodError, both with the
// compile-or-parse gate green.
//
// The arguments are TYPED models, which is what makes the assertions cover the
// defect that replaced them: each frame must carry the wire keys the SCHEMA
// declares — `channelId`, not the `channelID` a property-name projection gives.
//
// Two calls, because one does not reach every shape the models emit:
//
//  * `messages:list` covers a required string and an OMITTED optional. `limit` is
//    left at its default and must not appear in the frame at all — `v.optional`
//    parses the value or `undefined` and rejects an explicit null, so sending one
//    fails every such call.
//  * `messages:send` covers the enum and the record. An enum must encode its own
//    wire string ("text", not the entry name), and a `Map<String, String>` must
//    arrive as a JSON object.
//
// Compiled by `sdks/generated-check.sh kotlin` as `kotlinc $LUNORA_SDK_OUT
// GeneratedSmoke.kt`, against an SDK generated into a scratch directory outside
// this repo — so `dev.lunora` here is the vendored transport, not `sdks/kotlin`.

package dev.lunora

import lunoraapi.Api
import lunoraapi.models.MessagesListArgs
import lunoraapi.models.MessagesSendArgs
import lunoraapi.models.MessagesSendArgsKind

fun main() {
    var captured: String? = null

    val client = Client("https://app.example", post = { _, _, body ->
        captured = String(body, Charsets.UTF_8)

        HttpResponse(200, """{"result":{"ok":true}}""")
    })

    val api = Api(client)

    api.messages.list(MessagesListArgs(channelId = "chan_1"))
    assertFrame(captured, """{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}""")

    api.messages.send(
        MessagesSendArgs(
            channelId = "chan_1",
            text = "hi",
            kind = MessagesSendArgsKind.TEXT,
            tags = mapOf("topic" to "release"),
        ),
    )
    assertFrame(
        captured,
        """{"args":{"channelId":"chan_1","kind":"text","tags":{"topic":"release"},""" +
            """"text":"hi"},"functionPath":"messages:send"}""",
    )

    // The generated watch member reaches the primitive with the right function path. The
    // subscribe frame is sent at call time, the first data frame is decoded through the
    // iterator, and closing the watch sends the unsubscribe for the same id.
    val watchFrames = mutableListOf<Map<String, Any?>>()
    val watchClient = Client("https://app.example")

    watchClient.attachSocket { frame -> watchFrames.add(frame) }

    val watch = Api(watchClient).messages.watchList(MessagesListArgs(channelId = "chan_1"))

    val subscribe = framesOfType(watchFrames, "subscribe")
    val query = subscribe["query"] as Map<*, *>

    if (query["functionPath"] != "messages:list") {
        throw AssertionError("watch subscribed to ${query["functionPath"]}, want messages:list")
    }

    val sentArgs = Key.stableStringify(query["args"])

    if (sentArgs != """{"channelId":"chan_1"}""") throw AssertionError("watch sent args $sentArgs")

    val id = subscribe["id"] as String

    watchClient.handleFrame("""{"cursor":1,"data":{"ok":true},"id":"$id","type":"data"}""")

    val event = watch.iterator().next()

    if (event.error != null) throw AssertionError("watch delivered an error: ${event.error}")

    val decoded = Key.stableStringify(Wire.encode(checkNotNull(event.value)))

    if (decoded != """{"ok":true}""") throw AssertionError("watch yielded $decoded, want {\"ok\":true}")

    watch.close()

    if (framesOfType(watchFrames, "unsubscribe")["id"] != id) {
        throw AssertionError("closing the watch did not unsubscribe $id")
    }

    println("OK — the generated surface reaches the wire, and the watch member reaches the primitive")
}

/** The single frame of [kind] that was sent; fails when none or several were. */
private fun framesOfType(frames: List<Map<String, Any?>>, kind: String): Map<String, Any?> {
    val found = frames.filter { it["type"] == kind }

    if (found.size != 1) throw AssertionError("sent ${found.size} $kind frames, want exactly one")

    return found.single()
}

/** Normalises key order out of the comparison, so only the keys and values are asserted. */
private fun assertFrame(captured: String?, want: String) {
    val got = Key.stableStringify(Json.parse(captured ?: error("the poster was never called")))

    if (got != want) throw AssertionError("generated call produced $got, want $want")
}
