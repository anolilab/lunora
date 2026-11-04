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

    it("retries unless the provider gave an explicit permanent status or timed out", () => {
        expect.assertions(7);

        const withCode = (code: number | string): Error => Object.assign(new Error("failed"), { code });

        expect(isRetryableProviderError(new Error("socket reset"))).toBe(true);
        expect(isRetryableProviderError("accepted: false")).toBe(true);
        expect(isRetryableProviderError(withCode(422))).toBe(false);
        expect(isRetryableProviderError(withCode("403"))).toBe(false);
        expect(isRetryableProviderError(withCode(429))).toBe(true);
        expect(isRetryableProviderError(withCode(503))).toBe(true);
        expect(isRetryableProviderError(withCode("ETIMEDOUT"))).toBe(false);
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

        expect(refusal).toBeInstanceOf(TypeError);
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
