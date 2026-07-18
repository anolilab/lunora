/**
 * HTTP-SSE stream consumer for `httpRoute.&lt;verb>(path).stream()` routes.
 *
 * The server pump (`@lunora/server`'s `buildStreamHandler`) writes one
 * `data: &lt;json>\n\n` frame per yielded chunk, a final `event: complete` frame
 * on iterator completion, and an `event: error` frame carrying
 * `{ code, message }` on throw. This consumer opens the route with `fetch`,
 * reads `response.body.getReader()`, parses that exact framing, and yields
 * typed chunks through the same bounded {@link StreamIterable} queue the WS
 * procedure stream uses — so `.cancel()`, backpressure, and error delivery
 * behave identically across both stream primitives. Cancelling (or aborting
 * the supplied signal) aborts the fetch, which reaches the server handler as
 * `request.signal`.
 */
import { LunoraError } from "@lunora/errors";

import type { StreamIterable } from "./stream";
import { createStream } from "./stream";
import type { HttpStreamArgsOf, HttpStreamChunkOf, HttpStreamRef } from "./types";

/** One optional space after an SSE field's colon (`data: x` vs `data:x`) — spec-stripped. */
const SSE_FIELD_SPACE_RE = /^ /u;

/**
 * Options accepted by {@link httpStream}.
 * @experimental Part of the HTTP-SSE stream surface.
 */
interface HttpStreamOptions {
    /**
     * Origin (or origin + prefix) the route path is appended to, e.g.
     * `https://my-app.example.com`. Defaults to `""` — a relative URL, which
     * resolves against the page origin in a browser.
     */
    baseUrl?: string;
    /** `fetch` implementation override; defaults to the global `fetch`. */
    fetch?: typeof fetch;
    /** Extra request headers (e.g. `authorization`). `accept: text/event-stream` is always sent. */
    headers?: Record<string, string>;
    /** Caps the in-flight chunk buffer (see `createStream`); exceeding it fails the stream. */
    maxBuffer?: number;
    /** External abort signal — aborting it cancels the fetch (→ the server handler's `signal`). */
    signal?: AbortSignal;
}

/** One parsed SSE frame: the (possibly empty ⇒ default) event name and the joined `data:` payload. */
interface SseFrame {
    data: string;
    event: string;
}

/** The untyped producer side of the stream queue the pump writes into. */
interface UntypedHandle {
    complete: () => void;
    fail: (error: Error) => void;
    push: (value: unknown) => void;
}

/** Untyped view of `HttpStreamCallArgs` the URL builder works over. */
interface HttpStreamCallArgsShape {
    params?: Record<string, unknown>;
    searchParams?: Record<string, unknown>;
}

/** Render a path/query param value for the URL: scalars stringify directly, objects via JSON. */
const parameterToString = (value: unknown): string => (typeof value === "object" && value !== null ? JSON.stringify(value) : String(value));

/**
 * Parse one raw SSE frame (the text between `\n\n` separators). The server
 * writes at most one `event:` line and exactly one `data:` line per frame, but
 * the parser follows the SSE spec loosely: multiple `data:` lines join with
 * `\n`, comment lines (leading `:`) and unknown fields are ignored, and one
 * optional leading space after the colon is stripped.
 */
const parseSseFrame = (raw: string): SseFrame => {
    let event = "";
    const dataLines: string[] = [];

    for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) {
            event = line.slice("event:".length).replace(SSE_FIELD_SPACE_RE, "");
        } else if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).replace(SSE_FIELD_SPACE_RE, ""));
        }
        // Comments (":…") and unknown fields ("id:", "retry:") are ignored.
    }

    return { data: dataLines.join("\n"), event };
};

/**
 * Resolve the request URL for a stream route: fill the path's `:name` segments
 * from `args.params` (percent-encoded), then append the non-undefined
 * `args.searchParams` entries as a query string.
 */
