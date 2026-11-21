package dev.lunora;

import static dev.lunora.ConformanceTest.check;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;

/**
 * A reconnect re-sends its query subscriptions a few at a time, as the reference client does.
 *
 * <p>{@code RESUBSCRIBE_CONCURRENCY} in {@code packages/client/src/client-tuning.ts} is the width:
 * a re-sent {@code subscribe} holds a slot until any frame bearing its id arrives, it is
 * unsubscribed, or {@link Client#RESUBSCRIBE_ACK_TIMEOUT_NANOS} passes with no reply.
 */
final class ResubscribePacingTest {
    private static final int SUBSCRIPTIONS = 7;

    private ResubscribePacingTest() {}

    static void run() {
        onlyTheWindowGoesOutUntilAReplyArrives();
        anyFrameBearingTheIdLetsTheNextOneOut();
        everySubscriptionGoesOutExactlyOnce();
        unsubscribeSkipsAQueuedOneAndFreesAnOutstandingOne();
        unansweredOneStopsHoldingItsSlotAfterTheTimeout();
        reconnectMidDrainStartsAFreshWindow();
        queuedOneCarriesTheCursorItHasWhenItGoesOut();
        failedPacedSendFromAFrameDoesNotThrow();
        shapeSubscriptionsAreNotPaced();
    }

    private static List<Object> subscribes(List<Map<String, Object>> sent) {
        List<Object> ids = new ArrayList<>();

        for (Map<String, Object> frame : sent) {
            if ("subscribe".equals(frame.get("type"))) {
                ids.add(frame.get("id"));
            }
        }

        return ids;
    }

    private static String ack(Object id) {
        return "{\"id\":\"" + id + "\",\"type\":\"ack\"}";
    }

    private static Runnable subscribeTo(Client client, int index) {
        return client.subscribe(
                "messages:list", Map.of("channel", "c" + index), value -> {}, error -> {}, null);
    }

    /** A client holding {@code count} query subscriptions, re-attached to {@code sent}, resent. */
    private static Client reconnected(int count, List<Map<String, Object>> sent) {
        Client client = new Client("https://app.example", null);

        client.attachSocket(frame -> {}, null);

        for (int index = 0; index < count; index++) {
            subscribeTo(client, index);
        }

        client.attachSocket(sent::add, null);
        sent.clear();
        client.resendSubscriptions();

        return client;
    }

    private static void onlyTheWindowGoesOutUntilAReplyArrives() {
        check(Client.RESUBSCRIBE_CONCURRENCY == 3, "the window must be the reference client's 3");

        List<Map<String, Object>> sent = new ArrayList<>();

        reconnected(SUBSCRIPTIONS, sent);

        check(
                subscribes(sent).size() == Client.RESUBSCRIBE_CONCURRENCY,
                "a resend must send only the window until a reply arrives, got "
                        + subscribes(sent).size());
    }

    private static void anyFrameBearingTheIdLetsTheNextOneOut() {
        List<Map<String, Object>> sent = new ArrayList<>();
        Client client = reconnected(SUBSCRIPTIONS, sent);
        List<Object> window = subscribes(sent);

        client.handleFrame(ack(window.get(0)));
        check(subscribes(sent).size() == 4, "an ack must free its slot");

        client.handleFrame(
                "{\"cursor\":1,\"data\":[],\"id\":\"" + window.get(1) + "\",\"type\":\"data\"}");
        check(subscribes(sent).size() == 5, "a data frame that overtakes the ack must free it too");

        client.handleFrame(
                "{\"error\":{\"code\":\"FORBIDDEN\",\"message\":\"no\"},\"id\":\""
                        + window.get(2)
                        + "\",\"type\":\"error\"}");
        check(subscribes(sent).size() == 6, "so must the error that refuses it");

        client.handleFrame(ack(window.get(0)));
        check(subscribes(sent).size() == 6, "a second frame for a released id must free nothing");
    }

    private static void everySubscriptionGoesOutExactlyOnce() {
        List<Map<String, Object>> sent = new ArrayList<>();
        Client client = reconnected(SUBSCRIPTIONS, sent);

        for (int answered = 0; answered < subscribes(sent).size(); answered++) {
            client.handleFrame(ack(subscribes(sent).get(answered)));
        }

        List<Object> ids = subscribes(sent);

        check(ids.size() == SUBSCRIPTIONS, "every subscription must be re-sent, got " + ids.size());
        check(new HashSet<>(ids).size() == SUBSCRIPTIONS, "no subscription may be re-sent twice");
    }

    private static void unsubscribeSkipsAQueuedOneAndFreesAnOutstandingOne() {
        Client client = new Client("https://app.example", null);
        List<Runnable> unsubscribes = new ArrayList<>();

        client.attachSocket(frame -> {}, null);

        for (int index = 0; index < 5; index++) {
            unsubscribes.add(subscribeTo(client, index));
        }

        List<Map<String, Object>> sent = new ArrayList<>();

        client.attachSocket(sent::add, null);
        sent.clear();
        client.resendSubscriptions();

        List<Object> outstanding = subscribes(sent);

        unsubscribes.get(4).run();
        check(subscribes(sent).size() == 3, "a queued one must be dropped, and free no slot");

        unsubscribes.get(0).run();
        check(
                subscribes(sent).size() == 4,
                "an outstanding one will never be answered, so its slot must go on");
        check(!subscribes(sent).contains("sub_5"), "the unsubscribed queued one must not go out");

        client.handleFrame(ack(outstanding.get(1)));
        check(subscribes(sent).size() == 4, "nothing must be left to send");
    }

