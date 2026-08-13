import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { OpenRpcDocument } from "../src/sdk";
import { generateSdk } from "../src/sdk";
import { dartLiteral, dartTarget, memberName, repairOptionals } from "../src/sdk/targets/dart";

const fixture = (): OpenRpcDocument =>
    JSON.parse(readFileSync(join(__dirname, "fixtures", "simple", "expected", "_generated", "openrpc.json"), "utf8")) as OpenRpcDocument;

/** A document whose args carry an OPTIONAL record and an OPTIONAL array — the two shapes quicktype's Dart backend gets wrong. */
const optionalsDocument: OpenRpcDocument = {
    methods: [
        {
            name: "records:put",
            params: [
                {
                    name: "args",
                    schema: {
                        additionalProperties: false,
                        properties: {
                            id: { type: "string" },
                            labels: { items: { type: "string" }, type: "array" },
                            tags: { additionalProperties: { type: "string" }, type: "object" },
                        },
                        required: ["id"],
                        type: "object",
                    },
                },
            ],
            summary: "mutation: records:put",
            "x-lunora-function-kind": "mutation",
        },
    ],
};

describe("dart memberName", () => {
    it("camel-cases and suffixes Dart reserved words", () => {
        expect.assertions(4);

        expect(memberName("listMessages")).toBe("listMessages");
        expect(memberName("list_messages")).toBe("listMessages");
        // Dart has no backtick escape, so a reserved word takes a trailing
        // underscore — a LEADING one would make the member library-private.
        expect(memberName("switch")).toBe("switch_");
        expect(memberName("default")).toBe("default_");
    });
});

describe("dartLiteral", () => {
    it("escapes the dollar Dart would otherwise interpolate", () => {
        expect.assertions(3);

        // An export named `$client` would otherwise emit "billing:$client", which
        // compiles, runs, and posts a variable's value as the wire path.
        expect(dartLiteral("billing:$client")).toBe(String.raw`billing:\$client`);
        expect(dartLiteral('a"b')).toBe(String.raw`a\"b`);
        // The backslash pass runs first, so its own output is not re-escaped.
        expect(dartLiteral(String.raw`a\$b`)).toBe(String.raw`a\\\$b`);
    });
});

describe("repairOptionals", () => {
    it("turns an unset optional list into null rather than an empty list", () => {
        expect.assertions(2);

        expect(repairOptionals('labels: json["labels"] == null ? [] : List<String>.from(json["labels"]!.map((x) => x)),')).toBe(
            'labels: json["labels"] == null ? null : List<String>.from(json["labels"]!.map((x) => x)),',
        );
        expect(repairOptionals('"labels": labels == null ? [] : List<dynamic>.from(labels!.map((x) => x)),')).toBe(
            '"labels": labels == null ? null : List<dynamic>.from(labels!.map((x) => x)),',
        );
    });

    it("guards the null-assertion quicktype puts on an optional map", () => {
        expect.assertions(2);

        // Unrepaired, both of these throw "Null check operator used on a null
        // value" the moment the optional record is unset.
        expect(repairOptionals('tags: Map.from(json["tags"]!).map((k, v) => MapEntry<String, String>(k, v)),')).toBe(
            'tags: json["tags"] == null ? null : Map.from(json["tags"]!).map((k, v) => MapEntry<String, String>(k, v)),',
        );
        expect(repairOptionals('"tags": Map.from(tags!).map((k, v) => MapEntry<String, dynamic>(k, v)),')).toBe(
            '"tags": tags == null ? null : Map.from(tags!).map((k, v) => MapEntry<String, dynamic>(k, v)),',
        );
    });

    it("leaves a required map alone", () => {
        expect.assertions(1);

        // The `!` IS quicktype's nullability marker: a required record renders
        // without one, so the rewrite must not fire and must not introduce a null
        // into a non-nullable field.
        const required = 'tags: Map.from(json["tags"]).map((k, v) => MapEntry<String, String>(k, v)),';

        expect(repairOptionals(required)).toBe(required);
    });
});

describe("generateSdk (dart)", () => {
    it("emits one package whose surface re-exports the vendored transport", async () => {
        expect.assertions(6);

        const { files } = await generateSdk(fixture(), dartTarget);

        expect(Object.keys(files).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["lib/lunora_api.dart", "lib/models.dart", "pubspec.yaml"]);

        const api = files["lib/lunora_api.dart"] ?? "";

        // One import for a consumer: the surface re-exports the transport and the
        // models, so `package:lunora_sdk/lunora_api.dart` is the whole SDK.
        expect(api).toContain("export 'lunora.dart';");
        expect(api).toContain("export 'models.dart';");
        // pub takes a path dependency's identity from this name, not the output
        // directory — the opposite of SwiftPM.
        expect(files["pubspec.yaml"]).toContain("name: lunora_sdk");
        expect(api).toContain("class MessagesApi {");
        expect(api).toContain("class Api {");
    });

    it("routes each verb over its own runtime method and projects typed args", async () => {
        expect.assertions(2);

        const { files } = await generateSdk(fixture(), dartTarget);
        const api = files["lib/lunora_api.dart"] ?? "";

        // `wireValue`, not the model itself: it is what drops an unset optional,
        // and passing the model straight through would send `"limit": null`,
        // which `v.optional()` rejects.
        expect(api).toContain('_client.query("messages:list", args: LunoraClient.wireValue(args)');
        expect(api).toContain('_client.mutation("messages:send", args: LunoraClient.wireValue(args)');
    });

    it("gives every query a callback subscription and a Stream, and a mutation neither", async () => {
        expect.assertions(4);

        const { files } = await generateSdk(fixture(), dartTarget);
        const api = files["lib/lunora_api.dart"] ?? "";

        expect(api).toContain("LunoraUnsubscribe subscribeList(");
        // The Flutter binding: a StreamBuilder consumes this directly.
        expect(api).toContain("Stream<Object?> watchList(");
        // A write has nothing for the server to re-run, so a subscription on one
        // would generate a call the server rejects.
        expect(api).not.toContain("subscribeSend(");
        expect(api).not.toContain("watchSend(");
    });

    it("guards every optional map and drops every empty-list fallback in the models", async () => {
        expect.assertions(5);

        const { files } = await generateSdk(optionalsDocument, dartTarget);
        const models = files["lib/models.dart"] ?? "";

        // The fields quicktype declares nullable, and therefore the ones its own
        // codecs then mishandle.
        expect(models).toContain("Map<String, String>? tags");
        expect(models).toContain("List<String>? labels");

        // Guards against a quicktype bump quietly reintroducing either defect.
        // Unrepaired, the first pair throws "Null check operator used on a null
        // value" the moment `tags` is unset, and the second sends `[]` where the
        // server expects an absent key. Both verified against a real generated
        // SDK, analysed and run.
        expect(models).toContain('tags: json["tags"] == null ? null : Map.from(json["tags"]!)');
        expect(models).toContain('"tags": tags == null ? null : Map.from(tags!)');
        expect(models).not.toContain("== null ? [] :");
    });
});
