package dev.lunora;

import static dev.lunora.ConformanceTest.check;
import static dev.lunora.ConformanceTest.fixture;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Subscription-retry cases: a subscription error's {@code retryAfterMs} schedules exactly one cold
 * re-subscribe, which the caller fires through {@code retryDueSubscriptions}. Checked against the
 * {@code subscriptionRetry} golden in {@code protocol/fixtures/ws-frames.json}.
 */
final class SubscriptionRetryTest {
    private static final long SECOND_NANOS = 1_000_000_000L;

    private SubscriptionRetryTest() {}

    static void run() throws IOException {
        Map<String, Object> retry = retryFixture();

        hintSchedulesOneColdResubscribeAtTheHint(retry);
        hintLeavesErrorCallbackAsBefore(retry);
        laterHintReplacesPendingRetry(retry);
        answeringFramesCancelRetry(retry);
        framesWithoutAValidHintScheduleNothing(retry);
        unsubscribeSocketChangesAndCloseCancelRetry(retry);
        shapeErrorSchedulesNothing(retry);
        hintIsClampedToMaxRetryAfter(retry);
        unsubscribeThatOvertakesRetryIsFollowedByAnother(retry);
        failedSendKeepsUnsentRetriesDue(retry);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> retryFixture() throws IOException {
        return (Map<String, Object>) fixture("ws-frames.json").get("subscriptionRetry");
    }

    /**
     * A client with {@code sub_1} subscribed on an open socket, holding the golden seed frame and
     * nothing else. The errors list records every error the subscription's callback sees.
     */
    private static Client openSubscribed(
            Map<String, Object> retry,
            List<Map<String, Object>> sent,
            List<Client.SubscriptionError> errors)
            throws IOException {
        Client client = new Client("https://app.example", null);

        client.attachSocket(sent::add, null);
        client.subscribe(
                "messages:list", Map.of("channel", "general"), value -> {}, errors::add, null);
        client.handleFrame(Json.write(retry.get("seedFrame")));
        sent.clear();

        return client;
    }

    /** Opens a fresh client, delivers the golden hint, and returns it with the retry pending. */
    private static Client hinted(Map<String, Object> retry, List<Map<String, Object>> sent)
            throws IOException {
        Client client = openSubscribed(retry, sent, new ArrayList<>());

        client.handleFrame(Json.write(retry.get("hintFrame")));

        check(
                client.nextSubscriptionRetryAtNanos() != null,
                "the golden hint must schedule a retry");

        return client;
    }

    @SuppressWarnings("unchecked")
    private static void hintSchedulesOneColdResubscribeAtTheHint(Map<String, Object> retry)
            throws IOException {
        List<Map<String, Object>> sent = new ArrayList<>();
        Client client = openSubscribed(retry, sent, new ArrayList<>());

        long t0 = System.nanoTime();

        client.handleFrame(Json.write(retry.get("hintFrame")));

        long t1 = System.nanoTime();
        Long due = client.nextSubscriptionRetryAtNanos();

        check(due != null, "the hint must schedule a retry");
        check(
                due - (t0 + 5 * SECOND_NANOS) >= 0 && (t1 + 5 * SECOND_NANOS) - due >= 0,
                "the retry must be due retryAfterMs after the hint, not before or after");
        check(
                client.retryDueSubscriptions(due - 1_000_000L) == 0 && sent.isEmpty(),
                "nothing may be sent before the retry is due");
        check(
                client.retryDueSubscriptions(due) == 1,
                "the retry must send exactly one frame when due");
        check(
                sent.size() == 1
                        && Key.stableStringify(sent.get(0))
                                .equals(Key.stableStringify(retry.get("retryFrame"))),
                "the retry frame must be the cold subscribe golden, with no resume cursor");
        check(
                client.retryDueSubscriptions(due + 60 * SECOND_NANOS) == 0,
                "a fired retry must not fire again");
        check(
                client.nextSubscriptionRetryAtNanos() == null,
                "no retry may remain pending once it has fired");
    }

    private static void hintLeavesErrorCallbackAsBefore(Map<String, Object> retry)
            throws IOException {
        List<Map<String, Object>> sent = new ArrayList<>();
        List<Client.SubscriptionError> errors = new ArrayList<>();
        Client client = openSubscribed(retry, sent, errors);

        client.handleFrame(Json.write(retry.get("hintFrame")));

        check(errors.size() == 1, "the error callback must still fire once for a hinted error");
        check(
                "SUBSCRIPTION_REFRESH_FAILED".equals(errors.get(0).code()),
                "the error callback must still receive the server's code");
    }

    @SuppressWarnings("unchecked")
    private static void laterHintReplacesPendingRetry(Map<String, Object> retry)
            throws IOException {
        List<Map<String, Object>> sent = new ArrayList<>();
        Client client = hinted(retry, sent);

        long first = client.nextSubscriptionRetryAtNanos();

        client.handleFrame(Json.write(retry.get("laterHintFrame")));

        long second = client.nextSubscriptionRetryAtNanos();

        check(second - first > 0, "a later hint must push the pending retry later");
        check(
                client.retryDueSubscriptions(first) == 0 && sent.isEmpty(),
                "the replaced retry must not fire at its old deadline");
        check(
                client.retryDueSubscriptions(second) == 1,
                "the replacing retry must fire at its new deadline");
    }

    @SuppressWarnings("unchecked")
    private static void answeringFramesCancelRetry(Map<String, Object> retry) throws IOException {
        for (Object entry : (List<Object>) retry.get("cancelFrames")) {
            Map<String, Object> cancel = (Map<String, Object>) entry;
            List<Map<String, Object>> sent = new ArrayList<>();
            Client client = hinted(retry, sent);

            client.handleFrame(Json.write(cancel.get("frame")));

            check(
                    client.nextSubscriptionRetryAtNanos() == null,
                    "a " + cancel.get("name") + " frame must cancel the pending retry");
            check(
                    client.retryDueSubscriptions(System.nanoTime() + 60 * SECOND_NANOS) == 0
                            && sent.isEmpty(),
                    "a cancelled retry must never send, even far past its deadline");
        }
    }

    @SuppressWarnings("unchecked")
    private static void framesWithoutAValidHintScheduleNothing(Map<String, Object> retry)
            throws IOException {
        for (Object entry : (List<Object>) retry.get("noRetryFrames")) {
            Map<String, Object> rejected = (Map<String, Object>) entry;
            List<Map<String, Object>> sent = new ArrayList<>();
            Client client = openSubscribed(retry, sent, new ArrayList<>());

            client.handleFrame(Json.write(rejected.get("frame")));

            check(
                    client.nextSubscriptionRetryAtNanos() == null,
                    "a " + rejected.get("name") + " error must schedule no retry");
        }
    }

    private static void unsubscribeSocketChangesAndCloseCancelRetry(Map<String, Object> retry)
            throws IOException {
        List<Map<String, Object>> sent = new ArrayList<>();
        Client unsubscribing = new Client("https://app.example", null);

        unsubscribing.attachSocket(sent::add, null);

        Runnable unsubscribe =
                unsubscribing.subscribe(
                        "messages:list",
                        Map.of("channel", "general"),
                        value -> {},
                        error -> {},
                        null);

        unsubscribing.handleFrame(Json.write(retry.get("seedFrame")));
        unsubscribing.handleFrame(Json.write(retry.get("hintFrame")));
        unsubscribe.run();

        check(
                unsubscribing.nextSubscriptionRetryAtNanos() == null,
                "an unsubscribe must cancel the pending retry");

        Client detached = hinted(retry, new ArrayList<>());

        detached.detachSocket(null, null);

        check(
                detached.nextSubscriptionRetryAtNanos() == null,
                "a socket detach must cancel the pending retry");

        Client reattached = hinted(retry, new ArrayList<>());

        reattached.attachSocket(new ArrayList<Map<String, Object>>()::add, null);

        check(
                reattached.nextSubscriptionRetryAtNanos() == null,
                "a socket attach must cancel the pending retry");

        Client closed = hinted(retry, new ArrayList<>());

        closed.close();

        check(
                closed.nextSubscriptionRetryAtNanos() == null,
                "closing the client must cancel the pending retry");
    }

    private static void shapeErrorSchedulesNothing(Map<String, Object> retry) throws IOException {
        List<Map<String, Object>> sent = new ArrayList<>();
        Client client = new Client("https://app.example", null);

        client.attachSocket(sent::add, null);
        client.subscribeShape(
                "messages:list", Map.of("channel", "general"), rows -> {}, error -> {});
        client.handleFrame(
                Json.write(
                        Map.of(
                                "id",
                                "shape_1",
                                "type",
                                "error",
                                "error",
                                Map.of(
                                        "code",
                                        "SUBSCRIPTION_REFRESH_FAILED",
                                        "message",
                                        "refresh failed",
                                        "retryAfterMs",
                                        5000))));

        check(
                client.nextSubscriptionRetryAtNanos() == null,
                "a shape error must not schedule a query re-subscribe");
    }

    private static void hintIsClampedToMaxRetryAfter(Map<String, Object> retry) throws IOException {
        List<Map<String, Object>> sent = new ArrayList<>();
        Client client = openSubscribed(retry, sent, new ArrayList<>());

        long t0 = System.nanoTime();

        client.handleFrame(
                Json.write(
                        Map.of(
                                "id",
                                "sub_1",
                                "type",
                                "error",
                                "error",
                                Map.of(
                                        "code",
                                        "SUBSCRIPTION_REFRESH_FAILED",
                                        "message",
                                        "refresh failed",
                                        "retryAfterMs",
                                        3600000))));

        long t1 = System.nanoTime();
        Long due = client.nextSubscriptionRetryAtNanos();

        check(due != null, "a clamped hint must still schedule a retry");
        check(
                due - (t0 + 60 * SECOND_NANOS) >= 0 && (t1 + 60 * SECOND_NANOS) - due >= 0,
                "a retry hint above the 60000ms cap must be clamped to exactly that cap");
    }

    /**
     * An unsubscribe on another thread can reach the socket between the retry's selection and its
     * write; the retry must then be followed by another unsubscribe.
     */
    private static void unsubscribeThatOvertakesRetryIsFollowedByAnother(Map<String, Object> retry)
            throws IOException {
        List<Map<String, Object>> sent = new ArrayList<>();
        Runnable[] unsubscribe = new Runnable[1];
        boolean[] armed = {false};
        Client client = new Client("https://app.example", null);

        client.attachSocket(
                frame -> {
                    if (armed[0] && "subscribe".equals(frame.get("type"))) {
                        armed[0] = false;
                        unsubscribe[0].run();
                    }
                    sent.add(frame);
                },
                null);
        Map<String, Object> args = Map.of("channel", "general");

        unsubscribe[0] = client.subscribe("messages:list", args, value -> {}, error -> {}, null);
        client.handleFrame(Json.write(retry.get("seedFrame")));
        client.handleFrame(Json.write(retry.get("hintFrame")));
        Long due = client.nextSubscriptionRetryAtNanos();
        sent.clear();
        armed[0] = true;

        client.retryDueSubscriptions(due);

        List<Object> types = new ArrayList<>();

        for (Map<String, Object> frame : sent) {
            types.add(frame.get("type"));
        }

        check(
                types.equals(List.of("unsubscribe", "subscribe", "unsubscribe")),
                "a retry overtaken by an unsubscribe must be followed by another, got " + types);
    }

    /** A sender that throws must not discard the retries whose frames it never wrote. */
    private static void failedSendKeepsUnsentRetriesDue(Map<String, Object> retry)
            throws IOException {
        boolean[] failing = {false};
        List<Map<String, Object>> sent = new ArrayList<>();
        Client client = new Client("https://app.example", null);

        client.attachSocket(
                frame -> {
                    if (failing[0] && "subscribe".equals(frame.get("type"))) {
                        failing[0] = false;
                        throw new IllegalStateException("socket write failed");
                    }
                    sent.add(frame);
                },
                null);
        client.subscribe("messages:list", Map.of("channel", "a"), value -> {}, error -> {}, null);
        client.subscribe("messages:list", Map.of("channel", "b"), value -> {}, error -> {}, null);

        for (String id : List.of("sub_1", "sub_2")) {
            client.handleFrame(
                    Json.write(
                            Map.of(
                                    "id",
                                    id,
                                    "type",
                                    "error",
                                    "error",
                                    Map.of(
                                            "code",
                                            "SUBSCRIPTION_REFRESH_FAILED",
                                            "message",
                                            "refresh failed",
                                            "retryAfterMs",
                                            5000))));
        }

        long later = System.nanoTime() + 10 * SECOND_NANOS;
        boolean threw = false;

        failing[0] = true;

        try {
            client.retryDueSubscriptions(later);
        } catch (IllegalStateException expected) {
            threw = true;
        }

        check(threw, "the sender's failure must reach the caller");
        sent.clear();
        check(
                client.retryDueSubscriptions(later) == 2,
                "both retries must stay due after a failed write");
    }
}
