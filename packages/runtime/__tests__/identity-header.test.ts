import { describe, expect, it } from "vitest";

import { decodeIdentityHeader, decodeUserIdHeader, encodeIdentityHeader, encodeUserIdHeader, isByteStringSafe } from "../../../shared/identity-header";

describe("encodeIdentityHeader / decodeIdentityHeader", () => {
    it("round-trips ASCII claims", () => {
        expect.assertions(2);

        const claims = { email: "user@example.com", roles: ["admin", "member"] };
        const encoded = encodeIdentityHeader(claims);

        expect(isByteStringSafe(encoded)).toBe(true);
        expect(decodeIdentityHeader(encoded)).toStrictEqual(claims);
    });

    it("round-trips CJK claims as a valid ByteString header value", () => {
        expect.assertions(2);

        const claims = { name: "名前" };
        const encoded = encodeIdentityHeader(claims);

        expect(isByteStringSafe(encoded)).toBe(true);
        expect(decodeIdentityHeader(encoded)).toStrictEqual(claims);
    });

    it("round-trips emoji claims as a valid ByteString header value", () => {
        expect.assertions(2);

        const claims = { status: "名前 🎌" };
        const encoded = encodeIdentityHeader(claims);

        expect(isByteStringSafe(encoded)).toBe(true);
        expect(decodeIdentityHeader(encoded)).toStrictEqual(claims);
    });

    it("a real Request can be constructed with the encoded header value (the actual bug)", () => {
        expect.assertions(1);

        const encoded = encodeIdentityHeader({ name: "名前 🎌", roles: ["admin"] });

        // Before this codec, setting this header to raw `JSON.stringify(claims)`
        // made `new Request(...)` throw a TypeError (WebIDL ByteString violation)
        // for any non-Latin-1 claim. This is the actual failure mode the codec fixes.
        expect(() => new Request("https://shard.internal/rpc", { headers: { "x-lunora-identity": encoded } })).not.toThrow();
    });

    it("decodes a legacy raw-JSON header value (pre-encoding rollout / Latin-1-only claims sent raw)", () => {
        expect.assertions(1);

        const claims = { email: "user@example.com" };

        expect(decodeIdentityHeader(JSON.stringify(claims))).toStrictEqual(claims);
    });

    it.each([null, undefined, ""])("returns undefined for %p", (raw) => {
        expect.assertions(1);

        expect(decodeIdentityHeader(raw)).toBeUndefined();
    });

    it("returns undefined for garbage base64url that doesn't decode to JSON", () => {
        expect.assertions(1);

        expect(decodeIdentityHeader("not-valid-base64url-json!!!")).toBeUndefined();
    });

    it("returns undefined for malformed legacy JSON", () => {
        expect.assertions(1);

        expect(decodeIdentityHeader("{not json")).toBeUndefined();
    });

    it("returns undefined when the decoded JSON is an array, not an object", () => {
        expect.assertions(1);

        const encodedArray = btoa("[1,2,3]").replaceAll("+", "-").replaceAll("/", "_");

        expect(decodeIdentityHeader(encodedArray)).toBeUndefined();
    });

    it("returns undefined when the decoded JSON is a primitive, not an object", () => {
        expect.assertions(1);

        const encodedNumber = btoa("42").replaceAll("+", "-").replaceAll("/", "_");

        expect(decodeIdentityHeader(encodedNumber)).toBeUndefined();
    });
});

describe("encodeUserIdHeader / decodeUserIdHeader", () => {
    it("forwards a Latin-1-safe userId unchanged", () => {
        expect.assertions(2);

        const encoded = encodeUserIdHeader("user_42");

        expect(encoded).toBe("user_42");
        expect(decodeUserIdHeader(encoded)).toBe("user_42");
    });

    it("round-trips a CJK userId as a valid ByteString header value", () => {
        expect.assertions(3);

        const userId = "田中太郎";
        const encoded = encodeUserIdHeader(userId);

        expect(isByteStringSafe(encoded)).toBe(true);
        expect(encoded.startsWith("=")).toBe(true);
        expect(decodeUserIdHeader(encoded)).toBe(userId);
    });

    it("round-trips an emoji userId as a valid ByteString header value", () => {
        expect.assertions(2);

        const userId = "user_🎌";
        const encoded = encodeUserIdHeader(userId);

        expect(isByteStringSafe(encoded)).toBe(true);
        expect(decodeUserIdHeader(encoded)).toBe(userId);
    });

    it("a real Request can be constructed with the encoded userId header value (the actual bug)", () => {
        expect.assertions(1);

        const encoded = encodeUserIdHeader("田中太郎 🎌");

        expect(() => new Request("https://shard.internal/rpc", { headers: { "x-lunora-userid": encoded } })).not.toThrow();
    });

    it("encodes a Latin-1-safe userId that happens to start with the `=` sentinel, to avoid ambiguity", () => {
        expect.assertions(2);

        const userId = "=weird-but-latin1-id";
        const encoded = encodeUserIdHeader(userId);

        expect(encoded).not.toBe(userId);
        expect(decodeUserIdHeader(encoded)).toBe(userId);
    });

    it.each([null, undefined, ""])("returns undefined for %p", (raw) => {
        expect.assertions(1);

        expect(decodeUserIdHeader(raw)).toBeUndefined();
    });

    it("returns undefined for a malformed encoded userId", () => {
        expect.assertions(1);

        expect(decodeUserIdHeader("=not-valid-base64url!!!")).toBeUndefined();
    });
});
