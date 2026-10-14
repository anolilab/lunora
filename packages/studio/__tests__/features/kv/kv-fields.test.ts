import { describe, expect, it } from "vitest";

import { buildKvPutOptions, formatExpiration, isJsonOrEmpty, isTtlValid, tryFormatJson, ttlToSeconds } from "../../../src/features/kv/kv-fields";

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

describe("formatExpiration", () => {
    it("renders a KV expiration (Unix SECONDS, not ms) as an ISO string", () => {
        expect.assertions(1);

        // The ×1000 is the whole point: KV speaks seconds, `Date` speaks ms.
        expect(formatExpiration(1_767_225_600)).toBe("2026-01-01T00:00:00.000Z");
    });

    it("renders an unset expiration as an em dash", () => {
        expect.assertions(1);

        expect(formatExpiration(undefined)).toBe("—");
    });

    it("treats 0 as an instant, not as unset", () => {
        expect.assertions(1);

        expect(formatExpiration(0)).toBe("1970-01-01T00:00:00.000Z");
    });
});

describe("tryFormatJson", () => {
    it("pretty-prints a parseable value with two-space indentation", () => {
        expect.assertions(2);

        expect(tryFormatJson('{"a":1}')).toBe('{\n  "a": 1\n}');
        expect(tryFormatJson("[1,2]")).toBe("[\n  1,\n  2\n]");
    });

    it("formats a bare JSON scalar (the Format button stays live for one)", () => {
        expect.assertions(2);

        expect(tryFormatJson("42")).toBe("42");
        expect(tryFormatJson('"text"')).toBe('"text"');
    });

    it("returns undefined for blank input so the Format button stays disabled", () => {
        expect.assertions(2);

        expect(tryFormatJson("")).toBeUndefined();
        expect(tryFormatJson("   \n ")).toBeUndefined();
    });

    it("returns undefined rather than throwing on unparseable input", () => {
        expect.assertions(2);

        expect(tryFormatJson("{ broken")).toBeUndefined();
        expect(tryFormatJson("plain text")).toBeUndefined();
    });
});

describe("isJsonOrEmpty", () => {
    // The metadata save guard: empty means "no metadata", which is legal.
    it("accepts blank input", () => {
        expect.assertions(2);

        expect(isJsonOrEmpty("")).toBe(true);
        expect(isJsonOrEmpty("  \t ")).toBe(true);
    });

    it("accepts any parseable JSON, object or scalar", () => {
        expect.assertions(4);

        expect(isJsonOrEmpty('{"a":1}')).toBe(true);
        expect(isJsonOrEmpty("[]")).toBe(true);
        expect(isJsonOrEmpty("null")).toBe(true);
        expect(isJsonOrEmpty("0")).toBe(true);
    });

    // `buildKvPutOptions` calls `JSON.parse` unguarded, so a false positive here
    // becomes a thrown error on the save path.
    it("rejects unparseable input", () => {
        expect.assertions(3);

        expect(isJsonOrEmpty("{ broken")).toBe(false);
        expect(isJsonOrEmpty("plain text")).toBe(false);
        expect(isJsonOrEmpty("{'single':'quotes'}")).toBe(false);
    });

    // `buildKvPutOptions` documents "assumes metadata is valid JSON — guard with
    // isJsonOrEmpty at the call site" and then calls `JSON.parse` unguarded, so a
    // value this accepts but the builder throws on is a save-path crash.
    it("accepts nothing that makes buildKvPutOptions throw", () => {
        expect.assertions(12);

        for (const metadata of ["", "  ", '{"a":1}', "[]", "null", "0"]) {
            expect(isJsonOrEmpty(metadata)).toBe(true);
            expect(() => buildKvPutOptions({ metadata, ttl: "", value: "v" }, "k", "NS")).not.toThrow();
        }
    });
});