    private static void unansweredOneStopsHoldingItsSlotAfterTheTimeout() {
        List<Map<String, Object>> sent = new ArrayList<>();
        long before = System.nanoTime();
        Client client = reconnected(SUBSCRIPTIONS, sent);
        long after = System.nanoTime();
        Long deadline = client.nextSubscriptionRetryAtNanos();

        check(deadline != null, "an outstanding re-subscribe must report its deadline");
        check(
                deadline - (before + Client.RESUBSCRIBE_ACK_TIMEOUT_NANOS) >= 0
                        && (after + Client.RESUBSCRIBE_ACK_TIMEOUT_NANOS) - deadline >= 0,
                "the deadline must be the ack timeout after the resend");
        check(
                client.retryDueSubscriptions(deadline - 1_000_000L) == 0
                        && subscribes(sent).size() == 3,
                "a slot must hold until its deadline");
        check(
                client.retryDueSubscriptions(deadline) == Client.RESUBSCRIBE_CONCURRENCY,
                "every timed-out slot must let the next one out, and count it");
        check(subscribes(sent).size() == 6, "the next window must have gone out");
    }

    private static void reconnectMidDrainStartsAFreshWindow() {
        List<Map<String, Object>> sent = new ArrayList<>();
        Client client = reconnected(SUBSCRIPTIONS, sent);

        client.detachSocket(null, null);
        check(
                client.nextSubscriptionRetryAtNanos() == null,
                "a dropped socket's slots must be gone");

        List<Map<String, Object>> resent = new ArrayList<>();

        client.attachSocket(resent::add, null);
        resent.clear();
        client.resendSubscriptions();

        check(
                subscribes(resent).size() == Client.RESUBSCRIBE_CONCURRENCY,
                "the new socket must get a fresh window");

        client.handleFrame(ack(subscribes(sent).get(0)));
        check(subscribes(resent).size() == 4, "a reply on the new socket must drain its queue");
    }

    private static void queuedOneCarriesTheCursorItHasWhenItGoesOut() {
        Client client = new Client("https://app.example", null);

        client.identity("alice");
        client.attachSocket(frame -> {}, null);

        for (int index = 0; index < 4; index++) {
            subscribeTo(client, index);
            client.handleFrame(
                    "{\"cursor\":9,\"data\":[],\"id\":\"sub_"
                            + (index + 1)
                            + "\",\"type\":\"data\"}");
        }

        List<Map<String, Object>> sent = new ArrayList<>();

        client.attachSocket(sent::add, null);
        sent.clear();
        client.resendSubscriptions();
        client.identity("bob");
        client.handleFrame(ack("sub_1"));

        Map<String, Object> late = null;

        for (Map<String, Object> frame : sent) {
            if ("sub_4".equals(frame.get("id")) && "subscribe".equals(frame.get("type"))) {
                late = frame;
            }
        }

        check(late != null, "the queued subscription must go out once a slot frees");

        Object query = late.get("query");

        check(
                query instanceof Map<?, ?> map && !map.containsKey("sinceSeq"),
                "the new identity must not resume the old one's position, got " + late);
    }

    private static void failedPacedSendFromAFrameDoesNotThrow() {
        boolean[] failing = {false};
        List<Map<String, Object>> sent = new ArrayList<>();
        Client client = new Client("https://app.example", null);

        client.attachSocket(frame -> {}, null);

        for (int index = 0; index < 4; index++) {
            subscribeTo(client, index);
        }

        client.attachSocket(
                frame -> {
                    if (failing[0] && "subscribe".equals(frame.get("type"))) {
                        throw new IllegalStateException("socket write failed");
                    }

                    sent.add(frame);
                },
                null);
        client.resendSubscriptions();
        failing[0] = true;

        boolean threw = false;

        try {
            client.handleFrame(ack("sub_1"));
        } catch (RuntimeException escaped) {
            threw = true;
        }

        check(!threw, "a paced send that fails must not escape the frame handler");
    }

    private static void shapeSubscriptionsAreNotPaced() {
        Client client = new Client("https://app.example", null);

        client.attachSocket(frame -> {}, null);

        for (int index = 0; index < 5; index++) {
            client.subscribeShape("roomMessages", Map.of("room", "r" + index), rows -> {}, null);
        }

        List<Map<String, Object>> sent = new ArrayList<>();

        client.attachSocket(sent::add, null);
        sent.clear();
        client.resendSubscriptions();

        int shapes = 0;

        for (Map<String, Object> frame : sent) {
            if ("shape_subscribe".equals(frame.get("type"))) {
                shapes++;
            }
        }

        check(shapes == 5, "every shape subscription must go out at once, got " + shapes);
    }
}
