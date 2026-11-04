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

    it("refuses a declared Content-Length over the cap, and releases the body it will not read", async () => {
        expect.assertions(2);

        const request = new Request("https://app.test/payment/webhook", { body: "x".repeat(65), headers: { "content-length": "65" }, method: "POST" });

        await expect(readWebhookBody(request, 64)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
        // A cancelled stream is done: nothing is left for the host to keep receiving.
        await expect(request.body!.getReader().read()).resolves.toStrictEqual({ done: true, value: undefined });
    });

    it("refuses a cap that is not a number rather than reading without one", async () => {
        expect.assertions(1);

        await expect(readWebhookBody(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }), Number.NaN)).rejects.toThrow(RangeError);
    });

    it("refuses a body with no Content-Length once the bytes read pass the cap", async () => {
        expect.assertions(2);

        const request = chunked("x".repeat(65));

        expect(request.headers.get("content-length")).toBeNull();
        await expect(readWebhookBody(request, 64)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    });
});
