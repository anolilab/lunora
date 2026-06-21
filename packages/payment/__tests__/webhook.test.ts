import { describe, expect, it } from "vitest";

import { LunoraPaymentError } from "../src/errors";
import { constantTimeEqual, hmacSha256Hex, parseStripeSignatureHeader, verifyStandardWebhook, verifyStripeSignature } from "../src/webhook";

const sign = async (secret: string, payload: string, timestamp: number): Promise<string> => {
    const signature = await hmacSha256Hex(secret, `${String(timestamp)}.${payload}`);

    return `t=${String(timestamp)},v1=${signature}`;
};

describe("webhook verification", () => {
    const secret = "whsec_test";
    const payload = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });
    const timestamp = 1_700_000_000;
    const now = timestamp * 1000;

    it("verifies a valid signature over the raw body", async () => {
        expect.assertions(1);

        const signatureHeader = await sign(secret, payload, timestamp);

        await expect(verifyStripeSignature({ now, payload, secret, signatureHeader })).resolves.toBeUndefined();
    });

    it("rejects a tampered body", async () => {
        expect.assertions(1);

        const signatureHeader = await sign(secret, payload, timestamp);

        await expect(verifyStripeSignature({ now, payload: `${payload} `, secret, signatureHeader })).rejects.toBeInstanceOf(LunoraPaymentError);
    });

    it("rejects an out-of-tolerance timestamp (replay)", async () => {
        expect.assertions(1);

        const signatureHeader = await sign(secret, payload, timestamp);

        await expect(verifyStripeSignature({ now: now + 1_000_000, payload, secret, signatureHeader })).rejects.toMatchObject({
            code: "WEBHOOK_TIMESTAMP_INVALID",
        });
    });

    it("rejects a signature made with the wrong secret", async () => {
        expect.assertions(1);

        const signatureHeader = await sign("other_secret", payload, timestamp);

        await expect(verifyStripeSignature({ now, payload, secret, signatureHeader })).rejects.toMatchObject({
            code: "WEBHOOK_SIGNATURE_INVALID",
        });
    });

    it("compares in constant time", () => {
        expect.assertions(3);

        expect(constantTimeEqual("abc", "abc")).toBe(true);
        expect(constantTimeEqual("abc", "abd")).toBe(false);
        expect(constantTimeEqual("a", "ab")).toBe(false);
    });

    it("parses a multi-signature header", () => {
        expect.assertions(1);

        expect(parseStripeSignatureHeader("t=5,v1=aa,v1=bb")).toEqual({ signatures: ["aa", "bb"], timestamp: 5 });
    });

    it("fails closed on an empty signing secret (no forgeable zero-length-key MAC)", async () => {
        expect.assertions(2);

        // An attacker can't sign with the empty key anyway (WebCrypto rejects a
        // zero-length HMAC key), but the verifier must reject the empty secret
        // up front regardless of the supplied header — so any header shape does.
        const signatureHeader = `t=${String(timestamp)},v1=deadbeef`;

        await expect(verifyStripeSignature({ now, payload, secret: "", signatureHeader })).rejects.toMatchObject({ code: "CONFIG_INVALID" });

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
});
