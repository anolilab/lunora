package dev.lunora

/*
 * A reconnect re-sends its query subscriptions a few at a time, as the reference client does.
 * RESUBSCRIBE_CONCURRENCY in packages/client/src/client-tuning.ts is the width: a re-sent subscribe
 * holds a slot until any frame bearing its id arrives, it is unsubscribed, or
 * RESUBSCRIBE_ACK_TIMEOUT_NANOS passes with no reply.
 */

private const val PACED_SUBSCRIPTIONS = 7

private fun subscribeIds(sent: List<Map<String, Any?>>): List<Any?> = sent.filter { it["type"] == "subscribe" }.map { it["id"] }

private fun ackFrame(id: Any?): String = """{"id":"$id","type":"ack"}"""

private fun subscribeChannel(client: Client, index: Int): () -> Unit =
    client.subscribe("messages:list", WireValue.Obj(listOf("channel" to WireValue.Text("c$index"))), {}, {})

/** A client holding [count] query subscriptions made on a first socket, attached to [sender] before any resend. */
private fun pacedClient(count: Int, sender: (Map<String, Any?>) -> Unit): Pair<Client, List<() -> Unit>> {
    val client = Client("https://app.example", null)

    client.attachSocket {}

    val unsubscribes = (0 until count).map { subscribeChannel(client, it) }

    client.attachSocket(sender = sender)

    return client to unsubscribes
}

/** [pacedClient] recording to [sent], resent. */
private fun reconnected(count: Int, sent: MutableList<Map<String, Any?>>): Client {
    val (client, _) = pacedClient(count) { sent.add(it) }

    sent.clear()
    client.resendSubscriptions()

    return client
}

private fun onlyTheWindowGoesOutUntilAReplyArrives() {
    check(RESUBSCRIBE_CONCURRENCY == 3, "the window must be the reference client's 3")

    val sent = mutableListOf<Map<String, Any?>>()

    reconnected(PACED_SUBSCRIPTIONS, sent)

    check(subscribeIds(sent).size == RESUBSCRIBE_CONCURRENCY, "a resend must send only the window until a reply arrives, got ${subscribeIds(sent).size}")
}

private fun anyFrameBearingTheIdLetsTheNextOneOut() {
    val sent = mutableListOf<Map<String, Any?>>()
    val client = reconnected(PACED_SUBSCRIPTIONS, sent)
    val window = subscribeIds(sent)

    client.handleFrame(ackFrame(window[0]))
    check(subscribeIds(sent).size == 4, "an ack must free its slot")

    client.handleFrame("""{"cursor":1,"data":[],"id":"${window[1]}","type":"data"}""")
    check(subscribeIds(sent).size == 5, "a data frame that overtakes the ack must free it too")

    client.handleFrame("""{"error":{"code":"FORBIDDEN","message":"no"},"id":"${window[2]}","type":"error"}""")
    check(subscribeIds(sent).size == 6, "so must the error that refuses it")

    client.handleFrame(ackFrame(window[0]))
    check(subscribeIds(sent).size == 6, "a second frame for a released id must free nothing")
}

private fun everySubscriptionGoesOutExactlyOnceInSubscribeOrder() {
    val sent = mutableListOf<Map<String, Any?>>()
    val client = reconnected(PACED_SUBSCRIPTIONS, sent)
    var answered = 0

    while (answered < subscribeIds(sent).size) client.handleFrame(ackFrame(subscribeIds(sent)[answered++]))

    check(
        subscribeIds(sent) == (1..PACED_SUBSCRIPTIONS).map { "sub_$it" },
        "every subscription must be re-sent once, in subscribe order, got ${subscribeIds(sent)}",
    )
}

private fun unsubscribeSkipsAQueuedOneAndFreesAnOutstandingOne() {
    val sent = mutableListOf<Map<String, Any?>>()
    val (client, unsubscribes) = pacedClient(5) { sent.add(it) }

    sent.clear()
    client.resendSubscriptions()

    val outstanding = subscribeIds(sent)

    unsubscribes[4]()
    check(subscribeIds(sent).size == 3, "a queued one must be dropped, and free no slot")

    unsubscribes[0]()
    check(subscribeIds(sent).size == 4, "an outstanding one will never be answered, so its slot must go on")
    check("sub_5" !in subscribeIds(sent), "the unsubscribed queued one must not go out")

    client.handleFrame(ackFrame(outstanding[1]))
    check(subscribeIds(sent).size == 4, "nothing must be left to send")
}

