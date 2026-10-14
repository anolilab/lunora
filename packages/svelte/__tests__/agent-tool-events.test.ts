import type { FunctionReference } from "@lunora/client";
import { get } from "svelte/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentLiveEvent } from "../src/agent-chat";
import type { AgentToolEventsApi } from "../src/agent-tool-events";
import { agentToolEvents } from "../src/agent-tool-events";
import { createFakeClient } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

// The event stream must be referenced exactly — a widened `FunctionReference<"stream">`
// is not assignable to the phantom-typed live-stream reference.
const makeStreamRef = (reference: string): FunctionReference<"stream", { key: string }, AgentLiveEvent> => {
    return { __lunoraRef: reference };
};

const MESSAGES_REF = "agents:agentMessages";
const STREAM_REF = "chat:agentEvents";

const buildApi = (): AgentToolEventsApi =>
    ({
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
        },
    }) as unknown as AgentToolEventsApi;

// Every subscribing primitive in this package gates on a browser `window` (the
// SSR guard — svelte's server runtime subscribes to `{$store}` during
// `render()`, so a `readable`'s start callback runs on the server too). The
// vitest env is `node`, so define one for the client-path tests. Mirrors the
// same stub in `flag.test.ts` / `presence.test.ts`.
/* eslint-disable vitest/require-top-level-describe -- the `window` stub is shared by every describe in this file, so it belongs at file scope */
beforeAll(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
});
/* eslint-enable vitest/require-top-level-describe */

describe(agentToolEvents, () => {
    it("derives the durable tool lifecycle (call, result, awaiting-approval) from agentMessages", () => {
        const fake = createFakeClient();
        const handle = agentToolEvents(fake.client, { api: buildApi(), threadKey: "t1" });

        // The store is lazy — the lone history channel opens on the first subscriber.
        const unsubscribe = handle.events.subscribe(() => {});

        expect(fake.subscribeCalls.map((call) => call.functionPath)).toStrictEqual([MESSAGES_REF]);
        // With no `stream` reference the event stream is opened with `"skip"`, so no stream opens.
        expect(fake.streamCalls).toHaveLength(0);
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

    it("appends live progress events (kind === 'progress') after the durable lifecycle", async () => {
        const fake = createFakeClient();
        const handle = agentToolEvents(fake.client, { api: buildApi(), stream: makeStreamRef(STREAM_REF), threadKey: "t1" });

        const unsubscribe = handle.events.subscribe(() => {});

        // Both the durable history subscription and the live event stream open.
        expect(fake.subscribeCalls.map((call) => call.functionPath)).toStrictEqual([MESSAGES_REF]);
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([STREAM_REF]);

        fake.push(MESSAGES_REF, [
            { content: "checking…", role: "assistant", seq: 1, toolCalls: [{ id: "c1", input: { city: "Berlin" }, name: "getWeather" }] },
        ]);

        fake.pushStream(STREAM_REF, { data: { step: "geocoding" }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        await fake.flush();

        expect(get(handle.events)).toStrictEqual([
            { input: { city: "Berlin" }, seq: 1, toolCallId: "c1", toolName: "getWeather", type: "call" },
            { data: { step: "geocoding" }, toolCallId: "c1", type: "progress" },
        ]);

        unsubscribe();
    });

    it("only surfaces progress for the observed thread", async () => {
        const fake = createFakeClient();
        const handle = agentToolEvents(fake.client, { api: buildApi(), stream: makeStreamRef(STREAM_REF), threadKey: "t1" });

        const unsubscribe = handle.events.subscribe(() => {});

        // A progress event for a different thread is dropped; the observed thread's is kept.
        fake.pushStream(STREAM_REF, { data: { step: "other" }, kind: "progress", threadKey: "t2", toolCallId: "c9" });
        fake.pushStream(STREAM_REF, { data: { step: "mine" }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        await fake.flush();

        expect(get(handle.events)).toStrictEqual([{ data: { step: "mine" }, toolCallId: "c1", type: "progress" }]);

        unsubscribe();
    });

    it("forwards the history limit to agents:agentMessages", () => {
        const fake = createFakeClient();
        const handle = agentToolEvents(fake.client, { api: buildApi(), limit: 10, threadKey: "t1" });

        const unsubscribe = handle.events.subscribe(() => {});

        expect(fake.subscribeCalls[0]?.args).toStrictEqual({ key: "t1", limit: 10 });

        unsubscribe();
    });
});
