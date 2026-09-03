import type { MailTransport, SendPayload } from "@lunora/mail";
import { createMailer } from "@lunora/mail";
import type { InboundEmail } from "@lunora/mail/inbound";
import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { defineAgent } from "../src/define-agent";
import { buildReferences, captureEmailReplyRef, replyToEmail } from "../src/reply";
import { DurableStepJournal, finalTurn, loopDefaults, scriptedGenerate } from "./loop-harness";

/** Minimal `InboundEmail` builder — fills only the fields the helpers read. */
const fakeInboundEmail = (overrides: Partial<InboundEmail> = {}): InboundEmail => {
    return {
        attachments: [],
        authentication: {
            dkim: [{ domain: "example.com", result: "pass" }],
            dmarc: [{ domain: "example.com", result: "pass" }],
            spf: [{ domain: "example.com", result: "pass" }],
        },
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

describe("email reply", () => {
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

    it("calls onReply once with the captured ref when the run was triggered", async () => {
        expect.assertions(3);

        const calls: { channel: string; text?: string; threadKey: string }[] = [];
        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            onReply: ({ replyRef, result, threadKey }) => {
                calls.push({ channel: replyRef.channel, text: result.text, threadKey });
            },
        });
        const journal = new DurableStepJournal();
        const replyRef = captureEmailReplyRef(fakeInboundEmail({ from: "customer@example.com", messageId: "<msg@example.com>" }));

        await runAgentLoop(
            loopDefaults(agent, {
                generate: scriptedGenerate([finalTurn("the answer")]),
                params: { input: "hi", replyRef, threadKey: "thread-1" },
                step: journal,
            }),
        );

        expect(calls).toStrictEqual([{ channel: "email", text: "the answer", threadKey: "thread-1" }]);
        // Delivery is a named durable step, so a replay serves it from the memo
        // instead of sending the answer a second time.
        expect(journal.invoked.filter((name) => name === "agent:reply")).toHaveLength(1);
        expect(journal.invoked).toContain("agent:reply");
    });

    it("never calls onReply for an ordinary in-app run (no replyRef)", async () => {
        expect.assertions(1);

        let called = 0;
        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            onReply: () => {
                called += 1;
            },
        });

        await runAgentLoop(loopDefaults(agent, { generate: scriptedGenerate([finalTurn("the answer")]) }));

        expect(called).toBe(0);
    });

    it("a failing reply does not fail the run — the answer is already on the thread", async () => {
        expect.assertions(1);

        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            onReply: () => {
                throw new Error("slack is down");
            },
        });
        const replyRef = captureEmailReplyRef(fakeInboundEmail({ from: "customer@example.com", messageId: "<msg@example.com>" }));

        await expect(
            runAgentLoop(
                loopDefaults(agent, {
                    generate: scriptedGenerate([finalTurn("the answer")]),
                    params: { input: "hi", replyRef, threadKey: "thread-1" },
                }),
            ),
        ).resolves.toMatchObject({ text: "the answer" });
    });
});
