import type { FunctionReference } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it } from "vitest";

import type { AgentChatApi, AgentLiveEvent } from "../src/agent-chat";
import { agentChat } from "../src/agent-chat";
import { createFakeClient } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

// The token stream must be referenced exactly — a widened `FunctionReference<"stream">`
// is not assignable to the phantom-typed `AgentTokenStreamReference`.
const makeStreamRef = (reference: string): FunctionReference<"stream", { key: string }, AgentLiveEvent> => {
    return { __lunoraRef: reference };
};

const MESSAGES_REF = "agents:agentMessages";
const THREAD_REF = "agents:agentThread";
const APPROVAL_REF = "agents:agentResolveApproval";
const SEND_REF = "chat:startRun";
const CANCEL_REF = "chat:cancelRun";
const STREAM_REF = "chat:agentEvents";

const buildApi = (): AgentChatApi =>
    ({
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
            agentResolveApproval: makeRef(APPROVAL_REF),
            agentThread: makeRef(THREAD_REF),
        },
    }) as unknown as AgentChatApi;

describe(agentChat, () => {
    it("surfaces durable history and live status over the agents:* subscriptions", () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, { api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

        // Both the history and thread channels open eagerly on setup.
        expect(fake.subscribeCalls.map((call) => call.functionPath).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([MESSAGES_REF, THREAD_REF]);
        expect(get(handle.messages)).toStrictEqual([]);
        expect(get(handle.status)).toBeUndefined();
        // With no `stream` reference the token stream is opened with `"skip"` args,
        // so no stream is opened and `streamingText` stays empty.
        expect(fake.streamCalls).toHaveLength(0);
        expect(get(handle.streamingText)).toBe("");

        fake.push(THREAD_REF, { instanceId: "wf-1", status: "running" });

        expect(get(handle.status)).toBe("running");

        fake.push(MESSAGES_REF, [{ content: "hi", role: "user", seq: 0 }]);

        expect(get(handle.messages)).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        handle.teardown();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(2);
    });

    it("accumulates in-flight token deltas into streamingText, then clears once the turn persists", async () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, {
            api: buildApi(),
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            stream: makeStreamRef(STREAM_REF),
            threadKey: "t1",
        });

        // The token stream opens eagerly alongside the history/thread subscriptions.
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([STREAM_REF]);

        fake.pushStream(STREAM_REF, { text: "Hel", threadKey: "t1", turn: 0 });
        fake.pushStream(STREAM_REF, { text: "lo", threadKey: "t1", turn: 0 });
        // A progress event rides the same stream but carries no turn text — ignored here.
        fake.pushStream(STREAM_REF, { data: { pct: 50 }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        await fake.flush();

        expect(get(handle.streamingText)).toBe("Hello");

        // The turn persists → its assistant row advances the retire gate and the
        // deltas fall away, leaving the persisted message the source of truth.
        fake.push(MESSAGES_REF, [{ content: "Hello", role: "assistant", seq: 0 }]);

        expect(get(handle.streamingText)).toBe("");

        handle.teardown();
    });

    it("appends an optimistic user turn on send, then reconciles it against durable history", async () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, { api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

        await handle.send("hello there");

        expect(fake.mutationSpy).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: SEND_REF }), { input: "hello there", threadKey: "t1" }, undefined);
        expect(get(handle.messages)).toStrictEqual([{ content: "hello there", optimistic: true, role: "user", seq: 0 }]);

        // The durable turn lands → the optimistic row is reconciled away.
        fake.push(MESSAGES_REF, [{ content: "hello there", role: "user", seq: 0 }]);

        expect(get(handle.messages)).toStrictEqual([{ content: "hello there", role: "user", seq: 0 }]);

        handle.teardown();
    });

    it("shows a fresh optimistic echo for a repeated identical prompt, not reconciled by the earlier durable row", async () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, { api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

        // First send of "hi": acked by the server, durable history now has one "hi".
        await handle.send("hi");

        fake.push(MESSAGES_REF, [{ content: "hi", role: "user", seq: 0 }]);

        expect(get(handle.messages)).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        // Sending "hi" again must NOT be immediately swallowed by the stale durable
        // "hi" that predates this send — the optimistic echo should render until
        // ITS OWN durable row arrives.
        await handle.send("hi");

        expect(get(handle.messages)).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", optimistic: true, role: "user", seq: 1 },
        ]);

        // Once the second durable "hi" lands, the optimistic row reconciles away.
        fake.push(MESSAGES_REF, [
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);

        expect(get(handle.messages)).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);

        handle.teardown();
    });

    it("routes approve / reject / cancel with the in-flight instanceId", async () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, {
            api: buildApi(),
            cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        fake.push(THREAD_REF, { instanceId: "wf-1", status: "awaiting_input" });

        await handle.approve("call-1");

        expect(fake.mutationSpy).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: APPROVAL_REF }),
            { decision: "approve", instanceId: "wf-1", threadKey: "t1", toolCallId: "call-1" },
            undefined,
        );

        await handle.reject("call-2", "not allowed");

        expect(fake.mutationSpy).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: APPROVAL_REF }),
            { decision: "reject", instanceId: "wf-1", note: "not allowed", threadKey: "t1", toolCallId: "call-2" },
            undefined,
        );

        await handle.cancel();

        expect(fake.mutationSpy).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: CANCEL_REF }), { instanceId: "wf-1", threadKey: "t1" }, undefined);

        handle.teardown();
    });

    it("approve rejects when there is no in-flight run to resolve", async () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, { api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

        await expect(handle.approve("call-1")).rejects.toThrow("no in-flight run");

        handle.teardown();
    });
});
