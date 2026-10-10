import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import { TransportError } from "../src/errors";
import { errorEnvelopeOf, reconstructError, retryAfterHeaderMs, slotError } from "../src/wire-errors";

describe("reconstructError", () => {
    it("falls back to 'request failed' when the envelope carries no message", () => {
        expect.assertions(2);

        const error = reconstructError({ code: "NOT_FOUND" });

        expect(error.message).toBe("request failed");
        expect(error.code).toBe("NOT_FOUND");
    });

    it("keeps the server message, hint and docsUrl", () => {
        expect.assertions(3);

        const error = reconstructError({
            code: "INVALID_ARGUMENT",
            docsUrl: "https://lunora.dev/errors/invalid-argument",
            hint: ["Pass a number", "Not a string"],
            message: "bad input",
        });

        expect(error.message).toBe("bad input");
        expect(error.hint).toEqual(["Pass a number", "Not a string"]);
        expect(error.docsUrl).toBe("https://lunora.dev/errors/invalid-argument");
    });

    it("leaves hint and docsUrl unset when the envelope omits them", () => {
        expect.assertions(2);

        const error = reconstructError({ code: "INTERNAL", message: "boom" }) as Error & { docsUrl?: string; hint?: unknown };

        expect(error.hint).toBeUndefined();
        expect(error.docsUrl).toBeUndefined();
    });

    it("wire-decodes a valid data value", () => {
        expect.assertions(2);

        const error = reconstructError({ code: "CONFLICT", data: encodeWire({ amount: 42n }), message: "conflict" });

        expect(error.data).toEqual({ amount: 42n });
        expect(error.code).toBe("CONFLICT");
    });

    it("drops a data value the codec refuses and keeps the server's code", () => {
        expect.assertions(3);

        const error = reconstructError({ code: "CONFLICT", data: ["$lunora.wire$", "bigint", "not-a-number"], message: "conflict" });

        expect(error.data).toBeUndefined();
        expect(error.code).toBe("CONFLICT");
        expect(error.message).toBe("conflict");
    });
});

describe("errorEnvelopeOf", () => {
    it("returns the error object when the body carries an envelope", () => {
        expect.assertions(1);

        expect(errorEnvelopeOf({ error: { code: "CONFLICT", message: "m" } })).toEqual({ code: "CONFLICT", message: "m" });
    });

    it.each([
        ["a string slot", { error: "bad gateway" }],
        ["a null slot", { error: null }],
        ["an array slot", { error: [{ code: "X" }] }],
        ["no error key", { result: 1 }],
    ])("returns undefined for %s", (_label, body) => {
        expect.assertions(1);

        expect(errorEnvelopeOf(body)).toBeUndefined();
    });

    it.each([
        ["null", null],
        ["undefined", undefined],
        ["a number", 5],
        ["a string", "error"],
    ])("returns undefined for a non-object body (%s)", (_label, body) => {
        expect.assertions(1);

        expect(errorEnvelopeOf(body)).toBeUndefined();
    });
});

describe("retryAfterHeaderMs", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("reads delta-seconds as milliseconds", () => {
        expect.assertions(1);

        expect(retryAfterHeaderMs("2")).toBe(2000);
    });

    it("reads a future HTTP date as the remaining milliseconds", () => {
        expect.assertions(1);

        vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2015, 9, 21, 7, 27, 0));

        expect(retryAfterHeaderMs("Wed, 21 Oct 2015 07:28:00 GMT")).toBe(60_000);
    });

    it("returns undefined for a past HTTP date", () => {
        expect.assertions(1);

        vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2015, 9, 21, 7, 27, 0));

        expect(retryAfterHeaderMs("Wed, 21 Oct 2015 07:00:00 GMT")).toBeUndefined();
    });

    it("returns undefined when the header is absent", () => {
        expect.assertions(1);

        expect(retryAfterHeaderMs(null)).toBeUndefined();
    });

    it.each([["soon"], ["0"], ["-5"], [""]])("returns undefined for an unusable header (%j)", (header) => {
        expect.assertions(1);

        expect(retryAfterHeaderMs(header)).toBeUndefined();
    });
});

describe("slotError", () => {
    it("gives a TransportError when the slot carries no envelope", () => {
        expect.assertions(3);

        const error = slotError({ error: "bad gateway" });

        expect(error).toBeInstanceOf(TransportError);
        expect(error.message).toBe("LunoraClient: batch slot carried no error envelope");
        expect(error.code).toBe("INTERNAL");
    });

    it("reconstructs the code from a coded envelope", () => {
        expect.assertions(2);

        const error = slotError({ error: { code: "CONFLICT", message: "stale" } });

        expect(error.code).toBe("CONFLICT");
        expect(error.message).toBe("stale");
    });
});
