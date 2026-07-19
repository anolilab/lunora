import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";
import { effectScope } from "vue";

import type { AgentLiveEvent, UseAgentChatApi, UseAgentChatResult } from "../src/use-agent-chat";
import { useAgentChat } from "../src/use-agent-chat";
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

const buildApi = (): UseAgentChatApi =>
    ({
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
            agentResolveApproval: makeRef(APPROVAL_REF),
            agentThread: makeRef(THREAD_REF),
        },
    }) as unknown as UseAgentChatApi;

describe(useAgentChat, () => {
    it("surfaces durable history and live status over the agents:* subscriptions", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" }),
            ),
        )!;

        // Both the history and thread channels open on setup.
        expect(fake.subscribeCalls.map((call) => call.functionPath).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([MESSAGES_REF, THREAD_REF]);
        expect(chat.messages.value).toStrictEqual([]);
        expect(chat.status.value).toBeUndefined();
        // No stream reference supplied — streamingText stays empty (no stream opens).
        expect(chat.streamingText.value).toBe("");
        expect(fake.streamCalls).toHaveLength(0);

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "running" });

        expect(chat.status.value).toBe("running");

        fake.push(MESSAGES_REF, { key: "t1" }, [{ content: "hi", role: "user", seq: 0 }]);

        expect(chat.messages.value).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        scope.stop();
    });

    it("accumulates in-flight token deltas into streamingText, then clears once the turn persists", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({
                    api: buildApi(),
                    send: makeRef(SEND_REF) as FunctionReference<"mutation">,
                    stream: makeStreamRef(STREAM_REF),
                    threadKey: "t1",
                }),
            ),
        )!;

        // The live event stream opens alongside the durable subscriptions.
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([STREAM_REF]);
        expect(fake.streamCalls[0]?.args).toStrictEqual({ key: "t1" });

        // Turn-0 deltas (no assistant persisted yet) accumulate into streamingText.
        fake.pushStream(STREAM_REF, { key: "t1" }, { text: "Hel", threadKey: "t1", turn: 0 });
        fake.pushStream(STREAM_REF, { key: "t1" }, { text: "lo", threadKey: "t1", turn: 0 });
        await fake.flush();

        expect(chat.streamingText.value).toBe("Hello");

        // Progress events ride the same stream but carry no turn text — ignored here.
        fake.pushStream(STREAM_REF, { key: "t1" }, { data: { pct: 50 }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        await fake.flush();

        expect(chat.streamingText.value).toBe("Hello");

        // Once the turn's assistant message persists, its deltas are superseded —
        // streamingText clears (the persisted message is the source of truth).
        fake.push(MESSAGES_REF, { key: "t1" }, [
            { content: "hi", role: "user", seq: 0 },
            { content: "Hello", role: "assistant", seq: 1 },
        ]);

        expect(chat.streamingText.value).toBe("");

        scope.stop();
    });

    it("appends an optimistic user turn on send, then reconciles it against durable history", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" }),
            ),
        )!;

        await chat.send("hello there");

        expect(fake.mutationSpy).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: SEND_REF }), { input: "hello there", threadKey: "t1" }, undefined);
        expect(chat.messages.value).toStrictEqual([{ content: "hello there", optimistic: true, role: "user", seq: 0 }]);

        // The durable turn lands → the optimistic row is reconciled away.
        fake.push(MESSAGES_REF, { key: "t1" }, [{ content: "hello there", role: "user", seq: 0 }]);

        expect(chat.messages.value).toStrictEqual([{ content: "hello there", role: "user", seq: 0 }]);

        scope.stop();
    });

    it("shows a fresh optimistic echo for a repeated identical prompt, not reconciled by the earlier durable row", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" }),
            ),
        )!;

        // First send of "hi": acked by the server, durable history now has one "hi".
        await chat.send("hi");

        fake.push(MESSAGES_REF, { key: "t1" }, [{ content: "hi", role: "user", seq: 0 }]);

        expect(chat.messages.value).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        // Sending "hi" again must NOT be immediately swallowed by the stale durable
        // "hi" that predates this send — the optimistic echo should render until
        // ITS OWN durable row arrives.
        await chat.send("hi");

        expect(chat.messages.value).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", optimistic: true, role: "user", seq: 1 },
        ]);

        // Once the second durable "hi" lands, the optimistic row reconciles away.
        fake.push(MESSAGES_REF, { key: "t1" }, [
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);

        expect(chat.messages.value).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);

        scope.stop();
    });

    it("routes approve / reject / cancel with the in-flight instanceId", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({
                    api: buildApi(),
                    cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
                    send: makeRef(SEND_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                }),
            ),
        )!;

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "awaiting_input" });

        await chat.approve("call-1");

        expect(fake.mutationSpy).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: APPROVAL_REF }),
            { decision: "approve", instanceId: "wf-1", threadKey: "t1", toolCallId: "call-1" },
            undefined,
        );

        await chat.reject("call-2", "not allowed");

        expect(fake.mutationSpy).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: APPROVAL_REF }),
            { decision: "reject", instanceId: "wf-1", note: "not allowed", threadKey: "t1", toolCallId: "call-2" },
            undefined,
        );

        await chat.cancel();

        expect(fake.mutationSpy).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: CANCEL_REF }), { instanceId: "wf-1", threadKey: "t1" }, undefined);

        scope.stop();
    });

    it("approve rejects when there is no in-flight run to resolve", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" }),
            ),
        )!;

        await expect(chat.approve("call-1")).rejects.toThrow("no in-flight run");

        scope.stop();
    });
});
