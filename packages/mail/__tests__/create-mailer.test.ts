import { describe, expect, test, vi } from "vitest";

import { createMailer } from "../src/create-mailer.js";
import type { MailTransport, QueueLike, SendPayload } from "../src/types.js";

const fakeTransport = (id: string = "msg-1"): { transport: MailTransport; sent: SendPayload[] } => {
    const sent: SendPayload[] = [];
    const transport: MailTransport = {
        send: vi.fn(async (payload: SendPayload) => {
            sent.push(payload);

            return { id };
        }),
    };

    return { transport, sent };
};

describe("createMailer", () => {
    test("throws when `from` is missing", () => {
        expect(() => createMailer({ from: "" })).toThrow(/from/);
    });

    test("throws when neither apiKey nor transport is configured", () => {
        expect(() => createMailer({ from: "noreply@x.test" })).toThrow(/apiKey/);
    });

    test("send() forwards to the transport with the default `from`", async () => {
        const { transport, sent } = fakeTransport("id-42");
        const mailer = createMailer({ from: "Default <noreply@x.test>", transport });

        const result = await mailer.send({
            to: "alice@example.test",
            subject: "Hello",
            text: "world",
        });

        expect(result).toEqual({ id: "id-42" });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            from: "Default <noreply@x.test>",
            to: "alice@example.test",
            subject: "Hello",
            text: "world",
        });
    });

    test("send() honors a per-call `from` override", async () => {
        const { transport, sent } = fakeTransport();
        const mailer = createMailer({ from: "Default <noreply@x.test>", transport });

        await mailer.send({ to: "bob@x.test", subject: "Hi", from: "Bob <bob@x.test>" });

        expect(sent[0]?.from).toBe("Bob <bob@x.test>");
    });

    test("queue() enqueues a serializable payload and skips the transport", async () => {
        const { transport, sent } = fakeTransport();
        const queueMessages: unknown[] = [];
        const queue: QueueLike = {
            send: vi.fn(async (payload: unknown) => {
                queueMessages.push(payload);
            }),
        };
        const mailer = createMailer({ from: "Default <noreply@x.test>", transport, queue });

        const result = await mailer.queue({
            to: ["a@x.test", "b@x.test"],
            subject: "Queued",
            html: "<p>hi</p>",
        });

        expect(result).toEqual({ queued: true });
        expect(queueMessages).toHaveLength(1);
        expect(queueMessages[0]).toMatchObject({
            to: ["a@x.test", "b@x.test"],
            subject: "Queued",
            html: "<p>hi</p>",
            from: "Default <noreply@x.test>",
        });
        expect(sent).toHaveLength(0);
    });

    test("queue() requires a queue binding", async () => {
        const { transport } = fakeTransport();
        const mailer = createMailer({ from: "x@x.test", transport });

        await expect(mailer.queue({ to: "a@x.test", subject: "x", text: "y" })).rejects.toThrow(/queue/);
    });
});
