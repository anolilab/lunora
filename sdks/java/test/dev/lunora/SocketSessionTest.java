package dev.lunora;

import static dev.lunora.ConformanceTest.check;
import static dev.lunora.ConformanceTest.covers;
import static dev.lunora.ConformanceTest.fixture;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Socket-session cases: the {@code connect} frame and the credentials it carries, the close codes
 * that report token expiry, and whisper topics. Driven through the client's own calls and checked
 * against the shared goldens in {@code protocol/fixtures/ws-frames.json}.
 */
final class SocketSessionTest {
    private SocketSessionTest() {}

    static void run() throws IOException {
        connectFrameFirstAndCarriesSessionToken();
        wsUrlCarriesOnlyTheAdminTicket();
        attachSocketCarriesConnectionContext();
        closeCodesDriveTokenExpiry();
        whisperFramesJoinSendAndDeliver();
        whisperTopicsRejoinAfterReconnect();
        closedRoomRefusesSends();
        failedUnsubscribeCanBeRetried();
        supersededAttachStopsWritingJoins();
    }

    /** The first frame of every open is {@code connect}, carrying the session credential. */
    @SuppressWarnings("unchecked")
    private static void connectFrameFirstAndCarriesSessionToken() throws IOException {
        covers("connect_frame_first_and_carries_session_token");

        Map<String, Object> golden =
                (Map<String, Object>) fixture("ws-frames.json").get("clientFrames");
        Client client = new Client("https://app.example", null);

        client.clientId = "client-test";
        client.authToken("rpc-bearer");
        client.wsToken(() -> "session-token");
        client.subscribe("messages:list", Map.of("channel", "general"), value -> {}, null, null);

        List<Map<String, Object>> sent = new ArrayList<>();

        client.attachSocket(sent::add, null);
        client.resendSubscriptions();

        check(
                "connect".equals(sent.get(0).get("type")),
                "frame 0 of an open must be connect, before any resubscribe");
        check("subscribe".equals(sent.get(1).get("type")), "the resubscribe must follow connect");
        check(
                "session-token".equals(sent.get(0).get("token")),
                "connect must carry the session credential as token");
        check(
                Key.stableStringify(sent.get(0))
                        .equals(Key.stableStringify(golden.get("connect-with-token"))),
                "the connect frame must match the connect-with-token golden");
        check(
                Key.stableStringify(Client.buildConnectFrame("client-test", null, "session-token"))
                        .equals(Key.stableStringify(golden.get("connect-with-token"))),
                "buildConnectFrame must produce the connect-with-token golden");

        String url = client.wsUrl(null);

        check(
                !url.contains("session-token") && !url.contains("rpc-bearer"),
                "neither the session credential nor the RPC bearer may appear in the socket URL");

        Client bare = new Client("https://app.example", null);
        List<Map<String, Object>> unauthenticated = new ArrayList<>();

        bare.attachSocket(unauthenticated::add, null);

        check(
                !unauthenticated.get(0).containsKey("token"),
                "connect must omit token when no session credential is set");
    }

    /**
     * The socket URL carries the admin ticket as {@code ?token=}, and nothing else credential-like.
     */
    private static void wsUrlCarriesOnlyTheAdminTicket() {
        covers("ws_url_carries_only_the_admin_ticket");

        Client client = new Client("https://app.example", null);

        client.authToken("rpc-bearer");
        client.wsToken(() -> "session-token");

        check(
                client.wsUrl(null).equals("wss://app.example/_lunora/ws"),
                "with no ticket the URL must carry no token parameter");

        client.wsTicket(() -> "v1.1700000000000.signature");

        check(
                client.wsUrl(null)
                        .equals("wss://app.example/_lunora/ws?token=v1.1700000000000.signature"),
                "the ticket must be the only token parameter on the URL");
    }

    /**
     * The connection context rides {@code connect}, in the shape the golden pins, and only when
     * given.
     */
    @SuppressWarnings("unchecked")
    private static void attachSocketCarriesConnectionContext() throws IOException {
        covers("attach_socket_carries_connection_context");

        Map<String, Object> golden =
                (Map<String, Object>) fixture("ws-frames.json").get("clientFrames");
        Map<String, Object> connectWithContext =
                (Map<String, Object>) golden.get("connect-with-context");
        Map<String, Object> context = (Map<String, Object>) connectWithContext.get("context");
        Client client = new Client("https://app.example", null);

        client.clientId = "client-test";

        List<Map<String, Object>> withContext = new ArrayList<>();

        client.attachSocket(withContext::add, context);

        check(
                Key.stableStringify(withContext.get(0))
                        .equals(Key.stableStringify(connectWithContext)),
                "connect with a context must match the connect-with-context golden");

        List<Map<String, Object>> withoutContext = new ArrayList<>();

        client.attachSocket(withoutContext::add, null);

        check(
                !withoutContext.get(0).containsKey("context"),
                "connect with no context must omit the context field");
    }

