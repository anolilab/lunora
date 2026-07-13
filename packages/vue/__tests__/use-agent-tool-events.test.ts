import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";
import { effectScope } from "vue";

import type { AgentLiveEvent } from "../src/use-agent-chat";
import type { UseAgentToolEventsApi, UseAgentToolEventsResult } from "../src/use-agent-tool-events";
import { useAgentToolEvents } from "../src/use-agent-tool-events";
import { createFakeClient } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

// The live-event stream option is a *narrow* reference (`{ key: string }` args,
// `AgentLiveEvent` returns). A plain `{ __lunoraRef }` literal is structurally
// assignable to any specialization (the phantom field is optional), so this
// helper types the ref exactly instead of down-casting a widened one.
const makeStreamRef = (reference: string): FunctionReference<"stream", { key: string }, AgentLiveEvent> => {
    return { __lunoraRef: reference };
};

const MESSAGES_REF = "agents:agentMessages";
const STREAM_REF = "chat:liveEvents";

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

    it("appends live progress events (kind === 'progress') after the durable lifecycle", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const tool = scope.run(() =>
            fake.provide((): UseAgentToolEventsResult =>
                useAgentToolEvents({
                    api: buildApi(),
                    stream: makeStreamRef(STREAM_REF),
                    threadKey: "t1",
                }),
            ),
        )!;

        // Both the history subscription and the live event stream open on setup.
        expect(fake.subscribeCalls.map((call) => call.functionPath)).toStrictEqual([MESSAGES_REF]);
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([STREAM_REF]);

        fake.push(MESSAGES_REF, { key: "t1" }, [
            { content: "checking…", role: "assistant", seq: 1, toolCalls: [{ id: "c1", input: { city: "Berlin" }, name: "getWeather" }] },
        ]);

        // Token deltas on the same stream carry no progress payload — ignored here.
        fake.pushStream(STREAM_REF, { key: "t1" }, { text: "thinking", threadKey: "t1", turn: 0 });
        fake.pushStream(STREAM_REF, { key: "t1" }, { data: { pct: 25 }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        fake.pushStream(STREAM_REF, { key: "t1" }, { data: { pct: 75 }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        await fake.flush();

        expect(tool.events.value).toStrictEqual([
            { input: { city: "Berlin" }, seq: 1, toolCallId: "c1", toolName: "getWeather", type: "call" },
            { data: { pct: 25 }, toolCallId: "c1", type: "progress" },
            { data: { pct: 75 }, toolCallId: "c1", type: "progress" },
        ]);

        scope.stop();
    });

    it("only surfaces progress for the observed thread", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const tool = scope.run(() =>
            fake.provide((): UseAgentToolEventsResult =>
                useAgentToolEvents({
                    api: buildApi(),
                    stream: makeStreamRef(STREAM_REF),
                    threadKey: "t1",
                }),
            ),
        )!;

        // A progress event for a different thread rides the same fake stream key but
        // is filtered out by the `threadKey` guard in the composable.
        fake.pushStream(STREAM_REF, { key: "t1" }, { data: { pct: 10 }, kind: "progress", threadKey: "other", toolCallId: "c9" });
        await fake.flush();

        expect(tool.events.value).toStrictEqual([]);

        scope.stop();
    });
});
