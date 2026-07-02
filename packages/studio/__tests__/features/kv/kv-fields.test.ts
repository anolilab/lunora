import { describe, expect, it } from "vitest";

import { buildKvPutOptions, isTtlValid, ttlToSeconds } from "../../../src/features/kv/kv-fields";

describe("ttlToSeconds", () => {
    it("converts an amount in its unit to an integer-seconds string", () => {
        expect.assertions(4);

        expect(ttlToSeconds("2", "minutes")).toBe("120");
        expect(ttlToSeconds("1", "hours")).toBe("3600");
        expect(ttlToSeconds("1", "days")).toBe("86400");
        expect(ttlToSeconds("90", "seconds")).toBe("90");
    });

    it("rounds fractional amounts to whole seconds", () => {
        expect.assertions(1);

        expect(ttlToSeconds("1.5", "minutes")).toBe("90");
    });

    it('returns "" for a blank amount and forwards a bad amount for validation', () => {
        expect.assertions(3);

        expect(ttlToSeconds("", "minutes")).toBe("");
        expect(ttlToSeconds("  ", "hours")).toBe("");
        expect(ttlToSeconds("abc", "minutes")).toBe("abc");
    });
});

describe("isTtlValid", () => {
    it("accepts empty (no expiry) and whole seconds >= 60, rejects the rest", () => {
        expect.assertions(6);

        expect(isTtlValid("")).toBe(true);
        expect(isTtlValid("60")).toBe(true);
        expect(isTtlValid("120")).toBe(true);
        expect(isTtlValid("59")).toBe(false);
        expect(isTtlValid("abc")).toBe(false);
        expect(isTtlValid("90.5")).toBe(false);
    });
});

describe("buildKvPutOptions", () => {
    it("sends a fresh TTL as expirationTtl and clears the stored expiration", () => {
        expect.assertions(1);

        expect(buildKvPutOptions({ metadata: "", ttl: "120", value: "v" }, "k", "NS", 4_102_444_800)).toStrictEqual({
            expiration: undefined,
            expirationTtl: 120,
            key: "k",
            metadata: undefined,
            namespace: "NS",
            value: "v",
        });
    });

    it("re-sends the existing expiration when no fresh TTL is entered", () => {
        expect.assertions(1);

        expect(buildKvPutOptions({ metadata: "", ttl: "", value: "v" }, "k", "NS", 4_102_444_800)).toStrictEqual({
            expiration: 4_102_444_800,
            expirationTtl: undefined,
            key: "k",
            metadata: undefined,
            namespace: "NS",
            value: "v",
        });
    });

    it("parses non-empty metadata JSON", () => {
        expect.assertions(1);

        expect(buildKvPutOptions({ metadata: '{"a":1}', ttl: "", value: "v" }, "k", "NS").metadata).toStrictEqual({ a: 1 });
    });
});
