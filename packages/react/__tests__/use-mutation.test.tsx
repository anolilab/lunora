import type { FunctionReference } from "@lunora/client";
import { LunoraClient } from "@lunora/client";
import { onlineManager, QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, Ref } from "react";
import { createRef, useImperativeHandle } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import type { MutationHook } from "../src/use-mutation";
import { useMutation } from "../src/use-mutation";
import useQuery from "../src/use-query";
import { createMockClient } from "./mock-client";
import type { MockSocket } from "./mock-socket";
import { createMockWebSocket } from "./mock-socket";

const makeRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

/** A reference to a function with a `v.sensitive` argument, as codegen emits it. */
const makeSensitiveRef = (ref: string): FunctionReference => ({ __lunoraRef: ref, sensitive: true }) as FunctionReference;

interface WriterHandle {
    send: () => Promise<unknown>;
}

/** Mounts `useMutation(reference)` and exposes one write of `apiKey` through its ref, so a test can start and await it. */
const MutationWriter = ({
    apiKey,
    options,
    reference,
    ref,
}: {
    apiKey: string;
    options?: { onlineOnly?: boolean };
    ref: Ref<WriterHandle>;
    reference: FunctionReference;
}): ReactElement => {
    const { mutate } = useMutation(reference);

    useImperativeHandle(ref, () => {
        return { send: () => mutate({ apiKey }, options) };
    }, [apiKey, mutate, options]);

    return <div />;
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

    it("holds a write made offline before the client ever connected, then sends it once online", async () => {
        expect.assertions(3);

        const sockets: MockSocket[] = [];
        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ result: "sent" }));
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket(sockets) });
        let outcome = "pending";

        const Writer = (): ReactElement => {
            const { mutate } = useMutation(makeRef("posts:create"));

            return (
                <button
                    data-testid="write"
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test-only click handler; stable identity is irrelevant for a single fireEvent.
                    onClick={() => {
                        mutate({ title: "cold" })
                            .then((value) => {
                                outcome = `resolved:${String(value)}`;

                                return undefined;
                            })
                            .catch((error: unknown) => {
                                outcome = `rejected:${String(error)}`;
                            });
                    }}
                    type="button"
                >
                    write
                </button>
            );
        };

        render(
            <LunoraProvider client={client}>
                <Writer />
            </LunoraProvider>,
        );

        try {
            await act(async () => {
                onlineManager.setOnline(false);
                await Promise.resolve();
            });

            // No socket has ever opened, so the client cannot queue this write.
            fireEvent.click(screen.getByTestId("write"));

            await act(async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 20);
                });
            });

            expect(fetchMock).toHaveBeenCalledTimes(0);

            await act(async () => {
                onlineManager.setOnline(true);
                await new Promise((resolve) => {
                    setTimeout(resolve, 20);
                });
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(outcome).toBe("resolved:sent");
        } finally {
            onlineManager.setOnline(true);
            client.close();
        }
    });

    describe("online-only writes", () => {
        interface ColdWriter {
            client: LunoraClient;
            fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
            send: () => Promise<unknown>;
        }

        /**
         * Renders a writer over a client that has never connected and whose network
         * is down: every `fetch` attempt rejects, and no WebSocket ever opens. `send`
         * starts one call and returns its promise, so a test awaits the settled call.
         */
        const renderColdWriter = (reference: FunctionReference, options?: { onlineOnly?: boolean }): ColdWriter => {
            const fetchMock = vi.fn<typeof fetch>(async () => {
                throw new TypeError("Failed to fetch");
            });
            const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket([]) });
            const handle = createRef<WriterHandle>();

            render(
                <LunoraProvider client={client}>
                    <MutationWriter apiKey="sk_live_secret" options={options} ref={handle} reference={reference} />
                </LunoraProvider>,
            );

            return {
                client,
                fetchMock,
                send: () => {
                    let attempt: Promise<unknown> = Promise.resolve();

                    act(() => {
                        attempt = handle.current?.send() ?? Promise.resolve();
                    });

                    return attempt;
                },
            };
        };

        it("rejects a sensitive write made before the client ever connected, and never sends it once online", async () => {
            expect.assertions(2);

            const { client, fetchMock, send } = renderColdWriter(makeSensitiveRef("accounts:linkApiKey"));

            try {
                await act(async () => {
                    onlineManager.setOnline(false);
                    await Promise.resolve();
                });

                await expect(send()).rejects.toMatchObject({ code: "OFFLINE_NOT_QUEUED" });

                await act(async () => {
                    onlineManager.setOnline(true);
                });

                // The one attempt made while offline; the write is not replayed once online.
                expect(fetchMock).toHaveBeenCalledTimes(1);
            } finally {
                onlineManager.setOnline(true);
                client.close();
            }
        });

        it("drops an online-only call's arguments from the mutation cache, where an ordinary call keeps them", async () => {
            expect.hasAssertions();

            /** Run one write through the hook, unmount it, and hand back the cache that held the call. */
            const writeAndUnmount = async (reference: FunctionReference, options?: { onlineOnly?: boolean }): Promise<QueryClient> => {
                const queryClient = new QueryClient();
                const mock = createMockClient();

                mock.mutation.mockResolvedValue({ ok: true });

                const handle = createRef<WriterHandle>();
                const view = render(
                    <LunoraProvider client={mock.asClient} queryClient={queryClient}>
                        <MutationWriter apiKey="sk-test-1234" options={options} ref={handle} reference={reference} />
                    </LunoraProvider>,
                );

                await act(async () => {
                    await handle.current?.send();
                });
                view.unmount();

                return queryClient;
            };

            const ordinary = await writeAndUnmount(makeRef("accounts:note"));
            const sensitive = await writeAndUnmount(makeSensitiveRef("accounts:linkApiKey"));
            const perCall = await writeAndUnmount(makeRef("accounts:note"), { onlineOnly: true });

            // Default garbage-collection time: the settled call, with its arguments, stays cached.
            expect(ordinary.getMutationCache().getAll()).toHaveLength(1);

            await waitFor(() => {
                expect(sensitive.getMutationCache().getAll()).toHaveLength(0);
            });

            // A per-call online-only write on an ordinary reference leaves the cache once it settles.
            expect(perCall.getMutationCache().getAll()).toHaveLength(0);
        });

        it("rejects an explicit online-only write on a normal reference instead of holding it until online", async () => {
            expect.assertions(2);

            const { client, fetchMock, send } = renderColdWriter(makeRef("posts:create"), { onlineOnly: true });

            try {
                await act(async () => {
                    onlineManager.setOnline(false);
                    await Promise.resolve();
                });

                await expect(send()).rejects.toMatchObject({ code: "OFFLINE_NOT_QUEUED" });

                await act(async () => {
                    onlineManager.setOnline(true);
                });

                expect(fetchMock).toHaveBeenCalledTimes(1);
            } finally {
                onlineManager.setOnline(true);
                client.close();
            }
        });

        it("types onlineOnly per reference: `false` is refused on a sensitive one", () => {
            // Type-level only: the checks compile in the function below, which only
            // has to be defined for `tsc` to read it.
            expect.assertions(1);

            type SensitiveReference = FunctionReference & { readonly sensitive: true };
            const typeChecks = (plainMutate: MutationHook<FunctionReference>["mutate"], sensitiveMutate: MutationHook<SensitiveReference>["mutate"]): void => {
                plainMutate({}, { onlineOnly: false }).catch(() => undefined);
                plainMutate({}, { onlineOnly: true }).catch(() => undefined);
                sensitiveMutate({}, { onlineOnly: true }).catch(() => undefined);
                // @ts-expect-error -- a sensitive write is always online-only; `onlineOnly: false` is a type error
                sensitiveMutate({}, { onlineOnly: false }).catch(() => undefined);
            };

            expect(typeChecks).toBeTypeOf("function");
        });
    });
});
