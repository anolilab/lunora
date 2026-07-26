import type { FunctionReference, LunoraClient, StreamHandle, StreamIterable } from "@lunora/client";
import { createStream } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import type { UseAgentChatApi, UseAgentChatOptions, UseAgentChatResult } from "../src/use-agent-chat";
import { useAgentChat } from "../src/use-agent-chat";
import { createMockClient } from "./mock-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

interface StreamEntry {
    handle: StreamHandle;
    iterable: StreamIterable<unknown>;
    onCancel: ReturnType<typeof vi.fn>;
}

/**
 * A client that satisfies BOTH the subscription/mutation surface (from the shared
 * mock) and the streaming surface (a scripted `client.stream`), so `useAgentChat`
 * can compose its subscription, mutation, and stream hooks against one client.
 */
const buildClient = (): {
    client: LunoraClient;
    emit: (reference: string, value: unknown) => void;
    mutation: ReturnType<typeof vi.fn>;
    openStream: () => StreamEntry;
} => {
    const mock = createMockClient();
    const streams: StreamEntry[] = [];
    const streamFunction = vi.fn<(function__: FunctionReference, args: unknown) => StreamIterable<unknown>>(() => {
        const onCancel = vi.fn<() => void>();
        const { handle, iterable } = createStream<unknown>({ onCancel });

        streams.push({ handle, iterable, onCancel });

        return iterable;
    });

    // Attach the streaming surface onto the shared mock (a plain object) so one
    // client satisfies the subscription, mutation, and stream hooks at once.
    const client = mock.asClient;

    (client as unknown as Record<string, unknown>)["stream"] = streamFunction;

    return {
        client,
        emit: mock.emit,
        mutation: mock.mutation,
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
const THREAD_REF = "agents:agentThread";
const APPROVAL_REF = "agents:agentResolveApproval";
const SEND_REF = "chat:startRun";
const CANCEL_REF = "chat:cancelRun";
const STREAM_REF = "chat:tokens";

const buildOptions = (overrides: Partial<UseAgentChatOptions> = {}): UseAgentChatOptions => {
    const api = {
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
            agentResolveApproval: makeRef(APPROVAL_REF),
            agentThread: makeRef(THREAD_REF),
        },
    } as unknown as UseAgentChatApi;

    return {
        api,
        cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
        send: makeRef(SEND_REF) as FunctionReference<"mutation">,
        stream: makeRef(STREAM_REF) as UseAgentChatOptions["stream"],
        threadKey: "t1",
        ...overrides,
    };
};

interface HarnessProps {
    onReady: (result: UseAgentChatResult) => void;
    options: UseAgentChatOptions;
}

const Harness = ({ onReady, options }: HarnessProps): ReactElement => {
    const result = useAgentChat(options);

    // Expose the latest committed result to the test from an effect — invoking a
    // prop callback during render is impure (React may replay/discard renders).
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-pass-data-to-parent -- test harness: the hook must run inside a component, so the effect is the only channel to surface its result to the test.
        onReady(result);
    });

    return (
        <div>
            <span data-testid="status">{result.status ?? ""}</span>
            <span data-testid="streaming">{result.streamingText}</span>
            <span data-testid="messages">{JSON.stringify(result.messages)}</span>
        </div>
    );
};

