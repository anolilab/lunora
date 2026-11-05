import { afterEach, describe, expect, it, vi } from "vitest";

import createMailer from "../src/create-mailer";
import { isRetryableProviderError } from "../src/provider-transport";
import { consumeQueuedSend } from "../src/queue";
import { isOutcomeUnknownMailError, isRetryableMailError, MailSendError } from "../src/send-error";

describe("mail send classification", () => {
    it("marks a send error retryable only when it says so", () => {
        expect.assertions(3);

        expect(isRetryableMailError(new MailSendError({ retryable: true }))).toBe(true);
        expect(isRetryableMailError(new MailSendError({ retryable: false }))).toBe(false);
        expect(isRetryableMailError(new Error("unclassified"))).toBe(false);
    });

    it("reads the provider status from a wrapped cause", () => {
        expect.assertions(3);

        const wrap = (cause: Error): Error => new Error("send failed", { cause });

        expect(isRetryableProviderError(wrap(Object.assign(new Error("refused"), { code: "403" })))).toBe(false);
        expect(isRetryableProviderError(wrap(Object.assign(new Error("busy"), { code: 503 })))).toBe(true);
        expect(isRetryableProviderError(wrap(new Error("socket reset")))).toBe(true);
    });

    it("retries unless the provider gave an explicit permanent status", () => {
        expect.assertions(6);

        const withCode = (code: number | string): Error => Object.assign(new Error("failed"), { code });

        expect(isRetryableProviderError(new Error("socket reset"))).toBe(true);
        expect(isRetryableProviderError("accepted: false")).toBe(true);
        expect(isRetryableProviderError(withCode(422))).toBe(false);
        expect(isRetryableProviderError(withCode("403"))).toBe(false);
        expect(isRetryableProviderError(withCode(429))).toBe(true);
        expect(isRetryableProviderError(withCode(503))).toBe(true);
    });

    it("treats a transport error it did not classify as retryable, without leaking its text", async () => {
        expect.assertions(3);

        const original = new Error("provider socket reset");
        const mailer = createMailer({
            from: "noreply@x.test",
            transport: {
                send: vi.fn<() => Promise<{ id: string }>>(async () => {
                    throw original;
                }),
            },
        });

        const error = await mailer.send({ subject: "Hi", to: "a@x.test" }).catch((error_: unknown) => error_);

        expect(isRetryableMailError(error)).toBe(true);
        expect((error as Error).message).toBe("@lunora/mail: send failed");
        expect((error as MailSendError).cause).toBe(original);
    });

    it("rethrows a refusal from another copy of the package unchanged rather than re-wrapping it as retryable", async () => {
        expect.assertions(4);

        vi.resetModules();

        // A fresh module instance stands in for a second installed copy of @lunora/mail.
        const { MailSendError: ForeignMailSendError } = await import("../src/send-error");
        const original = new ForeignMailSendError({ message: "@lunora/mail: refused", retryable: false });
        const mailer = createMailer({
            from: "noreply@x.test",
            transport: {
                send: async () => {
                    throw original;
                },
            },
        });

        const error = await mailer.send({ subject: "Hi", to: "a@x.test" }).catch((error_: unknown) => error_);

        expect(ForeignMailSendError).not.toBe(MailSendError);
        expect(original).toBeInstanceOf(MailSendError);
        expect(error).toBe(original);
        expect(isRetryableMailError(error)).toBe(false);
    });

    it("treats a malformed queue body as a refusal, not a retry", async () => {
        expect.assertions(2);

        const mailer = createMailer({
            from: "noreply@x.test",
            transport: {
                send: async () => {
                    return { id: "x" };
                },
            },
        });

        const refusal = await consumeQueuedSend(mailer, { to: "a@x.test" }).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(MailSendError);
        expect(isRetryableMailError(refusal)).toBe(false);
    });
});