const buildHttpStreamUrl = (route: HttpStreamRef, args: HttpStreamCallArgsShape, baseUrl: string): string => {
    const parameters = args.params ?? {};

    const path = route.path
        .split("/")
        .map((segment) => {
            if (!segment.startsWith(":")) {
                return segment;
            }

            const name = segment.slice(1);
            const value = parameters[name];

            if (value === undefined) {
                throw new LunoraError("HTTP_STREAM_MISSING_PARAM", `httpStream: missing path param ":${name}" for route ${route.path}`);
            }

            return encodeURIComponent(parameterToString(value));
        })
        .join("/");

    const search = new URLSearchParams();

    for (const [key, value] of Object.entries(args.searchParams ?? {})) {
        if (value !== undefined) {
            search.set(key, parameterToString(value));
        }
    }

    const query = search.toString();
    const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

    return `${trimmedBase}${path}${query === "" ? "" : `?${query}`}`;
};

/**
 * Dispatch one parsed SSE frame into the stream handle. Returns `true` when
 * the frame was terminal (`complete` / `error` / a malformed chunk) — the
 * caller stops reading the body.
 */
const handleSseFrame = (frame: SseFrame, handle: UntypedHandle): boolean => {
    if (frame.event === "complete") {
        handle.complete();

        return true;
    }

    if (frame.event === "error") {
        let payload: { code?: unknown; message?: unknown } = {};

        try {
            payload = JSON.parse(frame.data) as { code?: unknown; message?: unknown };
        } catch {
            /* fall through to the generic error below */
        }

        const message = typeof payload.message === "string" ? payload.message : "stream error";
        const code = typeof payload.code === "string" ? payload.code : "HTTP_STREAM_ERROR";

        handle.fail(new LunoraError(code, message));

        return true;
    }

    // Default event: one JSON-encoded chunk. Ignore data-less frames (e.g. a
    // keepalive comment) rather than JSON.parse("").
    if ((frame.event === "" || frame.event === "message") && frame.data !== "") {
        try {
            handle.push(JSON.parse(frame.data));
        } catch {
            handle.fail(new LunoraError("HTTP_STREAM_BAD_CHUNK", "httpStream: malformed SSE chunk (invalid JSON)"));

            return true;
        }
    }

    return false;
};

/**
 * Read the SSE response body, pushing parsed chunks into `handle` until a
 * terminal frame (`complete` / `error`) or EOF. Runs inside the async pump —
 * all thrown errors are routed to the consumer by the caller's catch.
 */
const pumpSseBody = async (body: ReadableStream<Uint8Array>, handle: UntypedHandle): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    /** Drain every complete frame currently in the buffer; `true` when a terminal frame was handled. */
    const drainFrames = (): boolean => {
        let separatorIndex = buffer.indexOf("\n\n");

        while (separatorIndex !== -1) {
            const frame = parseSseFrame(buffer.slice(0, separatorIndex));

            buffer = buffer.slice(separatorIndex + 2);

            if (handleSseFrame(frame, handle)) {
                return true;
            }

            separatorIndex = buffer.indexOf("\n\n");
        }

        return false;
    };

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- SSE frames arrive sequentially on one body; each read depends on the previous one completing.
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        // The server writes `\n`-only frames; normalise `\r\n` defensively so a
        // proxy that rewrites line endings doesn't break frame detection.
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");

        if (drainFrames()) {
            // Terminal frame seen — release the connection and stop reading.
            // eslint-disable-next-line no-await-in-loop -- runs at most once: the terminal frame exits the loop via the return below.
            await reader.cancel().catch(() => {
                /* the response is being torn down anyway */
            });

            return;
        }
    }

    // Flush any bytes the decoder buffered, then drain one last time.
    buffer += decoder.decode().replaceAll("\r\n", "\n");

    if (!drainFrames()) {
        // The pump always writes `complete` or `error` before closing, so a
        // bare EOF is a transport-level interruption, not a clean finish.
        handle.fail(new LunoraError("HTTP_STREAM_INTERRUPTED", "httpStream: stream ended without a complete frame"));
    }
};

