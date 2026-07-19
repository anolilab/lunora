import type { HttpStreamRef, LunoraClient, StreamHandle, StreamIterable } from "@lunora/client";
import { createStream } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { useHttpStream } from "../src/use-http-stream";

const tokensRef: HttpStreamRef<{ text: string }, { prompt: string }> = { method: "GET", path: "/api/tokens" };

interface MockEntry {
    handle: StreamHandle;
    iterable: StreamIterable<unknown>;
    onCancel: ReturnType<typeof vi.fn>;
}

const buildClientWithHttpStream = (): { client: LunoraClient; opened: MockEntry[]; openStream: () => MockEntry } => {
    const opened: MockEntry[] = [];
    const httpStreamFunction = vi.fn<(route: HttpStreamRef, args: unknown) => StreamIterable<unknown>>((_route: HttpStreamRef, _args: unknown) => {
        const onCancel = vi.fn<() => void>();
        const { handle, iterable } = createStream<unknown>({ onCancel });
        const entry: MockEntry = { handle, iterable, onCancel };

        opened.push(entry);

        return iterable;
    });

    const client = { httpStream: httpStreamFunction } as unknown as LunoraClient;

    return {
        client,
        opened,
        openStream: () => {
            const entry = opened.at(-1);

            if (!entry) {
                throw new Error("client.httpStream was never called");
            }

            return entry;
        },
    };
};

const Display = ({ args = {} }: { args?: "skip" | { searchParams?: { prompt: string } } } = {}): ReactElement => {
    const { chunks, error, status } = useHttpStream(tokensRef, args);

    return (
        <div>
            <span data-testid="status">{status}</span>
            <span data-testid="error">{error?.message ?? ""}</span>
            <span data-testid="chunks">{JSON.stringify(chunks)}</span>
        </div>
    );
};

describe("useHttpStream", () => {
    it("opens the HTTP stream on mount and appends chunks until `complete`", async () => {
        expect.hasAssertions();

        const { client, openStream } = buildClientWithHttpStream();

        render(
            <LunoraProvider client={client}>
                <Display />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("status").textContent).not.toBe("idle");
        });

        await act(async () => {
            openStream().handle.push({ text: "hel" });
        });

        await waitFor(() => {
            expect(screen.getByTestId("chunks").textContent).toBe(JSON.stringify([{ text: "hel" }]));
        });

        await act(async () => {
            openStream().handle.push({ text: "lo" });
            openStream().handle.complete();
        });

        await waitFor(() => {
            expect(screen.getByTestId("status").textContent).toBe("complete");
        });

        expect(screen.getByTestId("chunks").textContent).toBe(JSON.stringify([{ text: "hel" }, { text: "lo" }]));
    });

    it('"skip" leaves the stream un-opened', () => {
        expect.assertions(2);

        const { client, opened } = buildClientWithHttpStream();

        render(
            <LunoraProvider client={client}>
                <Display args="skip" />
            </LunoraProvider>,
        );

        expect(opened).toHaveLength(0);
        expect(screen.getByTestId("status").textContent).toBe("idle");
    });

    it("unmount cancels the in-flight stream (abort reaches the fetch)", async () => {
        expect.hasAssertions();

        const { client, openStream } = buildClientWithHttpStream();

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

    it("an `event: error` frame transitions status to 'error' and surfaces the coded error", async () => {
        expect.hasAssertions();

        const { client, openStream } = buildClientWithHttpStream();

        render(
            <LunoraProvider client={client}>
                <Display />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(openStream).not.toThrow();
        });

        await act(async () => {
            openStream().handle.fail(Object.assign(new Error("not allowed"), { code: "FORBIDDEN" }));
        });

        await waitFor(() => {
            expect(screen.getByTestId("status").textContent).toBe("error");
        });

        expect(screen.getByTestId("error").textContent).toBe("not allowed");
    });
});
