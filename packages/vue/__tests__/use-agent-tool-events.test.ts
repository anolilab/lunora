import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";
import { effectScope } from "vue";

import type { UseAgentToolEventsApi, UseAgentToolEventsResult } from "../src/use-agent-tool-events";
import { useAgentToolEvents } from "../src/use-agent-tool-events";
import { createFakeClient } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const MESSAGES_REF = "agents:agentMessages";

const buildApi = (): UseAgentToolEventsApi =>
    ({
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
        },
    }) as unknown as UseAgentToolEventsApi;

describe(useAgentToolEvents, () => {
    it("derives the durable tool lifecycle (call, result, awaiting-approval) from agentMessages", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const tool = scope.run(() => fake.provide((): UseAgentToolEventsResult => useAgentToolEvents({ api: buildApi(), threadKey: "t1" })))!;

        // The lone history channel opens on setup.
        expect(fake.subscribeCalls.map((call) => call.functionPath)).toStrictEqual([MESSAGES_REF]);
        expect(tool.events.value).toStrictEqual([]);

        fake.push(MESSAGES_REF, { key: "t1" }, [
            { content: "hi", role: "user", seq: 0 },
            { content: "checking…", role: "assistant", seq: 1, toolCalls: [{ id: "c1", input: { city: "Berlin" }, name: "getWeather" }] },
            { content: "sunny", role: "tool", seq: 2, toolCallId: "c1", toolName: "getWeather" },
            { content: "awaiting approval", role: "tool", seq: 3, status: "awaiting_approval", toolCallId: "c2", toolName: "charge" },
        ]);

        expect(tool.events.value).toStrictEqual([
            { input: { city: "Berlin" }, seq: 1, toolCallId: "c1", toolName: "getWeather", type: "call" },
            { output: "sunny", seq: 2, toolCallId: "c1", toolName: "getWeather", type: "result" },
            { seq: 3, toolCallId: "c2", toolName: "charge", type: "awaiting-approval" },
        ]);

        scope.stop();
    });

    it("forwards the history limit to agents:agentMessages", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        scope.run(() => fake.provide(() => useAgentToolEvents({ api: buildApi(), limit: 10, threadKey: "t1" })));

        expect(fake.subscribeCalls[0]?.args).toStrictEqual({ key: "t1", limit: 10 });

        scope.stop();
    });
});
