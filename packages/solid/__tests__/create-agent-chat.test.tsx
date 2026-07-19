import type { FunctionReference } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import type { AgentLiveEvent, CreateAgentChatApi, CreateAgentChatResult } from "../src/create-agent-chat";
import { createAgentChat } from "../src/create-agent-chat";
import { LunoraProvider } from "../src/lunora-provider";
import { createFakeClient } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

// A narrow live-token stream reference (`{ key: string }` args, `AgentLiveEvent`
// returns). Typed exactly rather than down-cast from a widened `FunctionReference`.
const makeStreamRef = (reference: string): FunctionReference<"stream", { key: string }, AgentLiveEvent> => {
    return { __lunoraRef: reference };
};

const MESSAGES_REF = "agents:agentMessages";
const THREAD_REF = "agents:agentThread";
const APPROVAL_REF = "agents:agentResolveApproval";
const SEND_REF = "chat:startRun";
const CANCEL_REF = "chat:cancelRun";
const STREAM_REF = "chat:liveEvents";

const buildApi = (): CreateAgentChatApi =>
    ({
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
            agentResolveApproval: makeRef(APPROVAL_REF),
            agentThread: makeRef(THREAD_REF),
        },
    }) as unknown as CreateAgentChatApi;

const pushTo = (subscriptions: { functionPath: string; push: (value: unknown) => void }[], reference: string, value: unknown): void => {
    subscriptions.find((sub) => sub.functionPath === reference)?.push(value);
};

describe(createAgentChat, () => {
    it("surfaces durable history and live status over the agents:* subscriptions", () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

                return <pre>{JSON.stringify(latest.messages())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // Both the history and thread channels open on setup.
        expect(fake.subscriptions.map((sub) => sub.functionPath).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([MESSAGES_REF, THREAD_REF]);
        expect(latest?.messages()).toStrictEqual([]);
        expect(latest?.status()).toBeUndefined();
        // No stream reference supplied — streamingText stays empty (no stream opens).
        expect(latest?.streamingText()).toBe("");
        expect(fake.streamCalls).toHaveLength(0);

        pushTo(fake.subscriptions, THREAD_REF, { instanceId: "wf-1", status: "running" });

        expect(latest?.status()).toBe("running");

        pushTo(fake.subscriptions, MESSAGES_REF, [{ content: "hi", role: "user", seq: 0 }]);

        expect(latest?.messages()).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);
    });

    it("accumulates in-flight token deltas into streamingText, then clears once the turn persists", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({
                    api: buildApi(),
                    send: makeRef(SEND_REF) as FunctionReference<"mutation">,
                    stream: makeStreamRef(STREAM_REF),
                    threadKey: "t1",
                });

                return <pre>{latest.streamingText()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // The live event stream opens alongside the durable subscriptions.
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([STREAM_REF]);
        expect(fake.streamCalls[0]?.args).toStrictEqual({ key: "t1" });

        // Turn-0 deltas (no assistant persisted yet) accumulate into streamingText.
        fake.pushStream(STREAM_REF, { key: "t1" }, { text: "Hel", threadKey: "t1", turn: 0 });
        fake.pushStream(STREAM_REF, { key: "t1" }, { text: "lo", threadKey: "t1", turn: 0 });
        await fake.flush();

        expect(latest?.streamingText()).toBe("Hello");

        // Progress events ride the same stream but carry no turn text — ignored here.
        fake.pushStream(STREAM_REF, { key: "t1" }, { data: { pct: 50 }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        await fake.flush();

        expect(latest?.streamingText()).toBe("Hello");

        // Once the turn's assistant message persists, its deltas are superseded —
        // streamingText clears (the persisted message is the source of truth).
        pushTo(fake.subscriptions, MESSAGES_REF, [
            { content: "hi", role: "user", seq: 0 },
            { content: "Hello", role: "assistant", seq: 1 },
        ]);

        expect(latest?.streamingText()).toBe("");
    });

    it("appends an optimistic user turn on send, then reconciles it against durable history", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

                return <pre>{JSON.stringify(latest.messages())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        await latest?.send("hello there");

        expect(fake.mutationCalls).toContainEqual({ args: { input: "hello there", threadKey: "t1" }, functionPath: SEND_REF });
        expect(latest?.messages()).toStrictEqual([{ content: "hello there", optimistic: true, role: "user", seq: 0 }]);

        // The durable turn lands → the optimistic row is reconciled away.
        pushTo(fake.subscriptions, MESSAGES_REF, [{ content: "hello there", role: "user", seq: 0 }]);

        expect(latest?.messages()).toStrictEqual([{ content: "hello there", role: "user", seq: 0 }]);
    });

    it("shows a fresh optimistic echo for a repeated identical prompt, not reconciled by the earlier durable row", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

                return <pre>{JSON.stringify(latest.messages())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // First send of "hi": acked by the server, durable history now has one "hi".
        await latest?.send("hi");

        pushTo(fake.subscriptions, MESSAGES_REF, [{ content: "hi", role: "user", seq: 0 }]);

        expect(latest?.messages()).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        // Sending "hi" again must NOT be immediately swallowed by the stale durable
        // "hi" that predates this send — the optimistic echo should render until
        // ITS OWN durable row arrives.
        await latest?.send("hi");

        expect(latest?.messages()).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", optimistic: true, role: "user", seq: 1 },
        ]);

        // Once the second durable "hi" lands, the optimistic row reconciles away.
        pushTo(fake.subscriptions, MESSAGES_REF, [
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);

        expect(latest?.messages()).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);
    });

    it("routes approve / reject / cancel with the in-flight instanceId", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({
                    api: buildApi(),
                    cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
                    send: makeRef(SEND_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                });

                return <pre>{String(latest.status())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        pushTo(fake.subscriptions, THREAD_REF, { instanceId: "wf-1", status: "awaiting_input" });

        await latest?.approve("call-1");

        expect(fake.mutationCalls).toContainEqual({
            args: { decision: "approve", instanceId: "wf-1", threadKey: "t1", toolCallId: "call-1" },
            functionPath: APPROVAL_REF,
        });

        await latest?.reject("call-2", "not allowed");

        expect(fake.mutationCalls).toContainEqual({
            args: { decision: "reject", instanceId: "wf-1", note: "not allowed", threadKey: "t1", toolCallId: "call-2" },
            functionPath: APPROVAL_REF,
        });

        await latest?.cancel();

        expect(fake.mutationCalls).toContainEqual({ args: { instanceId: "wf-1", threadKey: "t1" }, functionPath: CANCEL_REF });
    });

    it("approve rejects when there is no in-flight run to resolve", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

                return <pre>{String(latest.status())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        await expect(latest?.approve("call-1")).rejects.toThrow("no in-flight run");
    });
});
