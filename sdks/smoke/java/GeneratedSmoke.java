import dev.lunora.Client;
import dev.lunora.Key;

import lunoraapi.models.MessagesListArgs;
import lunoraapi.models.MessagesSendArgs;
import lunoraapi.models.MessagesSendArgsKind;

/**
 * Runs generated calls, rather than only compiling them.
 *
 * <p>This exists because the compile check alone was not enough: an earlier revision of the Java
 * target emitted a surface that type checked perfectly and threw {@code cannot encode a
 * lunoraapi.MessagesListArgs} on the first call. Building proves the shapes line up; only invoking
 * proves a request reaches the wire.
 *
 * <p>The arguments are TYPED models, which is what makes the assertions cover the defect that
 * replaced them: each frame must carry the wire keys the SCHEMA declares — {@code channelId}, not
 * the {@code channelID} a field-name projection produces.
 *
 * <p>Two calls, because one does not reach every shape the models emit:
 *
 * <ul>
 *   <li>{@code messages:list} covers a required string and an OMITTED optional. {@code limit} is
 *       left null and must not appear in the frame at all — {@code v.optional} parses the value or
 *       {@code undefined} and rejects an explicit null, so sending one fails every such call.
 *   <li>{@code messages:send} covers the enum and the record. An enum must encode its own wire
 *       string ({@code "text"}, not the constant name), and a {@code Map<String, String>} must
 *       arrive as a JSON object.
 * </ul>
 *
 * <p>Compiled by {@code sdks/generated-check.sh java} with the generated SDK as the ONLY source
 * path — {@code javac -sourcepath $LUNORA_SDK_OUT} — against an SDK generated into a scratch
 * directory outside this repo. Both {@code dev.lunora} and {@code lunoraapi} therefore resolve out
 * of the vendored copy and nothing else, which is what the check is for.
 */
public final class GeneratedSmoke {
    public static void main(String[] args) {
        StringBuilder captured = new StringBuilder();

        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> {
                            // Reset, not append: this poster serves more than one call.
                            captured.setLength(0);
                            captured.append(
                                    new String(body, java.nio.charset.StandardCharsets.UTF_8));

                            return new Client.Response(200, "{\"result\":{\"ok\":true}}");
                        });

        lunoraapi.Api api = new lunoraapi.Api(client);

        api.messages.list(new MessagesListArgs("chan_1", null), null);
        assertFrame(
                captured,
                "{\"args\":{\"channelId\":\"chan_1\"},\"functionPath\":\"messages:list\"}");

        java.util.Map<String, String> tags = new java.util.LinkedHashMap<>();

        tags.put("topic", "release");

        api.messages.send(
                new MessagesSendArgs("chan_1", "hi", MessagesSendArgsKind.TEXT, tags), null);
        assertFrame(
                captured,
                "{\"args\":{\"channelId\":\"chan_1\",\"kind\":\"text\",\"tags\":{\"topic\":\"release\"},"
                    + "\"text\":\"hi\"},\"functionPath\":\"messages:send\"}");

        // The generated watch member reaches the primitive with the right function path. The
        // subscribe frame is sent at call time, the first data frame is decoded through the
        // iterator, and closing the watch sends the unsubscribe for the same id.
        java.util.List<java.util.Map<String, Object>> watchFrames = new java.util.ArrayList<>();
        Client watchClient =
                new Client(
                        "https://app.example",
                        (url, headers, body) ->
                                new Client.Response(200, "{\"result\":{\"ok\":true}}"));

        watchClient.attachSocket(watchFrames::add, null);

        var watch =
                new lunoraapi.Api(watchClient)
                        .messages.watchList(new MessagesListArgs("chan_1", null), null);

        java.util.Map<String, Object> subscribe = framesOfType(watchFrames, "subscribe");
        java.util.Map<?, ?> query = (java.util.Map<?, ?>) subscribe.get("query");

        if (!"messages:list".equals(query.get("functionPath"))) {
            throw new AssertionError(
                    "watch subscribed to " + query.get("functionPath") + ", want messages:list");
        }

        String sentArgs = Key.stableStringify(query.get("args"));

        if (!sentArgs.equals("{\"channelId\":\"chan_1\"}")) {
            throw new AssertionError("watch sent args " + sentArgs);
        }

        String id = (String) subscribe.get("id");

        watchClient.handleFrame(
                "{\"cursor\":1,\"data\":{\"ok\":true},\"id\":\"" + id + "\",\"type\":\"data\"}");

        var event = watch.iterator().next();

        if (event.error() != null) {
            throw new AssertionError("watch delivered an error: " + event.error());
        }

        String decoded = Key.stableStringify(event.value());

        if (!decoded.equals("{\"ok\":true}")) {
            throw new AssertionError("watch yielded " + decoded + ", want {\"ok\":true}");
        }

        watch.close();

        if (!id.equals(framesOfType(watchFrames, "unsubscribe").get("id"))) {
            throw new AssertionError("closing the watch did not unsubscribe " + id);
        }

        System.out.println(
                "OK — the generated surface reaches the wire, and the watch member reaches the"
                        + " primitive");
    }

    /** The single frame of {@code kind} that was sent; fails when none or several were. */
    private static java.util.Map<String, Object> framesOfType(
            java.util.List<java.util.Map<String, Object>> frames, String kind) {
        java.util.List<java.util.Map<String, Object>> found = new java.util.ArrayList<>();

        for (java.util.Map<String, Object> frame : frames) {
            if (kind.equals(frame.get("type"))) {
                found.add(frame);
            }
        }

        if (found.size() != 1) {
            throw new AssertionError(
                    "sent " + found.size() + " " + kind + " frames, want exactly one");
        }

        return found.get(0);
    }

    /** Normalises key order out of the comparison, so only the keys and values are asserted. */
    private static void assertFrame(StringBuilder captured, String want) {
        String normalised = Key.stableStringify(dev.lunora.Json.parse(captured.toString()));

        if (!normalised.equals(want)) {
            throw new AssertionError("generated call produced " + normalised + ", want " + want);
        }
    }
}
