// Every target that cannot tell an unset optional from a required null by
// looking at its own rendered model has to be HANDED the difference. This
// asserts each one actually emits it — a target that computed the paths and then
// dropped them on the floor would compile, generate, and silently send the wrong
// body.

import { describe, expect, it } from "vitest";

import type { OpenRpcDocument } from "../src/sdk";
import { generateSdk } from "../src/sdk";
import { rubyTarget } from "../src/sdk/targets/ruby";
import { rustTarget } from "../src/sdk/targets/rust";
import { swiftTarget } from "../src/sdk/targets/swift";

/**
 * One mutation whose args carry every shape that matters: a required nullable, a
 * plain optional, a nested optional, and an optional inside an array element.
 */
const document: OpenRpcDocument = {
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
                            limit: { type: "number" },
                            // `v.string().nullable()` — required, and legitimately null.
                            nickname: { anyOf: [{ type: "string" }, { type: "null" }] },
                            profile: { properties: { bio: { type: "string" } }, required: [], type: "object" },
                            rows: { items: { properties: { tag: { type: "string" } }, required: [], type: "object" }, type: "array" },
                        },
                        required: ["id", "nickname", "profile", "rows"],
                        type: "object",
                    },
                },
            ],
            summary: "mutation: records:put",
            "x-lunora-function-kind": "mutation",
        },
    ],
};

/**
 * A union argument. quicktype merges the branches into ONE class whose every
 * property is nullable, so a model built from it emits BOTH — one of them null,
 * which neither branch of the union accepts.
 */
const union: OpenRpcDocument = {
    methods: [
        {
            name: "events:put",
            params: [
                {
                    name: "args",
                    schema: {
                        additionalProperties: false,
                        properties: {
                            id: { type: "string" },
                            payload: {
                                anyOf: [
                                    { additionalProperties: false, properties: { a: { type: "string" } }, required: ["a"], type: "object" },
                                    { additionalProperties: false, properties: { b: { type: "number" } }, required: ["b"], type: "object" },
                                ],
                            },
                        },
                        required: ["id", "payload"],
                        type: "object",
                    },
                },
            ],
            summary: "mutation: events:put",
            "x-lunora-function-kind": "mutation",
        },
    ],
};

/** A document with no optional and no nullable argument at all. */
const plain: OpenRpcDocument = {
    methods: [
        {
            name: "records:touch",
            params: [{ name: "args", schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" } }],
            summary: "mutation: records:touch",
            "x-lunora-function-kind": "mutation",
        },
    ],
};

describe("ruby nullable arguments", () => {
    it("passes the optional paths its projection prunes at", async () => {
        expect.assertions(2);

        const { files } = await generateSdk(document, rubyTarget);
        const api = files["api.rb"] ?? "";

        // Every optional, at every depth, with `*` for an array element — and
        // `nickname` absent, because a required null must survive.
        expect(api).toContain('wire_args(args, [["limit"], ["profile", "bio"], ["rows", "*", "tag"]])');
        expect(api).not.toContain("nickname");
    });

    it("emits an empty list when nothing is optional", async () => {
        expect.assertions(1);

        // Not a special case in the emitter, but it must still be well-formed
        // Ruby rather than a dangling argument.
        const { files } = await generateSdk(plain, rubyTarget);

        expect(files["api.rb"]).toContain("wire_args(args, [])");
    });
});

describe("union arguments", () => {
    it("prunes the branch quicktype merged in but the caller did not pick", async () => {
        expect.assertions(2);

        // The regression guard. Reading each branch's own `required` in isolation
        // would emit no paths at all, and the inactive branch's null would go on
        // the wire — which is what the blanket prune used to stop.
        const ruby = await generateSdk(union, rubyTarget);
        const rust = await generateSdk(union, rustTarget);

        expect(ruby.files["api.rb"]).toContain('wire_args(args, [["payload", "a"], ["payload", "b"]])');
        expect(rust.files["src/api.rs"]).toContain('&[&["payload", "a"][..], &["payload", "b"][..]]');
    });
});

describe("rust nullable arguments", () => {
    it("passes the optional paths its projection prunes at", async () => {
        expect.assertions(2);

        const { files } = await generateSdk(document, rustTarget);
        const api = files["src/api.rs"] ?? "";

        // The `[..]` reslice is what lets paths of different lengths share one
        // slice; without it this does not compile.
        expect(api).toContain('&[&["limit"][..], &["profile", "bio"][..], &["rows", "*", "tag"][..]]');
        expect(api).not.toContain("nickname");
    });

    it("emits an empty slice when nothing is optional", async () => {
        expect.assertions(1);

        // `&[]` and not `&[][..]`: an empty array literal already coerces.
        const { files } = await generateSdk(plain, rustTarget);

        expect(files["src/api.rs"]).toContain("?, &[])");
    });
});

describe("swift nullable arguments", () => {
    it("passes the nullable paths its projection restores at", async () => {
        expect.assertions(3);

        const { files } = await generateSdk(document, swiftTarget);
        const api = files["Sources/LunoraApi/Api.swift"] ?? "";

        // The OPPOSITE list from Ruby and Rust: `JSONEncoder` has already dropped
        // every nil, so Swift restores at the required-nullable paths instead of
        // pruning at the optional ones.
        expect(api).toContain('wireValue(args, nullablePaths: [["nickname"]])');
        expect(api).not.toContain("limit");
        expect(api).not.toContain('"rows"');
    });

    it("omits the argument entirely when nothing is nullable", async () => {
        expect.assertions(2);

        // Nothing to restore, so the call keeps the plain single-argument form
        // rather than carrying an empty list nobody reads.
        const { files } = await generateSdk(plain, swiftTarget);
        const api = files["Sources/LunoraApi/Api.swift"] ?? "";

        expect(api).toContain("try LunoraClient.wireValue(args)");
        expect(api).not.toContain("nullablePaths");
    });
});
