import { describe, expect, it, vi } from "vitest";

import createMailer from "../src/create-mailer";
import { consumeQueuedSend } from "../src/queue";
import type { Mailer, MailTransport, SendPayload } from "../src/types";

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

const captureQueue = (): { messages: { [key: string]: unknown; idempotencyKey?: string }[]; queue: { send: (payload: unknown) => Promise<void> } } => {
    const messages: { [key: string]: unknown; idempotencyKey?: string }[] = [];

    return {
        messages,
        queue: {
            send: async (payload: unknown): Promise<void> => {
                messages.push(payload as { idempotencyKey?: string });
            },
        },
    };
};

const noopMailer = (): Mailer => {
    return {
        queue: async () => {
            return { queued: true };
        },
        send: vi.fn<Mailer["send"]>(async () => {
            return { id: "queued-send" };
        }),
    };
};

describe("queued send idempotency key", () => {
    it("stays stable across two consumes of the same enqueued payload — key is minted at enqueue time, not on every redelivery", async () => {
        expect.assertions(3);

        const { messages, queue } = captureQueue();
        const { transport } = captureTransport();
        const mailer = createMailer({ from: "noreply@x.test", queue, transport });

        await mailer.queue({ subject: "Hi", to: "a@x.test" });

        expect(messages).toHaveLength(1);

        const enqueued = messages[0]!;

        expect(typeof enqueued.idempotencyKey).toBe("string");

        // Simulate Cloudflare Queues redelivering the SAME message body twice —
        // `consumeQueuedSend` must forward the same key both times, proving the
        // key was minted once at enqueue and not regenerated per consume.
        const consumer = noopMailer();

        await consumeQueuedSend(consumer, enqueued);
        await consumeQueuedSend(consumer, enqueued);

        const sendMock = consumer.send as ReturnType<typeof vi.fn>;
        const firstKey = (sendMock.mock.calls[0]?.[0] as { idempotencyKey?: string }).idempotencyKey;
        const secondKey = (sendMock.mock.calls[1]?.[0] as { idempotencyKey?: string }).idempotencyKey;

        expect(firstKey).toBe(secondKey);
    });

    it("lets a caller-supplied key win over the generated one", async () => {
        expect.assertions(1);

        const { messages, queue } = captureQueue();
        const { transport } = captureTransport();
        const mailer = createMailer({ from: "noreply@x.test", queue, transport });

        await mailer.queue({ idempotencyKey: "order-42", subject: "Hi", to: "a@x.test" });

        expect(messages[0]?.idempotencyKey).toBe("order-42");
    });

    it("still rejects malformed queue bodies (regression guard)", async () => {
        expect.assertions(2);

        await expect(consumeQueuedSend(noopMailer(), { to: "a@x.test" })).rejects.toThrow(/string `subject`/);
        await expect(consumeQueuedSend(noopMailer(), { idempotencyKey: 42, subject: "Hi", to: "a@x.test" })).rejects.toThrow(
            /`idempotencyKey` must be a string/,
        );
    });
});
