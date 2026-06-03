import { describe, expect, it, vi } from "vitest";

import createMailer from "../src/create-mailer.js";
import { consumeQueuedSend } from "../src/queue.js";
import type { Mailer, MailTransport, SendPayload } from "../src/types.js";

const captureTransport = (): { sent: SendPayload[]; transport: MailTransport } => {
    const sent: SendPayload[] = [];

    return {
        sent,
        transport: {
            send: async (payload) => {
                sent.push(payload);

                return { id: "ok" };
            },
        },
    };
};

const CR_LF_COMMA_PATTERN = /CR, LF, or comma/;

describe("address validation (applies to every transport + the queue path)", () => {
    it("accepts a `Name <addr>` form and forwards it untouched to the transport", async () => {
        expect.assertions(1);

        const { sent, transport } = captureTransport();
        const mailer = createMailer({ from: "Default <noreply@x.test>", transport });

        await mailer.send({ subject: "Hi", to: "Alice <alice@x.test>" });

        expect(sent[0]?.to).toBe("Alice <alice@x.test>");
    });

    it("accepts a bare angle-addr `<addr>` with no display name", async () => {
        expect.assertions(1);

        const { sent, transport } = captureTransport();
        // This is the regression: a bare `<addr>` must NOT throw and must NOT be
        // mangled into a bracketed literal address downstream.
        const mailer = createMailer({ from: "<noreply@x.test>", transport });

        await mailer.send({ subject: "Hi", to: "<bob@x.test>" });

        expect(sent[0]?.to).toBe("<bob@x.test>");
    });

    it("rejects an address with an embedded CR/LF (header-injection vector)", async () => {
        expect.assertions(1);

        const { transport } = captureTransport();
        const mailer = createMailer({ from: "noreply@x.test", transport });

        await expect(mailer.send({ subject: "Hi", to: "a@x.test\r\nbcc: evil@x.test" })).rejects.toThrow(CR_LF_COMMA_PATTERN);
    });

    it("rejects an address with a comma (smuggled second recipient)", async () => {
        expect.assertions(1);

        const { transport } = captureTransport();
        const mailer = createMailer({ from: "noreply@x.test", transport });

        await expect(mailer.send({ subject: "Hi", to: "a@x.test,evil@x.test" })).rejects.toThrow(CR_LF_COMMA_PATTERN);
    });

    it("rejects an oversized email (> 320 chars)", async () => {
        expect.assertions(1);

        const { transport } = captureTransport();
        const mailer = createMailer({ from: "noreply@x.test", transport });
        const huge = `${"a".repeat(321)}@x.test`;

        await expect(mailer.send({ subject: "Hi", to: huge })).rejects.toThrow(/<= 320 characters/);
    });

    it("rejects an oversized display name (> 256 chars)", async () => {
        expect.assertions(1);

        const { transport } = captureTransport();
        const mailer = createMailer({ from: "noreply@x.test", transport });
        const longName = "a".repeat(257);

        await expect(mailer.send({ subject: "Hi", to: `${longName} <a@x.test>` })).rejects.toThrow(/<= 256 characters/);
    });

    it("validates cc / bcc / replyTo on a custom transport", async () => {
        expect.assertions(2);

        const { transport } = captureTransport();
        const mailer = createMailer({ from: "noreply@x.test", transport });

        await expect(mailer.send({ cc: ["a@x.test", "b@x.test,evil@x.test"], subject: "Hi", to: "x@x.test" })).rejects.toThrow(
            CR_LF_COMMA_PATTERN,
        );
        await expect(mailer.send({ replyTo: "reply@x.test\r\nx: y", subject: "Hi", to: "x@x.test" })).rejects.toThrow(CR_LF_COMMA_PATTERN);
    });

    it("validates addresses on the queue path before enqueueing", async () => {
        expect.assertions(2);

        const { transport } = captureTransport();
        const messages: unknown[] = [];
        const queue = { send: async (payload: unknown) => void messages.push(payload) };
        const mailer = createMailer({ from: "noreply@x.test", queue, transport });

        await expect(mailer.queue({ subject: "Hi", to: "a@x.test,evil@x.test" })).rejects.toThrow(CR_LF_COMMA_PATTERN);
        expect(messages).toHaveLength(0);
    });
});

