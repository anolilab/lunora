import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import createMailer from "../src/create-mailer";

// Drive the Cloudflare transport by faking the underlying @visulima/email
// provider, exactly like resend-transport.test does for Resend.
const sendEmail = vi.fn<(...args: unknown[]) => unknown>();
const initialize = vi.fn<() => Promise<undefined>>(async () => undefined);

vi.mock(import("@visulima/email/providers/cloudflare-email"), () => {
    return {
        cloudflareEmailProvider: () =>
            ({ initialize, sendEmail }) as unknown as ReturnType<typeof import("@visulima/email/providers/cloudflare-email").cloudflareEmailProvider>,
    };
});

describe("cloudflare transport (default provider)", () => {
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        sendEmail.mockReset();
        initialize.mockClear();
        consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        consoleError.mockRestore();
    });

    it("is selected as the default when `cloudflareSend` is supplied", async () => {
        expect.assertions(2);

        sendEmail.mockResolvedValue({ data: { messageId: "cf-1" }, success: true });
        const cloudflareSend = vi.fn<(from: string, to: string, raw: string) => Promise<void>>(async () => undefined);

        const mailer = createMailer({ cloudflareSend, from: "noreply@x.test" });
        const result = await mailer.send({ subject: "Welcome", text: "hi", to: "user@x.test" });

        expect(result).toStrictEqual({ id: "cf-1" });
        expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it("delivers to the single first recipient (binding is single-recipient)", async () => {
        expect.assertions(1);

        sendEmail.mockResolvedValue({ data: { messageId: "cf-2" }, success: true });
        const mailer = createMailer({ cloudflareSend: async () => undefined, from: "noreply@x.test" });

        await mailer.send({ subject: "Hi", text: "x", to: ["first@x.test", "second@x.test"] });

        const [options] = sendEmail.mock.calls[0] as [{ to: { email: string } }];

        expect(options.to).toStrictEqual({ email: "first@x.test" });
    });

    it("throws a generic error and logs the provider detail on failure", async () => {
        expect.assertions(2);

        sendEmail.mockResolvedValue({ error: "binding refused", success: false });
        const mailer = createMailer({ cloudflareSend: async () => undefined, from: "noreply@x.test" });

        await expect(mailer.send({ subject: "Hi", text: "x", to: "user@x.test" })).rejects.toThrow("@cirrus/mail: send failed");
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("binding refused"));
    });
});
