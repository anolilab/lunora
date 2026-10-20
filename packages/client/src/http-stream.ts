/**
 * HTTP-SSE stream consumer for `httpRoute.<verb>(path).stream()` routes.
 *
 * The server pump (`@lunora/server`'s `buildStreamHandler`) writes one
 * `data: <wire-encoded json>\n\n` frame per yielded chunk, a final
 * `event: complete` frame on iterator completion, and an `event: error` frame
 * carrying a plain (unencoded) `{ code, message }` on throw. This consumer opens
 * the route with `fetch`, reads `response.body.getReader()`, parses that exact framing, and yields
 * typed chunks through the same bounded {@link StreamIterable} queue the WS
 * procedure stream uses — so `.cancel()`, backpressure, and error delivery
 * behave identically across both stream primitives. Cancelling (or aborting
 * the supplied signal) aborts the fetch, which reaches the server handler as
 * `request.signal`.
 *
 * A runtime whose `fetch` resolves with no `body` stream — React Native, whose
 * `whatwg-fetch` polyfill defines no `body` on `Response` — is read whole
 * through `response.text()` instead: the same frames, dispatched in one drain,
 * so every chunk of the route arrives together when the response lands rather
 * than as the handler yields it.
 *
 * A frame may also carry an SSE `id:` (the server emits one for a chunk a
 * handler wrapped in `sseEvent`) and a `retry:` (an integer reconnect delay in
 * ms). The last `id:` seen is tracked and replayed as the request's
 * `Last-Event-ID` header — {@link HttpStreamOptions.lastEventId} seeds it for
 * the first request, and with {@link HttpStreamOptions.reconnect} it is what
 * lets a dropped connection resume instead of replaying from the start. A
 * transport interruption (a bare EOF, or a read/transport error) is the only
 * thing that reconnects; a terminal `complete`/`error` frame, a non-2xx status,
 * and a consumer `.cancel()` / external abort all end the stream.
 */
import { LunoraError } from "@lunora/errors";
import { decodeWire } from "@lunora/wire";

import { createReconnect } from "./reconnect";
import type { StreamIterable } from "./stream";
import { createStream } from "./stream";
import readOrIdle from "./stream-idle";
import type { HttpStreamArgsOf, HttpStreamChunkOf, HttpStreamRef } from "./types";

/** One optional space after an SSE field's colon (`data: x` vs `data:x`) — spec-stripped. */
const SSE_FIELD_SPACE_RE = /^ /u;

/** A `retry:` value is a plain non-negative integer count of milliseconds, per the SSE spec. */
const SSE_RETRY_RE = /^\d+$/u;

/**
 * Longest delay `setTimeout` honours (2^31 - 1 ms). A larger one fires after about
 * 1 ms, so an oversized `retry:` is capped here rather than reconnecting at once.
 */
const MAX_RETRY_MS = 2_147_483_647;

/**
 * Consecutive transport interruptions a `reconnect: true` stream tolerates
 * before it gives up. The count resets whenever a frame arrives intact, so this
 * bounds an unbroken outage rather than total reconnects over a healthy stream.
 */
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

/** How long a non-2xx response's error body may take to arrive before the status error is reported without it. */
const ERROR_BODY_WAIT_MS = 1000;

/**
 * Options accepted by {@link httpStream}.
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

    /**
     * Treat a connection that delivers nothing — no chunk, no keepalive comment —
     * for this many milliseconds as dead: it is cancelled, then reconnected with
     * {@link HttpStreamOptions.reconnect} or failed with `STREAM_IDLE`. Off by
     * default, because a route may be silent for as long as its handler works
     * (a model thinking); set it to a few multiples of the route's keepalive
     * interval when the route sends one.
     */
    idleTimeoutMs?: number;

    /**
     * Seed the first request's `Last-Event-ID` header, resuming a stream from a
     * position a previous consumer persisted. Once frames arrive this is
     * superseded by their `id:`, and a reconnecting stream always sends the
     * latest id it saw.
     */
    lastEventId?: string;
    /** Caps the in-flight chunk buffer (see `createStream`); exceeding it fails the stream. */
    maxBuffer?: number;
    /** Called with each frame's `id:` as it is seen (the value that will be replayed on reconnect). */
    onEventId?: (id: string) => void;
    /** Called when the server advertises a `retry:` reconnect delay, in milliseconds. */
    onRetry?: (ms: number) => void;

    /**
     * Reopen the request after a transport interruption — a bare EOF or a
     * read/transport error — replaying the last seen id as `Last-Event-ID`.
     * Defaults to `false`, which surfaces the interruption as
     * `HTTP_STREAM_INTERRUPTED` exactly as before. A terminal `complete`/`error`
     * frame, a non-2xx status, and a consumer cancel never reconnect.
     */
    reconnect?: boolean;
    /** External abort signal — aborting it cancels the fetch (→ the server handler's `signal`). */
    signal?: AbortSignal;
}

