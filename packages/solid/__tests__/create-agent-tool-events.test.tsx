import type { FunctionReference } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import type { AgentLiveEvent } from "../src/create-agent-chat";
import type { CreateAgentToolEventsApi, CreateAgentToolEventsResult } from "../src/create-agent-tool-events";
import { createAgentToolEvents } from "../src/create-agent-tool-events";
import { LunoraProvider } from "../src/lunora-provider";
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

const buildApi = (): CreateAgentToolEventsApi =>
    ({
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
        },
    }) as unknown as CreateAgentToolEventsApi;

const pushTo = (subscriptions: { functionPath: string; push: (value: unknown) => void }[], reference: string, value: unknown): void => {
    subscriptions.find((sub) => sub.functionPath === reference)?.push(value);
};

describe(createAgentToolEvents, () => {
    it("derives the durable tool lifecycle (call, result, awaiting-approval) from agentMessages", () => {
        const fake = createFakeClient();
        let latest: CreateAgentToolEventsResult | undefined;

        render(
            () => {
                latest = createAgentToolEvents({ api: buildApi(), threadKey: "t1" });

                return <pre>{JSON.stringify(latest.events())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // The lone history channel opens on setup.
        expect(fake.subscriptions.map((sub) => sub.functionPath)).toStrictEqual([MESSAGES_REF]);
        expect(latest?.events()).toStrictEqual([]);

        pushTo(fake.subscriptions, MESSAGES_REF, [
            { content: "hi", role: "user", seq: 0 },
            { content: "checking…", role: "assistant", seq: 1, toolCalls: [{ id: "c1", input: { city: "Berlin" }, name: "getWeather" }] },
            { content: "sunny", role: "tool", seq: 2, toolCallId: "c1", toolName: "getWeather" },
            { content: "awaiting approval", role: "tool", seq: 3, status: "awaiting_approval", toolCallId: "c2", toolName: "charge" },
        ]);

        expect(latest?.events()).toStrictEqual([
            { input: { city: "Berlin" }, seq: 1, toolCallId: "c1", toolName: "getWeather", type: "call" },
            { output: "sunny", seq: 2, toolCallId: "c1", toolName: "getWeather", type: "result" },
            { seq: 3, toolCallId: "c2", toolName: "charge", type: "awaiting-approval" },
        ]);
    });

    it("forwards the history limit to agents:agentMessages", () => {
        const fake = createFakeClient();

        render(
            () => {
                const { events } = createAgentToolEvents({ api: buildApi(), limit: 10, threadKey: "t1" });

                return <pre>{JSON.stringify(events())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions[0]?.args).toStrictEqual({ key: "t1", limit: 10 });
    });

    it("appends live progress events (kind === 'progress') after the durable lifecycle", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentToolEventsResult | undefined;

        render(
            () => {
                latest = createAgentToolEvents({ api: buildApi(), stream: makeStreamRef(STREAM_REF), threadKey: "t1" });

                return <pre>{JSON.stringify(latest.events())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // Both the history subscription and the live event stream open on setup.
        expect(fake.subscriptions.map((sub) => sub.functionPath)).toStrictEqual([MESSAGES_REF]);
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([STREAM_REF]);

        pushTo(fake.subscriptions, MESSAGES_REF, [
            { content: "checking…", role: "assistant", seq: 1, toolCalls: [{ id: "c1", input: { city: "Berlin" }, name: "getWeather" }] },
        ]);

        // Token deltas on the same stream carry no progress payload — ignored here.
        fake.pushStream(STREAM_REF, { key: "t1" }, { text: "thinking", threadKey: "t1", turn: 0 });
        fake.pushStream(STREAM_REF, { key: "t1" }, { data: { pct: 25 }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        fake.pushStream(STREAM_REF, { key: "t1" }, { data: { pct: 75 }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        await fake.flush();

        expect(latest?.events()).toStrictEqual([
            { input: { city: "Berlin" }, seq: 1, toolCallId: "c1", toolName: "getWeather", type: "call" },
            { data: { pct: 25 }, toolCallId: "c1", type: "progress" },
            { data: { pct: 75 }, toolCallId: "c1", type: "progress" },
        ]);
    });

    it("only surfaces progress for the observed thread", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentToolEventsResult | undefined;

        render(
            () => {
                latest = createAgentToolEvents({ api: buildApi(), stream: makeStreamRef(STREAM_REF), threadKey: "t1" });

                return <pre>{JSON.stringify(latest.events())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // A progress event for a different thread rides the same fake stream key but
        // is filtered out by the `threadKey` guard in the primitive.
        fake.pushStream(STREAM_REF, { key: "t1" }, { data: { pct: 10 }, kind: "progress", threadKey: "other", toolCallId: "c9" });
        await fake.flush();

        expect(latest?.events()).toStrictEqual([]);
    });
});