private fun unansweredOneStopsHoldingItsSlotAfterTheTimeout() {
    val sent = mutableListOf<Map<String, Any?>>()
    val before = System.nanoTime()
    val client = reconnected(PACED_SUBSCRIPTIONS, sent)
    val after = System.nanoTime()
    val deadline = checkNotNull(client.nextSubscriptionRetryAtNanos()) { "an outstanding re-subscribe must report its deadline" }

    check(
        deadline - (before + RESUBSCRIBE_ACK_TIMEOUT_NANOS) >= 0 && after + RESUBSCRIBE_ACK_TIMEOUT_NANOS - deadline >= 0,
        "the deadline must be the ack timeout after the resend",
    )
    check(client.retryDueSubscriptions(deadline - 1_000_000L) == 0 && subscribeIds(sent).size == 3, "a slot must hold until its deadline")
    check(client.retryDueSubscriptions(deadline) == RESUBSCRIBE_CONCURRENCY, "every timed-out slot must let the next one out, and count it")
    check(subscribeIds(sent).size == 6, "the next window must have gone out")
}

private fun lateRetryDatesTheNextWindowFromNow() {
    val sent = mutableListOf<Map<String, Any?>>()
    val client = reconnected(PACED_SUBSCRIPTIONS, sent)
    // A timer armed for an hour-old deadline that only fires now passes that deadline.
    val armedFor = System.nanoTime() - 3_600_000_000_000L

    @Suppress("UNCHECKED_CAST")
    val slots = Client::class.java.getDeclaredField("resubscribeSlots").apply { isAccessible = true }.get(client) as MutableMap<String, Long>

    slots.replaceAll { _, _ -> armedFor }

    val before = System.nanoTime()

    check(client.retryDueSubscriptions(armedFor) == RESUBSCRIBE_CONCURRENCY, "the expired slots must let the next window out")

    val deadline = checkNotNull(client.nextSubscriptionRetryAtNanos()) { "the new window must report its deadline" }

    check(deadline - (before + RESUBSCRIBE_ACK_TIMEOUT_NANOS) >= 0, "the new window's slots must hold for the ack timeout from now")
}

private fun reconnectMidDrainStartsAFreshWindow() {
    val sent = mutableListOf<Map<String, Any?>>()
    val client = reconnected(PACED_SUBSCRIPTIONS, sent)

    client.detachSocket()
    check(client.nextSubscriptionRetryAtNanos() == null, "a dropped socket's slots must be gone")

    val resent = mutableListOf<Map<String, Any?>>()

    client.attachSocket { resent.add(it) }
    resent.clear()
    client.resendSubscriptions()

    check(subscribeIds(resent).size == RESUBSCRIBE_CONCURRENCY, "the new socket must get a fresh window")

    client.handleFrame(ackFrame(subscribeIds(sent)[0]))
    check(subscribeIds(resent).size == 4, "a reply on the new socket must drain its queue")
}

private fun queuedOneCarriesTheCursorItHasWhenItGoesOut() {
    val client = Client("https://app.example", null)

    client.identity = "alice"
    client.attachSocket {}

    for (index in 0 until 4) {
        subscribeChannel(client, index)
        client.handleFrame("""{"cursor":9,"data":[],"id":"sub_${index + 1}","type":"data"}""")
    }

    val sent = mutableListOf<Map<String, Any?>>()

    client.attachSocket { sent.add(it) }
    sent.clear()
    client.resendSubscriptions()
    client.identity = "bob"
    client.handleFrame(ackFrame("sub_1"))

    val late = sent.lastOrNull { it["id"] == "sub_4" && it["type"] == "subscribe" }

    check(late != null, "the queued subscription must go out once a slot frees")
    check(
        (late!!["query"] as Map<*, *>).containsKey("sinceSeq").not(),
        "the new identity must not resume the old one's position, got $late",
    )
}

private fun failedPacedSendFromAFrameDoesNotThrow() {
    var failing = false
    val (client, _) = pacedClient(4) { if (failing && it["type"] == "subscribe") throw IllegalStateException("socket write failed") }

    client.resendSubscriptions()
    failing = true

    val threw = try {
        client.handleFrame(ackFrame("sub_1"))
        false
    } catch (escaped: RuntimeException) {
        true
    }

    check(!threw, "a paced send that fails must not escape the frame handler")
}

private fun failedSendPutsTheUnsentOnesBackInLine() {
    val sent = mutableListOf<Map<String, Any?>>()
    var broken = true
    val (client, _) =
        pacedClient(PACED_SUBSCRIPTIONS) {
            if (it["id"] == "sub_2" && broken) {
                broken = false

                throw IllegalStateException("write failed")
            }

            sent.add(it)
        }

    sent.clear()

    val threw = try {
        client.resendSubscriptions()
        false
    } catch (expected: IllegalStateException) {
        true
    }

    check(threw, "the caller's own resend reports the failed write")

    var answered = 0

    while (answered < subscribeIds(sent).size) client.handleFrame(ackFrame(subscribeIds(sent)[answered++]))

    check(subscribeIds(sent).toSet().size == PACED_SUBSCRIPTIONS, "every subscription must still go out after a failed write, got ${subscribeIds(sent)}")
}