/** One parsed SSE frame: the (possibly empty ⇒ default) event name, the joined `data:` payload, and the optional `id:` / `retry:` controls. */
interface SseFrame {
    data: string;
    event: string;
    id?: string;
    retry?: number;
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
 * optional leading space after the colon is stripped. `id:` (an event id) and
 * `retry:` (a non-negative integer of milliseconds) are captured; a malformed
 * `retry:` is dropped rather than trusted.
 */
const parseSseFrame = (raw: string): SseFrame => {
    let event = "";
    let id: string | undefined;
    let retry: number | undefined;
    const dataLines: string[] = [];

    for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) {
            event = line.slice("event:".length).replace(SSE_FIELD_SPACE_RE, "");
        } else if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).replace(SSE_FIELD_SPACE_RE, ""));
        } else if (line.startsWith("id:")) {
            const value = line.slice("id:".length).replace(SSE_FIELD_SPACE_RE, "");

            // Per the spec an id containing NUL is ignored, keeping the previous one.
            if (!value.includes("\0")) {
                id = value;
            }
        } else if (line.startsWith("retry:")) {
            const value = line.slice("retry:".length).replace(SSE_FIELD_SPACE_RE, "");

            if (SSE_RETRY_RE.test(value) && Number.isSafeInteger(Number(value))) {
                retry = Math.min(Number(value), MAX_RETRY_MS);
            }
        }
        // Comment lines (":…") and any other field are ignored.
    }

    return { data: dataLines.join("\n"), event, id, retry };
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
        let payload: { code?: unknown; message?: unknown; why?: unknown } = {};

        try {
            payload = JSON.parse(frame.data) as { code?: unknown; message?: unknown; why?: unknown };
        } catch {
            /* fall through to the generic error below */
        }

        const message = typeof payload.message === "string" ? payload.message : "stream error";
        const code = typeof payload.code === "string" ? payload.code : "HTTP_STREAM_ERROR";
        const error: LunoraError & { why?: string } = new LunoraError(code, message);

        if (typeof payload.why === "string") {
            error.why = payload.why;
        }

        handle.fail(error);

        return true;
    }

    // Default event: one wire-encoded chunk. Ignore data-less frames (e.g. a
    // keepalive comment) rather than JSON.parse("").
    //
    // `decodeWire` is the other half of the server pump's `encodeWire`, and the
    // ONLY decode on this path — it is not idempotent, so nothing downstream may
    // decode again. Without it a `Date` arrived as an ISO string, an
    // `ArrayBuffer` as `{}` and a `NaN` as `null`, each still typed as the
    // declared chunk type.
    if ((frame.event === "" || frame.event === "message") && frame.data !== "") {
        try {
            handle.push(decodeWire(JSON.parse(frame.data)));
        } catch {
            handle.fail(new LunoraError("HTTP_STREAM_BAD_CHUNK", "httpStream: malformed SSE chunk (invalid JSON)"));

            return true;
        }
    }

    return false;
};

/** Callbacks the pump raises as it reads frames, so the caller can track the resume point and reconnect state. */
interface SseFrameObservers {
    /** A frame arrived intact — proof the transport is alive, so a reconnecting caller can reset its backoff. */
    onFrame?: () => void;
    /** A frame carried an `id:` — the position a reconnect should resume from. */
    onId?: (id: string) => void;
    /** A frame carried a valid `retry:` — the server-advertised reconnect delay in ms. */
    onRetry?: (ms: number) => void;
}

/**
 * The frame buffer both body paths share: `append` folds decoded text in with
 * `\r\n` normalised (across read boundaries too), and `drain` dispatches every
 * complete frame to the handle. `drain` returns `true` once a terminal frame
 * (`complete` / `error` / a malformed chunk) ended the stream — the signal its
 * caller stops reading the body.
 */
