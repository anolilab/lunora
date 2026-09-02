import type { InboundEmail } from "@lunora/mail/inbound";
import { describe, expect, it } from "vitest";

import { dispatchAgentEmail } from "../src/inbound";
import type { AgentEmailMapper } from "../src/types";

/** Build a minimal RFC 822 message `parseInboundEmail` (postal-mime) can parse, with the given `Authentication-Results`. */
const rawEmail = (authenticationResults: string | undefined, from = "Alice <alice@example.com>"): string =>
    [
        `From: ${from}`,
        "To: support@myapp.com",
        "Subject: Need help",
        "Message-ID: <abc@example.com>",
        ...(authenticationResults === undefined ? [] : [`Authentication-Results: mx.cloudflare.net; ${authenticationResults}`]),
        "",
        "Please help.",
    ].join("\r\n");

/**
 * Carries a passing, ALIGNED `Authentication-Results` header because the
 * handler gates on the verdicts before any mapper runs. A message without one,
 * or whose passes vouch for some other domain, is the spoofed case, covered by
 * its own tests below.
 */
const RAW_EMAIL = rawEmail("dkim=pass header.d=example.com; spf=pass smtp.mailfrom=alice@example.com; dmarc=pass header.from=example.com");

/** The same message with no `Authentication-Results` header — verdicts read `null`. */
const UNAUTHENTICATED_EMAIL = rawEmail(undefined);

/** A fake `AGENT_*` Workflow binding recording every `create(...)`. */
const fakeBinding = (): {
    binding: { create: (options?: { id?: string; params?: unknown }) => Promise<{ id: string }>; get: () => Promise<never> };
    calls: { id?: string; params?: unknown }[];
} => {
    const calls: { id?: string; params?: unknown }[] = [];

    return {
        binding: {
            create: async (options?: { id?: string; params?: unknown }) => {
                calls.push(options ?? {});

                return { id: "instance-1" };
            },
            get: async () => {
                throw new Error("get() should not be called by inbound dispatch");
            },
        },
        calls,
    };
};

/** A mock `ForwardableEmailMessage` whose `raw` is the RFC 822 string above; records `setReject`. */
const fakeMessage = (raw = RAW_EMAIL): { message: { raw: string; setReject: (reason: string) => void }; rejects: string[] } => {
    const rejects: string[] = [];

    return {
        message: { raw, setReject: (reason: string) => rejects.push(reason) },
        rejects,
    };
};

