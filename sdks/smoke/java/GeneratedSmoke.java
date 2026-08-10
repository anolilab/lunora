import dev.lunora.Client;
import dev.lunora.Key;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Runs a generated call, rather than only compiling one.
 *
 * <p>This exists because the compile check alone was not enough: an earlier revision of the Java
 * target emitted a surface that type checked perfectly and threw {@code cannot encode a
 * lunoraapi.MessagesListArgs} on the first call. Building proves the shapes line up; only invoking
 * proves a request reaches the wire.
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
                            captured.append(
                                    new String(body, java.nio.charset.StandardCharsets.UTF_8));

                            return new Client.Response(200, "{\"result\":{\"ok\":true}}");
                        });

        lunoraapi.Api api = new lunoraapi.Api(client);
        Map<String, Object> callArgs = new LinkedHashMap<>();

        callArgs.put("channelId", "chan_1");
        api.messages.list(callArgs, null);

        String body = captured.toString();
        String want = "{\"args\":{\"channelId\":\"chan_1\"},\"functionPath\":\"messages:list\"}";
        String normalised = Key.stableStringify(dev.lunora.Json.parse(body));

        if (!normalised.equals(want)) {
            throw new AssertionError("generated call produced " + normalised + ", want " + want);
        }

        System.out.println("OK — the generated surface reaches the wire");
    }
}
