import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSignedUrl, verifySignedUrl } from "../src/signed-url";

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

    it("pins contentType into a PUT signature and round-trips it", async () => {
        expect.assertions(4);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            contentType: "image/png",
            expiresInSeconds: 60,
            key: "uploads/x.png",
            method: "PUT",
            secret: "shh",
        });

        expect(new URL(url).searchParams.get("ct")).toBe("image/png");

        const result = await verifySignedUrl(url, "shh");

        expect(result.valid).toBe(true);
        expect(result.contentType).toBe("image/png");

        // Tampering with the pinned content-type breaks the signature.
        const tampered = new URL(url);

        tampered.searchParams.set("ct", "text/html");

        await expect(verifySignedUrl(tampered.toString(), "shh")).resolves.toMatchObject({ valid: false });
    });

    it("ignores contentType for GET URLs (no body to pin)", async () => {
        expect.assertions(2);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            contentType: "image/png",
            expiresInSeconds: 60,
            key: "x.png",
            method: "GET",
            secret: "shh",
        });

        expect(new URL(url).searchParams.has("ct")).toBe(false);
        await expect(verifySignedUrl(url, "shh")).resolves.toMatchObject({ valid: true });
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

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects a non-positive/non-finite expiresInSeconds (%s)", async (expiresInSeconds) => {
        expect.assertions(1);

        await expect(
            buildSignedUrl({
                baseUrl: "https://cdn.test",
                expiresInSeconds,
                key: "x",
                secret: "shh",
            }),
        ).rejects.toThrow(/positive finite number/);
    });

    it("rejects an expiresInSeconds beyond the 7-day ceiling", async () => {
        expect.assertions(1);

        await expect(
            buildSignedUrl({
                baseUrl: "https://cdn.test",
                expiresInSeconds: 8 * 24 * 60 * 60,
                key: "x",
                secret: "shh",
            }),
        ).rejects.toThrow(/must not exceed/);
    });

    it("rejects an out-of-bounds expiresInSeconds as a 400 validation error, not a redacted 500", async () => {
        expect.assertions(2);

        // A caller passing a bad TTL is a client error → VALIDATION_ERROR / 400,
        // not an INTERNAL / 500 that redacts the message to a generic string.
        await expect(buildSignedUrl({ baseUrl: "https://cdn.test", expiresInSeconds: 0, key: "x", secret: "shh" })).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
            status: 400,
        });

        await expect(buildSignedUrl({ baseUrl: "https://cdn.test", expiresInSeconds: 8 * 24 * 60 * 60, key: "x", secret: "shh" })).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
            status: 400,
        });
    });

    it("normalises a multi-trailing-slash baseUrl to a single-slash join", async () => {
        expect.assertions(1);

        // Regression: getUrl trims all trailing slashes, but the signed-URL
        // builder previously trimmed only one — a `https://cdn.test//` base then
        // yielded a double-slash signed URL. Both must agree now.
        const url = await buildSignedUrl({ baseUrl: "https://cdn.test//", expiresInSeconds: 60, key: "uploads/x.png", secret: "shh" });

        expect(new URL(url).pathname).toBe("/uploads/x.png");
    });

    it("returns malformed for an exp with trailing garbage", async () => {
        expect.assertions(2);

        const url = await buildSignedUrl({
            baseUrl: "https://cdn.test",
            expiresInSeconds: 60,
            key: "x",
            secret: "shh",
        });
        const tampered = new URL(url);

        tampered.searchParams.set("exp", `${tampered.searchParams.get("exp") ?? ""}abc`);

        const result = await verifySignedUrl(tampered.toString(), "shh");

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("malformed");
    });

    it("binds the signature to a bare-host baseUrl (no scheme)", async () => {
        expect.assertions(2);

        // extractHost falls back to scheme-stripping + path-splitting for a
        // bare host. The minted URL has no scheme, so verify must be handed an
        // explicit expectedHost to canonicalize against the same host.
        const url = await buildSignedUrl({
            baseUrl: "cdn.test/uploads",
            expiresInSeconds: 60,
            key: "x.png",
            secret: "shh",
        });

        const result = await verifySignedUrl(`https://cdn.test/x.png?${url.split("?")[1] ?? ""}`, "shh", { expectedHost: "cdn.test" });

        expect(result.valid).toBe(true);
        expect(result.key).toBe("x.png");
    });

    it("verifies against an explicit expectedHost differing from the inbound host", async () => {
        expect.assertions(2);

        // Minted for the CDN host, verified against a Worker route host: without
        // expectedHost this would fail as bad_signature.
        const url = await buildSignedUrl({
            baseUrl: "https://cdn.example.com",
            expiresInSeconds: 60,
            key: "uploads/x.png",
            secret: "shh",
        });

        const rewritten = new URL(url);

        rewritten.host = "api.example.com";

        await expect(verifySignedUrl(rewritten.toString(), "shh")).resolves.toMatchObject({ reason: "bad_signature", valid: false });
        await expect(verifySignedUrl(rewritten.toString(), "shh", { expectedHost: "https://cdn.example.com" })).resolves.toMatchObject({ valid: true });
    });

    it("rejects a key containing a raw newline at sign time (BINDINGS-01)", async () => {
        expect.assertions(1);

        // The canonical is `method\nhost\nkey\nexp[\nct]` — `key` is not its
        // last field, so a raw \n could shift where `exp` re-splits on verify.
        await expect(buildSignedUrl({ baseUrl: "https://cdn.test", key: "uploads/x\n9999999999\nGET", secret: "shh" })).rejects.toThrow(/control character/);
    });

    it("rejects a key containing a carriage return at sign time", async () => {
        expect.assertions(1);

        await expect(buildSignedUrl({ baseUrl: "https://cdn.test", key: "uploads/x\ry", secret: "shh" })).rejects.toThrow(/control character/);
    });

    it("still signs and verifies a normal key unaffected by the control-char guard", async () => {
        expect.assertions(2);

        const url = await buildSignedUrl({ baseUrl: "https://cdn.test", key: "uploads/x.png", secret: "shh" });
        const result = await verifySignedUrl(url, "shh");

        expect(result.valid).toBe(true);
        expect(result.key).toBe("uploads/x.png");
    });
});