describe("header / subject validation", () => {
    it("rejects CR/LF in the subject", async () => {
        expect.assertions(1);

        const { transport } = captureTransport();
        const mailer = createMailer({ from: "noreply@x.test", transport });

        await expect(mailer.send({ subject: "Hi\r\nX: y", to: "a@x.test" })).rejects.toThrow(/subject must not contain CR or LF/);
    });

    it("rejects CR/LF in a header key", async () => {
        expect.assertions(1);

        const { transport } = captureTransport();
        const mailer = createMailer({ from: "noreply@x.test", transport });

        await expect(mailer.send({ headers: { "X-Bad\r\nInjected": "v" }, subject: "Hi", to: "a@x.test" })).rejects.toThrow(
            /header name .* must not contain CR or LF/s,
        );
    });

    it("rejects CR/LF in a header value", async () => {
        expect.assertions(1);

        const { transport } = captureTransport();
        const mailer = createMailer({ from: "noreply@x.test", transport });

        await expect(mailer.send({ headers: { "X-Ok": "v\r\nInjected: y" }, subject: "Hi", to: "a@x.test" })).rejects.toThrow(
            /header .* value must not contain CR or LF/,
        );
    });
});

const noopMailer = (): Mailer => ({
    queue: async () => ({ queued: true }),
    send: vi.fn(async () => ({ id: "queued-send" })),
});

describe("consumeQueuedSend rejects malformed queue bodies", () => {
    it("rejects a non-object body", async () => {
        expect.assertions(1);

        await expect(consumeQueuedSend(noopMailer(), "not-an-object")).rejects.toThrow(/must be an object/);
    });

    it("rejects an array body", async () => {
        expect.assertions(1);

        await expect(consumeQueuedSend(noopMailer(), [])).rejects.toThrow(/must be an object/);
    });

    it("rejects a missing/non-string subject", async () => {
        expect.assertions(1);

        await expect(consumeQueuedSend(noopMailer(), { to: "a@x.test" })).rejects.toThrow(/string `subject`/);
    });

    it("rejects a bad `to`", async () => {
        expect.assertions(1);

        await expect(consumeQueuedSend(noopMailer(), { subject: "Hi", to: 42 })).rejects.toThrow(/`to` must be a string or string\[\]/);
    });

    it("rejects a non-string `from`", async () => {
        expect.assertions(1);

        await expect(consumeQueuedSend(noopMailer(), { from: 5, subject: "Hi", to: "a@x.test" })).rejects.toThrow(/`from` must be a string/);
    });

    it("rejects a non-object `headers`", async () => {
        expect.assertions(1);

        await expect(consumeQueuedSend(noopMailer(), { headers: 5, subject: "Hi", to: "a@x.test" })).rejects.toThrow(
            /`headers` must be an object/,
        );
    });

    it("rejects a `headers` map with a non-string value", async () => {
        expect.assertions(1);

        await expect(consumeQueuedSend(noopMailer(), { headers: { "X-A": 1 }, subject: "Hi", to: "a@x.test" })).rejects.toThrow(
            /header "X-A" must be a string/,
        );
    });

    it("forwards a well-formed body to mailer.send()", async () => {
        expect.assertions(2);

        const mailer = noopMailer();
        const result = await consumeQueuedSend(mailer, {
            from: "noreply@x.test",
            headers: { "X-Tag": "welcome" },
            subject: "Hi",
            to: ["a@x.test", "b@x.test"],
        });

        expect(result).toEqual({ id: "queued-send" });
        expect(mailer.send).toHaveBeenCalledWith(
            expect.objectContaining({ from: "noreply@x.test", headers: { "X-Tag": "welcome" }, subject: "Hi", to: ["a@x.test", "b@x.test"] }),
        );
    });
});
