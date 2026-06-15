import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import createMailer from "../src/create-mailer";

// Drive the private Resend transport's error-mapping branches by faking the
// underlying @visulima/email provider. Each test swaps `sendEmail`'s result.
const sendEmail = vi.fn<(...args: unknown[]) => unknown>();
const initialize = vi.fn<() => Promise<undefined>>(async () => undefined);

vi.mock(import("@visulima/email/providers/resend"), () => {
    // The transport only ever calls `initialize()` + `sendEmail()`, so the fake
    // provider implements just those two; cast through `unknown` because the real
    // `Provider` interface declares more members we don't exercise here.
    return {
        resendProvider: () => ({ initialize, sendEmail }) as unknown as ReturnType<typeof import("@visulima/email/providers/resend").resendProvider>,
    };
});

describe("resend transport error mapping", () => {
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        sendEmail.mockReset();
        initialize.mockClear();
        consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        consoleError.mockRestore();
    });

    const mailer = () => createMailer({ apiKey: "test-key", from: "noreply@x.test" });

    it("returns the provider messageId on success", async () => {
        expect.assertions(2);

        sendEmail.mockResolvedValue({ data: { messageId: "abc-123" }, success: true });

        const result = await mailer().send({ subject: "Hi", to: "a@x.test" });

        expect(result).toEqual({ id: "abc-123" });
        expect(initialize).toHaveBeenCalledTimes(1);
    });

    it("throws a stable generic message and logs an Error reason", async () => {
        expect.assertions(2);

        sendEmail.mockResolvedValue({ error: new Error("rate limited"), success: false });

        await expect(mailer().send({ subject: "Hi", to: "a@x.test" })).rejects.toThrow("@lunora/mail: send failed");
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
    });

    it("logs a string reason", async () => {
        expect.assertions(2);

        sendEmail.mockResolvedValue({ error: "boom", success: false });

        await expect(mailer().send({ subject: "Hi", to: "a@x.test" })).rejects.toThrow("@lunora/mail: send failed");
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });

    it("logs a numeric reason", async () => {
        expect.assertions(2);

        sendEmail.mockResolvedValue({ error: 503, success: false });

        await expect(mailer().send({ subject: "Hi", to: "a@x.test" })).rejects.toThrow("@lunora/mail: send failed");
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("503"));
    });

    it("falls back to `send failed` for a null reason", async () => {
        expect.assertions(2);

        sendEmail.mockResolvedValue({ error: null, success: false });

        await expect(mailer().send({ subject: "Hi", to: "a@x.test" })).rejects.toThrow("@lunora/mail: send failed");
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("send failed"));
    });

    it("stringifies an object reason", async () => {
        expect.assertions(2);

        sendEmail.mockResolvedValue({ error: { code: "E", detail: "nope" }, success: false });

        await expect(mailer().send({ subject: "Hi", to: "a@x.test" })).rejects.toThrow("@lunora/mail: send failed");
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("nope"));
    });

    it("uses the `send failed` fallback when JSON.stringify yields undefined (symbol)", async () => {
        expect.assertions(2);

        sendEmail.mockResolvedValue({ error: Symbol("x"), success: false });

        await expect(mailer().send({ subject: "Hi", to: "a@x.test" })).rejects.toThrow("@lunora/mail: send failed");
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("send failed"));
    });

    it("requires at least one recipient", async () => {
        expect.assertions(1);

        sendEmail.mockResolvedValue({ data: { messageId: "x" }, success: true });

        // An empty recipient list reaches the transport as `[]`.
        await expect(mailer().send({ subject: "Hi", to: [] })).rejects.toThrow(/at least one recipient/);
    });
});
