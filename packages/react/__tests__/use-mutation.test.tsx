import type { FunctionReference } from "@lunora/client";
import { LunoraClient } from "@lunora/client";
import { onlineManager } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { useMutation } from "../src/use-mutation";
import useQuery from "../src/use-query";
import { createMockClient } from "./mock-client";
import type { MockSocket } from "./mock-socket";
import { createMockWebSocket } from "./mock-socket";

const makeRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

interface HarnessProps {
    onCall: (call: () => Promise<unknown>, pending: () => boolean) => void;
}

const Harness = ({ onCall }: HarnessProps): ReactElement => {
    const { mutate, pending } = useMutation(makeRef("posts:create"));

    onCall(
        () => mutate({ title: "hello" }),
        () => pending,
    );

    return <div data-testid="pending">{pending ? "yes" : "no"}</div>;
};

describe("useMutation", () => {
    it("invokes client.mutation and flips `pending` while in-flight", async () => {
        expect.hasAssertions();

        let resolvePromise: (value: unknown) => void = (_value) => undefined;
        const promise = new Promise((resolve) => {
            resolvePromise = resolve;
        });
        const mock = createMockClient();

        mock.mutation.mockReturnValue(promise);

        let trigger: () => Promise<unknown> = async () => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onCall={(call) => {
                        trigger = call;
                    }}
                />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("pending").textContent).toBe("no");

        let resolved: unknown;
        let inFlight: Promise<unknown> | undefined;

        act(() => {
            inFlight = trigger().then((value) => {
                resolved = value;

                return value;
            });
        });

        await waitFor(() => {
            expect(screen.getByTestId("pending").textContent).toBe("yes");
        });

        await act(async () => {
            resolvePromise({ id: "p1" });
            await inFlight;
        });

        expect(resolved).toEqual({ id: "p1" });
        expect(mock.mutation).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: "posts:create" }), { title: "hello" }, undefined);
        expect(screen.getByTestId("pending").textContent).toBe("no");
    });

    it("forwards optimistic callback to the client", async () => {
        // hasAssertions (not assertions(1)): the mutation now fires through
        // TanStack's lifecycle a microtask after mutate(), so the waitFor below
        // retries once — the forwarded-args assertion itself is unchanged.
        expect.hasAssertions();

        const mock = createMockClient();

        mock.mutation.mockResolvedValue({ ok: true });

        const optimistic = vi.fn<() => number>(() => 5);
        const Probe = (): ReactElement => {
            const { mutate } = useMutation(makeRef("counter:inc"));

            return (
                <button
                    aria-label="increment"
                    data-testid="btn"
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test-only click handler; stable identity is irrelevant for a single fireEvent.
                    onClick={() => {
                        mutate({}, { optimistic }).catch(() => {});
                    }}
                    type="button"
                />
            );
        };

        render(
            <LunoraProvider client={mock.asClient}>
                <Probe />
            </LunoraProvider>,
        );

        // fireEvent already wraps the dispatch in act(), so no outer act() is needed.
        fireEvent.click(screen.getByTestId("btn"));

        await waitFor(() => {
            expect(mock.mutation).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: "counter:inc" }), {}, { optimistic });
        });
    });

    it("withOptimisticUpdate forwards the bound callback as optimisticUpdate", async () => {
        // hasAssertions (not assertions(1)): the mutation now fires through
        // TanStack's lifecycle a microtask after mutate(), so the waitFor below
        // retries once — the forwarded-args assertion itself is unchanged.
        expect.hasAssertions();

        const mock = createMockClient();

        mock.mutation.mockResolvedValue({ ok: true });

        const optimisticUpdate = vi.fn<() => void>();
        const Probe = (): ReactElement => {
            const bound = useMutation(makeRef("counter:inc")).withOptimisticUpdate(optimisticUpdate);

            return (
                <button
                    aria-label="increment"
                    data-testid="btn"
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test-only click handler; stable identity is irrelevant for a single fireEvent.
                    onClick={() => {
                        bound.mutate({}).catch(() => {});
                    }}
                    type="button"
                />
            );
        };

        render(
            <LunoraProvider client={mock.asClient}>
                <Probe />
            </LunoraProvider>,
        );

        fireEvent.click(screen.getByTestId("btn"));

        await waitFor(() => {
            expect(mock.mutation).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: "counter:inc" }), {}, { optimisticUpdate });
        });
    });

    it("a per-call optimisticUpdate overrides the bound one", async () => {
        // hasAssertions (not assertions(1)): the mutation now fires through
        // TanStack's lifecycle a microtask after mutate(), so the waitFor below
        // retries once — the forwarded-args assertion itself is unchanged.
        expect.hasAssertions();

        const mock = createMockClient();

        mock.mutation.mockResolvedValue({ ok: true });

        const bound = vi.fn<() => void>();
        const perCall = vi.fn<() => void>();
        const Probe = (): ReactElement => {
            const hook = useMutation(makeRef("counter:inc")).withOptimisticUpdate(bound);

            return (
                <button
                    aria-label="increment"
                    data-testid="btn"
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test-only click handler; stable identity is irrelevant for a single fireEvent.
                    onClick={() => {
                        hook.mutate({}, { optimisticUpdate: perCall }).catch(() => {});
                    }}
                    type="button"
                />
            );
        };

        render(
            <LunoraProvider client={mock.asClient}>
                <Probe />
            </LunoraProvider>,
        );

        fireEvent.click(screen.getByTestId("btn"));

        await waitFor(() => {
            expect(mock.mutation).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: "counter:inc" }), {}, { optimisticUpdate: perCall });
        });
    });

    it("reaches client.mutation while offline, so the write queues and its optimistic update paints", async () => {
        expect.assertions(3);

        const sockets: MockSocket[] = [];
        const counter = makeRef("counter:get");
        const client = new LunoraClient({
            fetch: vi.fn<typeof fetch>(async () => {
                throw new TypeError("Failed to fetch");
            }),
            url: "https://app.example",
            WebSocket: createMockWebSocket(sockets),
        });
        const spy = vi.spyOn(client, "mutation");

        const Counter = (): ReactElement => {
            const value = useQuery(counter, {}) as { count: number } | undefined;
            const { mutate } = useMutation(makeRef("counter:inc"));

            return (
                <button
                    data-testid="count"
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test-only click handler; stable identity is irrelevant for a single fireEvent.
                    onClick={() => {
                        mutate(
                            {},
                            {
                                optimisticUpdate: (store) => {
                                    store.setQuery(counter, {}, { count: 1 });
                                },
                            },
                        ).catch(() => undefined);
                    }}
                    type="button"
                >
                    {value === undefined ? "-" : String(value.count)}
                </button>
            );
        };

        render(
            <LunoraProvider client={client}>
                <Counter />
            </LunoraProvider>,
        );

        // Connected once, so an offline write is eligible for the queue.
        await act(async () => {
            sockets.at(-1)?.open();
            await Promise.resolve();
        });

        const subscribe = sockets.at(-1)?.sent.find((frame) => frame.type === "subscribe");

        await act(async () => {
            sockets.at(-1)?.receive({ cursor: 1, data: { count: 0 }, id: subscribe?.id, type: "data" });
            await Promise.resolve();
        });

        try {
            await act(async () => {
                sockets.at(-1)?.drop();
                onlineManager.setOnline(false);
                await Promise.resolve();
            });

            fireEvent.click(screen.getByTestId("count"));

            await act(async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 20);
                });
            });

            expect(spy).toHaveBeenCalledTimes(1);
            expect(client.pendingCount()).toBe(1);
            expect(screen.getByTestId("count").textContent).toBe("1");
        } finally {
            onlineManager.setOnline(true);
            client.close();
        }
    });
});
