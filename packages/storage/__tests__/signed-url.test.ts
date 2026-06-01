import { afterEach, describe, expect, test, vi } from "vitest";

import { buildSignedUrl, verifySignedUrl } from "../src/signed-url.js";

describe("signedUrl", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test("sign + verify roundtrip succeeds for a fresh signature", async () => {
        expect.assertions(3);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            secret: "shh",
            key: "uploads/x.png",
            expiresInSeconds: 120,
        });

        const result = await verifySignedUrl(url, "shh");

        expect(result.valid).toBe(true);
        expect(result.key).toBe("uploads/x.png");
        expect(result.method).toBe("GET");
    });

    test("rejects an expired URL", async () => {
        expect.assertions(2);

        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            secret: "shh",
            key: "uploads/x.png",
            expiresInSeconds: 60,
        });

        // Advance past expiry.
        vi.setSystemTime(new Date("2025-01-01T00:05:00Z"));

        const result = await verifySignedUrl(url, "shh");

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("expired");
    });

    test("rejects a URL signed with a different secret", async () => {
        expect.assertions(2);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            secret: "right",
            key: "x",
            expiresInSeconds: 60,
        });

        const result = await verifySignedUrl(url, "wrong");

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("bad_signature");
    });

    test("rejects a URL with a tampered key path", async () => {
        expect.assertions(2);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            secret: "shh",
            key: "uploads/a.png",
            expiresInSeconds: 60,
        });

        const tampered = url.replace("uploads/a.png", "uploads/b.png");
        const result = await verifySignedUrl(tampered, "shh");

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("bad_signature");
    });

    test("returns malformed for URLs missing sig or exp", async () => {
        expect.assertions(2);

        const result = await verifySignedUrl("https://cdn.test/x", "shh");

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("malformed");
    });

    test("preserves PUT method in the round-trip", async () => {
        expect.assertions(2);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            secret: "shh",
            key: "uploads/x.png",
            method: "PUT",
            expiresInSeconds: 60,
        });

        const result = await verifySignedUrl(url, "shh");

        expect(result.valid).toBe(true);
        expect(result.method).toBe("PUT");
    });

    test("handles keys with multiple path segments", async () => {
        expect.assertions(2);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test/",
            secret: "shh",
            key: "a/b/c.txt",
            expiresInSeconds: 60,
        });

        const result = await verifySignedUrl(url, "shh");

        expect(result.valid).toBe(true);
        expect(result.key).toBe("a/b/c.txt");
    });
});