const createSseFrameBuffer = (handle: UntypedHandle, observers: SseFrameObservers): { append: (text: string) => void; drain: () => boolean } => {
    let buffer = "";
    // A `\r` that ended the previous chunk may be the first half of a `\r\n`
    // split across two reads, so it waits for the next chunk before normalising.
    let carriedCr = false;

    /** Append decoded text with `\r\n` normalised to `\n`, across chunk boundaries too. */
    const append = (text: string): void => {
        let chunk = carriedCr ? `\r${text}` : text;

        carriedCr = chunk.endsWith("\r");

        if (carriedCr) {
            chunk = chunk.slice(0, -1);
        }

        buffer += chunk.replaceAll("\r\n", "\n");
    };

    /** Drain every complete frame currently in the buffer; `true` when a terminal frame was handled. */
    const drain = (): boolean => {
        let separatorIndex = buffer.indexOf("\n\n");

        while (separatorIndex !== -1) {
            const frame = parseSseFrame(buffer.slice(0, separatorIndex));

            buffer = buffer.slice(separatorIndex + 2);

            // Report the frame before dispatching it: even a keepalive with no
            // data proves the transport works, and an `id:` sets the resume point
            // before the dispatch that may end the stream.
            observers.onFrame?.();

            if (frame.id !== undefined) {
                observers.onId?.(frame.id);
            }

            if (frame.retry !== undefined) {
                observers.onRetry?.(frame.retry);
            }

            if (handleSseFrame(frame, handle)) {
                return true;
            }

            separatorIndex = buffer.indexOf("\n\n");
        }

        return false;
    };

    return { append, drain };
};

/**
 * Read the SSE response body, pushing parsed chunks into `handle` until a
 * terminal frame (`complete` / `error`) or EOF. Returns `true` when a terminal
 * frame finished the stream and `false` on a bare EOF — a transport
 * interruption the caller may retry. Runs inside the async pump — all thrown
 * read errors are routed to the consumer by the caller's catch.
 */
const pumpSseBody = async (
    body: ReadableStream<Uint8Array>,
    handle: UntypedHandle,
    observers: SseFrameObservers,
    attemptAbort: AbortController,
    idleTimeoutMs = 0,
): Promise<boolean> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const frames = createSseFrameBuffer(handle, observers);

    const releaseReader = (): Promise<void> =>
        reader.cancel().then(
            () => undefined,
            () => undefined,
        );

    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- SSE frames arrive sequentially on one body; each read depends on the previous one completing.
            const { done, value } = await readOrIdle(reader, idleTimeoutMs);

            if (done) {
                break;
            }

            // The server writes `\n`-only frames; normalise `\r\n` defensively so a
            // proxy that rewrites line endings doesn't break frame detection.
            frames.append(decoder.decode(value, { stream: true }));

            if (frames.drain()) {
                // Terminal frame seen — release the connection and stop reading.
                // eslint-disable-next-line no-await-in-loop -- runs at most once: the terminal frame exits the loop via the return below.
                await releaseReader();

                return true;
            }
        }

        // Flush any bytes the decoder buffered, then drain one last time.
        // A `\r` still carried here is a lone trailing one, which ends no frame.
        frames.append(decoder.decode());

        // The pump always writes `complete` or `error` before closing, so an EOF
        // that drains no terminal frame is a transport-level interruption. Whether
        // that fails the stream or triggers a reconnect is the caller's decision, so
        // it is reported here as `false` rather than failed.
        return frames.drain();
    } catch (error: unknown) {
        // An idle timeout or a throwing observer/dispatch: drop the connection and surface the error at
        // once. A body whose `cancel()` never settles must not hold the error (and the reconnect) hostage.
        attemptAbort.abort();
        releaseReader().catch(() => undefined);

        throw error;
    }
};

/**
 * Pump an SSE body a runtime delivers whole rather than as a stream: React
 * Native's `fetch` (the `whatwg-fetch` polyfill `react-native` loads) resolves
 * with a `Response` that defines no `body`, so `text()` is the only read. The
 * buffered payload is appended once and drained in one pass — the same frames
 * through the same dispatch, so `id:`s, `retry:`s and terminal frames behave
 * exactly as on the streamed path; the chunks simply arrive together when the
 * response lands rather than as the handler yields them.
 */
const pumpBufferedSseBody = async (response: Response, handle: UntypedHandle, observers: SseFrameObservers): Promise<boolean> => {
    const frames = createSseFrameBuffer(handle, observers);

    frames.append(await response.text());

    // A payload that drains no terminal frame reads as a bare EOF: a transport
    // interruption the caller fails or reconnects on, not an error raised here.
    return frames.drain();
};

