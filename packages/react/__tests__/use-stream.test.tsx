import type { CirrusClient, FunctionReference, StreamHandle, StreamIterable } from "@cirrus/client";
import { createStream } from "@cirrus/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider.js";
import { useStream } from "../src/use-stream.js";

const fn = (reference: string): FunctionReference => { return { __cirrusRef: reference }; };

interface MockEntry {
    handle: StreamHandle;
    iterable: StreamIterable<unknown>;
    onCancel: ReturnType<typeof vi.fn>;
}

const buildClientWithStream = (): { client: CirrusClient; opened: MockEntry[]; openStream: () => MockEntry } => {
    const opened: MockEntry[] = [];
    const streamFn = vi.fn<(fn: FunctionReference, args: unknown) => StreamIterable<unknown>>((_fn: FunctionReference, _args: unknown) => {
        const onCancel = vi.fn<() => void>();
        const { handle, iterable } = createStream<unknown>({ onCancel });
        const entry: MockEntry = { handle, iterable, onCancel };

        opened.push(entry);

        return iterable;
    });

    const client = { stream: streamFn } as unknown as CirrusClient;

    return {
        client,
        openStream: () => {
            const entry = opened.at(-1);

            if (!entry) {
                throw new Error("client.stream was never called");
            }

            return entry;
        },
        opened,
    };
};

const Display = ({ args = {} }: { args?: Record<string, unknown> | "skip" } = {}): ReactElement => {
    const { chunks, error, status } = useStream(fn("metrics:tick"), args);

    return (
        <div>
            <span data-testid="status">{status}</span>
            <span data-testid="error">{error?.message ?? ""}</span>
            <span data-testid="chunks">{JSON.stringify(chunks)}</span>
        </div>
    );
};

describe("useStream", () => {
    it("opens a stream on mount and appends chunks as they arrive", async () => {
        expect.hasAssertions();

        const { client, openStream } = buildClientWithStream();

        render(
            <CirrusProvider client={client}>
                <Display />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("status").textContent).not.toBe("idle");
        });

        await act(async () => {
            openStream().handle.push({ tick: 1 });
        });

        await waitFor(() => {
            expect(screen.getByTestId("chunks").textContent).toBe(JSON.stringify([{ tick: 1 }]));
        });

        await act(async () => {
            openStream().handle.push({ tick: 2 });
        });

        await waitFor(() => {
            expect(screen.getByTestId("chunks").textContent).toBe(JSON.stringify([{ tick: 1 }, { tick: 2 }]));
        });

        await act(async () => {
            openStream().handle.complete();
        });

        await waitFor(() => {
            expect(screen.getByTestId("status").textContent).toBe("complete");
        });
    });

    it('"skip" leaves the stream un-opened', () => {
        expect.assertions(2);

        const { client, opened } = buildClientWithStream();

        render(
            <CirrusProvider client={client}>
                <Display args="skip" />
            </CirrusProvider>,
        );

        expect(opened).toHaveLength(0);
        expect(screen.getByTestId("status").textContent).toBe("idle");
    });

    it("unmount cancels the in-flight stream", async () => {
        expect.hasAssertions();

        const { client, openStream } = buildClientWithStream();

        const view = render(
            <CirrusProvider client={client}>
                <Display />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(openStream).not.toThrow();
        });

        view.unmount();

        expect(openStream().onCancel).toHaveBeenCalledWith();
    });

    it("server error transitions status to 'error' and surfaces the error", async () => {
        expect.hasAssertions();

        const { client, openStream } = buildClientWithStream();

        render(
            <CirrusProvider client={client}>
                <Display />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(openStream).not.toThrow();
        });

        await act(async () => {
            openStream().handle.fail(new Error("forbidden"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("status").textContent).toBe("error");
        });

        expect(screen.getByTestId("error").textContent).toBe("forbidden");
    });
});
