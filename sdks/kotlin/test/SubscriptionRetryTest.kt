package dev.lunora

private const val SECOND_NANOS = 1_000_000_000L

private val retryQueryArgs = WireValue.Obj(listOf("channel" to WireValue.Text("general")))

/** A client with `sub_1` subscribed on an open socket, holding the golden seed frame and nothing else. */
private fun openRetrySubscribed(
    retry: Map<*, *>,
    sent: MutableList<Map<String, Any?>>,
    errors: MutableList<SubscriptionError>,
): Client {
    val client = Client("https://app.example", null)

    client.attachSocket { sent.add(it) }
    client.subscribe("messages:list", retryQueryArgs, null, { errors.add(it) })
    client.handleFrame(Json.write(retry["seedFrame"]))
    sent.clear()

    return client
}

/** Opens a fresh client, delivers the golden hint, and returns it with the retry pending. */
private fun hintedRetryClient(retry: Map<*, *>, sent: MutableList<Map<String, Any?>>): Client {
    val client = openRetrySubscribed(retry, sent, mutableListOf())

    client.handleFrame(Json.write(retry["hintFrame"]))

    check(client.nextSubscriptionRetryAtNanos() != null, "the golden hint must schedule a retry")

    return client
}

private fun hintSchedulesOneColdResubscribeAtTheHint(retry: Map<*, *>) {
    val sent = mutableListOf<Map<String, Any?>>()
    val client = openRetrySubscribed(retry, sent, mutableListOf())

    val t0 = System.nanoTime()

    client.handleFrame(Json.write(retry["hintFrame"]))

    val t1 = System.nanoTime()
    val due = checkNotNull(client.nextSubscriptionRetryAtNanos()) { "the hint must schedule a retry" }

    check(
        due - (t0 + 5 * SECOND_NANOS) >= 0 && t1 + 5 * SECOND_NANOS - due >= 0,
        "the retry must be due retryAfterMs after the hint, not before or after",
    )
    check(
        client.retryDueSubscriptions(due - 1_000_000L) == 0 && sent.isEmpty(),
        "nothing may be sent before the retry is due",
    )
    check(client.retryDueSubscriptions(due) == 1, "the retry must send exactly one frame when due")
    check(
        sent.size == 1 && Key.stableStringify(sent[0]) == Key.stableStringify(retry["retryFrame"]),
        "the retry frame must be the cold subscribe golden, with no resume cursor",
    )
    check(client.retryDueSubscriptions(due + 60 * SECOND_NANOS) == 0, "a fired retry must not fire again")
    check(client.nextSubscriptionRetryAtNanos() == null, "no retry may remain pending once it has fired")
}

private fun hintLeavesErrorCallbackAsBefore(retry: Map<*, *>) {
    val errors = mutableListOf<SubscriptionError>()
    val client = openRetrySubscribed(retry, mutableListOf(), errors)

    client.handleFrame(Json.write(retry["hintFrame"]))

    check(errors.size == 1, "the error callback must still fire once for a hinted error")
    check(errors[0].code == "SUBSCRIPTION_REFRESH_FAILED", "the error callback must still receive the server's code")
}

private fun laterHintReplacesPendingRetry(retry: Map<*, *>) {
    val sent = mutableListOf<Map<String, Any?>>()
    val client = hintedRetryClient(retry, sent)

    val first = checkNotNull(client.nextSubscriptionRetryAtNanos())

    client.handleFrame(Json.write(retry["laterHintFrame"]))

    val second = checkNotNull(client.nextSubscriptionRetryAtNanos())

    check(second - first > 0, "a later hint must push the pending retry later")
    check(client.retryDueSubscriptions(first) == 0 && sent.isEmpty(), "the replaced retry must not fire at its old deadline")
    check(client.retryDueSubscriptions(second) == 1, "the replacing retry must fire at its new deadline")
}

private fun answeringFramesCancelRetry(retry: Map<*, *>) {
    for (entry in retry["cancelFrames"] as List<*>) {
        val cancel = entry as Map<*, *>
        val sent = mutableListOf<Map<String, Any?>>()
        val client = hintedRetryClient(retry, sent)

        client.handleFrame(Json.write(cancel["frame"]))

        check(client.nextSubscriptionRetryAtNanos() == null, "a ${cancel["name"]} frame must cancel the pending retry")
        check(
            client.retryDueSubscriptions(System.nanoTime() + 60 * SECOND_NANOS) == 0 && sent.isEmpty(),
            "a cancelled retry must never send, even far past its deadline",
        )
    }
}