/**
 * Resolve after `ms`, or immediately when `signal` aborts first. The abort
 * listener is removed on either path so a long-lived signal does not accumulate
 * one closure per reconnect delay.
 */
const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) {
        return;
    }

    await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;

        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };

        timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);

        signal.addEventListener("abort", onAbort, { once: true });
    });
};

/**
 * The status error for a non-2xx stream response whose body is the flat `{ code, error, why }`
 * envelope the HTTP routes send before a stream opens. It keeps the status code and carries the
 * server's message and `why`. `undefined` for any other body, so the caller keeps its generic status error.
 */
const statusErrorOf = (body: unknown, status: number): LunoraError | undefined => {
    if (typeof body !== "object" || body === null) {
        return undefined;
    }

    const { code, error, why } = body as { code?: unknown; error?: unknown; why?: unknown };

    if (typeof code !== "string" || typeof error !== "string") {
        return undefined;
    }

    // The code stays `HTTP_STREAM_STATUS`, which callers branch on; the server's code rides in the message.
    return new LunoraError("HTTP_STREAM_STATUS", `httpStream: request failed (status ${status.toString()}, ${code}): ${error}`, {
        status,
        why: typeof why === "string" ? why : undefined,
    });
};

/**
 * A non-2xx response's JSON body, read for at most `ERROR_BODY_WAIT_MS`. `undefined` when the body is
 * absent, malformed or slow; the body is then cancelled so it cannot hold the connection. An abort
 * while reading rethrows, so the attempt's abort handling takes over.
 */
const readErrorBody = async (response: Response, signal: AbortSignal): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
            resolve(undefined);
        }, ERROR_BODY_WAIT_MS);
    });
    const parsed = response.json().catch((error: unknown) => {
        if (signal.aborted) {
            throw error;
        }

        return undefined;
    });

    try {
        return await Promise.race([parsed, slow]);
    } finally {
        clearTimeout(timer);
        await response.body?.cancel().catch(() => undefined);
    }
};

/**
 * Request headers for one attempt. A set `lastEventId` replaces any differently
 * cased `Last-Event-ID` a caller supplied, since header names are case-insensitive
 * and only the latest resume position may be sent.
 */
const attemptHeaders = (extra: Record<string, string> | undefined, lastEventId: string | undefined): Record<string, string> => {
    const kept = Object.entries(extra ?? {}).filter(([name]) => lastEventId === undefined || name.toLowerCase() !== "last-event-id");

    return {
        accept: "text/event-stream",
        ...Object.fromEntries(kept),
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
    };
};