/**
 * Open a typed HTTP-SSE stream route and iterate its chunks:
 *
 * ```ts
 * const stream = httpStream(httpStreams.http.tokens, { searchParams: { prompt } }, { baseUrl });
 * for await (const token of stream) {
 *     render(token); // typed as the route handler's yielded chunk
 * }
 * ```
 *
 * The returned iterable terminates when the server writes `event: complete`;
 * an `event: error` frame (or a transport failure) surfaces as a coded
 * rejection on the next `next()`. `.cancel()` — or aborting `options.signal` —
 * aborts the underlying fetch, which the server observes via `request.signal`.
 * @experimental Reconnect/POST-body/wire-fidelity design questions are still open, so the shape may change.
 */
const httpStream = <Ref extends HttpStreamRef>(
    route: Ref,
    args?: HttpStreamArgsOf<Ref>,
    options: HttpStreamOptions = {},
): StreamIterable<HttpStreamChunkOf<Ref>> => {
    const fetchImpl = options.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);

    if (!fetchImpl) {
        throw new LunoraError("INTERNAL", "httpStream: no `fetch` implementation available");
    }

    // Throws synchronously on a missing path param — a caller bug, not a
    // stream-lifecycle event, so it should fail loudly at the call site.
    const url = buildHttpStreamUrl(route, (args ?? {}) as HttpStreamCallArgsShape, options.baseUrl ?? "");

    const ac = new AbortController();

    // Track the listener we attach to an external `options.signal` so it can be
    // detached on normal completion — otherwise a shared, long-lived signal (e.g.
    // a page-level `AbortController` never aborted during the page's lifetime)
    // accumulates one listener closure per `httpStream` call for as long as the
    // signal lives, even after this stream has long since finished.
    let onExternalAbort: (() => void) | undefined;

    if (options.signal) {
        if (options.signal.aborted) {
            ac.abort();
        } else {
            onExternalAbort = () => {
                ac.abort();
            };
            options.signal.addEventListener("abort", onExternalAbort, { once: true });
        }
    }

    // `{ once: true }` already self-removes the listener when it FIRES (i.e. on
    // abort) — this detach covers the normal-completion / error paths where it
    // never fires. Safe to call unconditionally (removing an already-removed
    // listener is a no-op) and safe to call more than once.
    const detachExternalAbort = (): void => {
        if (onExternalAbort) {
            options.signal?.removeEventListener("abort", onExternalAbort);
        }
    };

    const { handle, iterable } = createStream<HttpStreamChunkOf<Ref>>({
        maxBuffer: options.maxBuffer,
        onCancel: () => {
            ac.abort();
        },
    });

    (async () => {
        const response = await fetchImpl(url, {
            headers: { accept: "text/event-stream", ...options.headers },
            method: route.method,
            signal: ac.signal,
        });

        if (!response.ok) {
            // Release the (possibly still-open) response body before failing —
            // otherwise an unread non-OK body keeps its underlying connection
            // occupied until the runtime garbage-collects the response.
            await response.body?.cancel().catch(() => {
                /* body already closed/unusable — nothing to release */
            });

            handle.fail(
                new LunoraError("HTTP_STREAM_STATUS", `httpStream: request failed (status ${response.status.toString()})`, {
                    status: response.status,
                }),
            );

            return;
        }

        if (!response.body) {
            handle.fail(new LunoraError("HTTP_STREAM_NO_BODY", "httpStream: response has no body"));

            return;
        }

        await pumpSseBody(response.body, handle as UntypedHandle);
    })()
        .catch((error: unknown) => {
            // A consumer cancel (or external abort) rejects the in-flight read
            // with an AbortError — the iterator is already closing, stay silent.
            if (ac.signal.aborted) {
                handle.complete();

                return;
            }

            if (error instanceof Error && "code" in error) {
                handle.fail(error);

                return;
            }

            handle.fail(new LunoraError("HTTP_STREAM_TRANSPORT", error instanceof Error ? error.message : String(error), { cause: error }));
        })
        .finally(() => {
            detachExternalAbort();
        });

    return iterable;
};

export type { HttpStreamOptions };
export { httpStream };