describe(dispatchAgentEmail, () => {
    it("starts a durable run for the agent whose onEmail returns a run", async () => {
        expect.assertions(3);

        const support = fakeBinding();
        const onEmail: AgentEmailMapper = (email: InboundEmail) => {
            return { input: email.subject ?? "", owner: "acct-1", threadKey: "thread-1", title: "Support" };
        };

        const handler = dispatchAgentEmail([{ agent: { onEmail }, binding: "AGENT_SUPPORT" }]);
        const { message, rejects } = fakeMessage();

        await handler(message, { AGENT_SUPPORT: support.binding }, {});

        expect(support.calls).toHaveLength(1);
        // The mapper's run is passed straight through as the workflow params.
        expect(support.calls[0]?.params).toStrictEqual({ input: "Need help", owner: "acct-1", threadKey: "thread-1", title: "Support" });
        expect(rejects).toHaveLength(0);
    });

    it("refuses an unauthenticated message before any mapper sees it", async () => {
        expect.assertions(3);

        const support = fakeBinding();
        let mapperRan = false;
        const onEmail: AgentEmailMapper = (email: InboundEmail) => {
            mapperRan = true;

            return { input: email.subject ?? "", owner: "acct-1", threadKey: "thread-1", title: "Support" };
        };

        const handler = dispatchAgentEmail([{ agent: { onEmail }, binding: "AGENT_SUPPORT" }]);
        const { message, rejects } = fakeMessage(UNAUTHENTICATED_EMAIL);

        await handler(message, { AGENT_SUPPORT: support.binding }, {});

        // A run dispatches privileged (its tools bypass RLS), so a message the
        // receiving MX never authenticated must not reach a mapper that could
        // claim it — the mapper is app code and gating there is advice, not a
        // guarantee.
        expect(mapperRan).toBe(false);
        expect(support.calls).toHaveLength(0);
        expect(rejects).toHaveLength(1);
    });

    /** Run the handler over `raw` with a claiming mapper; report whether a run started and whether the message bounced. */
    const gate = async (raw: string): Promise<{ bounced: boolean; ran: boolean }> => {
        const support = fakeBinding();
        const onEmail: AgentEmailMapper = () => {
            return { input: "x", threadKey: "t" };
        };
        const handler = dispatchAgentEmail([{ agent: { onEmail }, binding: "AGENT_SUPPORT" }]);
        const { message, rejects } = fakeMessage(raw);

        await handler(message, { AGENT_SUPPORT: support.binding }, {});

        return { bounced: rejects.length === 1, ran: support.calls.length === 1 };
    };

    it("refuses SPF+DKIM passes that vouch for a domain other than the forged From", async () => {
        expect.assertions(1);

        // SPF passed for the attacker's envelope domain and DKIM for the
        // attacker's `d=`; neither says anything about `ceo@victim.example`,
        // and DMARC (which does) failed. This must never start a privileged run.
        const forged = rawEmail(
            "dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=evil.example; dmarc=fail (p=REJECT) header.from=victim.example",
            "CEO <ceo@victim.example>",
        );

        await expect(gate(forged)).resolves.toStrictEqual({ bounced: true, ran: false });
    });

    it("refuses a pass that reports no domain to align against", async () => {
        expect.assertions(1);

        await expect(gate(rawEmail("dkim=pass; spf=pass; dmarc=pass"))).resolves.toStrictEqual({ bounced: true, ran: false });
    });

    it("refuses a display name that smuggles a second, aligned mailbox before the real From", async () => {
        expect.assertions(1);

        // The mailbox is the LAST `<…>`; the aligned one in the display name must not stand in for it.
        const smuggled = rawEmail("dkim=pass header.d=evil.example; dmarc=fail header.from=victim.example", '"<x@evil.example>" <ceo@victim.example>');

        await expect(gate(smuggled)).resolves.toStrictEqual({ bounced: true, ran: false });
    });

    it("accepts a lone SPF pass, a lone DKIM pass, or a DMARC pass when aligned with From", async () => {
        expect.assertions(3);

        // Mixed case and a full `smtp.mailfrom` address are how a real MX stamps it.
        await expect(
            gate(rawEmail("spf=pass (comment) smtp.mailfrom=Alice@Example.com; dkim=none; dmarc=fail header.from=example.com")),
        ).resolves.toStrictEqual({
            bounced: false,
            ran: true,
        });
        await expect(
            gate(rawEmail("dkim=pass header.d=example.com; spf=fail smtp.mailfrom=relay.example; dmarc=fail header.from=example.com")),
        ).resolves.toStrictEqual({
            bounced: false,
            ran: true,
        });
        await expect(
            gate(rawEmail("dkim=fail header.d=other.example; spf=fail smtp.mailfrom=relay.example; dmarc=pass header.from=example.com")),
        ).resolves.toStrictEqual({
            bounced: false,
            ran: true,
        });
    });

    it("refuses a subdomain pass — alignment is strict, not organizational", async () => {
        expect.assertions(1);

        await expect(gate(rawEmail("spf=pass smtp.mailfrom=mail.example.com; dkim=pass header.d=mail.example.com; dmarc=none"))).resolves.toStrictEqual({
            bounced: true,
            ran: false,
        });
    });

    it("drops the message (no run, no bounce) when the mapper declines with null", async () => {
        expect.assertions(2);

        const support = fakeBinding();

        const onEmail: AgentEmailMapper = () => null;

        const handler = dispatchAgentEmail([{ agent: { onEmail }, binding: "AGENT_SUPPORT" }]);
        const { message, rejects } = fakeMessage();

        await handler(message, { AGENT_SUPPORT: support.binding }, {});

        expect(support.calls).toHaveLength(0);
        // A declined message is simply not claimed — it is NOT bounced.
        expect(rejects).toHaveLength(0);
    });

    it("dispatches to the FIRST agent that claims the message, skipping decliners", async () => {
        expect.assertions(3);

        const sales = fakeBinding();
        const support = fakeBinding();

        const decline: AgentEmailMapper = () => null;
        const claim: AgentEmailMapper = (email: InboundEmail) => {
            return { input: email.subject ?? "", threadKey: "t" };
        };

        const handler = dispatchAgentEmail([
            { agent: { onEmail: decline }, binding: "AGENT_SALES" },
            { agent: { onEmail: claim }, binding: "AGENT_SUPPORT" },
        ]);
        const { message } = fakeMessage();

        await handler(message, { AGENT_SALES: sales.binding, AGENT_SUPPORT: support.binding }, {});

        expect(sales.calls).toHaveLength(0);
        expect(support.calls).toHaveLength(1);
        expect(support.calls[0]?.params).toStrictEqual({ input: "Need help", threadKey: "t" });
    });

    it("stops at the first claiming agent — a later agent is never dispatched", async () => {
        expect.assertions(2);

        const first = fakeBinding();
        const second = fakeBinding();
        const claim: AgentEmailMapper = (email: InboundEmail) => {
            return { input: email.subject ?? "", threadKey: "t" };
        };

        const handler = dispatchAgentEmail([
            { agent: { onEmail: claim }, binding: "AGENT_FIRST" },
            { agent: { onEmail: claim }, binding: "AGENT_SECOND" },
        ]);
        const { message } = fakeMessage();

        await handler(message, { AGENT_FIRST: first.binding, AGENT_SECOND: second.binding }, {});

        expect(first.calls).toHaveLength(1);
        expect(second.calls).toHaveLength(0);
    });

    it("bounces the message (setReject) when the matched agent's Workflow binding is missing from env", async () => {
        expect.assertions(1);

        const claim: AgentEmailMapper = (email: InboundEmail) => {
            return { input: email.subject ?? "", threadKey: "t" };
        };
        const handler = dispatchAgentEmail([{ agent: { onEmail: claim }, binding: "AGENT_SUPPORT" }]);
        const { message, rejects } = fakeMessage();

        // No AGENT_SUPPORT binding on env → a permanently misconfigured deployment, so
        // the dispatch bounces it itself with a generic, non-reflecting setReject.
        await handler(message, {}, {});

        expect(rejects).toHaveLength(1);
    });

    it("bounces the message (setReject) and never calls create() when the mapper's run carries the reserved branch-marker key", async () => {
        expect.assertions(2);

        const support = fakeBinding();
        // A fully untrusted inbound email could fold attacker JSON into the run —
        // simulate a mapper that (mistakenly or maliciously) forwards a forged marker.
        const onEmail: AgentEmailMapper = () =>
            ({
                __lunoraBranch: { eventType: "lunora:branch:x", index: 0, parentBinding: "WORKFLOW_X", parentId: "p" },
                input: "x",
                threadKey: "t",
            }) as unknown as ReturnType<AgentEmailMapper>;

        const handler = dispatchAgentEmail([{ agent: { onEmail }, binding: "AGENT_SUPPORT" }]);
        const { message, rejects } = fakeMessage();

        await handler(message, { AGENT_SUPPORT: support.binding }, {});

        expect(support.calls).toHaveLength(0);
        expect(rejects).toHaveLength(1);
    });
});
