import type { MailTransport, SendPayload } from "@lunora/mail";
import { createMailer } from "@lunora/mail";
import type { InboundEmail } from "@lunora/mail/inbound";
import { describe, expect, it } from "vitest";

import { buildReferences, captureEmailReplyRef, replyToEmail } from "../src/reply.prototype";

/** Minimal `InboundEmail` builder — fills only the fields the prototype reads. */
const fakeInboundEmail = (overrides: Partial<InboundEmail> = {}): InboundEmail => {
    return {
        attachments: [],
        authentication: { dkim: "pass", dmarc: "pass", spf: "pass" },
        from: "customer@example.com",
        headers: {},
        to: ["support@lunora.sh"],
        ...overrides,
    };
};

/** Records every payload handed to `send` — the fake mail sender. */
const fakeMailTransport = (): { sent: SendPayload[]; transport: MailTransport } => {
    const sent: SendPayload[] = [];

    return {
        sent,
        transport: {
            send: async (payload) => {
                sent.push(payload);

                return { id: `sent-${String(sent.length)}` };
            },
        },
    };
};

describe("reply prototype (plan 242 spike)", () => {
    it("captures a reply ref from an inbound email and threads the reply's In-Reply-To/References", async () => {
        const { sent, transport } = fakeMailTransport();
        const mailer = createMailer({ from: "support@lunora.sh", transport });

        const inbound = fakeInboundEmail({
            from: "customer@example.com",
            messageId: "<abc123@example.com>",
        });

        const replyRef = captureEmailReplyRef(inbound);

        expect(replyRef).toStrictEqual({
            channel: "email",
            from: "customer@example.com",
            messageId: "<abc123@example.com>",
            to: ["support@lunora.sh"],
        });

        // "Run the agent" — stands in for the real runAgentLoop's final answer.
        const answer = "Your order #4821 ships tomorrow.";

        await replyToEmail(mailer, replyRef as NonNullable<typeof replyRef>, { subject: "Re: Order status", text: answer });

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            headers: { "In-Reply-To": "<abc123@example.com>", References: "<abc123@example.com>" },
            text: answer,
            to: "customer@example.com",
        });
    });

    it("appends to an existing References chain rather than replacing it", async () => {
        const { sent, transport } = fakeMailTransport();
        const mailer = createMailer({ from: "support@lunora.sh", transport });

        const inbound = fakeInboundEmail({
            from: "customer@example.com",
            messageId: "<third@example.com>",
            references: "<first@example.com> <second@example.com>",
        });

        const replyRef = captureEmailReplyRef(inbound);

        expect(replyRef?.references).toBe("<first@example.com> <second@example.com>");
        expect(buildReferences(replyRef as NonNullable<typeof replyRef>)).toBe("<first@example.com> <second@example.com> <third@example.com>");

        await replyToEmail(mailer, replyRef as NonNullable<typeof replyRef>, { subject: "Re: Order status", text: "reply body" });

        expect(sent[0]?.headers?.["References"]).toBe("<first@example.com> <second@example.com> <third@example.com>");
        expect(sent[0]?.headers?.["In-Reply-To"]).toBe("<third@example.com>");
    });

    it("declines to reply when the inbound message carried no Message-ID (nothing to thread against)", () => {
        const inbound = fakeInboundEmail({ from: "customer@example.com" });

        expect(captureEmailReplyRef(inbound)).toBeUndefined();
    });

    it("threads a real reply through the mailer's own address/header validation (not a hand-rolled assertion)", async () => {
        const { sent, transport } = fakeMailTransport();
        const mailer = createMailer({ from: "support@lunora.sh", transport });

        const replyRef = captureEmailReplyRef(fakeInboundEmail({ from: "customer@example.com", messageId: "<msg@example.com>" }));

        await replyToEmail(mailer, replyRef as NonNullable<typeof replyRef>, { subject: "Re: hi", text: "hello" });

        // The mailer's buildPayload ran (from defaulted, addresses validated) —
        // proof this went through the real @lunora/mail send path, not a stub.
        expect(sent[0]?.from).toBe("support@lunora.sh");
    });
});