private fun failedUnsubscribeWriteStillSendsTheBatchItFreed() {
    val sent = mutableListOf<Map<String, Any?>>()
    val (client, unsubscribes) =
        pacedClient(5) {
            if (it["type"] == "unsubscribe") throw IllegalStateException("write failed")

            sent.add(it)
        }

    sent.clear()
    client.resendSubscriptions()

    try {
        unsubscribes[0]()
    } catch (expected: IllegalStateException) {
        // The unsubscribe write itself is the caller's to see.
    }

    check("sub_4" in subscribeIds(sent), "the batch a failed unsubscribe freed must still go out, got ${subscribeIds(sent)}")
}

private fun retryAcrossASocketSwapLeavesTheNewQueueAlone() {
    val old = mutableListOf<Map<String, Any?>>()
    val fresh = mutableListOf<Map<String, Any?>>()
    var swapped = false
    lateinit var client: Client

    client =
        pacedClient(5) {
            old.add(it)

            // The socket is replaced while the retry's own frame is being written to the old one.
            if (it["id"] == "sub_5" && !swapped) {
                swapped = true
                client.detachSocket()
                client.attachSocket { frame -> fresh.add(frame) }
                client.resendSubscriptions()
            }
        }.first
    client.resendSubscriptions()
    client.handleFrame("""{"error":{"code":"OVERLOADED","message":"busy","retryAfterMs":0},"id":"sub_5","type":"error"}""")

    client.retryDueSubscriptions(System.nanoTime() + 2 * RESUBSCRIBE_ACK_TIMEOUT_NANOS)

    check(swapped, "the retry must have reached the old socket")
    check("sub_4" !in subscribeIds(old), "the new socket's queue must not be drained onto the old one, got ${subscribeIds(old)}")
    check("sub_1" in subscribeIds(fresh), "the new socket must keep its own window")
}

private fun shapeSubscriptionsAreNotPaced() {
    val client = Client("https://app.example", null)

    client.attachSocket {}

    for (index in 0 until 5) client.subscribeShape("roomMessages", WireValue.Obj(listOf("room" to WireValue.Text("r$index"))), {})

    val sent = mutableListOf<Map<String, Any?>>()

    client.attachSocket { sent.add(it) }
    sent.clear()
    client.resendSubscriptions()

    check(sent.count { it["type"] == "shape_subscribe" } == 5, "every shape subscription must go out at once")
}

private fun aQueuedOneStaysFrozenWhileAnEarlierOneIsWritten() {
    val frozenAtOne = mutableListOf<Boolean>()
    lateinit var client: Client

    client =
        pacedClient(PACED_SUBSCRIPTIONS) {
            if (it["type"] == "subscribe" && it["id"] == "sub_1") frozenAtOne.add(checkNotNull(client.subscriptions["sub_2"]).poisoned)
        }.first
    synchronized(client.lock) { checkNotNull(client.subscriptions["sub_2"]).poisoned = true }
    client.resendSubscriptions()

    check(frozenAtOne == listOf(true), "a subscription must stay frozen until its own frame goes out, got $frozenAtOne")
    check(!checkNotNull(client.subscriptions["sub_2"]).poisoned, "its own frame must lift the freeze")
}

private fun aReplyDuringTheFirstWindowDoesNotJumpTheQueue() {
    val sent = mutableListOf<Map<String, Any?>>()
    lateinit var client: Client

    client =
        pacedClient(PACED_SUBSCRIPTIONS) {
            sent.add(it)

            // The read loop answers sub_1 while the resend is still writing it.
            if (it["type"] == "subscribe" && it["id"] == "sub_1") client.handleFrame(ackFrame("sub_1"))
        }.first
    sent.clear()
    client.resendSubscriptions()

    check(
        subscribeIds(sent) == listOf("sub_1", "sub_2", "sub_3", "sub_4"),
        "the freed slot's query must go out after the window, in subscribe order, got ${subscribeIds(sent)}",
    )
}

