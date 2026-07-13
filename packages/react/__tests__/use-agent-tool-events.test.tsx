import type { FunctionReference, LunoraClient, StreamHandle, StreamIterable } from "@lunora/client";
import { createStream } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import type { UseAgentToolEventsApi, UseAgentToolEventsOptions, UseAgentToolEventsResult } from "../src/use-agent-tool-events";
import { useAgentToolEvents } from "../src/use-agent-tool-events";
import { createMockClient } from "./mock-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

interface StreamEntry {
    handle: StreamHandle;
    iterable: StreamIterable<unknown>;
    onCancel: ReturnType<typeof vi.fn>;
}

/** A client satisfying both the subscription surface (shared mock) and a scripted `client.stream`. */
const buildClient = (): { client: LunoraClient; emit: (reference: string, value: unknown) => void; openStream: () => StreamEntry } => {
    const mock = createMockClient();
    const streams: StreamEntry[] = [];
    const streamFunction = vi.fn<(function__: FunctionReference, args: unknown) => StreamIterable<unknown>>(() => {
        const onCancel = vi.fn<() => void>();
        const { handle, iterable } = createStream<unknown>({ onCancel });

        streams.push({ handle, iterable, onCancel });

        return iterable;
    });

    const client = mock.asClient;

    (client as unknown as Record<string, unknown>)["stream"] = streamFunction;

    return {
        client,
        emit: mock.emit,
        openStream: () => {
            const entry = streams.at(-1);

            if (!entry) {
                throw new Error("client.stream was never called");
            }

            return entry;
        },
    };
};

const MESSAGES_REF = "agents:agentMessages";
const STREAM_REF = "chat:tokens";

const buildOptions = (overrides: Partial<UseAgentToolEventsOptions> = {}): UseAgentToolEventsOptions => {
    const api = {
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
        },
    } as unknown as UseAgentToolEventsApi;

    return {
        api,
        stream: makeRef(STREAM_REF) as UseAgentToolEventsOptions["stream"],
        threadKey: "t1",
        ...overrides,
    };
};

interface HarnessProps {
    onReady: (result: UseAgentToolEventsResult) => void;
    options: UseAgentToolEventsOptions;
}

const Harness = ({ onReady, options }: HarnessProps): ReactElement => {
    const result = useAgentToolEvents(options);

    // Expose the latest committed result to the test from an effect — invoking a
    // prop callback during render is impure (React may replay/discard renders).
    useEffect(() => {
        onReady(result);
    });

    return <span data-testid="events">{JSON.stringify(result.events)}</span>;
};

const readEvents = (): unknown[] => JSON.parse(screen.getByTestId("events").textContent ?? "[]") as unknown[];

describe("useAgentToolEvents", () => {
    it("derives the durable tool lifecycle (call, result, awaiting-approval) from agentMessages", async () => {
        expect.hasAssertions();

        const { client, emit } = buildClient();

        render(
            <LunoraProvider client={client}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={() => {}}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        await act(async () => {
            emit(MESSAGES_REF, [
                { content: "hi", role: "user", seq: 0 },
                { content: "checking…", role: "assistant", seq: 1, toolCalls: [{ id: "c1", input: { city: "Berlin" }, name: "getWeather" }] },
                { content: "sunny", role: "tool", seq: 2, toolCallId: "c1", toolName: "getWeather" },
                { content: "awaiting approval", role: "tool", seq: 3, status: "awaiting_approval", toolCallId: "c2", toolName: "charge" },
            ]);
        });

        expect(readEvents()).toStrictEqual([
            { input: { city: "Berlin" }, seq: 1, toolCallId: "c1", toolName: "getWeather", type: "call" },
            { output: "sunny", seq: 2, toolCallId: "c1", toolName: "getWeather", type: "result" },
            { seq: 3, toolCallId: "c2", toolName: "charge", type: "awaiting-approval" },
        ]);
    });

    it("surfaces live progress events for the thread and ignores token deltas + other threads", async () => {
        expect.hasAssertions();

        const { client, emit, openStream } = buildClient();

        render(
            <LunoraProvider client={client}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={() => {}}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        // Seed one durable result so the ordering (durable first, progress after) is visible.
        await act(async () => {
            emit(MESSAGES_REF, [{ content: "done", role: "tool", seq: 0, toolCallId: "c1", toolName: "sync" }]);
        });

        await waitFor(() => {
            expect(openStream).not.toThrow();
        });

        await act(async () => {
            // A token delta rides the same stream but is NOT a progress event.
            openStream().handle.push({ text: "hi", threadKey: "t1", turn: 0 });
            // Progress for another thread must be ignored.
            openStream().handle.push({ data: { pct: 10 }, kind: "progress", threadKey: "other", toolCallId: "c9" });
            // Progress for THIS thread is surfaced.
            openStream().handle.push({ data: { pct: 50 }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        });

        await waitFor(() => {
            expect(readEvents()).toStrictEqual([
                { output: "done", seq: 0, toolCallId: "c1", toolName: "sync", type: "result" },
                { data: { pct: 50 }, toolCallId: "c1", type: "progress" },
            ]);
        });
    });
});
