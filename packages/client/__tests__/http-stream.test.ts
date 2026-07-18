import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { httpStream } from "../src/http-stream";
import type { HttpStreamRef } from "../src/types";

// --- SSE response fakes ------------------------------------------------------

/** Build a `text/event-stream` Response whose body enqueues `parts` as separate reads, then closes. */
const sseResponse = (parts: string[], init: { status?: number } = {}): Response => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const part of parts) {
                controller.enqueue(encoder.encode(part));
            }

            controller.close();
        },
    });

    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" }, status: init.status ?? 200 });
};

/** A `fetch` double resolving to one SSE response, recording the request it saw. */
const fetchReturning = (
    parts: string[],
    init: { status?: number } = {},
): { calls: { init: RequestInit | undefined; url: string }[]; fetchImpl: typeof fetch } => {
    const calls: { init: RequestInit | undefined; url: string }[] = [];

    const requestUrl = (input: RequestInfo | URL): string => {
        if (typeof input === "string") {
            return input;
        }

        return input instanceof URL ? input.href : input.url;
    };

    const fetchImpl = vi.fn<(input: RequestInfo | URL, requestInit?: RequestInit) => Promise<Response>>(
        async (input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
            calls.push({ init: requestInit, url: requestUrl(input) });

            return sseResponse(parts, init);
        },
    ) as unknown as typeof fetch;

    return { calls, fetchImpl };
};

const tokensRef: HttpStreamRef<{ text: string }, { prompt: string }> = { method: "GET", path: "/api/tokens" };

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
    const out: T[] = [];

    for await (const chunk of iterable) {
        out.push(chunk);
    }

    return out;
};

// --- Tests --------------------------------------------------------------------

