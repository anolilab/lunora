// Invariants that must hold for EVERY registered target. Table-driven over
// SDK_TARGETS, so adding a language inherits these guarantees at zero test cost
// — and a language whose backend behaves differently fails here rather than in
// a consumer's build.

import { describe, expect, it } from "vitest";

import type { OpenRpcDocument } from "../src/sdk";
import { generateSdk, SDK_TARGETS } from "../src/sdk";

const targets = Object.values(SDK_TARGETS);

/** A document exercising object args plus each result shape a backend treats differently. */
const document = (resultSchema: Record<string, unknown>): OpenRpcDocument => {
    return {
        methods: [
            {
                name: "messages:count",
                params: [{ name: "args", schema: { properties: { channelId: { type: "string" } }, type: "object" } }],
                result: { name: "result", schema: resultSchema },
                summary: "query: messages:count",
                "x-lunora-function-kind": "query",
            },
        ],
    };
};

const RESULT_SHAPES = {
    "array-of-object": { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" },
    "array-of-scalar": { items: { type: "string" }, type: "array" },
    object: { properties: { total: { type: "number" } }, type: "object" },
    scalar: { type: "string" },
};

describe("assertGeneratable", () => {
    it("rejects a namespace that would produce an invalid identifier", async () => {
        expect.assertions(1);

        // `lunora/2fa.ts` is a legal source file, and `2faApi` is a syntax
        // error in every target language.
        const digitLed: OpenRpcDocument = { methods: [{ name: "2fa:verify", "x-lunora-function-kind": "query" }] };

        await expect(generateSdk(digitLed, targets[0]!)).rejects.toThrow(/invalid identifier/u);
    });

    it("rejects two namespaces that collapse to one generated name", async () => {
        expect.assertions(1);

        // Pascal-casing is not injective; both of these yield `UserProfile`,
        // which is a duplicate declaration in Go and a silent shadow in Python.
        const colliding: OpenRpcDocument = {
            methods: [
                { name: "user_profile:get", "x-lunora-function-kind": "query" },
                { name: "userProfile:get", "x-lunora-function-kind": "query" },
            ],
        };

        await expect(generateSdk(colliding, targets[0]!)).rejects.toThrow(/both generate/u);
    });

    it("rejects two functions in one namespace that collapse to one method", async () => {
        expect.assertions(1);

        const colliding: OpenRpcDocument = {
            methods: [
                { name: "messages:get_thing", "x-lunora-function-kind": "query" },
                { name: "messages:getThing", "x-lunora-function-kind": "query" },
            ],
        };

        await expect(generateSdk(colliding, targets[0]!)).rejects.toThrow(/both generate/u);
    });
});

describe("wire types no model can carry", () => {
    it("generates no args model for a v.bigint() or v.bytes() argument", async () => {
        expect.assertions(3);

        // v.bigint() schemas as {format:"int64",type:"integer"} and v.bytes() as
        // {contentEncoding:"base64",type:"string"}. quicktype renders those as a
        // plain integer and string, but the wire needs the TAGGED forms — a
        // typed model would send a number where the server demands a bigint and
        // every call would fail validation.
        const spec: OpenRpcDocument = {
            methods: [
                {
                    name: "billing:charge",
                    params: [
                        {
                            name: "args",
                            schema: {
                                properties: { amount: { format: "int64", type: "integer" }, blob: { contentEncoding: "base64", type: "string" } },
                                type: "object",
                            },
                        },
                    ],
                    "x-lunora-function-kind": "action",
                },
            ],
        };

        const { files, unrepresentable } = await generateSdk(spec, targets[0]!);

        expect(unrepresentable).toStrictEqual(["billing:charge"]);
        expect(Object.values(files).join("\n")).not.toContain("BillingChargeArgs");
        // The call itself is still generated — just with untyped args.
        expect(Object.values(files).join("\n")).toContain("billing:charge");
    });

    it("still types a v.date() argument, which is genuinely epoch-ms on the wire", async () => {
        expect.assertions(1);

        const spec: OpenRpcDocument = {
            methods: [
                {
                    name: "events:at",
                    params: [{ name: "args", schema: { properties: { when: { description: "epoch milliseconds (date)", type: "integer" } }, type: "object" } }],
                    "x-lunora-function-kind": "query",
                },
            ],
        };

        const { unrepresentable } = await generateSdk(spec, targets[0]!);

        expect(unrepresentable).toStrictEqual([]);
    });
});

// The JVM targets emit their own models (`sdk/jvm-models.ts`) rather than using
// quicktype, because quicktype's Java and Kotlin backends rename properties. These
// assert the property that makes emitting them here worthwhile, and they do it
// WITHOUT a JVM: the wire key must survive verbatim.
//
// The five keys below are the ones measured to still rename under quicktype's most
// permissive `acronym-style: original` — the reason no renderer option was enough.
// `sdks/generated-check.sh java|kotlin` covers the same property end to end for
// `channelId` by running a call; this covers the shapes a fixture does not reach.
describe.each([
    ["java", SDK_TARGETS["java"]!],
    ["kotlin", SDK_TARGETS["kotlin"]!],
])("jvm models: %s", (_id, target) => {
    const RENAMED_BY_QUICKTYPE = ["2fa", "ID", "URLs", "some-key", "user_name"];

    const wideDocument: OpenRpcDocument = {
        methods: [
            {
                name: "wide:save",
                params: [
                    {
                        name: "args",
                        schema: {
                            properties: Object.fromEntries([...RENAMED_BY_QUICKTYPE, "channelId"].map((key) => [key, { type: "string" }])),
                            required: [...RENAMED_BY_QUICKTYPE, "channelId"],
                            type: "object",
                        },
                    },
                ],
                "x-lunora-function-kind": "mutation",
            },
        ],
    };

    it.each(RENAMED_BY_QUICKTYPE)("carries the wire key %s verbatim into toWire and fromWire", async (wireKey) => {
        expect.assertions(2);

        const { files, undeclared } = await generateSdk(wideDocument, target);
        const models = Object.entries(files)
            .filter(([path]) => path.toLowerCase().includes("models"))
            .map(([, contents]) => contents)
            .join("\n");

        // A local identifier may be derived — `2fa` cannot be a Java field — but
        // the KEY may not be, so it is the quoted literal that is asserted.
        expect(undeclared).toStrictEqual([]);
        expect(models).toContain(`"${wireKey}"`);
    });

    it("omits an unset optional rather than sending an explicit null", async () => {
        expect.assertions(2);

        // `v.optional(x)` parses `undefined` or `x` and REJECTS null, so a model
        // that writes null for an unset optional fails every call that leaves one
        // unset. Ruby and Rust both shipped exactly that.
        const withOptional: OpenRpcDocument = {
            methods: [
                {
                    name: "wide:save",
                    params: [{ name: "args", schema: { properties: { limit: { type: "number" } }, required: [], type: "object" } }],
                    "x-lunora-function-kind": "mutation",
                },
            ],
        };

        const { files } = await generateSdk(withOptional, target);
        const models = Object.entries(files)
            .filter(([path]) => path.toLowerCase().includes("models"))
            .map(([, contents]) => contents)
            .join("\n");

        // Guarded, and by the FIELD rather than by a null literal: both languages
        // spell the guard differently, but neither may write the key unconditionally.
        expect(models).toContain(`"limit"`);
        expect(/if \(this\.limit != null\) \{|limit\?\.let \{/u.test(models)).toBe(true);
    });
});

describe.each(targets.map((target) => [target.id, target] as const))("target: %s", (_id, target) => {
    it.each(Object.entries(RESULT_SHAPES))("never references a model the backend did not declare (%s result)", async (_shape, resultSchema) => {
        expect.assertions(1);

        const { files, undeclared } = await generateSdk(document(resultSchema), target);

        // Deliberately does NOT try to identify "the models file": targets name
        // it differently (`models.py`, `Models.swift`) and the JVM targets emit
        // no models at all. The invariant is simpler and
        // language-agnostic — a name the backend did not declare must appear
        // NOWHERE in the output, because the surface should have degraded it to
        // an untyped return instead of referencing a type that does not exist.
        const everything = Object.values(files).join("\n");

        // Word-bounded for the same reason the production check is: quicktype
        // renders an array-of-object result as `<Name>Element`, so a loose
        // substring test reports `<Name>` as leaked when only the longer,
        // genuinely-declared name is present.
        const leaked = undeclared.filter((name) => new RegExp(String.raw`\b${name}\b`, "u").test(everything));

        expect(leaked).toStrictEqual([]);
    });

    // The conventions `target.ts` documents as binding were prose, and every one
    // of them was violated by at least one target without anything failing:
    // Rust emitted no subscriptions at all, Rust discarded every result type,
    // and Java and Kotlin dropped the shard key. A doc comment does not run —
    // these do.

    it("renders a live subscription for every query", async () => {
        expect.assertions(1);

        const spec: OpenRpcDocument = {
            methods: [{ name: "messages:list", "x-lunora-function-kind": "query" }],
        };

        const { files } = await generateSdk(spec, target);
        const surface = Object.values(files).join("\n");

        // Naming differs per language (`subscribe_list`, `subscribeList`), so
        // match the shared stem rather than any one convention.
        expect(/subscribe/iu.test(surface)).toBe(true);
    });

    it("renders no subscription for a write, which the server cannot re-run", async () => {
        expect.assertions(1);

        const spec: OpenRpcDocument = {
            methods: [{ name: "messages:send", "x-lunora-function-kind": "mutation" }],
        };

        const { files } = await generateSdk(spec, target);
        const surface = Object.values(files).join("\n");

        expect(/subscribe/iu.test(surface)).toBe(false);
    });

    it("accepts a shard key on every generated call and subscription", async () => {
        expect.assertions(1);

        const spec: OpenRpcDocument = {
            methods: [{ name: "messages:list", "x-lunora-function-kind": "query" }],
        };

        const { files } = await generateSdk(spec, target);
        const surface = Object.values(files).join("\n");

        // Spelt `shard_key` or `shardKey` depending on the language.
        const mentions = [...surface.matchAll(/shard_?key/giu)].length;

        // One for the call, one for the subscription, at minimum.
        expect(mentions).toBeGreaterThanOrEqual(2);
    });

    it("uses a declared result model at its call site rather than emitting it unused", async () => {
        expect.assertions(1);

        const spec: OpenRpcDocument = {
            methods: [
                {
                    name: "messages:count",
                    result: { name: "result", schema: { properties: { total: { type: "number" } }, type: "object" } },
                    "x-lunora-function-kind": "query",
                },
            ],
        };

        const { files, undeclared } = await generateSdk(spec, target);
        const surface = Object.entries(files)
            .filter(([path]) => !path.toLowerCase().includes("models"))
            .map(([, contents]) => contents)
            .join("\n");

        // Either the backend could not declare the model (reported), or the
        // surface must actually reference it — a model emitted and never used
        // is dead weight the caller cannot reach.
        const declared = !undeclared.includes("MessagesCountResult");

        expect(declared ? surface.includes("MessagesCountResult") : true).toBe(true);
    });

    it("is deterministic — a second run is byte-identical", async () => {
        expect.assertions(1);

        const first = await generateSdk(document(RESULT_SHAPES.object), target);
        const second = await generateSdk(document(RESULT_SHAPES.object), target);

        expect(second.files).toStrictEqual(first.files);
    });

    it("emits every functionPath verbatim, since the wire dispatches on it", async () => {
        expect.assertions(1);

        const { files } = await generateSdk(document(RESULT_SHAPES.object), target);

        expect(Object.values(files).some((source) => source.includes("messages:count"))).toBe(true);
    });

    it("emits no empty files", async () => {
        expect.assertions(1);

        const { files } = await generateSdk(document(RESULT_SHAPES.object), target);

        expect(Object.entries(files).filter(([, contents]) => contents.trim().length === 0)).toStrictEqual([]);
    });

    // A `summary` and a `functionPath` reach every target as raw document text.
    // Both are normally generated, but `lunora sdk generate --spec` accepts a
    // hand-written document, and a target that interpolates them unescaped emits
    // whatever they contain into executable position.
    it("does not let a summary or function path escape the syntax it is emitted into", async () => {
        expect.assertions(3);

        const hostile: OpenRpcDocument = {
            methods: [
                {
                    name: String.raw`messages:co"unt`,
                    params: [{ name: "args", schema: { properties: { channelId: { type: "string" } }, type: "object" } }],
                    result: { name: "result", schema: RESULT_SHAPES.object },
                    // A comment terminator for every comment syntax in play, plus
                    // the line breaks that end a line comment.
                    summary: 'query\n*/ raise("pwned")\n""" #{sabotage} \\ $sabotage',
                    "x-lunora-function-kind": "query",
                },
            ],
        };

        const { files } = await generateSdk(hostile, target);
        const sources = Object.values(files).join("\n");

        // The summary's line breaks must not have produced a line whose first
        // token is the injected call.
        expect(sources.split("\n").some((line) => line.trimStart().startsWith(`raise("pwned")`))).toBe(false);
        expect(sources).not.toContain("*/ raise");
        // The unescaped quote in the function path would close its string literal.
        expect(sources).not.toContain(String.raw`"messages:co"unt"`);
    });

    it("reports the result types its backend could not name", async () => {
        expect.assertions(1);

        // Whatever the backend does, the report must agree with the output: a
        // name is either declared in the models, or listed as undeclared.
        const { files, undeclared } = await generateSdk(document(RESULT_SHAPES.scalar), target);
        const models = Object.entries(files).find(([path]) => path.toLowerCase().includes("models"))?.[1] ?? "";

        expect(undeclared.every((name) => !models.includes(name))).toBe(true);
    });
});
