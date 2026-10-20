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

/**
 * A `text/event-stream` Response shaped like the one React Native's `fetch`
 * resolves with: `whatwg-fetch` (which `react-native` polyfills `fetch` from)
 * defines no `body` on `Response`, so `text()` is the only read.
 */
const bodylessResponse = (parts: string[], init: { status?: number } = {}): Response => {
    const response = new Response(parts.join(""), { headers: { "content-type": "text/event-stream; charset=utf-8" }, status: init.status ?? 200 });

    // `body` sits on `Response.prototype`; an own property shadows it without
    // disturbing the internal stream `text()` still reads.
    Object.defineProperty(response, "body", { value: undefined });

    return response;
};

/** Normalise a `fetch` input to its URL string. */
const requestUrl = (input: RequestInfo | URL): string => {
    if (typeof input === "string") {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
};

/** A `fetch` double resolving to one SSE response, recording the request it saw. */
const fetchReturning = (
    parts: string[],
    init: { status?: number } = {},
): { calls: { init: RequestInit | undefined; url: string }[]; fetchImpl: typeof fetch } => {
    const calls: { init: RequestInit | undefined; url: string }[] = [];

    const fetchImpl = vi.fn<(input: RequestInfo | URL, requestInit?: RequestInit) => Promise<Response>>(
        async (input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
            calls.push({ init: requestInit, url: requestUrl(input) });

            return sseResponse(parts, init);
        },
    ) as unknown as typeof fetch;

    return { calls, fetchImpl };
};

/**
 * A `fetch` double resolving one body-less (React Native-shaped) SSE response,
 * recording the request it saw.
 */
const fetchReturningBodyless = (
    parts: string[],
    init: { status?: number } = {},
): { calls: { init: RequestInit | undefined; url: string }[]; fetchImpl: typeof fetch } => {
    const calls: { init: RequestInit | undefined; url: string }[] = [];

    const fetchImpl = vi.fn<(input: RequestInfo | URL, requestInit?: RequestInit) => Promise<Response>>(
        async (input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
            calls.push({ init: requestInit, url: requestUrl(input) });

            return bodylessResponse(parts, init);
        },
    ) as unknown as typeof fetch;

    return { calls, fetchImpl };
};

/**
 * A `fetch` double resolving one response PER call (the last is reused once
 * exhausted), recording every request — for reconnect tests that need the first
 * call to fail and the next to succeed.
 */
const fetchReturningSequence = (responses: (() => Response)[]): { calls: { init: RequestInit | undefined; url: string }[]; fetchImpl: typeof fetch } => {
    const calls: { init: RequestInit | undefined; url: string }[] = [];
    let index = 0;

    const fetchImpl = vi.fn<(input: RequestInfo | URL, requestInit?: RequestInit) => Promise<Response>>(
        async (input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
            calls.push({ init: requestInit, url: requestUrl(input) });

            const make = responses[Math.min(index, responses.length - 1)];

            index += 1;

            if (!make) {
                throw new Error("fetchReturningSequence: no response configured");
            }

            return make();
        },
    ) as unknown as typeof fetch;

    return { calls, fetchImpl };
};

/** Read one request header out of a recorded `RequestInit`. */
const headerOf = (init: RequestInit | undefined, name: string): string | undefined => (init?.headers as Record<string, string> | undefined)?.[name];

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

    it("keeps the server's why explanation on an `event: error` frame", async () => {
        expect.assertions(1);

        const { fetchImpl } = fetchReturning([
            'data: {"text":"partial"}\n\n',
            'event: error\ndata: {"code":"CONFLICT","message":"stale","why":"row moved"}\n\n',
        ]);

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch((error_: unknown) => error_ as Error & { why?: string });

        expect((error as Error & { why?: string }).why).toBe("row moved");
    });

    it("keeps HTTP_STREAM_STATUS as the code, and the server's message and why, for a non-2xx error envelope", async () => {
        expect.assertions(3);

        const { fetchImpl } = fetchReturning([JSON.stringify({ code: "INVALID_INPUT", error: "bad args", why: "limit must be positive" })], { status: 400 });

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch(
            (error_: unknown) => error_ as Error & { code?: string; why?: string },
        );

        expect((error as Error & { code?: string }).code).toBe("HTTP_STREAM_STATUS");
        expect((error as Error & { message?: string }).message).toContain("bad args");
        expect((error as Error & { why?: string }).why).toBe("limit must be positive");
    });

    it("does not wait on a non-2xx error body that never ends", async () => {
        expect.assertions(1);

        const body = new ReadableStream<Uint8Array>({
            start() {
                // Never closed: the body stays open.
            },
        });

        const fetchImpl = vi.fn<() => Promise<Response>>(async (): Promise<Response> => new Response(body, { status: 400 })) as unknown as typeof fetch;

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch((error_: unknown) => error_ as Error & { code?: string });

        expect((error as Error & { code?: string }).code).toBe("HTTP_STREAM_STATUS");
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

    it("yields chunks from a body-less response (React Native's whatwg-fetch defines no `body`) by reading text() whole", async () => {
        expect.assertions(2);

        const { fetchImpl } = fetchReturningBodyless(['data: {"text":"hel"}\n\ndata: {"text":"lo"}\n\nevent: complete\ndata: {}\n\n']);

        const chunks = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl }));

        expect(chunks).toStrictEqual([{ text: "hel" }, { text: "lo" }]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("reads a body-less response that ends without a terminal frame as a transport interruption", async () => {
        expect.assertions(1);

        const { fetchImpl } = fetchReturningBodyless(['data: {"text":"a"}\n\n']);

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch((error_: unknown) => error_ as Error & { code?: string });

        expect((error as Error & { code?: string }).code).toBe("HTTP_STREAM_INTERRUPTED");
    });

    it("fails with HTTP_STREAM_NO_BODY when the response exposes neither a body stream nor text()", async () => {
        expect.assertions(1);

        const fetchImpl = vi.fn<() => Promise<Response>>(async (): Promise<Response> => {
            const response = new Response(null, { status: 200 });

            // Neither read exists — the shape `HTTP_STREAM_NO_BODY` still names.
            Object.defineProperty(response, "body", { value: undefined });
            Object.defineProperty(response, "text", { value: undefined });

            return response;
        }) as unknown as typeof fetch;

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch((error_: unknown) => error_ as Error & { code?: string });

        expect((error as Error & { code?: string }).code).toBe("HTTP_STREAM_NO_BODY");
    });

    it("tracks event ids and reconnects from them on the buffered path", async () => {
        expect.assertions(4);

        const ids: string[] = [];
        const { calls, fetchImpl } = fetchReturningSequence([
            // One buffered frame carrying an id, then a bare end — the interruption.
            () => bodylessResponse(['id: e1\ndata: {"text":"a"}\n\n']),
            // Second response resumes and finishes cleanly.
            () => bodylessResponse(['id: e2\ndata: {"text":"b"}\n\nevent: complete\ndata: {}\n\n']),
        ]);

        const chunks = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl, onEventId: (id) => ids.push(id), reconnect: true }));

        expect(chunks).toStrictEqual([{ text: "a" }, { text: "b" }]);
        expect(ids).toStrictEqual(["e1", "e2"]);
        expect(calls).toHaveLength(2);
        // The reconnect carries the last id the first attempt saw.
        expect(headerOf(calls[1]?.init, "last-event-id")).toBe("e1");
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

    it("normalises a `\\r\\n` split across two reads", async () => {
        expect.assertions(1);

        // The first read ends on the `\r` of the frame's closing `\r\n`.
        const { fetchImpl } = fetchReturning(['data: {"text":"a"}\r\n\r', '\ndata: {"text":"b"}\r\n\r\nevent: complete\r\ndata: {}\r\n\r\n']);

        const chunks = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl }));

        expect(chunks).toStrictEqual([{ text: "a" }, { text: "b" }]);
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

    it("reads a non-OK response's body to its end instead of leaving it unread (CLIENT-05 regression)", async () => {
        expect.assertions(1);

        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            },
        });

        const fetchImpl = vi.fn<() => Promise<Response>>(async (): Promise<Response> => new Response(body, { status: 503 })) as unknown as typeof fetch;

        await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch(() => undefined);

        // A reader holds the body until it is consumed, so a locked body was released.
        expect(body.locked).toBe(true);
    });

    it("rejects transport failures with HTTP_STREAM_TRANSPORT", async () => {
        expect.assertions(1);

        const fetchImpl = vi.fn<() => Promise<Response>>(async (): Promise<Response> => {
            throw new Error("network down");
        }) as unknown as typeof fetch;

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch((error_: unknown) => error_ as Error & { code?: string });

        expect((error as Error & { code?: string }).code).toBe("HTTP_STREAM_TRANSPORT");
    });

    // The server pump wire-encodes each data frame (`@lunora/server`'s
    // `sseFrame`); this is the one decode on the path. Without it a `Date`
    // arrived as an ISO string and a `bigint` never arrived at all.
    it("decodes wire-tagged chunks back into the values the handler yielded", async () => {
        expect.assertions(3);

        const richRef: HttpStreamRef<{ at: Date; balance: bigint; ratio: number }, Record<string, never>> = { method: "GET", path: "/api/rich" };
        const { fetchImpl } = fetchReturning([
            'data: {"at":["$lunora.wire$","date",1700000000000],"balance":["$lunora.wire$","bigint","9007199254740993"],"ratio":["$lunora.wire$","nan"]}\n\n',
            "event: complete\ndata: {}\n\n",
        ]);

        const chunks = await collect(httpStream(richRef, {}, { fetch: fetchImpl }));

        expect(chunks[0]?.at).toStrictEqual(new Date(1_700_000_000_000));
        expect(chunks[0]?.balance).toBe(9_007_199_254_740_993n);
        expect(chunks[0]?.ratio).toBeNaN();
    });

    it("seeds the Last-Event-ID header and reports each frame id via onEventId", async () => {
        expect.assertions(3);

        const ids: string[] = [];
        const { calls, fetchImpl } = fetchReturning(['id: e1\ndata: {"text":"a"}\n\nid: e2\ndata: {"text":"b"}\n\nevent: complete\ndata: {}\n\n']);

        const chunks = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl, lastEventId: "seed", onEventId: (id) => ids.push(id) }));

        expect(chunks).toStrictEqual([{ text: "a" }, { text: "b" }]);
        expect(ids).toStrictEqual(["e1", "e2"]);
        // The seeded id reaches the first request so the server can resume.
        expect(headerOf(calls[0]?.init, "last-event-id")).toBe("seed");
    });

    it("reports a server `retry:` via onRetry and ignores a malformed one", async () => {
        expect.assertions(1);

        const retries: number[] = [];
        const { fetchImpl } = fetchReturning(['retry: 1500\ndata: {"text":"a"}\n\nretry: nope\n\ndata: {"text":"b"}\n\nevent: complete\ndata: {}\n\n']);

        await collect(httpStream(tokensRef, {}, { fetch: fetchImpl, onRetry: (ms) => retries.push(ms) }));

        expect(retries).toStrictEqual([1500]);
    });

    it("caps an oversized digit-only `retry:` at the timer limit and ignores one that is not a safe integer", async () => {
        expect.assertions(1);

        const retries: number[] = [];
        const { fetchImpl } = fetchReturning([
            'retry: 99999999999\ndata: {"text":"a"}\n\nretry: 99999999999999999999999\ndata: {"text":"b"}\n\nevent: complete\ndata: {}\n\n',
        ]);

        await collect(httpStream(tokensRef, {}, { fetch: fetchImpl, onRetry: (ms) => retries.push(ms) }));

        expect(retries).toStrictEqual([2_147_483_647]);
    });

    it("ignores an `id:` containing NUL and keeps the previous resume position", async () => {
        expect.assertions(1);

        const ids: string[] = [];
        const { fetchImpl } = fetchReturning(['id: e1\ndata: {"text":"a"}\n\nid: e\u00002\ndata: {"text":"b"}\n\nevent: complete\ndata: {}\n\n']);

        await collect(httpStream(tokensRef, {}, { fetch: fetchImpl, onEventId: (id) => ids.push(id) }));

        expect(ids).toStrictEqual(["e1"]);
    });

    it("fails the stream without reconnecting when an onEventId callback throws", async () => {
        expect.assertions(2);

        const boom = new Error("observer failed");
        const { calls, fetchImpl } = fetchReturning(['id: e1\ndata: {"text":"a"}\n\nevent: complete\ndata: {}\n\n']);

        const error = await collect(
            httpStream(
                tokensRef,
                {},
                {
                    fetch: fetchImpl,
                    reconnect: true,
                    onEventId: () => {
                        throw boom;
                    },
                },
            ),
        ).catch((error_: unknown) => error_);

        expect(error).toBe(boom);
        expect(calls).toHaveLength(1);
    });

    it("sends only the latest Last-Event-ID when the caller supplied a differently cased one", async () => {
        expect.assertions(2);

        const { calls, fetchImpl } = fetchReturningSequence([
            () => sseResponse(['id: e1\ndata: {"text":"a"}\n\n']),
            () => sseResponse(["event: complete\ndata: {}\n\n"]),
        ]);

        await collect(httpStream(tokensRef, {}, { fetch: fetchImpl, headers: { "Last-Event-ID": "stale" }, reconnect: true }));

        const lastEventKeys = Object.keys((calls[1]?.init?.headers ?? {}) as Record<string, string>).filter((name) => name.toLowerCase() === "last-event-id");

        expect(lastEventKeys).toStrictEqual(["last-event-id"]);
        expect(headerOf(calls[1]?.init, "last-event-id")).toBe("e1");
    });

    it("stops reconnecting once the stream has failed on buffer overflow", async () => {
        expect.assertions(2);

        // Each attempt delivers frames then EOF — the reconnect bait. The overflow must end it.
        const { calls, fetchImpl } = fetchReturning(['retry: 1\ndata: {"text":"a"}\n\ndata: {"text":"b"}\n\ndata: {"text":"c"}\n\n']);

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl, maxBuffer: 1, reconnect: true })).catch(
            (error_: unknown) => error_ as { code?: string },
        );

        await new Promise((resolve) => {
            setTimeout(resolve, 25);
        });

        expect((error as { code?: string }).code).toBe("STREAM_BACKPRESSURE");
        expect(calls).toHaveLength(1);
    });

    it("does not reconnect by default — a bare EOF still fails once with HTTP_STREAM_INTERRUPTED", async () => {
        expect.assertions(2);

        const { calls, fetchImpl } = fetchReturning(['id: e1\ndata: {"text":"a"}\n\n']);

        const error = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl })).catch((error_: unknown) => error_ as Error & { code?: string });

        expect((error as Error & { code?: string }).code).toBe("HTTP_STREAM_INTERRUPTED");
        expect(calls).toHaveLength(1);
    });

    it("reconnects from the last seen id, replaying it as Last-Event-ID", async () => {
        expect.assertions(4);

        const ids: string[] = [];
        const { calls, fetchImpl } = fetchReturningSequence([
            // First response: one frame carrying an id and a `retry:`, then a bare
            // EOF (no terminal frame) — a transport interruption.
            () => sseResponse(['id: e1\ndata: {"text":"a"}\nretry: 5\n\n']),
            // Second response resumes and finishes cleanly.
            () => sseResponse(['id: e2\ndata: {"text":"b"}\n\nevent: complete\ndata: {}\n\n']),
        ]);

        const chunks = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl, onEventId: (id) => ids.push(id), reconnect: true }));

        expect(chunks).toStrictEqual([{ text: "a" }, { text: "b" }]);
        expect(ids).toStrictEqual(["e1", "e2"]);
        expect(calls).toHaveLength(2);
        // The reconnect carries the last id the first attempt saw.
        expect(headerOf(calls[1]?.init, "last-event-id")).toBe("e1");
    });

    it("reconnects after a transport error when enabled", async () => {
        expect.assertions(2);

        let attempt = 0;
        const fetchImpl = vi.fn<() => Promise<Response>>(async (): Promise<Response> => {
            attempt += 1;

            if (attempt === 1) {
                throw new Error("network down");
            }

            return sseResponse(["event: complete\ndata: {}\n\n"]);
        }) as unknown as typeof fetch;

        const chunks = await collect(httpStream(tokensRef, {}, { fetch: fetchImpl, reconnect: true }));

        expect(chunks).toStrictEqual([]);
        expect(attempt).toBe(2);
    });

    it("never reconnects on a consumer cancel, even with reconnect: true", async () => {
        expect.assertions(1);

        let calls = 0;
        const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (): Promise<Response> => {
            calls += 1;

            // A tiny server retry, so a (buggy) reconnect would fire fast
            // enough to be caught by the wait below.
            return sseResponse(['retry: 1\ndata: {"text":"a"}\n\n']);
        }) as unknown as typeof fetch;

        const stream = httpStream(tokensRef, {}, { fetch: fetchImpl, reconnect: true });
        const iterator = stream[Symbol.asyncIterator]();

        await iterator.next();

        stream.cancel();

        await new Promise((resolve) => {
            setTimeout(resolve, 25);
        });

        expect(calls).toBe(1);
    });

    it("surfaces an idle timeout at once even when the body's cancel() never settles", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        try {
            let requestSignal: AbortSignal | undefined;
            const stuckBody = new ReadableStream<Uint8Array>({
                // Never settles: a body whose release hangs.
                cancel: async () =>
                    new Promise<void>(() => {
                        /* hangs */
                    }),
            });
            const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
                async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                    requestSignal = init?.signal ?? undefined;

                    return new Response(stuckBody, { headers: { "content-type": "text/event-stream" }, status: 200 });
                },
            ) as unknown as typeof fetch;

            const iterator = httpStream(tokensRef, {}, { fetch: fetchImpl, idleTimeoutMs: 50 })[Symbol.asyncIterator]();
            const outcome = iterator.next().then(
                () => "resolved",
                (error: unknown) => (error as { code?: string }).code,
            );

            await vi.advanceTimersByTimeAsync(60);

            // Settled within the idle window; before the fix the awaited cancel() held it forever.
            await expect(Promise.race([outcome, Promise.resolve("pending")])).resolves.toBe("STREAM_IDLE");
            expect(requestSignal?.aborted).toBe(true);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
