// The schema walk three SDK targets depend on to tell "unset" from "null".
//
// An unset `v.optional()` and a `v.nullable()` set to null are the same nil in
// every generated model and opposite things on the wire, so getting this wrong
// silently breaks either every optional argument or every nullable one.

import { describe, expect, it } from "vitest";

import type { OpenRpcDocument } from "../src/sdk";
import { nullPathsOf, parseSpec } from "../src/sdk/spec";

/** `.nullable()` renders as this, and so does `v.union(v.null(), x)`. */
const nullable = (inner: Record<string, unknown>): Record<string, unknown> => {
    return { anyOf: [inner, { type: "null" }] };
};

describe("nullPathsOf", () => {
    it("separates an unset optional from a required nullable", () => {
        expect.assertions(2);

        const paths = nullPathsOf({
            additionalProperties: false,
            properties: { id: { type: "string" }, limit: { type: "number" }, nickname: nullable({ type: "string" }) },
            required: ["id", "nickname"],
            type: "object",
        });

        // Absent from `required`, so a nil there means the caller sent nothing.
        expect(paths.optional).toStrictEqual([["limit"]]);
        // Required AND null-permitting, so a nil there is a value the server wants.
        expect(paths.nullable).toStrictEqual([["nickname"]]);
    });

    it("leaves a required non-nullable property out of both lists", () => {
        expect.assertions(2);

        // A nil here is invalid input either way; it is not the transport's to
        // reinterpret, and dropping it would hide the server's real complaint.
        const paths = nullPathsOf({ properties: { id: { type: "string" } }, required: ["id"], type: "object" });

        expect(paths.optional).toStrictEqual([]);
        expect(paths.nullable).toStrictEqual([]);
    });

    it("descends into nested objects, extending the path", () => {
        expect.assertions(2);

        const paths = nullPathsOf({
            properties: {
                profile: {
                    properties: { bio: nullable({ type: "string" }), nickname: { type: "string" } },
                    required: ["bio"],
                    type: "object",
                },
            },
            required: ["profile"],
            type: "object",
        });

        expect(paths.optional).toStrictEqual([["profile", "nickname"]]);
        expect(paths.nullable).toStrictEqual([["profile", "bio"]]);
    });

    it("walks THROUGH a nullable wrapper without extending the path", () => {
        expect.assertions(2);

        // `v.object({…}).nullable()` has the same properties in the same places
        // as the object it wraps; a walk that stopped at the `anyOf` would miss
        // every one of them.
        const paths = nullPathsOf({
            properties: {
                profile: nullable({ properties: { bio: nullable({ type: "string" }), nickname: { type: "string" } }, required: ["bio"], type: "object" }),
            },
            required: ["profile"],
            type: "object",
        });

        expect(paths.optional).toStrictEqual([["profile", "nickname"]]);
        // Both the wrapper itself and the property inside it.
        expect(paths.nullable).toStrictEqual([["profile"], ["profile", "bio"]]);
    });

    it("uses a star for an array's elements and a record's values", () => {
        expect.assertions(2);

        const paths = nullPathsOf({
            properties: {
                rows: {
                    items: { properties: { note: nullable({ type: "string" }), tag: { type: "string" } }, required: ["note"], type: "object" },
                    type: "array",
                },
                tags: { additionalProperties: nullable({ type: "string" }), type: "object" },
            },
            required: ["rows", "tags"],
            type: "object",
        });

        expect(paths.optional).toStrictEqual([["rows", "*", "tag"]]);
        // The property INSIDE the array's elements, but not the record's values
        // themselves: no port drops a null in a `*` position, and listing one
        // would make Swift's restore invent record keys that were never sent.
        expect(paths.nullable).toStrictEqual([["rows", "*", "note"]]);
    });

    it("treats a union's properties the way quicktype MERGES them", () => {
        expect.assertions(2);

        // The regression this exists to prevent. quicktype folds an `anyOf` into
        // ONE class whose every property is nullable unless every branch requires
        // it, so a model built from `v.union(v.object({a}), v.object({b}))` emits
        // BOTH — one of them null. Reading each branch's own `required` in
        // isolation would call both required, prune nothing, and send
        // `{"a":"x","b":null}`, which neither branch of the union accepts.
        const paths = nullPathsOf({
            anyOf: [
                { additionalProperties: false, properties: { a: { type: "string" } }, required: ["a"], type: "object" },
                { additionalProperties: false, properties: { b: { type: "number" } }, required: ["b"], type: "object" },
            ],
        });

        expect(paths.optional).toStrictEqual([["a"], ["b"]]);
        expect(paths.nullable).toStrictEqual([]);
    });

    it("keeps a property required when EVERY branch requires it", () => {
        expect.assertions(2);

        const paths = nullPathsOf({
            anyOf: [
                { properties: { kind: { type: "string" }, only: { type: "string" } }, required: ["kind", "only"], type: "object" },
                { properties: { kind: { type: "string" } }, required: ["kind"], type: "object" },
            ],
        });

        // `kind` is in both; `only` is missing from the second, which is exactly
        // what makes it optional in the merged class.
        expect(paths.optional).toStrictEqual([["only"]]);
        expect(paths.nullable).toStrictEqual([]);
    });

    it("does not let a nullable wrapper make an object's properties optional", () => {
        expect.assertions(2);

        // `v.object({…}).nullable()` is an `anyOf` too, but its `{type:"null"}`
        // branch is not an object and contributes no shape — so intersecting must
        // not sweep the real branch's requirements away with it.
        const paths = nullPathsOf({
            properties: { profile: nullable({ properties: { bio: nullable({ type: "string" }) }, required: ["bio"], type: "object" }) },
            required: ["profile"],
            type: "object",
        });

        expect(paths.optional).toStrictEqual([]);
        expect(paths.nullable).toStrictEqual([["profile"], ["profile", "bio"]]);
    });

    it("treats allOf as a conjunction, not a choice", () => {
        expect.assertions(2);

        // Every `allOf` branch holds at once, so a property required by any of
        // them is required — the opposite of the `anyOf` rule above.
        const paths = nullPathsOf({
            allOf: [
                { properties: { a: { type: "string" } }, required: ["a"], type: "object" },
                { properties: { b: { type: "string" } }, required: ["b"], type: "object" },
            ],
        });

        expect(paths.optional).toStrictEqual([]);
        expect(paths.nullable).toStrictEqual([]);
    });

    it("does not walk `additionalProperties: false` as if it were a schema", () => {
        expect.assertions(2);

        const paths = nullPathsOf({ additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"], type: "object" });

        expect(paths.optional).toStrictEqual([]);
        expect(paths.nullable).toStrictEqual([]);
    });

    it("accepts every spelling of a null-permitting schema", () => {
        expect.assertions(1);

        const paths = nullPathsOf({
            properties: {
                // `v.union(v.null(), v.string())`.
                fromUnion: { anyOf: [{ type: "null" }, { type: "string" }] },
                // A hand-written `--spec` may use either of these.
                fromArray: { type: ["string", "null"] },
                fromOneOf: { oneOf: [{ type: "number" }, { type: "null" }] },
                plainNull: { type: "null" },
            },
            required: ["fromUnion", "fromArray", "fromOneOf", "plainNull"],
            type: "object",
        });

        expect(paths.nullable).toStrictEqual([["fromArray"], ["fromOneOf"], ["fromUnion"], ["plainNull"]]);
    });

    it("sorts, so two runs over one schema emit identical paths", () => {
        expect.assertions(1);

        const paths = nullPathsOf({ properties: { b: { type: "string" }, a: { type: "string" }, c: { type: "string" } }, required: [], type: "object" });

        expect(paths.optional).toStrictEqual([["a"], ["b"], ["c"]]);
    });

    it("terminates on a self-referential schema", () => {
        expect.assertions(1);

        // `--spec` takes a hand-written document, and a cycle there must be a
        // bounded walk rather than a hung generation.
        const cyclic: Record<string, unknown> = { properties: { name: { type: "string" } }, required: [], type: "object" };

        (cyclic["properties"] as Record<string, unknown>)["self"] = cyclic;

        expect(nullPathsOf(cyclic).optional.length).toBeGreaterThan(0);
    });

    it("returns empty lists for a schema with nothing to describe", () => {
        expect.assertions(3);

        // What `openrpc.ts` emits for a function with no declared `.output()`.
        expect(nullPathsOf({ description: "Result is TS-inferred …" })).toStrictEqual({ nullable: [], optional: [] });
        expect(nullPathsOf(undefined)).toStrictEqual({ nullable: [], optional: [] });
        expect(nullPathsOf({ type: "string" })).toStrictEqual({ nullable: [], optional: [] });
    });
});

describe("argsNullPaths on a parsed method", () => {
    it("carries the paths for the method's own arguments", () => {
        expect.assertions(2);

        const document: OpenRpcDocument = {
            methods: [
                {
                    name: "records:put",
                    params: [
                        {
                            name: "args",
                            schema: {
                                properties: { id: { type: "string" }, limit: { type: "number" }, nickname: nullable({ type: "string" }) },
                                required: ["id", "nickname"],
                                type: "object",
                            },
                        },
                    ],
                    summary: "mutation: records:put",
                    "x-lunora-function-kind": "mutation",
                },
            ],
        };

        // On the method, so a target reads them where it already has the method
        // — no lookup, and no second naming rule to keep in step.
        const method = parseSpec(document)[0]?.methods[0];

        expect(method?.argsNullPaths.optional).toStrictEqual([["limit"]]);
        expect(method?.argsNullPaths.nullable).toStrictEqual([["nickname"]]);
    });
});