    /**
     * Every close and frame in {@code closeSequences} drives the same number of token-expiry
     * notifications. A listener that throws is registered first in each run, so the count also
     * shows a throwing listener neither breaks a detach nor hides the others.
     */
    @SuppressWarnings("unchecked")
    private static void closeCodesDriveTokenExpiry() throws IOException {
        covers("close_codes_drive_token_expiry");

        Map<String, Object> document =
                (Map<String, Object>) fixture("ws-frames.json").get("closeSequences");

        for (Object raw : (List<Object>) document.get("cases")) {
            Map<String, Object> testCase = (Map<String, Object>) raw;
            String name = (String) testCase.get("name");
            Client client = new Client("https://app.example", null);
            int[] notified = {0};
            int[] subscriptionErrors = {0};

            client.onTokenExpired(
                    () -> {
                        throw new IllegalStateException("an app listener that throws");
                    });
            client.onTokenExpired(() -> notified[0]++);
            client.subscribe(
                    "messages:list",
                    Map.of("channel", "general"),
                    value -> {},
                    error -> subscriptionErrors[0]++,
                    null);

            List<Map<String, Object>> sent = new ArrayList<>();

            for (Object rawStep : (List<Object>) testCase.get("steps")) {
                Map<String, Object> step = (Map<String, Object>) rawStep;

                if (step.containsKey("attach")) {
                    client.attachSocket(sent::add, null);
                } else if (step.containsKey("close")) {
                    Map<String, Object> close = (Map<String, Object>) step.get("close");

                    client.detachSocket(
                            ((Number) close.get("code")).intValue(), (String) close.get("reason"));
                    check(!client.online(), name + ": every close leaves the client offline");
                } else if (step.containsKey("frame")) {
                    client.handleFrame(Json.write(step.get("frame")));
                } else if (step.containsKey("credentialChange")) {
                    client.wsToken(() -> "rotated-session-token");
                } else {
                    throw new IllegalStateException("unknown step in " + name);
                }
            }

            check(
                    notified[0] == ((Number) testCase.get("tokenExpiredNotifications")).intValue(),
                    name + ": token-expiry notifications");

            if (testCase.containsKey("subscriptionErrors")) {
                check(
                        subscriptionErrors[0]
                                == ((Number) testCase.get("subscriptionErrors")).intValue(),
                        name + ": subscription errors");
            }
        }

        Client client = new Client("https://app.example", null);
        int[] notified = {0};
        Runnable unregister = client.onTokenExpired(() -> notified[0]++);

        unregister.run();
        client.attachSocket(frame -> {}, null);
        client.detachSocket(4001, "");

        check(notified[0] == 0, "an unregistered token-expiry listener must not be called");
    }

    /**
     * Each whisper server frame is delivered to its topic's listeners only, and the builders match
     * the goldens.
     */
    @SuppressWarnings("unchecked")
    private static void whisperFramesJoinSendAndDeliver() throws IOException {
        covers("whisper_frames_join_send_and_deliver");

        Map<String, Object> golden =
                (Map<String, Object>) fixture("ws-frames.json").get("clientFrames");
        Map<String, Object> payload = new LinkedHashMap<>();

        payload.put("text", "hi");

        check(
                Key.stableStringify(Client.buildWhisperSubscribeFrame("room:general"))
                        .equals(Key.stableStringify(golden.get("whisper-subscribe"))),
                "the whisper_subscribe builder must match its golden");
        check(
                Key.stableStringify(Client.buildWhisperUnsubscribeFrame("room:general"))
                        .equals(Key.stableStringify(golden.get("whisper-unsubscribe"))),
                "the whisper_unsubscribe builder must match its golden");
        check(
                Key.stableStringify(Client.buildWhisperFrame("room:general", payload))
                        .equals(Key.stableStringify(golden.get("whisper-send"))),
                "the whisper builder must match its golden");

        Client detached = new Client("https://app.example", null);

        check(
                !detached.whisper("room:general", payload),
                "a whisper with no socket attached must report false, not queue");

        List<Map<String, Object>> sent = new ArrayList<>();
        Client client = new Client("https://app.example", null);

        client.clientId = "client-test";
        client.attachSocket(sent::add, null);

        Runnable leave = client.whisperSubscribe("room:general", value -> {});

        check(
                Key.stableStringify(sent.get(1))
                        .equals(Key.stableStringify(golden.get("whisper-subscribe"))),
                "a join while attached must send whisper_subscribe");
        check(
                client.whisper("room:general", payload),
                "a whisper with a socket attached must send");
        check(
                Key.stableStringify(sent.get(2))
                        .equals(Key.stableStringify(golden.get("whisper-send"))),
                "the whisper frame sent must match the whisper-send golden");

        leave.run();
        leave.run();

        check(
                sent.size() == 4
                        && Key.stableStringify(sent.get(3))
                                .equals(Key.stableStringify(golden.get("whisper-unsubscribe"))),
                "leaving the last listener must send one whisper_unsubscribe");

        Map<String, Object> whisper =
                (Map<String, Object>) fixture("ws-frames.json").get("whisperFrames");

        for (Object raw : (List<Object>) whisper.get("serverFrames")) {
            Map<String, Object> serverCase = (Map<String, Object>) raw;
            String name = (String) serverCase.get("name");
            Client receiver = new Client("https://app.example", null);
            // Joined to room:general alone: a frame on any other topic must not reach the listener.
            List<Object> received = new ArrayList<>();

            receiver.whisperSubscribe("room:general", received::add);
            receiver.handleFrame(Json.write(serverCase.get("frame")));

            List<Object> expected = new ArrayList<>();

            for (Object rawDelivery : (List<Object>) serverCase.get("delivered")) {
                Map<String, Object> delivery = (Map<String, Object>) rawDelivery;

                if ("room:general".equals(delivery.get("topic"))) {
                    expected.add(delivery.get("value"));
                }
            }

            check(
                    Key.stableStringify(Wire.encode(received))
                            .equals(Key.stableStringify(expected)),
                    name + ": values delivered to the room:general listener");
        }
    }