describe("httpStream", () => {
    it("yields one typed chunk per `data:` frame and terminates on `event: complete`", async () => {
        expect.assertions(2);

        const { fetchImpl } = fetchReturning(['data: {"text":"hel"}\n\n', 'data: {"text":"lo"}\n\nevent: complete\ndata: {}\n\n']);

        const stream = httpStream(tokensRef, { searchParams: { prompt: "hi" } }, { fetch: fetchImpl });
        const chunks = await collect(stream);

        // The chunk type flows from the reference's phantom — not `any`/`unknown`.
        expectTypeOf(chunks).toEqualTypeOf<{ text: string }[]>();

        expect(chunks).toStrictEqual([{ text: "hel" }, { text: "lo" }]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("builds the URL from baseUrl + path params + searchParams and sends the SSE accept header", async () => {
        expect.assertions(3);

        const roomRef: HttpStreamRef<{ kind: string }, { since?: number }, { roomId: string }> = { method: "GET", path: "/api/rooms/:roomId/events" };
        const { calls, fetchImpl } = fetchReturning(["event: complete\ndata: {}\n\n"]);

        await collect(
            httpStream(roomRef, { params: { roomId: "a/b" }, searchParams: { since: 42 } }, { baseUrl: "https://api.example.com/", fetch: fetchImpl }),
        );

        expect(calls[0]?.url).toBe("https://api.example.com/api/rooms/a%2Fb/events?since=42");
        expect(calls[0]?.init?.method).toBe("GET");
        expect((calls[0]?.init?.headers as Record<string, string>)["accept"]).toBe("text/event-stream");
    });

    it("skips undefined searchParams entries", async () => {
        expect.assertions(1);

        const roomRef: HttpStreamRef<{ kind: string }, { since?: number }> = { method: "GET", path: "/api/events" };
        const { calls, fetchImpl } = fetchReturning(["event: complete\ndata: {}\n\n"]);

        await collect(httpStream(roomRef, { searchParams: { since: undefined } }, { fetch: fetchImpl }));

        expect(calls[0]?.url).toBe("/api/events");
    });

    it("throws synchronously on a missing path param", () => {
        expect.assertions(1);

        const roomRef: HttpStreamRef<unknown, Record<string, never>, { roomId: string }> = { method: "GET", path: "/api/rooms/:roomId/events" };
        const { fetchImpl } = fetchReturning([]);

        expect(() => httpStream(roomRef, {}, { fetch: fetchImpl })).toThrow('missing path param ":roomId"');
    });

    it("parses frames split across reads (including mid-frame byte boundaries)", async () => {
        expect.assertions(1);

        const { fetchImpl } = fetchReturning(['data: {"te', 'xt":"a"}\n', '\ndata: {"text":"b"}\n\neve', "nt: complete\ndata: {}\n\n"]);

        const chunks = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl }));

        expect(chunks).toStrictEqual([{ text: "a" }, { text: "b" }]);
    });

    it("surfaces an `event: error` frame as a coded rejection carrying the server's code", async () => {
        expect.assertions(2);

        const { fetchImpl } = fetchReturning(['data: {"text":"partial"}\n\n', 'event: error\ndata: {"code":"FORBIDDEN","message":"not allowed"}\n\n']);

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch((error_: unknown) => error_ as Error & { code?: string });

        expect((error as Error).message).toBe("not allowed");
        expect((error as Error & { code?: string }).code).toBe("FORBIDDEN");
    });

    it("fails with HTTP_STREAM_STATUS on a non-2xx response", async () => {
        expect.assertions(2);

        const { fetchImpl } = fetchReturning([], { status: 503 });

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch(
            (error_: unknown) => error_ as Error & { code?: string; status?: number },
        );

        expect((error as Error & { code?: string }).code).toBe("HTTP_STREAM_STATUS");
        expect((error as Error & { status?: number }).status).toBe(503);
    });

    it("fails with HTTP_STREAM_INTERRUPTED when the body closes without a terminal frame", async () => {
        expect.assertions(1);

        const { fetchImpl } = fetchReturning(['data: {"text":"a"}\n\n']);

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch((error_: unknown) => error_ as Error & { code?: string });

        expect((error as Error & { code?: string }).code).toBe("HTTP_STREAM_INTERRUPTED");
    });

    it("fails with HTTP_STREAM_BAD_CHUNK on non-JSON chunk data", async () => {
        expect.assertions(1);

        const { fetchImpl } = fetchReturning(["data: not-json\n\n"]);

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch((error_: unknown) => error_ as Error & { code?: string });

        expect((error as Error & { code?: string }).code).toBe("HTTP_STREAM_BAD_CHUNK");
    });

    it("normalises `\\r\\n` line endings", async () => {
        expect.assertions(1);

        const { fetchImpl } = fetchReturning(['data: {"text":"a"}\r\n\r\nevent: complete\r\ndata: {}\r\n\r\n']);

        const chunks = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl }));

        expect(chunks).toStrictEqual([{ text: "a" }]);
    });

    it("cancel() aborts the fetch signal and resolves the iterator", async () => {
        expect.assertions(2);

        let capturedSignal: AbortSignal | undefined;

        // A never-ending body: no terminal frame, the controller stays open.
        const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
            async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                capturedSignal = init?.signal ?? undefined;

                const encoder = new TextEncoder();
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode('data: {"text":"a"}\n\n'));
                    },
                });

                return new Response(body, { status: 200 });
            },
        ) as unknown as typeof fetch;

        const stream = httpStream(tokensRef, {}, { fetch: fetchImpl });
        const iterator = stream[Symbol.asyncIterator]();

        await expect(iterator.next()).resolves.toStrictEqual({ done: false, value: { text: "a" } });

        stream.cancel();

        expect(capturedSignal?.aborted).toBe(true);
    });

    it("an aborted external signal cancels the stream without surfacing an error", async () => {
        expect.assertions(1);

        const ac = new AbortController();

        const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
            async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                // Mirror the real fetch contract: reject with an AbortError when
                // the signal fires before (or while) the request is in flight.
                await new Promise<never>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                    });
                });

                throw new Error("unreachable");
            },
        ) as unknown as typeof fetch;

        const stream = httpStream(tokensRef, {}, { fetch: fetchImpl, signal: ac.signal });

        ac.abort();

        // The iterator terminates cleanly (done) instead of rejecting.
        await expect(collect(stream)).resolves.toStrictEqual([]);
    });

    it("removes the external abort listener on normal completion (no leaked listener, CLIENT-05 regression)", async () => {
        expect.assertions(1);

        const ac = new AbortController();
        const addSpy = vi.spyOn(ac.signal, "addEventListener");
        const removeSpy = vi.spyOn(ac.signal, "removeEventListener");

        const { fetchImpl } = fetchReturning(["event: complete\ndata: {}\n\n"]);

        await collect(httpStream(tokensRef, {}, { fetch: fetchImpl, signal: ac.signal }));

        // `collect()` resolves as soon as the iterator reports `done` — that
        // happens on `handle.complete()`, a separate microtask chain from the
        // stream's own `.catch().finally()` that detaches the listener. Cross a
        // macrotask boundary so every queued microtask (however many `.then`s
        // deep) has run before asserting.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        // The listener attached to the (potentially long-lived) external signal
        // must be detached once the stream finishes normally — otherwise it stays
        // registered, and its closure, for the signal's entire remaining lifetime.
        const [, handler] = addSpy.mock.calls[0] ?? [];

        expect(removeSpy).toHaveBeenCalledWith("abort", handler);
    });

    it("cancels a non-OK response's body instead of leaving it unread (CLIENT-05 regression)", async () => {
        expect.assertions(1);

        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            },
        });
        const cancelSpy = vi.spyOn(body, "cancel");

        const fetchImpl = vi.fn<() => Promise<Response>>(async (): Promise<Response> => {
            return new Response(body, { status: 503 });
        }) as unknown as typeof fetch;

        await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch(() => undefined);

        expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it("rejects transport failures with HTTP_STREAM_TRANSPORT", async () => {
        expect.assertions(1);

        const fetchImpl = vi.fn<() => Promise<Response>>(async (): Promise<Response> => {
            throw new Error("network down");
        }) as unknown as typeof fetch;

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch((error_: unknown) => error_ as Error & { code?: string });

        expect((error as Error & { code?: string }).code).toBe("HTTP_STREAM_TRANSPORT");
    });
});
