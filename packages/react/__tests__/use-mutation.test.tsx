import type { FunctionReference } from "@cirrus/client";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider.js";
import { useMutation } from "../src/use-mutation.js";
import { createMockClient } from "./mock-client.js";

const function_ = (ref: string): FunctionReference => {
    return { __cirrusRef: ref };
};

interface HarnessProps {
    onCall: (call: () => Promise<unknown>, pending: () => boolean) => void;
}

const Harness = ({ onCall }: HarnessProps): ReactElement => {
    const { mutate, pending } = useMutation(function_("posts:create"));

    onCall(
        () => mutate({ title: "hello" }),
        () => pending,
    );

    return <div data-testid="pending">{pending ? "yes" : "no"}</div>;
};

describe("useMutation", () => {
    it("invokes client.mutation and flips `pending` while in-flight", async () => {
        expect.hasAssertions();

        let resolve: (value: unknown) => void = () => undefined;
        const promise = new Promise((r) => {
            resolve = r;
        });
        const mock = createMockClient();

        mock.mutation.mockReturnValue(promise);

        let trigger: () => Promise<unknown> = async () => undefined;

        render(
            <CirrusProvider client={mock.asClient}>
                <Harness
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
            });
        });

        await waitFor(() => {
            expect(screen.getByTestId("pending").textContent).toBe("yes");
        });

        await act(async () => {
            resolve({ id: "p1" });
            await inFlight;
        });

        expect(resolved).toEqual({ id: "p1" });
        expect(mock.mutation).toHaveBeenCalledWith(expect.objectContaining({ __cirrusRef: "posts:create" }), { title: "hello" }, undefined);
        expect(screen.getByTestId("pending").textContent).toBe("no");
    });

    it("forwards optimistic callback to the client", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.mutation.mockResolvedValue({ ok: true });

        const optimistic = vi.fn<() => number>(() => 5);
        const Probe = (): ReactElement => {
            const { mutate } = useMutation(function_("counter:inc"));

            return (
                <button
                    aria-label="increment"
                    data-testid="btn"
                    onClick={() => {
                        void mutate({}, { optimistic });
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
});
