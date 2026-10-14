import { describe, expect, it } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import { demuxBatchResults, encodeCallArgs, isEncodable, isSlotEnvelope } from "../src/call-wire";
import { TransportError } from "../src/errors";

describe("isSlotEnvelope", () => {
    it.each([
        ["null", null],
        ["a number", 5],
        ["a string", "result"],
        ["an object with neither key", { other: 1 }],
    ])("is false for %s", (_label, body) => {
        expect.assertions(1);

        expect(isSlotEnvelope(body)).toBe(false);
    });

    it("is true for an {error} envelope", () => {
        expect.assertions(1);

        expect(isSlotEnvelope({ error: { code: "X" } })).toBe(true);
    });

    it("is true for a {result} envelope", () => {
        expect.assertions(1);

        expect(isSlotEnvelope({ result: 1 })).toBe(true);
    });
});

describe("demuxBatchResults", () => {
    it("orders slots by id regardless of arrival order", () => {
        expect.assertions(1);

        const slots = demuxBatchResults(
            [
                { body: { result: "c" }, id: 2 },
                { body: { result: "a" }, id: 0 },
                { body: { result: "b" }, id: 1 },
            ],
            3,
        );

        expect(slots).toEqual([
            { ok: true, value: "a" },
            { ok: true, value: "b" },
            { ok: true, value: "c" },
        ]);
    });

    it("marks a slot the server never returned as an error", () => {
        expect.assertions(3);

        const slots = demuxBatchResults([{ body: { result: 1 }, id: 0 }], 2);
        const missing = slots[1];

        expect(missing?.ok).toBe(false);
        expect(missing?.ok === false ? missing.error.message : undefined).toBe("batch call returned no result");
        expect(slots[0]).toEqual({ ok: true, value: 1 });
    });

    it("fails a null body without throwing and still settles later slots", () => {
        expect.assertions(4);

        const slots = demuxBatchResults(
            [
                { body: null, id: 0 },
                { body: { result: 7 }, id: 1 },
            ],
            2,
        );
        const failed = slots[0];

        expect(failed?.ok).toBe(false);
        expect(failed?.ok === false ? failed.error : undefined).toBeInstanceOf(TransportError);
        expect(failed?.ok === false ? failed.error.message : undefined).toBe("LunoraClient: batch slot carried no error envelope");
        expect(slots[1]).toEqual({ ok: true, value: 7 });
    });

    it("wire-decodes a successful result", () => {
        expect.assertions(1);

        const slots = demuxBatchResults([{ body: { result: encodeWire(5n) }, id: 0 }], 1);

        expect(slots[0]).toEqual({ ok: true, value: 5n });
    });

    it("reconstructs the code on a failing call", () => {
        expect.assertions(2);

        const slots = demuxBatchResults([{ body: { error: { code: "CONFLICT", message: "stale" } }, id: 0 }], 1);
        const failed = slots[0];

        expect(failed?.ok === false ? failed.error.code : undefined).toBe("CONFLICT");
        expect(failed?.ok === false ? failed.error.message : undefined).toBe("stale");
    });

    it("ignores entries with an out-of-range or non-numeric id", () => {
        expect.assertions(1);

        const slots = demuxBatchResults([{ body: { result: 1 }, id: 5 }, { body: { result: 2 }, id: -1 }, { body: { result: 3 } }], 1);

        expect(slots[0]?.ok).toBe(false);
    });
});

describe("encodeCallArgs", () => {
    it("wire-encodes a bigint argument", () => {
        expect.assertions(1);

        expect(encodeCallArgs({ amount: 5n }, "args for 'x:y'")).toEqual({ amount: ["$lunora.wire$", "bigint", "5"] });
    });

    it("tags an unencodable value with the call label and keeps the cause", () => {
        expect.assertions(4);

        let thrown: unknown;

        try {
            encodeCallArgs(/a/u, "args for 'x:y'");
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(TypeError);
        expect((thrown as TypeError).message).toMatch(/^LunoraClient: cannot encode args for 'x:y' — /u);
        expect((thrown as TypeError).cause).toBeInstanceOf(TypeError);
        expect((thrown as TypeError).message).toContain("RegExp");
    });
});

describe("isEncodable", () => {
    it("is true for a bigint-bearing payload", () => {
        expect.assertions(1);

        expect(isEncodable({ amount: 5n })).toBe(true);
    });

    it("is false for an unencodable value rather than throwing", () => {
        expect.assertions(1);

        expect(isEncodable(/a/u)).toBe(false);
    });
});
