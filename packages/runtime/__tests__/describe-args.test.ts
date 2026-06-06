import { describe, expect, it } from "vitest";

import { describeArgument, describeArguments } from "../src/describe-args.js";

/** A minimal stand-in for a `v.*` validator: the `kind` tag + reflection `_meta`. */
const validator = (kind: string, meta?: Record<string, unknown>): { _meta?: Record<string, unknown>; kind: string } => {
    return { _meta: meta, kind };
};

describe("describeArgument", () => {
    it("describes a required scalar", () => {
        expect.assertions(1);

        expect(describeArgument("text", validator("string"))).toStrictEqual({ kind: "string", name: "text", optional: false });
    });

    it("unwraps v.optional, marking the arg optional and reporting the inner kind", () => {
        expect.assertions(1);

        expect(describeArgument("limit", validator("optional", { inner: validator("number") }))).toStrictEqual({
            kind: "number",
            name: "limit",
            optional: true,
        });
    });

    it("surfaces an id arg's target table", () => {
        expect.assertions(1);

        expect(describeArgument("channelId", validator("id", { tableName: "channels" }))).toStrictEqual({
            kind: "id",
            name: "channelId",
            optional: false,
            table: "channels",
        });
    });

    it("carries the table through an optional id", () => {
        expect.assertions(1);

        const optionalId = validator("optional", { inner: validator("id", { tableName: "users" }) });

        expect(describeArgument("author", optionalId)).toStrictEqual({ kind: "id", name: "author", optional: true, table: "users" });
    });

    it("reports an array's element kind", () => {
        expect.assertions(1);

        expect(describeArgument("tags", validator("array", { inner: validator("string") }))).toStrictEqual({
            element: "string",
            kind: "array",
            name: "tags",
            optional: false,
        });
    });

    it("falls back to `unknown` for a non-validator value", () => {
        expect.assertions(1);

        expect(describeArgument("weird", 42)).toStrictEqual({ kind: "unknown", name: "weird", optional: false });
    });
});

describe("describeArguments", () => {
    it("describes a whole args map, sorted by name", () => {
        expect.assertions(1);

        const args = {
            channelId: validator("id", { tableName: "channels" }),
            limit: validator("optional", { inner: validator("number") }),
            text: validator("string"),
        };

        expect(describeArguments(args)).toStrictEqual([
            { kind: "id", name: "channelId", optional: false, table: "channels" },
            { kind: "number", name: "limit", optional: true },
            { kind: "string", name: "text", optional: false },
        ]);
    });

    it("returns an empty list for no args or a non-object", () => {
        expect.assertions(2);

        expect(describeArguments({})).toStrictEqual([]);
        expect(describeArguments(undefined)).toStrictEqual([]);
    });
});
