import { describe, expect, expectTypeOf, it, vi } from "vitest";

import createMailer from "../src/create-mailer";
import type { SentMailStore } from "../src/queue";
import { consumeQueuedSend } from "../src/queue";
import { isRetryableMailError, MailSendError } from "../src/send-error";
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

describe("consumeQueuedSend with a sent-mail store", () => {
    const body = { idempotencyKey: "order-42", subject: "Hi", to: "a@x.test" };

    /** A KV-shaped store over a Map, recording every `put`. */
    const memoryStore = (initial: Record<string, string> = {}) => {
        const entries = new Map(Object.entries(initial));
        const puts: { key: string; ttl: number; value: string }[] = [];

        return {
            entries,
            puts,
            store: {
                get: async (key: string) => entries.get(key) ?? null,
                put: async (key: string, value: string, options: { expirationTtl: number }) => {
                    puts.push({ key, ttl: options.expirationTtl, value });
                    entries.set(key, value);
                },
            } satisfies SentMailStore,
        };
    };

    it("sends once, records the key with the provider id, and acks a redelivery without a second send", async () => {
        expect.assertions(4);

        const mailer = noopMailer();
        const { puts, store } = memoryStore();

        const first = await consumeQueuedSend(mailer, body, { sent: store });
        const redelivered = await consumeQueuedSend(mailer, body, { sent: store });

        expect(first).toStrictEqual({ deduplicated: false, id: "queued-send" });
        expect(redelivered).toStrictEqual({ deduplicated: true, id: "queued-send" });
        expect(mailer.send).toHaveBeenCalledTimes(1);
        expect(puts).toStrictEqual([{ key: "order-42", ttl: 86_400, value: "queued-send" }]);
    });

    it("remembers a key for the configured TTL", async () => {
        expect.assertions(1);

        const { puts, store } = memoryStore();

        await consumeQueuedSend(noopMailer(), body, { sent: store, sentTtlSeconds: 3600 });

        expect(puts[0]?.ttl).toBe(3600);
    });

    it("does not record a failed send, so the redelivery sends", async () => {
        expect.assertions(3);

        const { puts, store } = memoryStore();
        const send = vi
            .fn<Mailer["send"]>()
            .mockRejectedValueOnce(new MailSendError({ retryable: true }))
            .mockResolvedValueOnce({ id: "second-try" });
        const mailer: Mailer = {
            queue: async () => {
                return { queued: true };
            },
            send,
        };

        await expect(consumeQueuedSend(mailer, body, { sent: store })).rejects.toBeInstanceOf(MailSendError);
        await expect(consumeQueuedSend(mailer, body, { sent: store })).resolves.toStrictEqual({ deduplicated: false, id: "second-try" });
        expect(puts).toHaveLength(1);
    });

    it("does not record a retryable timed-out send, so the redelivery re-sends under the same key and is then recorded", async () => {
        expect.assertions(5);

        const { puts, store } = memoryStore();
        const send = vi
            .fn<Mailer["send"]>()
            .mockRejectedValueOnce(new MailSendError({ outcomeUnknown: true, retryable: true }))
            .mockResolvedValueOnce({ id: "provider-original" });
        const mailer: Mailer = {
            queue: async () => {
                return { queued: true };
            },
            send,
        };

        const timedOut = await consumeQueuedSend(mailer, body, { sent: store }).catch((error: unknown) => error);

        expect(isRetryableMailError(timedOut)).toBe(true);
        expect(puts).toHaveLength(0);

        await expect(consumeQueuedSend(mailer, body, { sent: store })).resolves.toStrictEqual({ deduplicated: false, id: "provider-original" });
        expect(send.mock.calls.map(([options]) => options.idempotencyKey)).toStrictEqual(["order-42", "order-42"]);
        await expect(consumeQueuedSend(mailer, body, { sent: store })).resolves.toStrictEqual({ deduplicated: true, id: "provider-original" });
    });

    it("fails as retryable without sending when the store cannot be read: nothing has gone out yet", async () => {
        expect.assertions(2);

        const mailer = noopMailer();
        const store: SentMailStore = {
            get: async () => {
                throw new Error("KV unavailable");
            },
            put: async () => undefined,
        };

        const error = await consumeQueuedSend(mailer, body, { sent: store }).catch((error_: unknown) => error_);

        expect(isRetryableMailError(error)).toBe(true);
        expect(mailer.send).not.toHaveBeenCalled();
    });

    it("returns the id when the store cannot be written after the send, rather than redelivering a sent message", async () => {
        expect.assertions(2);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const store: SentMailStore = {
            get: async () => null,
            put: async () => {
                throw new Error("KV write failed");
            },
        };

        const result = await consumeQueuedSend(noopMailer(), body, { sent: store });

        expect(result).toStrictEqual({ deduplicated: false, id: "queued-send" });
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("could not record the idempotency key"), expect.any(Error));

        consoleError.mockRestore();
    });

    it("refuses a body without an idempotency key, which it could not dedupe", async () => {
        expect.assertions(3);

        const mailer = noopMailer();
        const { store } = memoryStore();

        const error = await consumeQueuedSend(mailer, { subject: "Hi", to: "a@x.test" }, { sent: store }).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(MailSendError);
        expect(isRetryableMailError(error)).toBe(false);
        expect(mailer.send).not.toHaveBeenCalled();
    });

    it("refuses a key the provider or store would reject before the store is read", async () => {
        expect.assertions(4);

        const mailer = noopMailer();
        // A store that fails on the over-long key, as Workers KV does past 512 bytes.
        const get = vi.fn<SentMailStore["get"]>(async () => {
            throw new Error("KV GET failed: 414 UTF-8 encoded length exceeds key length limit");
        });
        const store: SentMailStore = { get, put: async () => undefined };

        const error = await consumeQueuedSend(mailer, { idempotencyKey: "k".repeat(600), subject: "Hi", to: "a@x.test" }, { sent: store }).catch(
            (error_: unknown) => error_,
        );

        expect(error).toBeInstanceOf(MailSendError);
        expect(isRetryableMailError(error)).toBe(false);
        expect(get).not.toHaveBeenCalled();
        expect(mailer.send).not.toHaveBeenCalled();
    });

    it("accepts a Workers KV namespace as the store", () => {
        // Checked by the type checker (lint:types), not at runtime.
        expect.assertions(0);

        expectTypeOf<KVNamespace>().toExtend<SentMailStore>();
    });
});
