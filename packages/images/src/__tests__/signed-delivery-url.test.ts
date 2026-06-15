import { describe, expect, it } from "vitest";

import { buildImageDeliveryUrl } from "../delivery-url";
import { buildSignedImageUrl, verifySignedImageUrl } from "../signed-delivery-url";

const SECRET = "test-signing-secret";
const BASE = "https://cdn.acme.test";

describe("buildSignedImageUrl / verifySignedImageUrl", () => {
    it("round-trips a valid signed URL", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: BASE, key: "uploads/avatar.png", secret: SECRET });
        const result = await verifySignedImageUrl(url, SECRET);

        expect(result.valid).toBe(true);
        expect(result.key).toBe("uploads/avatar.png");
    });

    it("binds the transform into the signature and surfaces it on verify", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({
            baseUrl: BASE,
            key: "uploads/avatar.png",
            secret: SECRET,
            transform: { fit: "cover", height: 256, width: 256 },
        });
        const result = await verifySignedImageUrl(url, SECRET);

        expect(result.valid).toBe(true);
        expect(result.transform).toContain("width=256");
    });

    it("rejects a tampered key as bad_signature", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: BASE, key: "uploads/avatar.png", secret: SECRET });
        const tampered = url.replace("avatar.png", "secret.png");
        const result = await verifySignedImageUrl(tampered, SECRET);

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("bad_signature");
    });

    it("rejects a tampered transform as bad_signature", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({
            baseUrl: BASE,
            key: "uploads/avatar.png",
            secret: SECRET,
            transform: { width: 256 },
        });
        const parsed = new URL(url);

        parsed.searchParams.set("t", "width=4096");

        const result = await verifySignedImageUrl(parsed.toString(), SECRET);

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("bad_signature");
    });

    it("rejects an expired URL", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: BASE, expiresInSeconds: 1, key: "uploads/avatar.png", secret: SECRET });
        const parsed = new URL(url);

        // Rewind exp to the past, then re-sign-free path: verify must catch expiry
        // before the signature check, so a stale exp is rejected as `expired`.
        parsed.searchParams.set("exp", "1");

        const result = await verifySignedImageUrl(parsed.toString(), SECRET);

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("expired");
    });

    it("rejects a malformed URL", async () => {
        expect.assertions(2);

        const result = await verifySignedImageUrl("not a url", SECRET);

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("malformed");
    });

    it("rejects a URL missing the signature as malformed", async () => {
        expect.assertions(2);

        const result = await verifySignedImageUrl(`${BASE}/uploads/avatar.png?exp=99999999999`, SECRET);

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("malformed");
    });

    it("fails verify under a different secret", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: BASE, key: "k.png", secret: SECRET });
        const result = await verifySignedImageUrl(url, "other-secret");

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("bad_signature");
    });

    it("rejects a non-positive TTL at build time", async () => {
        expect.assertions(1);

        await expect(buildSignedImageUrl({ baseUrl: BASE, expiresInSeconds: 0, key: "k.png", secret: SECRET })).rejects.toThrow(/positive finite number/);
    });

    it("rejects a TTL above the 7-day ceiling", async () => {
        expect.assertions(1);

        await expect(buildSignedImageUrl({ baseUrl: BASE, expiresInSeconds: 8 * 24 * 60 * 60, key: "k.png", secret: SECRET })).rejects.toThrow(/7 days/);
    });
});

describe("buildImageDeliveryUrl", () => {
    it("builds the /cdn-cgi/image transform path for a relative key", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: BASE, key: "uploads/avatar.png", transform: { width: 256, fit: "cover" } });

        expect(url).toBe(`${BASE}/cdn-cgi/image/width=256,fit=cover/uploads/avatar.png`);
    });

    it("leaves an absolute source URL verbatim after the options", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: BASE, key: "https://origin.test/a.png", transform: { width: 100 } });

        expect(url).toBe(`${BASE}/cdn-cgi/image/width=100/https://origin.test/a.png`);
    });

    it("omits the options segment when no transform is given", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: BASE, key: "a.png" });

        expect(url).toBe(`${BASE}/cdn-cgi/image/a.png`);
    });

    it("builds the hosted delivery-variant form for an imageId", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: BASE, imageId: "abc-123", variant: "thumbnail" });

        expect(url).toBe(`${BASE}/abc-123/thumbnail`);
    });

    it("defaults the variant to public", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: BASE, imageId: "abc-123" });

        expect(url).toBe(`${BASE}/abc-123/public`);
    });

    it("throws when neither imageId nor key is supplied", () => {
        expect.assertions(1);

        expect(() => buildImageDeliveryUrl({ baseUrl: BASE })).toThrow(/requires either/);
    });
});
