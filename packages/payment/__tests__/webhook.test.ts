import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { constantTimeEqual as sharedConstantTimeEqual } from "../../../shared/constant-time-equal";
import { constantTimeEqual, hmacSha256Hex, verifyStandardWebhook } from "../src/webhook";

describe("webhook verification", () => {
    const payload = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });
    const timestamp = 1_700_000_000;
    const now = timestamp * 1000;

    it("compares in constant time", () => {
        expect.assertions(3);

        expect(constantTimeEqual("abc", "abc")).toBe(true);
        expect(constantTimeEqual("abc", "abd")).toBe(false);
        expect(constantTimeEqual("a", "ab")).toBe(false);
    });

    /**
     * Pins the ONE-definition rule rather than the behaviour: a re-inlined local
     * copy would still satisfy the assertions above while reintroducing the
     * early return on a length mismatch that leaks the expected signature's
     * length through response timing.
     */
    it("is the shared primitive, not a local copy", () => {
        expect.assertions(1);

        expect(constantTimeEqual).toBe(sharedConstantTimeEqual);
    });

    it("fails closed on an empty signing secret (no forgeable zero-length-key MAC)", async () => {
        expect.assertions(1);

        // WebCrypto rejects a zero-length HMAC key anyway, but the verifier must reject the empty
        // secret up front regardless of the supplied header.
        await expect(
            verifyStandardWebhook({
                now,
                payload,
                secret: "",
                webhookId: "msg_1",
                webhookSignature: "v1,sig",
                webhookTimestamp: String(timestamp),
            }),
        ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });

    const signed = (key: Buffer): string =>
        `v1,${createHmac("sha256", key)
            .update(`msg_1.${String(timestamp)}.${payload}`)
            .digest("base64")}`;
    const verify = async (secret: string, webhookSignature: string, keyEncoding?: "base64" | "utf8"): Promise<void> =>
        verifyStandardWebhook({
            ...(keyEncoding === undefined ? {} : { keyEncoding }),
            now,
            payload,
            secret,
            webhookId: "msg_1",
            webhookSignature,
            webhookTimestamp: String(timestamp),
        });

    it("keys a utf8 secret by its bytes verbatim, prefix included", async () => {
        expect.assertions(2);

        const polarFormat = "polar_whs_3kL9xQ2mV7pR4tY8wZ1nB6cD5fG0hJ"; // gitleaks:allow -- test fixture signing key, not a real secret

        await expect(verify(polarFormat, signed(Buffer.from(polarFormat, "utf8")), "utf8")).resolves.toBeUndefined();
        // The prefix is part of the key: signing without it must not verify.
        await expect(verify(polarFormat, signed(Buffer.from(polarFormat.slice("polar_whs_".length), "utf8")), "utf8")).rejects.toMatchObject({
            code: "WEBHOOK_SIGNATURE_INVALID",
        });
    });

    it("keeps the base64 default for whsec_ secrets", async () => {
        expect.assertions(1);

        const key = Buffer.from("a-standard-webhooks-key");

        await expect(verify(`whsec_${key.toString("base64")}`, signed(key))).resolves.toBeUndefined();
    });

    it("reports a non-base64 secret as a configuration error, not a bad delivery", async () => {
        expect.assertions(1);

        await expect(verify("polar_whs_not-base64!", "v1,sig")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });

    // The key caches are module-level and outlive each test, so every test uses its own secret.
    describe("key cache", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("imports a base64 secret's key once across deliveries", async () => {
            expect.assertions(1);

            const key = Buffer.from("cache-once-base64-key");
            const importKey = vi.spyOn(crypto.subtle, "importKey");

            await Promise.all(Array.from({ length: 5 }, async () => verify(`whsec_${key.toString("base64")}`, signed(key))));

            expect(importKey).toHaveBeenCalledTimes(1);
        });

        it("imports a utf8 secret's key once across deliveries and hex signatures", async () => {
            expect.assertions(1);

            const secret = "cache-once-utf8-secret";
            const importKey = vi.spyOn(crypto.subtle, "importKey");

            await Promise.all(Array.from({ length: 5 }, async () => verify(secret, signed(Buffer.from(secret, "utf8")), "utf8")));
            await Promise.all(Array.from({ length: 5 }, async () => hmacSha256Hex(secret, payload)));

            expect(importKey).toHaveBeenCalledTimes(1);
        });

        it("imports a new key for a new secret and rejects a signature made under the old one", async () => {
            expect.assertions(3);

            const oldKey = Buffer.from("cache-rotate-old-key");
            const newKey = Buffer.from("cache-rotate-new-key");
            const importKey = vi.spyOn(crypto.subtle, "importKey");

            await expect(verify(`whsec_${newKey.toString("base64")}`, signed(oldKey))).rejects.toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });
            await expect(verify(`whsec_${oldKey.toString("base64")}`, signed(oldKey))).resolves.toBeUndefined();
            expect(importKey).toHaveBeenCalledTimes(2);
        });
    });
});