/** Map a thrown fetch/read failure to the error a consumer sees; a coded error is preserved as-is. */
const toTransportError = (error: unknown): Error => {
    if (error instanceof Error && "code" in error) {
        return error;
    }

    return new LunoraError("HTTP_STREAM_TRANSPORT", error instanceof Error ? error.message : String(error), { cause: error });
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
        // A failed handle (e.g. a buffer overflow) stops the request and any reconnect.
        onFail: () => {
            ac.abort();
        },
    });

    const reconnectEnabled = options.reconnect ?? false;
    const reconnectCalculator = createReconnect();

    // The resume position: seeded from `options.lastEventId` for the first
    // request, then advanced by every frame's `id:`.
    let { lastEventId } = options;
    // The server-advertised `retry:` delay, once seen. It outranks the backoff
    // for every later reconnect, mirroring how `EventSource` treats `retry:`.
    let serverRetryMs: number | undefined;

    // A bare counter that bounds consecutive interruptions (the calculator
    // bounds the DELAY only); reset alongside the calculator on a live frame.
    let attempt = 0;

    /** Reset the reconnect state after a frame proves the transport is alive. */
    const onFrame = (): void => {
        reconnectCalculator.reset();
        attempt = 0;
    };

    // A user callback that throws fails the stream. Its frame is not delivered, so the
    // cursor must not advance past it and the error must not read as a transport drop.
    const callbackFailure: { value?: { error: unknown } } = {};

    const guarded = (callback: () => void): void => {
        try {
            callback();
        } catch (error: unknown) {
            callbackFailure.value = { error };

            throw error;
        }
    };

    const observers: SseFrameObservers = {
        onFrame,
        onId: (id) => {
            guarded(() => options.onEventId?.(id));
            lastEventId = id;
        },
        onRetry: (ms) => {
            guarded(() => options.onRetry?.(ms));
            serverRetryMs = ms;
        },
    };

    /**
     * One request attempt. Resolves with the interruption to consider replaying,
     * or `undefined` when the stream is already finished — a terminal frame, a
     * non-2xx status, a body-less response, or a consumer cancel.
     */
    const runAttempt = async (): Promise<{ completed: boolean; error: Error } | undefined> => {
        const headers = attemptHeaders(options.headers, lastEventId);

        // A bare EOF is a transport interruption; a read/transport throw
        // replaces this with the coded/transport error it carried.
        const interrupted = new LunoraError("HTTP_STREAM_INTERRUPTED", "httpStream: stream ended without a complete frame");

        // Aborting only this attempt lets the pump drop a dead connection without reading as a consumer cancel.
        const attemptAbort = new AbortController();
        const forwardAbort = (): void => {
            attemptAbort.abort();
        };

        ac.signal.addEventListener("abort", forwardAbort, { once: true });

        try {
            const response = await fetchImpl(url, { headers, method: route.method, signal: attemptAbort.signal });

            if (!response.ok) {
                // A bad status is a real answer, not a transport drop — read its error
                // envelope, if it has one, and fail WITHOUT reconnecting.
                const body = await readErrorBody(response, ac.signal);

                handle.fail(
                    statusErrorOf(body, response.status) ??
                        new LunoraError("HTTP_STREAM_STATUS", `httpStream: request failed (status ${response.status.toString()})`, {
                            status: response.status,
                        }),
                );

                return undefined;
            }

            if (!response.body) {
                // React Native's `fetch` (the `whatwg-fetch` polyfill
                // `react-native` loads) resolves with a `Response` that defines
                // no `body`, so the payload is read whole via `text()` instead
                // of the reader loop. A response exposing neither read is a
                // broken `fetch` implementation, which keeps the explicit
                // `HTTP_STREAM_NO_BODY` failure.
                if (typeof response.text !== "function") {
                    handle.fail(new LunoraError("HTTP_STREAM_NO_BODY", "httpStream: response exposes neither a body stream nor a text() read"));

                    return undefined;
                }

                const completed = await pumpBufferedSseBody(response, handle as UntypedHandle, observers);

                return { completed, error: interrupted };
            }

            const completed = await pumpSseBody(response.body, handle as UntypedHandle, observers, attemptAbort, options.idleTimeoutMs);

            return { completed, error: interrupted };
        } catch (error: unknown) {
            // A consumer cancel (or external abort) rejects the in-flight read
            // with an AbortError — the iterator is already closing.
            if (ac.signal.aborted) {
                handle.complete();

                return undefined;
            }

            if (callbackFailure.value) {
                const { error: callbackError } = callbackFailure.value;

                handle.fail(
                    callbackError instanceof Error ? callbackError : new LunoraError("HTTP_STREAM_CALLBACK", "httpStream: an onEventId/onRetry callback threw"),
                );

                return undefined;
            }

            return { completed: false, error: toTransportError(error) };
        } finally {
            ac.signal.removeEventListener("abort", forwardAbort);
        }
    };

    (async () => {
        try {
            for (;;) {
                // A failed or cancelled stream (the handle aborts `ac` on fail) must not reopen the request.
                if (ac.signal.aborted) {
                    handle.complete();

                    return;
                }

                // eslint-disable-next-line no-await-in-loop -- reconnects are sequential: each request starts only after the previous one proved interrupted.
                const outcome = await runAttempt();

                // Already finished: terminal frame, bad status, no body, or cancel.
                if (!outcome) {
                    return;
                }

                // A terminal frame (completed) or a stream that did not opt into
                // reconnecting ends here: only a transport interruption reached
                // with `reconnect: true` falls through to the backoff below.
                if (outcome.completed || !reconnectEnabled || attempt >= DEFAULT_MAX_RECONNECT_ATTEMPTS) {
                    if (!outcome.completed) {
                        handle.fail(outcome.error);
                    }

                    return;
                }

                attempt += 1;

                // An abort during the delay is caught by the aborted check at the loop top.
                // eslint-disable-next-line no-await-in-loop -- the delay itself is what spaces consecutive reconnect attempts.
                await sleep(serverRetryMs ?? reconnectCalculator.next(), ac.signal);
            }
        } finally {
            detachExternalAbort();
        }
    })().catch((error: unknown) => {
        // A consumer cancel (or external abort) rejects the in-flight read
        // with an AbortError — the iterator is already closing, stay silent.
        if (ac.signal.aborted) {
            handle.complete();

            return;
        }

        handle.fail(toTransportError(error));
    });

    return iterable;
};

export type { HttpStreamOptions };
export { httpStream };
