import type { FunctionReference, LunoraClient } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import type { AgentToolEventsApi } from "../src/agent-tool-events";
import { agentToolEvents } from "../src/agent-tool-events";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const MESSAGES_REF = "agents:agentMessages";

interface SubscribeCall {
    args: { key: string; limit?: number };
    callback: (value: unknown) => void;
    functionPath: string;
}

const buildApi = (): AgentToolEventsApi =>
    ({
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
        },
    }) as unknown as AgentToolEventsApi;

const createFakeClient = () => {
    const subscribeCalls: SubscribeCall[] = [];
    const unsubscribeSpy = vi.fn<() => void>();

    const subscribe = vi.fn<(function_: FunctionReference, args: SubscribeCall["args"], callback: (value: unknown) => void) => () => void>(
        (function_, args, callback) => {
            // Bracket access — `__lunoraRef` is the public function-reference marker.
            subscribeCalls.push({ args, callback, functionPath: function_["__lunoraRef"] });

            return unsubscribeSpy;
        },
    );

    const client = { subscribe } as unknown as LunoraClient;

    return {
        client,
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

describe(agentToolEvents, () => {
    it("derives the durable tool lifecycle (call, result, awaiting-approval) from agentMessages", () => {
        const fake = createFakeClient();
        const handle = agentToolEvents(fake.client, { api: buildApi(), threadKey: "t1" });

        // The store is lazy — the lone history channel opens on the first subscriber.
        const unsubscribe = handle.events.subscribe(() => {});

        expect(fake.subscribeCalls.map((call) => call.functionPath)).toStrictEqual([MESSAGES_REF]);
        expect(get(handle.events)).toStrictEqual([]);

        fake.push(MESSAGES_REF, [
            { content: "hi", role: "user", seq: 0 },
            { content: "checking…", role: "assistant", seq: 1, toolCalls: [{ id: "c1", input: { city: "Berlin" }, name: "getWeather" }] },
            { content: "sunny", role: "tool", seq: 2, toolCallId: "c1", toolName: "getWeather" },
            { content: "awaiting approval", role: "tool", seq: 3, status: "awaiting_approval", toolCallId: "c2", toolName: "charge" },
        ]);

        expect(get(handle.events)).toStrictEqual([
            { input: { city: "Berlin" }, seq: 1, toolCallId: "c1", toolName: "getWeather", type: "call" },
            { output: "sunny", seq: 2, toolCallId: "c1", toolName: "getWeather", type: "result" },
            { seq: 3, toolCallId: "c2", toolName: "charge", type: "awaiting-approval" },
        ]);

        // Dropping the last subscriber tears the underlying subscription down.
        unsubscribe();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("forwards the history limit to agents:agentMessages", () => {
        const fake = createFakeClient();
        const handle = agentToolEvents(fake.client, { api: buildApi(), limit: 10, threadKey: "t1" });

        const unsubscribe = handle.events.subscribe(() => {});

        expect(fake.subscribeCalls[0]?.args).toStrictEqual({ key: "t1", limit: 10 });

        unsubscribe();
    });
});
