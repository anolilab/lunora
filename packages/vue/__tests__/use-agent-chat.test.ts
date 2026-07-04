import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";
import { effectScope } from "vue";

import type { UseAgentChatApi, UseAgentChatResult } from "../src/use-agent-chat";
import { useAgentChat } from "../src/use-agent-chat";
import { createFakeClient } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const MESSAGES_REF = "agents:agentMessages";
const THREAD_REF = "agents:agentThread";
const APPROVAL_REF = "agents:agentResolveApproval";
const SEND_REF = "chat:startRun";
const CANCEL_REF = "chat:cancelRun";

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
        // No token-stream primitive on this adapter — streamingText stays empty.
        expect(chat.streamingText.value).toBe("");

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "running" });

        expect(chat.status.value).toBe("running");

        fake.push(MESSAGES_REF, { key: "t1" }, [{ content: "hi", role: "user", seq: 0 }]);

        expect(chat.messages.value).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

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
