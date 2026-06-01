import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSignedUrl, verifySignedUrl } from "../src/signed-url.js";

describe("signedUrl", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("sign + verify roundtrip succeeds for a fresh signature", async () => {
        expect.assertions(3);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            expiresInSeconds: 120,
            key: "uploads/x.png",
            secret: "shh",
        });

        const result = await verifySignedUrl(url, "shh");

        expect(result.valid).toBe(true);
        expect(result.key).toBe("uploads/x.png");
        expect(result.method).toBe("GET");
    });

    it("rejects an expired URL", async () => {
        expect.assertions(2);

        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            expiresInSeconds: 60,
            key: "uploads/x.png",
            secret: "shh",
        });

        // Advance past expiry.
        vi.setSystemTime(new Date("2025-01-01T00:05:00Z"));

        const result = await verifySignedUrl(url, "shh");

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("expired");
    });

    it("rejects a URL signed with a different secret", async () => {
        expect.assertions(2);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            expiresInSeconds: 60,
            key: "x",
            secret: "right",
        });

        const result = await verifySignedUrl(url, "wrong");

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("bad_signature");
    });

    it("rejects a URL with a tampered key path", async () => {
        expect.assertions(2);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            expiresInSeconds: 60,
            key: "uploads/a.png",
            secret: "shh",
        });

        const tampered = url.replace("uploads/a.png", "uploads/b.png");
        const result = await verifySignedUrl(tampered, "shh");

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("bad_signature");
    });

    it("returns malformed for URLs missing sig or exp", async () => {
        expect.assertions(2);

        const result = await verifySignedUrl("https://cdn.test/x", "shh");

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("malformed");
    });

    it("preserves PUT method in the round-trip", async () => {
        expect.assertions(2);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            expiresInSeconds: 60,
            key: "uploads/x.png",
            method: "PUT",
            secret: "shh",
        });

        const result = await verifySignedUrl(url, "shh");

        expect(result.valid).toBe(true);
        expect(result.method).toBe("PUT");
    });

    it("returns malformed for an unsupported method", async () => {
        expect.assertions(2);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            expiresInSeconds: 60,
            key: "uploads/x.png",
            method: "GET",
            secret: "shh",
        });
        const tampered = new URL(url);

        tampered.searchParams.set("method", "DELETE");

        const result = await verifySignedUrl(tampered.toString(), "shh");

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("malformed");
    });

    it("handles keys with multiple path segments", async () => {
        expect.assertions(2);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test/",
            expiresInSeconds: 60,
            key: "a/b/c.txt",
            secret: "shh",
        });

        const result = await verifySignedUrl(url, "shh");

        expect(result.valid).toBe(true);
        expect(result.key).toBe("a/b/c.txt");
    });
});
