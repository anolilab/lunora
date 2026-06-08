import type { FunctionReference } from "@cirrus/client";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider.js";
import { useMutation } from "../src/use-mutation.js";
import { createMockClient } from "./mock-client.js";

const makeRef = (ref: string): FunctionReference => {
    return { __cirrusRef: ref };
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
            <CirrusProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onCall={(call) => {
                        trigger = call;
                    }}
                />
            </CirrusProvider>,
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
        expect(mock.mutation).toHaveBeenCalledWith(expect.objectContaining({ __cirrusRef: "posts:create" }), { title: "hello" }, undefined);
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
            <CirrusProvider client={mock.asClient}>
                <Probe />
            </CirrusProvider>,
        );

        // fireEvent already wraps the dispatch in act(), so no outer act() is needed.
        fireEvent.click(screen.getByTestId("btn"));

        await waitFor(() => {
            expect(mock.mutation).toHaveBeenCalledWith(expect.objectContaining({ __cirrusRef: "counter:inc" }), {}, { optimistic });
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
            <CirrusProvider client={mock.asClient}>
                <Probe />
            </CirrusProvider>,
        );

        fireEvent.click(screen.getByTestId("btn"));

        await waitFor(() => {
            expect(mock.mutation).toHaveBeenCalledWith(expect.objectContaining({ __cirrusRef: "counter:inc" }), {}, { optimisticUpdate });
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
            <CirrusProvider client={mock.asClient}>
                <Probe />
            </CirrusProvider>,
        );

        fireEvent.click(screen.getByTestId("btn"));

        await waitFor(() => {
            expect(mock.mutation).toHaveBeenCalledWith(expect.objectContaining({ __cirrusRef: "counter:inc" }), {}, { optimisticUpdate: perCall });
        });
    });
});
