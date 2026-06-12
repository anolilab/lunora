import { describe, expect, it, vi } from "vitest";

import type { MailboxSink } from "../src/capture-transport";
import { createCaptureTransport } from "../src/capture-transport";
import createMailer from "../src/create-mailer";
import type { SendPayload } from "../src/types";

const fakeSink = (id = "captured-1"): { recorded: SendPayload[]; sink: MailboxSink } => {
    const recorded: SendPayload[] = [];
    const sink: MailboxSink = {
        record: vi.fn<MailboxSink["record"]>(async (mail: SendPayload) => {
            recorded.push(mail);

            return { id };
        }),
    };

    return { recorded, sink };
};

describe("createCaptureTransport", () => {
    it("persists the payload to the sink and returns the assigned id", async () => {
        expect.assertions(3);

        const { recorded, sink } = fakeSink("cap-42");
        const transport = createCaptureTransport(sink);

        const result = await transport.send({ subject: "Hi", to: "a@b.test" });

        expect(result).toStrictEqual({ id: "cap-42" });
        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.subject).toBe("Hi");
    });

    it("captures fully-rendered + validated mail when used through createMailer", async () => {
        expect.assertions(2);

        const { recorded, sink } = fakeSink();
        const mailer = createMailer({ from: "Default <noreply@x.test>", transport: createCaptureTransport(sink) });

        await mailer.send({ subject: "Reset your password", text: "go to https://x.test/reset?token=abc", to: "user@x.test" });

        expect(recorded[0]?.from).toBe("Default <noreply@x.test>");
        expect(recorded[0]?.to).toBe("user@x.test");
    });

    it("still rejects header-injection through the capture path", async () => {
        expect.assertions(1);

        const { sink } = fakeSink();
        const mailer = createMailer({ from: "noreply@x.test", transport: createCaptureTransport(sink) });

        await expect(mailer.send({ subject: "bad\r\nBcc: evil@x.test", to: "user@x.test" })).rejects.toThrow(/CR or LF/);
    });
});
