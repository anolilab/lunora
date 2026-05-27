import type { FunctionReference } from "@cirrus/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";

import { CirrusProvider } from "../src/CirrusProvider.js";
import { useMutation } from "../src/useMutation.js";
import { createMockClient } from "./mockClient.js";

const fn = (ref: string): FunctionReference => ({ __cirrusRef: ref });

interface HarnessProps {
    onCall: (call: () => Promise<unknown>, pending: () => boolean) => void;
}

const Harness = ({ onCall }: HarnessProps): ReactElement => {
    const { mutate, pending } = useMutation(fn("posts:create"));

    onCall(
        () => mutate({ title: "hello" } as Record<string, unknown>),
        () => pending,
    );

    return <div data-testid="pending">{pending ? "yes" : "no"}</div>;
};

describe("useMutation", () => {
    test("invokes client.mutation and flips `pending` while in-flight", async () => {
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
        expect(mock.mutation).toHaveBeenCalledWith(
            expect.objectContaining({ __cirrusRef: "posts:create" }),
            { title: "hello" },
            undefined,
        );
        expect(screen.getByTestId("pending").textContent).toBe("no");
    });

    test("forwards optimistic callback to the client", async () => {
        const mock = createMockClient();

        mock.mutation.mockResolvedValue({ ok: true });

        const optimistic = vi.fn(() => 5);
        const Probe = (): ReactElement => {
            const { mutate } = useMutation(fn("counter:inc"));

            return (
                <button
                    data-testid="btn"
                    onClick={() => {
                        void mutate({} as Record<string, unknown>, { optimistic });
                    }}
                />
            );
        };

        render(
            <CirrusProvider client={mock.asClient}>
                <Probe />
            </CirrusProvider>,
        );

        await act(async () => {
            screen.getByTestId("btn").click();
        });

        expect(mock.mutation).toHaveBeenCalledWith(
            expect.objectContaining({ __cirrusRef: "counter:inc" }),
            {},
            { optimistic },
        );
    });
});
