"use client";

import type { LiveStreamSubscribeError, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import { stableWireKey } from "@lunora/wire";
import { useEffect, useRef, useState } from "react";

/** Options for {@link useLiveTopic}: the `subscribeLiveTopic` options, with the callbacks read through a ref. */
type UseLiveTopicOptions = SubscribeLiveTopicOptions;

interface UseLiveTopicResult {
    /** Set when the shard refuses the subscription (403, 409, 429 and similar). */
    error: LiveStreamSubscribeError | undefined;
    /** The last payload delivered on the topic, or `undefined` until the first event. */
    lastEvent: unknown;
}

interface LiveTopicState {
    error: LiveStreamSubscribeError | undefined;
    key: string;
    lastEvent: unknown;
}

/**
 * `useLiveTopic` — follow one live topic of a `defineLiveStream` for the life of
 * the component.
 *
 * It is a lifecycle wrapper over `subscribeLiveTopic`: the connection itself is
 * shared by URL, so mounting this hook ten times still opens one stream. It
 * subscribes on mount, unsubscribes on unmount, and resubscribes only when the
 * connection inputs (`url`, `topic`, credentials, headers, retry tuning) change.
 * Changing `onEvent` or `onError` identity does not resubscribe — the latest
 * callback is read through a ref.
 *
 * It is a no-op during SSR: effects do not run on the server, so the hook returns
 * its initial values there.
 */
const useLiveTopic = (options: UseLiveTopicOptions): UseLiveTopicResult => {
    // Anything that changes which stream is opened lands in `connectionKey`; the callbacks are left
    // out so their identity never matters, and `stableWireKey` ignores property order, so the same
    // headers in a new order do not resubscribe.
    const { headers, maxDelayMs, retryDelay, topic, url, withCredentials } = options;
    const connectionKey = stableWireKey({ headers, maxDelayMs, retryDelay, topic, url, withCredentials });

    const [state, setState] = useState<LiveTopicState>();
    const current = state?.key === connectionKey ? state : undefined;

    // Latest options, so callback identity never re-runs the subscribe effect. Declared
    // before the subscribe effect, so it has already run when the subscription reads it.
    const latestRef = useRef(options);

    useEffect(() => {
        latestRef.current = options;
    });

    useEffect(() => {
        const unsubscribe = subscribeLiveTopic({
            ...latestRef.current,
            onError: (error) => {
                setState((previous) => {
                    return {
                        error,
                        key: connectionKey,
                        lastEvent: previous?.key === connectionKey ? previous.lastEvent : undefined,
                    };
                });
                latestRef.current.onError?.(error);
            },
            onEvent: (payload) => {
                setState({ error: undefined, key: connectionKey, lastEvent: payload });
                latestRef.current.onEvent?.(payload);
            },
        });

        return () => {
            unsubscribe();
            // A retired subscription's value must not come back when the hook
            // returns to this topic before the next event arrives.
            setState(undefined);
        };
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: the subscription re-opens on `connectionKey`, a key over every connection field (url, topic, credentials, retry tuning, headers). The field values are read from `latestRef`, so a caller passing a fresh `headers` literal with the same content does not resubscribe. The callbacks are read through `latestRef` too, so their identity never resubscribes.
    }, [connectionKey]);

    return { error: current?.error, lastEvent: current?.lastEvent };
};

export type { UseLiveTopicOptions, UseLiveTopicResult };
export { useLiveTopic };