    /**
     * A last-listener leave whose unsubscribe write fails stays registered, so the leave can be
     * retried.
     */
    private static void failedUnsubscribeCanBeRetried() {
        List<Map<String, Object>> sent = new ArrayList<>();
        boolean[] refuse = {true};
        Client client = new Client("https://app.example", null);

        client.clientId = "client-test";
        client.attachSocket(
                frame -> {
                    if ("whisper_unsubscribe".equals(frame.get("type")) && refuse[0]) {
                        refuse[0] = false;
                        throw new IllegalStateException("write refused");
                    }

                    sent.add(frame);
                },
                null);

        Runnable leave = client.whisperSubscribe("room:general", value -> {});

        try {
            leave.run();
            check(false, "the refused unsubscribe must surface to the caller");
        } catch (IllegalStateException expected) {
            // The write was refused, as the sender reported.
        }

        leave.run();

        check(
                sent.stream().anyMatch(frame -> "whisper_unsubscribe".equals(frame.get("type"))),
                "the retried leave must write whisper_unsubscribe");
    }

    /**
     * A sender that detaches during the attach's joins stops the remaining joins from being
     * written.
     */
    private static void supersededAttachStopsWritingJoins() {
        List<Map<String, Object>> sent = new ArrayList<>();
        Client client = new Client("https://app.example", null);

        client.clientId = "client-test";
        client.whisperSubscribe("room:a", value -> {});
        client.whisperSubscribe("room:b", value -> {});
        client.attachSocket(
                frame -> {
                    sent.add(frame);

                    if ("whisper_subscribe".equals(frame.get("type"))) {
                        client.detachSocket(null, null);
                    }
                },
                null);

        check(
                sent.stream().filter(frame -> "whisper_subscribe".equals(frame.get("type"))).count()
                        == 1,
                "a detach during the joins must stop the remaining joins");
    }

    /** A closed room refuses sends, even while another listener keeps its topic joined. */
    private static void closedRoomRefusesSends() {
        List<Map<String, Object>> sent = new ArrayList<>();
        Client client = new Client("https://app.example", null);

        client.clientId = "client-test";
        client.attachSocket(sent::add, null);

        Client.Room room = client.connectRoom("general", value -> {});

        client.whisperSubscribe("room:general", value -> {});
        room.close();

        check(!room.send("after close"), "a closed room must report its send as not sent");
        check(
                sent.stream().noneMatch(frame -> "whisper".equals(frame.get("type"))),
                "and must write no whisper frame after close");
    }

    /** Every attach re-joins each registered topic right after {@code connect}. */
    @SuppressWarnings("unchecked")
    private static void whisperTopicsRejoinAfterReconnect() throws IOException {
        covers("whisper_topics_rejoin_after_reconnect");

        Map<String, Object> whisper =
                (Map<String, Object>) fixture("ws-frames.json").get("whisperFrames");
        List<String> topics = (List<String>) whisper.get("rejoinOnReconnect");
        Client client = new Client("https://app.example", null);

        client.clientId = "client-test";
        client.wsToken(() -> "session-token");

        Client.Room room = client.connectRoom("general", value -> {});

        for (int attach = 0; attach < 2; attach++) {
            List<Map<String, Object>> sent = new ArrayList<>();

            client.attachSocket(sent::add, null);

            check("connect".equals(sent.get(0).get("type")), "connect must lead every attach");
            check(
                    sent.size() == 1 + topics.size(),
                    "each attach must send one whisper_subscribe per registered topic");

            for (int i = 0; i < topics.size(); i++) {
                check(
                        Key.stableStringify(sent.get(i + 1))
                                .equals(
                                        Key.stableStringify(
                                                Client.buildWhisperSubscribeFrame(topics.get(i)))),
                        "attach " + attach + " must rejoin " + topics.get(i) + " after connect");
            }

            client.detachSocket(null, null);
        }

        room.close();
    }
}
