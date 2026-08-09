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

describe.each(targets.map((target) => [target.id, target] as const))("target: %s", (_id, target) => {
    it.each(Object.entries(RESULT_SHAPES))("never references a model the backend did not declare (%s result)", async (_shape, resultSchema) => {
        expect.assertions(1);

        const { files } = await generateSdk(document(resultSchema), target);
        const sources = Object.entries(files);
        const models = sources.find(([path]) => path.toLowerCase().includes("models"))?.[1] ?? "";
        const surfaces = sources.filter(([path]) => !path.toLowerCase().includes("models")).map(([, contents]) => contents);

        // Model names are the namespace and function in Pascal case, suffixed
        // Args or Result. Any the surface mentions must exist in the models
        // file, or the generated SDK cannot import or compile.
        const referenced = surfaces.flatMap((source) => [...source.matchAll(/\bMessagesCount(?:Args|Result)\b/gu)].map((match) => match[0]));
        const dangling = [...new Set(referenced)].filter((name) => !models.includes(name));

        expect(dangling).toStrictEqual([]);
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

    it("reports the result types its backend could not name", async () => {
        expect.assertions(1);

        // Whatever the backend does, the report must agree with the output: a
        // name is either declared in the models, or listed as undeclared.
        const { files, undeclared } = await generateSdk(document(RESULT_SHAPES.scalar), target);
        const models = Object.entries(files).find(([path]) => path.toLowerCase().includes("models"))?.[1] ?? "";

        expect(undeclared.every((name) => !models.includes(name))).toBe(true);
    });
});
