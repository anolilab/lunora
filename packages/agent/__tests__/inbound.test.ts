import type { InboundEmail } from "@lunora/mail/inbound";
import { describe, expect, it } from "vitest";

import { dispatchAgentEmail } from "../src/inbound";
import type { AgentEmailMapper } from "../src/types";

/** A minimal RFC 822 message `parseInboundEmail` (postal-mime) can parse. */
const RAW_EMAIL = ["From: Alice <alice@example.com>", "To: support@myapp.com", "Subject: Need help", "Message-ID: <abc@example.com>", "", "Please help."].join(
    "\r\n",
);

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

        // No AGENT_SUPPORT binding on env → the dispatch throws, routing through the
        // inbound handler's default onError (a generic, non-reflecting setReject).
        await handler(message, {}, {});

        expect(rejects).toHaveLength(1);
    });

    it("bounces the message (setReject) and never calls create() when the mapper's run carries the reserved branch-marker key", async () => {
        expect.assertions(2);

        const support = fakeBinding();
        // A fully untrusted inbound email could fold attacker JSON into the run —
        // simulate a mapper that (mistakenly or maliciously) forwards a forged marker.
        const onEmail: AgentEmailMapper = () => ({
                __lunoraBranch: { eventType: "lunora:branch:x", index: 0, parentBinding: "WORKFLOW_X", parentId: "p" },
                input: "x",
                threadKey: "t",
            } as unknown as ReturnType<AgentEmailMapper>);

        const handler = dispatchAgentEmail([{ agent: { onEmail }, binding: "AGENT_SUPPORT" }]);
        const { message, rejects } = fakeMessage();

        await handler(message, { AGENT_SUPPORT: support.binding }, {});

        expect(support.calls).toHaveLength(0);
        expect(rejects).toHaveLength(1);
    });
});
