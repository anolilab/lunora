import { describe, expect, it, vi } from "vitest";

import createMailer from "../src/create-mailer";
import { isRetryableProviderError } from "../src/provider-transport";
import { consumeQueuedSend } from "../src/queue";
import { isRetryableMailError, MailSendError } from "../src/send-error";

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
