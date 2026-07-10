import type { FunctionReference, LunoraClient, StreamHandle, StreamIterable } from "@lunora/client";
import { createStream } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { useStream } from "../src/use-stream";

const makeRef = (reference: string): FunctionReference<"stream"> => {
    return { __lunoraRef: reference };
};

interface MockEntry {
    handle: StreamHandle;
    iterable: StreamIterable<unknown>;
    onCancel: ReturnType<typeof vi.fn>;
}

const buildClientWithStream = (): { client: LunoraClient; opened: MockEntry[]; openStream: () => MockEntry } => {
    const opened: MockEntry[] = [];
    const streamFunction = vi.fn<(function__: FunctionReference, args: unknown) => StreamIterable<unknown>>((_function: FunctionReference, _args: unknown) => {
        const onCancel = vi.fn<() => void>();
        const { handle, iterable } = createStream<unknown>({ onCancel });
        const entry: MockEntry = { handle, iterable, onCancel };

        opened.push(entry);

        return iterable;
    });

    const client = { stream: streamFunction } as unknown as LunoraClient;

    return {
        client,
        opened,
        openStream: () => {
            const entry = opened.at(-1);

            if (!entry) {
                throw new Error("client.stream was never called");
            }

            return entry;
        },
    };
};

const Display = ({ args = {} }: { args?: Record<string, unknown> | "skip" } = {}): ReactElement => {
    const { chunks, error, status } = useStream(makeRef("metrics:tick"), args);

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
            <LunoraProvider client={client}>
                <Display />
            </LunoraProvider>,
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
            <LunoraProvider client={client}>
                <Display args="skip" />
            </LunoraProvider>,
        );

        expect(opened).toHaveLength(0);
        expect(screen.getByTestId("status").textContent).toBe("idle");
    });

    it('transitioning args to "skip" mid-stream resets to idle with empty chunks', async () => {
        expect.hasAssertions();

        const { client, openStream } = buildClientWithStream();

        const view = render(
            <LunoraProvider client={client}>
                <Display />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("status").textContent).toBe("streaming");
        });

        await act(async () => {
            openStream().handle.push({ tick: 1 });
        });

        await waitFor(() => {
            expect(screen.getByTestId("chunks").textContent).toBe(JSON.stringify([{ tick: 1 }]));
        });

        // Flip to "skip" mid-stream: the iterator is cancelled by the previous
        // effect's cleanup, so no `complete`/`error` will ever land. The hook
        // must not stay stuck reporting "streaming" over the stale chunk — it
        // resets to idle with empty chunks (mirroring useSubscription's skip).
        view.rerender(
            <LunoraProvider client={client}>
                <Display args="skip" />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("status").textContent).toBe("idle");
        });

        expect(screen.getByTestId("chunks").textContent).toBe(JSON.stringify([]));
    });

    it("unmount cancels the in-flight stream", async () => {
        expect.hasAssertions();

        const { client, openStream } = buildClientWithStream();

        const view = render(
            <LunoraProvider client={client}>
                <Display />
            </LunoraProvider>,
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
            <LunoraProvider client={client}>
                <Display />
            </LunoraProvider>,
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
