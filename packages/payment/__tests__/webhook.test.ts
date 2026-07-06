import { describe, expect, it } from "vitest";

import { constantTimeEqual, verifyStandardWebhook } from "../src/webhook";

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
});
