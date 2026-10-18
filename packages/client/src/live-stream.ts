/**
 * `connectLiveStream` — browser side of live topic streams.
 *
 * Opens ONE Server-Sent Events connection to a `defineLiveStream` `connect`
 * route and multiplexes many named topics over it. `subscribe({ id, topic })`
 * registers a topic on the current connection and returns an unsubscribe
 * handle; the transport reconnects (with backoff) on a dropped stream and
 * re-registers every active subscription on the new connection.
 *
 * The server route is `<id>/connect` and the control route is its sibling
 * `<id>/control`, so the control URL is derived from `url` by swapping the
 * final `/connect` for `/control`.
 *
 * ```ts
 * const live = connectLiveStream("/live/posts/connect", { withCredentials: true, retryDelay: 500 });
 * const off = live.subscribe({ topic: "post:123", onEvent: (payload) => console.log(payload) });
 * // later
 * off();
 * live.close();
 * ```
 */

import { decodeWire } from "@lunora/wire";

import { LIVE_CONNECTION_HEADER, LIVE_EVENT_NAME } from "../../../shared/live-stream";
import { createReconnect } from "./reconnect";

/** Options for {@link connectLiveStream}. */
interface ConnectLiveStreamOptions {
    /** `fetch` override (a test seam, or a custom transport). */
    fetch?: typeof fetch;
    /** Extra headers sent on both the stream and the control requests. */
    headers?: Record<string, string>;
    /** Ceiling for the reconnect backoff, in ms. Defaults to `30000`. */
    maxDelayMs?: number;
    /** Base reconnect delay in ms. Defaults to `1000`. */
    retryDelay?: number;
    /** Send cookies / credentials on the stream and control requests. */
    withCredentials?: boolean;
}

/** A delivered live event. */
interface LiveStreamEvent {
    /** The decoded payload the publisher sent. */
    payload: unknown;
    /** The topic the event was published on. */
    topic: string;
}

/** Options for {@link LiveStream.subscribe}. */
/** A subscribe the shard refused for good: a reconnect would only be refused again. */
interface LiveStreamSubscribeError {
    /** The HTTP status of the refusal, e.g. 403, 409 or 429. */
    status: number;
    subscriptionId: string;
    topic: string;
}

interface LiveStreamSubscribeOptions {
    /** Stable caller id; a generated one is used when omitted. */
    id?: string;

    /**
     * Called when the shard refuses this subscription (403, 409, 429 and similar). The subscription is dropped
     * first, so a later subscribe with the same id is accepted. A 401 is not reported: the stream reconnects,
     * which re-authenticates and registers the subscription again.
     */
    onError?: (error: LiveStreamSubscribeError) => void;
    /** Called for every event on `topic`. */
    onEvent?: (payload: unknown) => void;
    /** The topic to follow. */
    topic: string;
}

type LiveStreamErrorListener = (error: LiveStreamSubscribeError) => void;

/** One subscription on the connection: its topic, its local handlers, and who asked to hear a refusal. */
interface LiveSubscription {
    errors: Set<LiveStreamErrorListener>;
    handlers: Set<(payload: unknown) => void>;
    refs: number;
    topic: string;
}

/** A live stream connection. */
interface LiveStream {
    /** Close the stream and stop reconnecting. */
    close: () => void;
    /** The server-minted connection id, or `undefined` before the first connect and while reconnecting. */
    readonly connectionId: string | undefined;
    /** Observe every event on the connection; returns an unsubscribe handle. */
    onEvent: (handler: (event: LiveStreamEvent) => void) => () => void;
    /** Resolves once the first connection is established (rejects only if `close`d first). */
    readonly ready: Promise<void>;
    /** Follow a topic; returns an unsubscribe handle. */
    subscribe: (options: LiveStreamSubscribeOptions) => () => void;
}

/** Wrap a callback so each handle holds its own reference, even when handles share one function. */
const wrapCallback = <Args extends unknown[]>(callback: ((...args: Args) => void) | undefined): ((...args: Args) => void) | undefined =>
    callback === undefined
        ? undefined
        : (...args: Args) => {
              callback(...args);
          };

/** A single leading space after an SSE field colon. */
const LEADING_SPACE = /^ /u;

/** Bound on one control POST, so a stalled request cannot hold the stream. Same bound as `sendLiveControl`. */
const LIVE_STREAM_CONTROL_TIMEOUT_MS = 10_000;

/**
 * Derive the control URL from the connect URL (`…/connect` → `…/control`), keeping any
 * query string. The path is split off by hand: a regex over the whole URL backtracks
 * polynomially on a crafted `/connect?/connect?…` input.
 */
