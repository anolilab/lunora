// Calls every function of the `sdk-surface` spec through a generated SDK.
//
// GeneratedSmoke proves a call reaches the wire. This proves the surface handles
// every SHAPE a model backend renders differently: a no-arg function, id /
// number / array / record / null results, a nullable object, an array of
// objects, a union, an unset optional, bigint arguments and results (top level
// and nested), and keyword-named functions.
//
// Run by `sdks/generated-check.sh java` with the generated tree as the only
// source path.

import dev.lunora.Client;
import dev.lunora.Key;
import dev.lunora.Wire;

import lunoraapi.Api;
import lunoraapi.models.ItemsClearArgs;
import lunoraapi.models.ItemsCountArgs;
import lunoraapi.models.ItemsCreateArgs;
import lunoraapi.models.ItemsFindArgs;
import lunoraapi.models.ItemsLabelsArgs;
import lunoraapi.models.ItemsMatchArgs;
import lunoraapi.models.ItemsPageArgs;
import lunoraapi.models.ItemsPickArgs;
import lunoraapi.models.ItemsSelfArgs;
import lunoraapi.models.ItemsStatsArgs;
import lunoraapi.models.ItemsSummaryArgs;
import lunoraapi.models.ItemsSummaryResult;
import lunoraapi.models.ItemsTagsArgs;
import lunoraapi.models.ItemsTotalsArgs;
import lunoraapi.models.ItemsTypeArgs;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class SurfaceSmoke {
    private static final String BIG_FIVE = "[\"$lunora.wire$\",\"bigint\",\"5\"]";

    private static final List<String> FRAMES = new ArrayList<>();
    private static String reply = "null";

    public static void main(String[] args) {
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> {
                            FRAMES.add(
                                    Key.stableStringify(
                                            dev.lunora.Json.parse(
                                                    new String(
                                                            body,
                                                            java.nio.charset.StandardCharsets
                                                                    .UTF_8))));
                            return new Client.Response(200, "{\"result\":" + reply + "}");
                        });
        Api api = new Api(client);
        Api.ItemsApi items = api.items;
        Wire.WireBigInt five = new Wire.WireBigInt(BigInteger.valueOf(5));

        reply = "2";
        expect("count", items.count(new ItemsCountArgs(), null), 2.0);
        reply = "{\"size\":2,\"title\":\"t\"}";
        ItemsSummaryResult summary = items.summary(new ItemsSummaryArgs(), null);
        expect("summary", summary.size + " " + summary.title, "2.0 t");
        reply = "\"items_1\"";
        expect("create", items.create(new ItemsCreateArgs(null, "t"), null), "items_1");
        reply = "null";
        expect("clear", items.clear(new ItemsClearArgs(), null), null);
        reply = "[\"a\"]";
        expect("tags", items.tags(new ItemsTagsArgs(), null), List.of("a"));
        reply = "[\"b\"]";
        expect("labels", items.labels(new ItemsLabelsArgs(), null), List.of("b"));
        reply = "{\"a\":1}";
        expect("stats", items.stats(new ItemsStatsArgs(), null), Map.of("a", 1.0));
        reply = "{\"b\":2}";
        expect("totals", items.totals(new ItemsTotalsArgs(), null), Map.of("b", 2.0));
        reply = "null";
        expect("find", items.find(new ItemsFindArgs("items_1"), null), null);
        reply = "[{\"kind\":\"a\",\"title\":\"t\"}]";
        expect(
                "page",
                items.page(new ItemsPageArgs(), null),
                List.of(Map.of("kind", "a", "title", "t")));
        reply = "\"x\"";
        Map<String, Object> choice = Map.of("a", 1.0, "kind", "x");
        expect("pick", items.pick(new ItemsPickArgs(choice), null), "x");
        reply = "1";
        expect("match", items.match(new ItemsMatchArgs("p"), null), 1.0);
        expect("type", items.type(new ItemsTypeArgs(), null), 1.0);
        expect("self", items.self(new ItemsSelfArgs(), null), 1.0);

        reply = BIG_FIVE;
        expect("charge", api.ledger.charge(Map.of("amount", five), null), five);
        reply = "{\"rows\":[{\"amount\":" + BIG_FIVE + "}],\"total\":" + BIG_FIVE + "}";
        Object balances =
                api.ledger.balances(
                        Map.of("accounts", List.of(Map.of("id", "acc", "limit", five))), null);
        expect(
                "balances",
                balances,
                Map.of("rows", List.of(Map.of("amount", five)), "total", five));

        List<String> want =
                List.of(
                        "{\"args\":{},\"functionPath\":\"items:count\"}",
                        "{\"args\":{},\"functionPath\":\"items:summary\"}",
                        "{\"args\":{\"title\":\"t\"},\"functionPath\":\"items:create\"}",
                        "{\"args\":{},\"functionPath\":\"items:clear\"}",
                        "{\"args\":{},\"functionPath\":\"items:tags\"}",
                        "{\"args\":{},\"functionPath\":\"items:labels\"}",
                        "{\"args\":{},\"functionPath\":\"items:stats\"}",
                        "{\"args\":{},\"functionPath\":\"items:totals\"}",
                        "{\"args\":{\"id\":\"items_1\"},\"functionPath\":\"items:find\"}",
                        "{\"args\":{},\"functionPath\":\"items:page\"}",
                        "{\"args\":{\"choice\":{\"a\":1,\"kind\":\"x\"}},\"functionPath\":\"items:pick\"}",
                        "{\"args\":{\"pattern\":\"p\"},\"functionPath\":\"items:match\"}",
                        "{\"args\":{},\"functionPath\":\"items:type\"}",
                        "{\"args\":{},\"functionPath\":\"items:self\"}",
                        "{\"args\":{\"amount\":"
                                + BIG_FIVE
                                + "},\"functionPath\":\"ledger:charge\"}",
                        "{\"args\":{\"accounts\":[{\"id\":\"acc\",\"limit\":"
                                + BIG_FIVE
                                + "}]},\"functionPath\":\"ledger:balances\"}");

        expect("frames", FRAMES, want);

        System.out.println("OK — every sdk-surface shape reaches the wire and decodes");
    }

    private static void expect(String what, Object got, Object want) {
        if (!Objects.equals(got, want)) {
            throw new AssertionError(what + ": got " + got + ", want " + want);
        }
    }
}