describe("send deadline", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const hangingMailer = (sendTimeoutMs?: number) => {
        // A transport whose promise never settles, as a hung binding or provider call looks.
        const send = vi.fn<() => Promise<{ id: string }>>(
            () =>
                new Promise<{ id: string }>(() => {
                    // never settles
                }),
        );

        return createMailer({ from: "noreply@x.test", sendTimeoutMs, transport: { send } });
    };

    it("fails a send the transport never answers as outcome-unknown, not retryable, once the deadline passes", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const mailer = hangingMailer(5000);
        const settled = mailer.send({ subject: "Hi", to: "a@x.test" }).catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(5000);

        const error = await settled;

        expect(error).toBeInstanceOf(MailSendError);
        expect(isOutcomeUnknownMailError(error)).toBe(true);
        expect(isRetryableMailError(error)).toBe(false);
        expect((error as MailSendError).data).toStrictEqual({ outcomeUnknown: true, retryable: false });
    });

    it("retries a timed-out send only when it carried a key and the transport's provider dedupes on it", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const timedOut = async (dedupes: boolean, idempotencyKey?: string): Promise<unknown> => {
            const mailer = createMailer({
                from: "noreply@x.test",
                sendTimeoutMs: 1000,
                transport: {
                    dedupesOnIdempotencyKey: dedupes,
                    send: async () =>
                        new Promise<{ id: string }>(() => {
                            // never settles
                        }),
                },
            });
            const settled = mailer.send({ idempotencyKey, subject: "Hi", to: "a@x.test" }).catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(1000);

            return settled;
        };

        expect(isRetryableMailError(await timedOut(true, "order-42"))).toBe(true);
        expect(isRetryableMailError(await timedOut(true))).toBe(false);
        expect(isRetryableMailError(await timedOut(false, "order-42"))).toBe(false);
    });

    it("decides retryability for a transport's own outcome-unknown failure by the same rule as the deadline", async () => {
        expect.assertions(4);

        const unknown = async (dedupes: boolean, idempotencyKey?: string): Promise<unknown> => {
            const cause = new Error("provider aborted the request");
            const mailer = createMailer({
                from: "noreply@x.test",
                transport: {
                    dedupesOnIdempotencyKey: dedupes,
                    send: async () => {
                        throw new MailSendError({ cause, message: "@lunora/mail: provider timed out", outcomeUnknown: true, retryable: false });
                    },
                },
            });

            return mailer.send({ idempotencyKey, subject: "Hi", to: "a@x.test" }).catch((error: unknown) => error);
        };

        const promoted = await unknown(true, "order-42");

        expect((promoted as MailSendError).data).toStrictEqual({ outcomeUnknown: true, retryable: true });
        expect((promoted as MailSendError).message).toBe("@lunora/mail: provider timed out");
        expect(isRetryableMailError(await unknown(true))).toBe(false);
        expect(isRetryableMailError(await unknown(false, "order-42"))).toBe(false);
    });

    it("waits 60 seconds by default", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const mailer = hangingMailer();
        let outcome: unknown = "pending";

        const settled = mailer.send({ subject: "Hi", to: "a@x.test" }).catch((error: unknown) => {
            outcome = error;
        });

        await vi.advanceTimersByTimeAsync(59_999);

        expect(outcome).toBe("pending");

        await vi.advanceTimersByTimeAsync(1);
        await settled;

        expect(isOutcomeUnknownMailError(outcome)).toBe(true);
    });

    it("leaves no timer behind once the transport answers", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const mailer = createMailer({
            from: "noreply@x.test",
            transport: {
                send: async () => {
                    return { id: "sent" };
                },
            },
        });

        await expect(mailer.send({ subject: "Hi", to: "a@x.test" })).resolves.toStrictEqual({ id: "sent" });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects a deadline that is not a positive, finite number", () => {
        expect.assertions(3);

        const transport = {
            send: async () => {
                return { id: "x" };
            },
        };

        expect(() => createMailer({ from: "noreply@x.test", sendTimeoutMs: 0, transport })).toThrow(/sendTimeoutMs/u);
        expect(() => createMailer({ from: "noreply@x.test", sendTimeoutMs: Number.NaN, transport })).toThrow(/sendTimeoutMs/u);
        expect(() => createMailer({ from: "noreply@x.test", sendTimeoutMs: Number.POSITIVE_INFINITY, transport })).toThrow(/sendTimeoutMs/u);
    });

    it("keeps an ordinary failure retryable and not outcome-unknown", () => {
        expect.assertions(2);

        const error = new MailSendError({ retryable: true });

        expect(isOutcomeUnknownMailError(error)).toBe(false);
        expect(error.data).toStrictEqual({ outcomeUnknown: false, retryable: true });
    });
});