const controlUrlFor = (url: string): string => {
    const queryAt = url.indexOf("?");
    const path = queryAt === -1 ? url : url.slice(0, queryAt);

    if (!path.endsWith("/connect")) {
        throw new Error(`connectLiveStream: expected a connect URL ending in "/connect", got "${url}"`);
    }

    return `${path.slice(0, -"/connect".length)}/control${queryAt === -1 ? "" : url.slice(queryAt)}`;
};

/** Parse one SSE block into its `event:` name and joined `data:` payload. */
const parseBlock = (block: string): { data: string; event: string } | undefined => {
    let event = "message";
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
            event = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).replace(LEADING_SPACE, ""));
        }
    }

    return dataLines.length === 0 ? undefined : { data: dataLines.join("\n"), event };
};

/**
 * Connect to a live topic stream. See the module docblock.
 * @param url the `connect` route URL (its sibling `control` route is derived)
 */
const connectLiveStream = (url: string, options: ConnectLiveStreamOptions = {}): LiveStream => {
    const fetchImpl = options.fetch ?? fetch;
    const controlUrl = controlUrlFor(url);
    const maxDelayMs = options.maxDelayMs ?? 30_000;
    const reconnect = createReconnect({ initialDelayMs: options.retryDelay ?? 1000, maxDelayMs });
    const credentials: RequestCredentials = options.withCredentials === true ? "include" : "same-origin";
    // A `?shard=` connect is served by that shard's DO, so its control calls must
    // name the same shard or they miss the connection (`LIVE_CONNECTION_NOT_FOUND`).
    const shardKey = new URL(url, "https://lunora.invalid").searchParams.get("shard") ?? undefined;

    const subscriptions = new Map<string, LiveSubscription>();
    const eventHandlers = new Set<(event: LiveStreamEvent) => void>();

    let connectionId: string | undefined;
    let aborter: AbortController | undefined;
    let closed = false;
    let idCounter = 0;

    /** A generated id that no active subscription holds, so a caller's own `live-N` id is never overwritten. */
    const nextGeneratedId = (): string => {
        let candidate: string;

        do {
            idCounter += 1;
            candidate = `live-${String(idCounter)}`;
        } while (subscriptions.has(candidate));

        return candidate;
    };

    // Read through a function so the compiler does not narrow `closed` to its
    // closed-over initial value inside `run()`'s loop — it is flipped by
    // `close()` from another task, which control-flow analysis cannot see.
    const isClosed = (): boolean => closed;

    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    // Rejection is opt-in: a caller that awaits `ready` sees it, and nobody else gets an unhandled rejection.
    ready.catch(() => undefined);

    const headers: Record<string, string> = { ...options.headers };

    /** Tail of each subscription's queued control posts, so one id's requests reach the server in order. */
    const controlChains = new Map<string, Promise<void>>();

    /** Control POSTs in flight, so `close()` can cancel them rather than leave a stalled one holding the stream. */
    const controlAborters = new Set<AbortController>();

    /**
     * POST one control call. Resolves the HTTP status, or `undefined` when the request never completed or
     * did not finish within {@link LIVE_STREAM_CONTROL_TIMEOUT_MS}.
     */
    const postControl = async (body: Record<string, unknown>): Promise<number | undefined> => {
        const abort = new AbortController();
        const timer = setTimeout(() => {
            abort.abort();
        }, LIVE_STREAM_CONTROL_TIMEOUT_MS);

        controlAborters.add(abort);

        try {
            const response = await fetchImpl(controlUrl, {
                body: JSON.stringify(shardKey === undefined ? body : { ...body, shardKey }),
                credentials,
                headers: { "content-type": "application/json", ...headers },
                method: "POST",
                signal: abort.signal,
            });

            // Drain the ack so the connection can be reused by a pooling runtime.
            await response.text();

            return response.status;
        } catch {
            return undefined;
        } finally {
            clearTimeout(timer);
            controlAborters.delete(abort);
        }
    };

    /** Queue a control call behind the previous one for the same subscription id. */
    const control = (subscriptionId: string, body: Record<string, unknown>): Promise<number | undefined> => {
        const previous = controlChains.get(subscriptionId) ?? Promise.resolve();
        const run = previous.then(() => postControl(body));
        const tail = run.then(
            () => undefined,
            () => undefined,
        );

        controlChains.set(subscriptionId, tail);
        tail.then(() => {
            if (controlChains.get(subscriptionId) === tail) {
                controlChains.delete(subscriptionId);
            }

            return undefined;
        }).catch(() => undefined);

        return run;
    };

    const dispatch = (topic: string, payload: unknown): void => {
        for (const entry of subscriptions.values()) {
            if (entry.topic !== topic) {
                continue;
            }

            for (const handler of entry.handlers) {
                try {
                    handler(payload);
                } catch {
                    // A user handler threw; keep delivering to its siblings.
                }
            }
        }

        for (const handler of eventHandlers) {
            try {
                handler({ payload, topic });
            } catch {
                // Ignore a throwing observer.
            }
        }
    };

    const handleBlock = (block: string): void => {
        const parsed = parseBlock(block);

        if (parsed?.event !== LIVE_EVENT_NAME) {
            return;
        }

        try {
            const frame = JSON.parse(parsed.data) as { data: unknown; topic: string };

            dispatch(frame.topic, decodeWire(frame.data));
        } catch {
            // A malformed frame is dropped rather than tearing the stream down.
        }
    };

    /** Drop a subscription the shard refused for good, and tell the callers that asked for it. */
    const refuse = (subscriptionId: string, entry: LiveSubscription, status: number): void => {
        if (subscriptions.get(subscriptionId) !== entry) {
            return;
        }

        subscriptions.delete(subscriptionId);

        for (const listener of entry.errors) {
            try {
                listener({ status, subscriptionId, topic: entry.topic });
            } catch {
                // A user callback threw; the other listeners and the remaining registrations still run.
            }
        }
    };

    /**
     * Re-register every active subscription on the current connection id. The control calls go out together:
     * `control` already queues calls per subscription id, so each id still sees one call at a time. A transient
     * failure (no reply, 5xx, 404 or 401) aborts the connection, so the reconnect loop registers them again; a
     * refusal is final, as with a fresh subscribe. Statuses are judged in subscription order, as before.
     */
    const resubscribeAll = async (): Promise<void> => {
        const replies = await Promise.all(
            [...subscriptions].map(async ([id, entry]) => {
                const status = await control(id, { action: "subscribe", connectionId, subscriptionId: id, topic: entry.topic });

                return { entry, id, status };
            }),
        );

        for (const { entry, id, status } of replies) {
            // No reply, a server error, a missing connection, or an expired credential: reconnect and register again.
            if (status === undefined || status >= 500 || status === 404 || status === 401) {
                aborter?.abort();

                return;
            }

            if (status >= 400) {
                refuse(id, entry, status);
            }
        }
    };

    const pump = async (response: Response): Promise<void> => {
        const header = response.headers.get(LIVE_CONNECTION_HEADER);

        connectionId = header ?? undefined;
        reconnect.reset();

        // Subscriptions are registered before the connection reports ready, so
        // an event published right after `ready` resolves reaches a subscriber.
        // The body is read meanwhile: a slow control POST must not hold the
        // stream's bytes unread.
        const registered = (async (): Promise<void> => {
            try {
                await resubscribeAll();
            } catch {
                // Registration failed outright: reconnect and register again rather than leave `ready` pending.
                aborter?.abort();

                return;
            }

            resolveReady?.();
            resolveReady = undefined;
            rejectReady = undefined;
        })();

        const reader = response.body?.getReader();

        if (reader === undefined) {
            await registered;

            return;
        }

        const decoder = new TextDecoder();
        let buffer = "";
        // A `\r` ending a read may be the first half of a `\r\n` split across two reads.
        let carriedCr = false;

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the loop exits via the `done` break or the abort below; TS cannot see the reader's side effect
        while (true) {
            // eslint-disable-next-line no-await-in-loop -- sequential by nature: read a chunk, dispatch its frames, read the next
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            // Normalise `\r\n` and lone `\r` (SSE allows both) so frame boundaries are always `\n\n`.
            const text = decoder.decode(value, { stream: true });
            const joined: string = carriedCr ? `\r${text}` : text;

            carriedCr = joined.endsWith("\r");
            buffer += (carriedCr ? joined.slice(0, -1) : joined).replaceAll("\r\n", "\n").replaceAll("\r", "\n");

            let index = buffer.indexOf("\n\n");

            while (index !== -1) {
                handleBlock(buffer.slice(0, index));
                buffer = buffer.slice(index + 2);
                index = buffer.indexOf("\n\n");
            }
        }

        await registered;
    };

    const run = async (): Promise<void> => {
        while (!isClosed()) {
            aborter = new AbortController();

            try {
                // eslint-disable-next-line no-await-in-loop -- the reconnect loop is sequential by design
                const response = await fetchImpl(url, {
                    credentials,
                    headers: { accept: "text/event-stream", ...headers },
                    signal: aborter.signal,
                });

                if (!response.ok) {
                    throw new Error(`live stream connect failed: HTTP ${String(response.status)}`);
                }

                // eslint-disable-next-line no-await-in-loop -- see above
                await pump(response);
            } catch {
                // A fetch failure or a mid-stream throw falls through to the backoff.
            }

            // The connection that id names is gone. A subscribe made during the backoff must not send it:
            // it would be refused, and its refusal would abort the next connect attempt.
            connectionId = undefined;

            if (isClosed()) {
                return;
            }

            const delay = reconnect.next();

            // eslint-disable-next-line no-await-in-loop -- deliberate backoff between reconnect attempts
            await new Promise((resolve) => {
                setTimeout(resolve, delay);
            });
        }
    };

    run().catch(() => undefined);

    return {
        close: () => {
            closed = true;
            aborter?.abort();

            for (const abort of controlAborters) {
                abort.abort();
            }

            controlAborters.clear();
            subscriptions.clear();
            eventHandlers.clear();

            // Closed before the first connection: `ready` settles instead of hanging.
            rejectReady?.(new Error("connectLiveStream: closed before the first connection"));
            resolveReady = undefined;
            rejectReady = undefined;
        },
        get connectionId() {
            return connectionId;
        },
        onEvent: (handler) => {
            eventHandlers.add(handler);

            return () => eventHandlers.delete(handler);
        },
        ready,
        subscribe: ({ id, onError, onEvent, topic }) => {
            if (closed) {
                throw new Error("connectLiveStream: subscribe on a closed stream");
            }

            const subscriptionId = id ?? nextGeneratedId();
            const active = subscriptions.get(subscriptionId);

            // The shard keeps one topic per subscription id. Re-using an active id for another topic
            // would leave the old registration in place and drop the new topic's events, so refuse it.
            if (active !== undefined && active.topic !== topic) {
                throw new Error(`connectLiveStream: subscription id "${subscriptionId}" already follows "${active.topic}"; unsubscribe it first`);
            }

            // A re-subscribe on an active id joins that registration: one shard-side subscription
            // carries every handler, and each handle releases only its own.
            const entry: LiveSubscription = active ?? {
                errors: new Set<LiveStreamErrorListener>(),
                handlers: new Set<(payload: unknown) => void>(),
                refs: 0,
                topic,
            };
            const listener = wrapCallback(onEvent);
            // Wrapped per handle: two handles may pass the same function, and releasing one must not drop the other's.
            const errorListener = wrapCallback(onError);

            entry.refs += 1;

            if (listener !== undefined) {
                entry.handlers.add(listener);
            }

            if (errorListener !== undefined) {
                entry.errors.add(errorListener);
            }

            if (active === undefined) {
                subscriptions.set(subscriptionId, entry);

                // Before the first connect there is no connection id to name, so nothing is sent: the connect
                // registers every active subscription (`resubscribeAll`) once it has one.
                if (connectionId !== undefined) {
                    // The reply is judged against the connection the subscribe was sent on. A reply that
                    // lands after a reconnect must not abort the connection that replaced it.
                    const sentOn = connectionId;
                    const sentAborter = aborter;

                    control(subscriptionId, { action: "subscribe", connectionId: sentOn, subscriptionId, topic })
                        .then((status) => {
                            // A subscribe that never reached the shard, failed server-side, names a connection the shard
                            // no longer has, or was rejected for an expired credential is retried by reconnecting, which
                            // re-registers every active subscription. A reply for a connection that has since been replaced
                            // needs no retry: the new connection registers it too.
                            if (status === undefined || status === 401 || status === 404 || status >= 500) {
                                if (sentOn === connectionId) {
                                    sentAborter?.abort();
                                }

                                return undefined;
                            }

                            // A refusal (403, 409, 429) is final for this subscription: report it rather than leave it registered.
                            if (status >= 400) {
                                refuse(subscriptionId, entry, status);
                            }

                            return undefined;
                        })
                        .catch(() => undefined);
                }
            }

            let released = false;

            return () => {
                if (released) {
                    return;
                }

                released = true;

                if (listener !== undefined) {
                    entry.handlers.delete(listener);
                }

                if (errorListener !== undefined) {
                    entry.errors.delete(errorListener);
                }

                entry.refs -= 1;

                // Only the last handle tears the registration down, and only while it is still the
                // live one: a stale handle (the stream was closed, or the id was re-registered) is a no-op.
                if (entry.refs > 0 || subscriptions.get(subscriptionId) !== entry) {
                    return;
                }

                subscriptions.delete(subscriptionId);
                control(subscriptionId, { action: "unsubscribe", connectionId, subscriptionId, topic }).catch(() => undefined);
            };
        },
    };
};

export { connectLiveStream };
export type { ConnectLiveStreamOptions, LiveStream, LiveStreamEvent, LiveStreamSubscribeError, LiveStreamSubscribeOptions };
