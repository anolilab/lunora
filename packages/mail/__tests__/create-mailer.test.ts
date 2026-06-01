import { describe, expect, it, vi } from "vitest";

import { createMailer } from "../src/create-mailer.js";
import type { MailTransport, QueueLike, SendPayload } from "../src/types.js";

const FROM_PATTERN = /from/;
const API_KEY_PATTERN = /apiKey/;
const QUEUE_PATTERN = /queue/;

const fakeTransport = (id: string = "msg-1"): { sent: SendPayload[]; transport: MailTransport } => {
    const sent: SendPayload[] = [];
    const transport: MailTransport = {
        send: vi.fn<MailTransport["send"]>(async (payload: SendPayload) => {
            sent.push(payload);

            return { id };
        }),
    };

    return { sent, transport };
};

describe("createMailer", () => {
    it("throws when `from` is missing", () => {
        expect.assertions(1);

        expect(() => createMailer({ from: "" })).toThrow(FROM_PATTERN);
    });

    it("throws when neither apiKey nor transport is configured", () => {
        expect.assertions(1);

        expect(() => createMailer({ from: "noreply@x.test" })).toThrow(API_KEY_PATTERN);
    });

    it("send() forwards to the transport with the default `from`", async () => {
        expect.assertions(3);

        const { sent, transport } = fakeTransport("id-42");
        const mailer = createMailer({ from: "Default <noreply@x.test>", transport });

        const result = await mailer.send({
            subject: "Hello",
            text: "world",
            to: "alice@example.test",
        });

        expect(result).toEqual({ id: "id-42" });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            from: "Default <noreply@x.test>",
            subject: "Hello",
            text: "world",
            to: "alice@example.test",
        });
    });

    it("send() honors a per-call `from` override", async () => {
        expect.assertions(1);

        const { sent, transport } = fakeTransport();
        const mailer = createMailer({ from: "Default <noreply@x.test>", transport });

        await mailer.send({ from: "Bob <bob@x.test>", subject: "Hi", to: "bob@x.test" });

        expect(sent[0]?.from).toBe("Bob <bob@x.test>");
    });

    it("queue() enqueues a serializable payload and skips the transport", async () => {
        expect.assertions(4);

        const { sent, transport } = fakeTransport();
        const queueMessages: unknown[] = [];
        const queue: QueueLike = {
            send: vi.fn<QueueLike["send"]>(async (payload: unknown) => {
                queueMessages.push(payload);
            }),
        };
        const mailer = createMailer({ from: "Default <noreply@x.test>", queue, transport });

        const result = await mailer.queue({
            html: "<p>hi</p>",
            subject: "Queued",
            to: ["a@x.test", "b@x.test"],
        });

        expect(result).toEqual({ queued: true });
        expect(queueMessages).toHaveLength(1);
        expect(queueMessages[0]).toMatchObject({
            from: "Default <noreply@x.test>",
            html: "<p>hi</p>",
            subject: "Queued",
            to: ["a@x.test", "b@x.test"],
        });
        expect(sent).toHaveLength(0);
    });

    it("queue() requires a queue binding", async () => {
        expect.assertions(1);

        const { transport } = fakeTransport();
        const mailer = createMailer({ from: "x@x.test", transport });

        await expect(mailer.queue({ subject: "x", text: "y", to: "a@x.test" })).rejects.toThrow(QUEUE_PATTERN);
    });
});