private fun framesWithoutAValidHintScheduleNothing(retry: Map<*, *>) {
    for (entry in retry["noRetryFrames"] as List<*>) {
        val rejected = entry as Map<*, *>
        val client = openRetrySubscribed(retry, mutableListOf(), mutableListOf())

        client.handleFrame(Json.write(rejected["frame"]))

        check(client.nextSubscriptionRetryAtNanos() == null, "a ${rejected["name"]} error must schedule no retry")
    }
}

private fun unsubscribeSocketChangesAndCloseCancelRetry(retry: Map<*, *>) {
    val unsubscribing = Client("https://app.example", null)

    unsubscribing.attachSocket { }

    val unsubscribe = unsubscribing.subscribe("messages:list", retryQueryArgs, null, null)

    unsubscribing.handleFrame(Json.write(retry["seedFrame"]))
    unsubscribing.handleFrame(Json.write(retry["hintFrame"]))
    unsubscribe()

    check(unsubscribing.nextSubscriptionRetryAtNanos() == null, "an unsubscribe must cancel the pending retry")

    val detached = hintedRetryClient(retry, mutableListOf())

    detached.detachSocket()

    check(detached.nextSubscriptionRetryAtNanos() == null, "a socket detach must cancel the pending retry")

    val reattached = hintedRetryClient(retry, mutableListOf())

    reattached.attachSocket { }

    check(reattached.nextSubscriptionRetryAtNanos() == null, "a socket attach must cancel the pending retry")

    val closed = hintedRetryClient(retry, mutableListOf())

    closed.close()

    check(closed.nextSubscriptionRetryAtNanos() == null, "closing the client must cancel the pending retry")
}

private fun shapeErrorSchedulesNothing() {
    val client = Client("https://app.example", null)

    client.attachSocket { }
    client.subscribeShape("messages:list", retryQueryArgs, null, null)
    client.handleFrame(
        Json.write(
            mapOf(
                "id" to "shape_1",
                "type" to "error",
                "error" to mapOf("code" to "SUBSCRIPTION_REFRESH_FAILED", "message" to "refresh failed", "retryAfterMs" to 5000),
            ),
        ),
    )

    check(client.nextSubscriptionRetryAtNanos() == null, "a shape error must not schedule a query re-subscribe")
}

private fun hintIsClampedToMaxRetryAfter(retry: Map<*, *>) {
    val client = openRetrySubscribed(retry, mutableListOf(), mutableListOf())

    val t0 = System.nanoTime()

    client.handleFrame(
        Json.write(
            mapOf(
                "id" to "sub_1",
                "type" to "error",
                "error" to mapOf("code" to "SUBSCRIPTION_REFRESH_FAILED", "message" to "refresh failed", "retryAfterMs" to 3600000),
            ),
        ),
    )

    val t1 = System.nanoTime()
    val due = checkNotNull(client.nextSubscriptionRetryAtNanos()) { "a clamped hint must still schedule a retry" }

    check(
        due - (t0 + 60 * SECOND_NANOS) >= 0 && t1 + 60 * SECOND_NANOS - due >= 0,
        "a retry hint above the 60000ms cap must be clamped to exactly that cap",
    )
}

/**
 * Subscription-retry cases: a subscription error's `retryAfterMs` schedules exactly one cold
 * re-subscribe, which the caller fires through [Client.retryDueSubscriptions]. Checked against the
 * `subscriptionRetry` golden in `protocol/fixtures/ws-frames.json`.
 */
internal fun runSubscriptionRetryCases() {
    val retry = fixture("ws-frames.json")["subscriptionRetry"] as Map<*, *>

    hintSchedulesOneColdResubscribeAtTheHint(retry)
    hintLeavesErrorCallbackAsBefore(retry)
    laterHintReplacesPendingRetry(retry)
    answeringFramesCancelRetry(retry)
    framesWithoutAValidHintScheduleNothing(retry)
    unsubscribeSocketChangesAndCloseCancelRetry(retry)
    shapeErrorSchedulesNothing()
    hintIsClampedToMaxRetryAfter(retry)
}
