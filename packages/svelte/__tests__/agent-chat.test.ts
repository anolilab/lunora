import type { FunctionReference, LunoraClient } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import type { AgentChatApi } from "../src/agent-chat";
import { agentChat } from "../src/agent-chat";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const MESSAGES_REF = "agents:agentMessages";
const THREAD_REF = "agents:agentThread";
const APPROVAL_REF = "agents:agentResolveApproval";
const SEND_REF = "chat:startRun";
const CANCEL_REF = "chat:cancelRun";

interface SubscribeCall {
    args: { key: string; limit?: number };
    callback: (value: unknown) => void;
    functionPath: string;
}

const buildApi = (): AgentChatApi =>
    ({
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
            agentResolveApproval: makeRef(APPROVAL_REF),
            agentThread: makeRef(THREAD_REF),
        },
    }) as unknown as AgentChatApi;

const createFakeClient = () => {
    const subscribeCalls: SubscribeCall[] = [];
    const unsubscribeSpy = vi.fn<() => void>();
    const mutationSpy = vi.fn<() => Promise<{ resolved: boolean }>>(async () => {
        return { resolved: true };
    });

    const subscribe = vi.fn<(function_: FunctionReference, args: SubscribeCall["args"], callback: (value: unknown) => void) => () => void>(
        (function_, args, callback) => {
            // Bracket access — `__lunoraRef` is the public function-reference marker.
            subscribeCalls.push({ args, callback, functionPath: function_["__lunoraRef"] });

            return unsubscribeSpy;
        },
    );

    const client = { mutation: mutationSpy, subscribe } as unknown as LunoraClient;

    return {
        client,
        mutationSpy,
        /** Push `value` to every subscription opened on `functionPath`. */
        push: (functionPath: string, value: unknown): void => {
            for (const call of subscribeCalls) {
                if (call.functionPath === functionPath) {
                    call.callback(value);
                }
            }
        },
        subscribeCalls,
        unsubscribeSpy,
    };
};

describe(agentChat, () => {
    it("surfaces durable history and live status over the agents:* subscriptions", () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, { api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

        // Both the history and thread channels open eagerly on setup.
        expect(fake.subscribeCalls.map((call) => call.functionPath).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([MESSAGES_REF, THREAD_REF]);
        expect(get(handle.messages)).toStrictEqual([]);
        expect(get(handle.status)).toBeUndefined();
        // No token-stream primitive on this adapter — streamingText stays empty.
        expect(get(handle.streamingText)).toBe("");

        fake.push(THREAD_REF, { instanceId: "wf-1", status: "running" });

        expect(get(handle.status)).toBe("running");

        fake.push(MESSAGES_REF, [{ content: "hi", role: "user", seq: 0 }]);

        expect(get(handle.messages)).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        handle.teardown();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(2);
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
