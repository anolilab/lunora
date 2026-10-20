import { LunoraError } from "@lunora/errors";
import { encodeWire } from "@lunora/wire";
import { describe, expect, it } from "vitest";

import { decodeErrorDetail, describeInternal, encodeErrorDetail } from "../../../shared/error-detail";
import { parseStackFrames, toError } from "../src/error-reporting";

const STACK = ["TypeError: db down", "    at load (src/server/index.js:12:5)", "    at Array.map (<anonymous>)", "    at src/server/index.js:40:9"].join("\n");

describe(toError, () => {
    it("rebuilds a throwable carrying the original name, message, stack and code", () => {
        expect.assertions(4);

        const error = toError({ code: "INTERNAL_SERVER_ERROR", message: "db down", name: "TypeError", stack: STACK }) as Error & { code?: string };

        expect(error.name).toBe("TypeError");
        expect(error.message).toBe("db down");
        expect(error.stack).toBe(STACK);
        expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    });

    it("falls back to the code for the name when the event has none", () => {
        expect.assertions(1);

        expect(toError({ code: "CONFLICT", message: "write conflict" }).name).toBe("CONFLICT");
    });
});

describe(parseStackFrames, () => {
    it("parses V8 lines oldest call first, skipping lines without a location", () => {
        expect.assertions(1);

        expect(parseStackFrames(STACK)).toStrictEqual([
            { colno: 9, filename: "src/server/index.js", function: "<anonymous>", lineno: 40 },
            { colno: 5, filename: "src/server/index.js", function: "load", lineno: 12 },
        ]);
    });

    it("stays linear on a pathological line (the input is any error's stack)", () => {
        expect.assertions(2);

        const startedAt = performance.now();

        expect(parseStackFrames(`Error\n    at ${"a (a".repeat(50_000)}`)).toStrictEqual([]);
        expect(performance.now() - startedAt).toBeLessThan(1000);
    });

    it("returns no frames for an absent stack", () => {
        expect.assertions(1);

        expect(parseStackFrames(undefined)).toStrictEqual([]);
    });
});

describe(encodeErrorDetail, () => {
    it("keeps an oversized detail under the header budget by dropping the stack and truncating the message", () => {
        expect.assertions(3);

        const encoded = encodeErrorDetail({ message: "é".repeat(50_000), name: "TypeError", stack: "x".repeat(8192) });
        const decoded = decodeErrorDetail(encoded);

        expect(encoded.length).toBeLessThanOrEqual(16_384);
        expect(decoded).not.toHaveProperty("stack");
        expect(decoded?.message).toHaveLength(1024);
    });
});

describe(describeInternal, () => {
    it("returns the internal context of a LunoraError", () => {
        expect.assertions(1);

        expect(describeInternal(new LunoraError("INTERNAL", "boom", { internal: { shard: "7" } }))).toStrictEqual({ shard: "7" });
    });

    it("returns undefined for a value with no internal context, or a non-Error throw", () => {
        expect.assertions(2);

        expect(describeInternal(new LunoraError("INTERNAL", "boom"))).toBeUndefined();
        expect(describeInternal({ internal: { shard: "7" } })).toBeUndefined();
    });

    it("drops internal context that JSON cannot carry, so the header encode never throws", () => {
        expect.assertions(2);

        const cyclic: Record<string, unknown> = {};

        cyclic.self = cyclic;

        expect(describeInternal(new LunoraError("INTERNAL", "boom", { internal: cyclic }))).toBeUndefined();
        expect(describeInternal(new LunoraError("INTERNAL", "boom", { internal: { big: 1n } }))).toBeUndefined();
    });
});

describe("a LunoraError embedded in a wire payload never carries internal", () => {
    it("encodes client-visible fields, including why, and drops the operator-only internal context", () => {
        expect.assertions(3);

        const SENTINEL = "INTERNAL_CONTEXT_SENTINEL_7f3a";
        const encoded = JSON.stringify(encodeWire({ failure: new LunoraError("CONFLICT", "stale", { internal: { query: SENTINEL }, why: "row moved" }) }));

        expect(encoded).not.toContain(SENTINEL);
        expect(encoded).toContain("row moved");
        expect(encoded).toContain("CONFLICT");
    });
});

describe("error detail header carries internal, and decode rejects a malformed one", () => {
    it("round-trips internal through the header encoding", () => {
        expect.assertions(1);

        const detail = { internal: { shard: "7" }, message: "boom", name: "LunoraError" };

        expect(decodeErrorDetail(encodeErrorDetail(detail))).toStrictEqual(detail);
    });

    it("drops a non-object internal and keeps the rest of the detail", () => {
        expect.assertions(2);

        const encoded = encodeURIComponent(JSON.stringify({ internal: "not-an-object", message: "boom", name: "LunoraError" }));

        expect(decodeErrorDetail(encoded)).toStrictEqual({ message: "boom", name: "LunoraError" });
        expect(decodeErrorDetail(encodeURIComponent(JSON.stringify({ internal: [1], message: "boom", name: "E" })))).not.toHaveProperty("internal");
    });
});
