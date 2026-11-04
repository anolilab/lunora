import { describe, expect, it } from "vitest";

import { readWebhookBody } from "../src/webhook-body";

/** A body with no `Content-Length`, the way a chunked request arrives. */
const chunked = (text: string): Request => {
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
            for (let offset = 0; offset < bytes.length; offset += 4) {
                controller.enqueue(bytes.slice(offset, offset + 4));
            }

            controller.close();
        },
    });

    return new Request("https://app.test/payment/webhook", { body, duplex: "half", method: "POST" } as RequestInit);
};

describe(readWebhookBody, () => {
    it("returns a body within the cap verbatim", async () => {
        expect.assertions(1);

        await expect(readWebhookBody(new Request("https://app.test/payment/webhook", { body: '{"id":"evt_1"}', method: "POST" }), 64)).resolves.toBe(
            '{"id":"evt_1"}',
        );
    });

    it("refuses a declared Content-Length over the cap", async () => {
        expect.assertions(1);

        const request = new Request("https://app.test/payment/webhook", { body: "x".repeat(65), headers: { "content-length": "65" }, method: "POST" });

        await expect(readWebhookBody(request, 64)).resolves.toBeUndefined();
    });

    it("refuses a body with no Content-Length once the bytes read pass the cap", async () => {
        expect.assertions(2);

        const request = chunked("x".repeat(65));

        expect(request.headers.get("content-length")).toBeNull();
        await expect(readWebhookBody(request, 64)).resolves.toBeUndefined();
    });
});
