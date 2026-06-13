import { describe, expect, it } from "vitest";

import { CirrusPaymentError } from "../src/errors";
import { constantTimeEqual, hmacSha256Hex, parseStripeSignatureHeader, verifyStripeSignature } from "../src/webhook";

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
        const signatureHeader = await sign(secret, payload, timestamp);

        await expect(verifyStripeSignature({ now, payload, secret, signatureHeader })).resolves.toBeUndefined();
    });

    it("rejects a tampered body", async () => {
        const signatureHeader = await sign(secret, payload, timestamp);

        await expect(verifyStripeSignature({ now, payload: `${payload} `, secret, signatureHeader })).rejects.toBeInstanceOf(CirrusPaymentError);
    });

    it("rejects an out-of-tolerance timestamp (replay)", async () => {
        const signatureHeader = await sign(secret, payload, timestamp);

        await expect(verifyStripeSignature({ now: now + 1_000_000, payload, secret, signatureHeader })).rejects.toMatchObject({
            code: "WEBHOOK_TIMESTAMP_INVALID",
        });
    });

    it("rejects a signature made with the wrong secret", async () => {
        const signatureHeader = await sign("other_secret", payload, timestamp);

        await expect(verifyStripeSignature({ now, payload, secret, signatureHeader })).rejects.toMatchObject({
            code: "WEBHOOK_SIGNATURE_INVALID",
        });
    });

    it("compares in constant time", () => {
        expect(constantTimeEqual("abc", "abc")).toBe(true);
        expect(constantTimeEqual("abc", "abd")).toBe(false);
        expect(constantTimeEqual("a", "ab")).toBe(false);
    });

    it("parses a multi-signature header", () => {
        expect(parseStripeSignatureHeader("t=5,v1=aa,v1=bb")).toEqual({ signatures: ["aa", "bb"], timestamp: 5 });
    });
});