private fun aSocketReplacedMidWindowGetsNoMoreOfIt() {
    val onOld = mutableListOf<Map<String, Any?>>()
    val onNew = mutableListOf<Map<String, Any?>>()
    lateinit var client: Client

    client =
        pacedClient(PACED_SUBSCRIPTIONS) {
            onOld.add(it)

            if (it["type"] == "subscribe" && it["id"] == "sub_1") client.attachSocket { frame -> onNew.add(frame) }
        }.first
    onOld.clear()
    client.resendSubscriptions()

    check(subscribeIds(onOld).size == 1, "nothing more of the window must go to the replaced socket, got ${subscribeIds(onOld)}")
    check(subscribeIds(onNew).isEmpty(), "the new socket's own resend sends its queries, not the old run, got ${subscribeIds(onNew)}")
}

private fun aReplacedSocketsLateFrameIsIgnored() {
    val sent = mutableListOf<Map<String, Any?>>()
    val (client, _) = pacedClient(PACED_SUBSCRIPTIONS) {}
    val old = client.attachSocket {}

    client.resendSubscriptions()

    val current = client.attachSocket { sent.add(it) }

    sent.clear()
    client.resendSubscriptions()

    check(old("""{"cursor":9,"data":[],"id":"sub_1","type":"data"}""") == null, "the replaced socket's frame must be ignored")
    check(checkNotNull(client.subscriptions["sub_1"]).cursor == null, "the replaced socket's frame must not move the cursor")
    check(subscribeIds(sent).size == RESUBSCRIBE_CONCURRENCY, "the replaced socket's frame must free no slot, got ${subscribeIds(sent)}")
    check(current(ackFrame("sub_1")) == "ack", "the current socket's frame must be applied")
    check(subscribeIds(sent).size == RESUBSCRIBE_CONCURRENCY + 1, "the current socket's reply must free its slot, got ${subscribeIds(sent)}")
}

private fun aFrameIsAppliedBeforeThePumpItFreedCanReplaceTheSocket() {
    val (client, _) = pacedClient(PACED_SUBSCRIPTIONS) {}
    var newer: FrameHandler? = null
    val old = client.attachSocket { frame ->
        // The pump the frame below starts writes sub_4, and the socket is replaced meanwhile; the new
        // socket's frame for sub_1 is the newer one.
        if (frame["type"] == "subscribe" && frame["id"] == "sub_4") {
            val handle = client.attachSocket {}

            newer = handle
            handle("""{"cursor":20,"data":[],"id":"sub_1","type":"data"}""")
        }
    }

    client.resendSubscriptions()
    old("""{"cursor":9,"data":[],"id":"sub_1","type":"data"}""")

    check(newer != null, "the frame's freed slot must have sent sub_4")

    val cursor = checkNotNull(client.subscriptions["sub_1"]).cursor

    check(cursor == 20.0, "the old socket's frame must land before the new socket's, got cursor $cursor")
}

private fun shapesDoNotFollowAQueryWriteThatReplacedTheSocket() {
    val onOld = mutableListOf<Map<String, Any?>>()
    val client = Client("https://app.example", null)

    client.attachSocket {}
    subscribeChannel(client, 0)
    client.subscribeShape("roomMessages", WireValue.Obj(listOf("room" to WireValue.Text("r0"))), {})
    client.attachSocket { frame ->
        onOld.add(frame)
        if (frame["type"] == "subscribe") client.attachSocket {}
    }
    onOld.clear()
    client.resendSubscriptions()

    check(onOld.none { it["type"] == "shape_subscribe" }, "the replaced socket must get no shape subscription, got $onOld")
}

internal fun runResubscribePacingCases() {
    onlyTheWindowGoesOutUntilAReplyArrives()
    anyFrameBearingTheIdLetsTheNextOneOut()
    everySubscriptionGoesOutExactlyOnceInSubscribeOrder()
    unsubscribeSkipsAQueuedOneAndFreesAnOutstandingOne()
    unansweredOneStopsHoldingItsSlotAfterTheTimeout()
    lateRetryDatesTheNextWindowFromNow()
    reconnectMidDrainStartsAFreshWindow()
    queuedOneCarriesTheCursorItHasWhenItGoesOut()
    failedPacedSendFromAFrameDoesNotThrow()
    failedSendPutsTheUnsentOnesBackInLine()
    failedUnsubscribeWriteStillSendsTheBatchItFreed()
    retryAcrossASocketSwapLeavesTheNewQueueAlone()
    shapeSubscriptionsAreNotPaced()
    aQueuedOneStaysFrozenWhileAnEarlierOneIsWritten()
    aReplyDuringTheFirstWindowDoesNotJumpTheQueue()
    aSocketReplacedMidWindowGetsNoMoreOfIt()
    aReplacedSocketsLateFrameIsIgnored()
    aFrameIsAppliedBeforeThePumpItFreedCanReplaceTheSocket()
    shapesDoNotFollowAQueryWriteThatReplacedTheSocket()
}
