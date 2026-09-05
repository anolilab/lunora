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

/** A `v.bigint()` search param, as `@lunora/codegen` types it for an http route. */
const feedRef: HttpStreamRef<{ text: string }, { after: bigint }> = { method: "GET", path: "/api/feed" };

/**
 * Hoisted out of the component body on purpose. React Compiler cannot lower a
 * `BigIntLiteral` expression, so an inline `42n` fails the `react-hooks-js/todo`
 * rule — the value under test is the bigint reaching the hook, not where the
 * literal is written. A stable reference is the right shape for options anyway.
 */
const BIGINT_STREAM_ARGS = { searchParams: { after: 42n } };

const BigIntDisplay = (): ReactElement => {
    const { status } = useHttpStream(feedRef, BIGINT_STREAM_ARGS);

    return <span data-testid="status">{status}</span>;
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

    it("keys on wire-typed search params — a bigint must not throw out of render", async () => {
        expect.hasAssertions();

        // A `bigint` search param is first-class end to end: `@lunora/server`'s
        // http router coerces `?after=42` to `BigInt(raw)` for a `v.bigint()`
        // param, codegen types it `bigint`, and `client.httpStream` transports
        // it. Keying the effect on `stableStringify` (which throws on a bigint)
        // rather than `stableWireKey` threw from the render body, so React
        // unwound the whole subtree to the nearest error boundary.
        const { client, openStream } = buildClientWithHttpStream();

        render(
            <LunoraProvider client={client}>
                <BigIntDisplay />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(openStream).not.toThrow();
        });

        await act(async () => {
            openStream().handle.push({ text: "ok" });
            openStream().handle.complete();
        });

        await waitFor(() => {
            expect(screen.getByTestId("status").textContent).toBe("complete");
        });
    });
});
