import type { FunctionReference, LunoraClient } from "@lunora/client";
import { onlineManager, QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { useAction } from "../src/use-action";
import { createMockClient } from "./mock-client";

const runRef: FunctionReference = { __lunoraRef: "commands:run" };

/** A promise plus its resolver, so a test can hold a call open and settle it deliberately. */
const deferred = (): { promise: Promise<unknown>; resolve: (value: unknown) => void } => {
    let settle: (value: unknown) => void = (_value) => undefined;
    const promise = new Promise<unknown>((resolve) => {
        settle = resolve;
    });

    return { promise, resolve: settle };
};

/** Mount `useAction` under a provider bound to `client`, optionally with a caller-supplied QueryClient. */
const renderAction = (client: LunoraClient, queryClient?: QueryClient) => {
    const wrapper = ({ children }: { children: ReactNode }): ReactElement => (
        <LunoraProvider client={client} queryClient={queryClient}>
            {children}
        </LunoraProvider>
    );

    return renderHook(() => useAction(runRef), { wrapper });
};

describe("useAction", () => {
    afterEach(() => {
        // `onlineManager` is a module singleton; the offline test must not leak
        // its state into anything that runs after it.
        onlineManager.setOnline(true);
    });

    it("still runs the action while the browser is offline", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.action.mockRejectedValue(new Error("Failed to fetch"));

        const { result } = renderAction(mock.asClient);

        onlineManager.setOnline(false);

        // TanStack's default `networkMode: "online"` pauses the retryer AFTER
        // the call is already marked pending, so offline the promise would never
        // settle and the action would silently fire on reconnect instead. An
        // action has no offline queue and no idempotency key, so it must fail
        // fast and let the caller decide.
        await act(async () => {
            await expect(result.current.call({ command: "lunora" })).rejects.toThrow("Failed to fetch");
        });

        expect(mock.action).toHaveBeenCalledTimes(1);
        expect(result.current.pending).toBe(false);
    });

    it("never retries, even under a QueryClient whose mutations default to retrying", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.action.mockRejectedValue(new Error("bad gateway"));

        // The common app recipe. A mutation may safely inherit it — it carries a
        // `mutationId` the server dedupes against. `client.action` sends no such
        // key, so an inherited retry re-runs a charge that already succeeded.
        const { result } = renderAction(mock.asClient, new QueryClient({ defaultOptions: { mutations: { retry: 2 } } }));

        await act(async () => {
            await expect(result.current.call({ command: "lunora" })).rejects.toThrow("bad gateway");
        });

        expect(mock.action).toHaveBeenCalledTimes(1);
    });

    it("invokes client.action and flips `pending` while in-flight", async () => {
        expect.hasAssertions();

        const first = deferred();
        const mock = createMockClient();

        mock.action.mockReturnValue(first.promise);

        const { result } = renderAction(mock.asClient);

        expect(result.current.pending).toBe(false);

        let resolved: unknown;
        let inFlight: Promise<unknown> | undefined;

        act(() => {
            inFlight = result.current.call({ command: "lunora" }).then((value) => {
                resolved = value;

                return value;
            });
        });

        await waitFor(() => {
            expect(result.current.pending).toBe(true);
        });

        await act(async () => {
            first.resolve({ code: 0 });
            await inFlight;
        });

        expect(resolved).toEqual({ code: 0 });
        expect(mock.action).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: "commands:run" }), { command: "lunora" }, undefined);
        expect(result.current.pending).toBe(false);
        expect(result.current.data).toEqual({ code: 0 });
    });

    it("forwards a per-call shardKey to the client", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.action.mockResolvedValue({ code: 0 });

        const { result } = renderAction(mock.asClient);

        await act(async () => {
            await result.current.call({ command: "lunora" }, { shardKey: "project-1" });
        });

        expect(mock.action).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: "commands:run" }), { command: "lunora" }, { shardKey: "project-1" });
    });

    it("rejects and surfaces the error rather than swallowing it", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.action.mockRejectedValue(new Error("command refused"));

        const { result } = renderAction(mock.asClient);

        // The awaitable must reject — a caller that awaits `call()` has to be able
        // to branch on failure, which is why this maps to `mutateAsync` rather
        // than TanStack's fire-and-forget `mutate`.
        await act(async () => {
            await expect(result.current.call({ command: "lunora" })).rejects.toThrow("command refused");
        });

        await waitFor(() => {
            expect(result.current.error?.message).toBe("command refused");
        });

        // And `pending` clears on the failure path, not just the success path.
        expect(result.current.pending).toBe(false);
    });

    it("normalizes a thrown non-Error so `error.message` is always readable", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.action.mockRejectedValue("refused");

        const { result } = renderAction(mock.asClient);

        await act(async () => {
            await expect(result.current.call({ command: "lunora" })).rejects.toThrow("refused");
        });

        await waitFor(() => {
            expect(result.current.error).toBeInstanceOf(Error);
        });

        expect(result.current.error?.message).toBe("refused");
    });

    it("keeps the previous `data` when a later call fails", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.action.mockResolvedValueOnce({ code: 0 }).mockRejectedValueOnce(new Error("command refused"));

        const { result } = renderAction(mock.asClient);

        await act(async () => {
            await result.current.call({ command: "lunora" });
        });

        expect(result.current.data).toEqual({ code: 0 });

        await act(async () => {
            await expect(result.current.call({ command: "lunora" })).rejects.toThrow("command refused");
        });

        // The documented contract, shared with every other adapter: a failure
        // sets `error` and leaves the last successful `data` alone, so a
        // transient error does not blank the view.
        await waitFor(() => {
            expect(result.current.error?.message).toBe("command refused");
        });

        expect(result.current.data).toEqual({ code: 0 });
    });

    it("clears `data` and `error` on reset", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.action.mockResolvedValue({ code: 0 });

        const { result } = renderAction(mock.asClient);

        await act(async () => {
            await result.current.call({ command: "lunora" });
        });

        expect(result.current.data).toEqual({ code: 0 });

        act(() => {
            result.current.reset();
        });

        expect(result.current.data).toBeUndefined();
        expect(result.current.error).toBeUndefined();
    });

    it("keeps `pending` true until the last of several overlapping calls settles", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const calls = [deferred(), deferred()];

        // `mockReturnValueOnce` twice rather than a `mockImplementation` callback:
        // the mock is typed `vi.fn()` (void-returning), so handing it a
        // promise-returning implementation trips `no-misused-promises`.
        mock.action.mockReturnValueOnce(calls[0]?.promise).mockReturnValueOnce(calls[1]?.promise);

        const { result } = renderAction(mock.asClient);

        let both: Promise<unknown> | undefined;

        act(() => {
            both = Promise.all([result.current.call({ command: "a" }), result.current.call({ command: "b" })]);
        });

        await waitFor(() => {
            expect(mock.action).toHaveBeenCalledTimes(2);
        });

        // Settling only the first must NOT clear `pending` — this is the
        // ref-counting, and getting it wrong makes a spinner vanish while a
        // second call is still running.
        await act(async () => {
            calls[0]?.resolve({ code: 0 });
        });

        expect(result.current.pending).toBe(true);

        await act(async () => {
            calls[1]?.resolve({ code: 0 });
            await both;
        });

        await waitFor(() => {
            expect(result.current.pending).toBe(false);
        });
    });
});