describe("useAgentChat", () => {
    it("surfaces durable history, live status, and streamed deltas", async () => {
        expect.hasAssertions();

        const { client, emit, openStream } = buildClient();
        let latest: UseAgentChatResult | undefined;

        render(
            <LunoraProvider client={client}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        // Live thread status flows through from the agentThread subscription.
        await act(async () => {
            emit(THREAD_REF, { instanceId: "wf-1", status: "running" });
        });

        expect(screen.getByTestId("status").textContent).toBe("running");

        // Durable history flows through from the agentMessages subscription.
        await act(async () => {
            emit(MESSAGES_REF, [{ content: "hi", role: "user", seq: 0 }]);
        });

        expect(screen.getByTestId("messages").textContent).toBe(JSON.stringify([{ content: "hi", role: "user", seq: 0 }]));

        // In-flight deltas (turn 0, no assistant persisted yet) accumulate into streamingText.
        await waitFor(() => {
            expect(openStream).not.toThrow();
        });

        await act(async () => {
            openStream().handle.push({ text: "Hel", threadKey: "t1", turn: 0 });
        });
        await act(async () => {
            openStream().handle.push({ text: "lo", threadKey: "t1", turn: 0 });
        });

        await waitFor(() => {
            expect(screen.getByTestId("streaming").textContent).toBe("Hello");
        });

        // Once the turn's assistant message persists, its deltas are superseded —
        // streamingText clears (the persisted message is the source of truth).
        await act(async () => {
            emit(MESSAGES_REF, [
                { content: "hi", role: "user", seq: 0 },
                { content: "Hello", role: "assistant", seq: 1 },
            ]);
        });

        expect(screen.getByTestId("streaming").textContent).toBe("");
        expect(latest).toBeDefined();
    });

    it("appends an optimistic user turn on send, then reconciles it against durable history", async () => {
        expect.hasAssertions();

        const { client, emit, mutation } = buildClient();
        let latest: UseAgentChatResult | undefined;

        render(
            <LunoraProvider client={client}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        await act(async () => {
            await latest?.send("hello there");
        });

        // The send mutation fires with the thread key + input merged in.
        expect(mutation).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: SEND_REF }), { input: "hello there", threadKey: "t1" }, undefined);

        // The optimistic user turn renders immediately, flagged as optimistic.
        const optimistic = JSON.parse(screen.getByTestId("messages").textContent ?? "[]") as Record<string, unknown>[];

        expect(optimistic).toStrictEqual([{ content: "hello there", optimistic: true, role: "user", seq: 0 }]);

        // When the durable turn lands, the optimistic row is reconciled away.
        await act(async () => {
            emit(MESSAGES_REF, [{ content: "hello there", role: "user", seq: 0 }]);
        });

        const reconciled = JSON.parse(screen.getByTestId("messages").textContent ?? "[]") as Record<string, unknown>[];

        expect(reconciled).toStrictEqual([{ content: "hello there", role: "user", seq: 0 }]);
    });

    it("shows a fresh optimistic echo for a repeated identical prompt, not reconciled by the earlier durable row", async () => {
        expect.hasAssertions();

        const { client, emit } = buildClient();
        let latest: UseAgentChatResult | undefined;

        render(
            <LunoraProvider client={client}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        // First send of "hi": acked by the server, durable history now has one "hi".
        await act(async () => {
            await latest?.send("hi");
        });

        await act(async () => {
            emit(MESSAGES_REF, [{ content: "hi", role: "user", seq: 0 }]);
        });

        const afterFirstAck = JSON.parse(screen.getByTestId("messages").textContent ?? "[]") as Record<string, unknown>[];

        expect(afterFirstAck).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        // Sending "hi" again must NOT be immediately swallowed by the stale durable
        // "hi" that predates this send — the optimistic echo should render until
        // ITS OWN durable row arrives.
        await act(async () => {
            await latest?.send("hi");
        });

        const afterSecondSend = JSON.parse(screen.getByTestId("messages").textContent ?? "[]") as Record<string, unknown>[];

        expect(afterSecondSend).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", optimistic: true, role: "user", seq: 1 },
        ]);

        // Once the second durable "hi" lands, the optimistic row reconciles away.
        await act(async () => {
            emit(MESSAGES_REF, [
                { content: "hi", role: "user", seq: 0 },
                { content: "hi", role: "user", seq: 1 },
            ]);
        });

        const afterSecondAck = JSON.parse(screen.getByTestId("messages").textContent ?? "[]") as Record<string, unknown>[];

        expect(afterSecondAck).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);
    });

    it("retires the optimistic row under a saturated windowed limit, where the durable user-row count stays flat", async () => {
        expect.hasAssertions();

        const { client, emit } = buildClient();
        let latest: UseAgentChatResult | undefined;

        // A bounded window (limit 50) saturated by 25 completed turns — a user row
        // and an assistant row each, seqs 0..49, so 25 durable user rows.
        const seededWindow: Record<string, unknown>[] = [];

        for (let turn = 0; turn < 25; turn += 1) {
            seededWindow.push(
                { content: `q-${String(turn)}`, role: "user", seq: turn * 2 },
                { content: `a-${String(turn)}`, role: "assistant", seq: turn * 2 + 1 },
            );
        }

        render(
            <LunoraProvider client={client}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions({ limit: 50 })}
                />
            </LunoraProvider>,
        );

        await act(async () => {
            emit(MESSAGES_REF, seededWindow);
        });

        // Send a new turn — its optimistic row renders atop the saturated window.
        await act(async () => {
            await latest?.send("new turn");
        });

        const withOptimistic = JSON.parse(screen.getByTestId("messages").textContent ?? "[]") as Record<string, unknown>[];

        expect(withOptimistic.at(-1)).toStrictEqual({ content: "new turn", optimistic: true, role: "user", seq: 50 });

        // The turn lands (user seq 50 + assistant seq 51) and the window slides to
        // keep its last 50 rows, evicting the oldest turn (seqs 0, 1). The durable
        // USER-row count is unchanged (still 25), so the positional reconcile can
        // never see the acknowledging row — only the seq-advance fallback retires it.
        const slidWindow = [...seededWindow.slice(2), { content: "new turn", role: "user", seq: 50 }, { content: "answer", role: "assistant", seq: 51 }];

        await act(async () => {
            emit(MESSAGES_REF, slidWindow);
        });

        const reconciled = JSON.parse(screen.getByTestId("messages").textContent ?? "[]") as Record<string, unknown>[];

        // No ghost: "new turn" appears exactly once, as the durable row, never
        // flagged optimistic — and the merged list is just the 50-row window.
        expect(reconciled.filter((message) => message.content === "new turn")).toStrictEqual([{ content: "new turn", role: "user", seq: 50 }]);
        expect(reconciled).toHaveLength(50);
    });

    it("rolls the optimistic user turn back when the send mutation fails", async () => {
        expect.hasAssertions();

        const { client, mutation } = buildClient();
        let latest: UseAgentChatResult | undefined;

        render(
            <LunoraProvider client={client}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        // The send fails (offline, server error, …). The optimistic row appears
        // synchronously, but must NOT linger as a ghost once the mutation rejects.
        mutation.mockRejectedValueOnce(new Error("send failed"));

        await act(async () => {
            await expect(latest?.send("will fail")).rejects.toThrow("send failed");
        });

        const messages = JSON.parse(screen.getByTestId("messages").textContent ?? "[]") as Record<string, unknown>[];

        expect(messages).toStrictEqual([]);
    });

    it("routes approve / reject through agentResolveApproval with the in-flight instanceId", async () => {
        expect.hasAssertions();

        const { client, emit, mutation } = buildClient();
        let latest: UseAgentChatResult | undefined;

        render(
            <LunoraProvider client={client}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        await act(async () => {
            emit(THREAD_REF, { instanceId: "wf-1", status: "awaiting_input" });
        });

        await act(async () => {
            await latest?.approve("call-1");
        });

        expect(mutation).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: APPROVAL_REF }),
            { decision: "approve", instanceId: "wf-1", threadKey: "t1", toolCallId: "call-1" },
            undefined,
        );

        await act(async () => {
            await latest?.reject("call-2", "not allowed");
        });

        expect(mutation).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: APPROVAL_REF }),
            { decision: "reject", instanceId: "wf-1", note: "not allowed", threadKey: "t1", toolCallId: "call-2" },
            undefined,
        );
    });

    it("cancel terminates the in-flight run via the cancel mutation", async () => {
        expect.hasAssertions();

        const { client, emit, mutation } = buildClient();
        let latest: UseAgentChatResult | undefined;

        render(
            <LunoraProvider client={client}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        await act(async () => {
            emit(THREAD_REF, { instanceId: "wf-1", status: "running" });
        });

        await act(async () => {
            await latest?.cancel();
        });

        expect(mutation).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: CANCEL_REF }), { instanceId: "wf-1", threadKey: "t1" }, undefined);
    });

    it("approve rejects when there is no in-flight run to resolve", async () => {
        expect.hasAssertions();

        const { client } = buildClient();
        let latest: UseAgentChatResult | undefined;

        render(
            <LunoraProvider client={client}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        await expect(latest?.approve("call-1")).rejects.toThrow("no in-flight run");
    });
});
