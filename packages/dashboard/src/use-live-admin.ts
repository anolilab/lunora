import { useCirrus } from "@cirrus/react";
import { useEffect, useRef } from "react";

import { adminRef, callOptions } from "./internal.js";

/**
 * Subscribe to a reserved admin RPC over the live WebSocket for the lifetime of
 * the component's mount, re-subscribing when the path, args, or shard change.
 *
 * Each server push — the initial seed plus every re-run triggered by a
 * write-flush on a table the query reads — invokes `onValue`. The subscription
 * is gated server-side by `CIRRUS_ADMIN_TOKEN` (the dashboard sends it as the
 * client's `wsToken`). A client without that token gets the subscription
 * rejected, which arrives via `onError` so the panel can say so rather than
 * silently never updating; the one-shot load remains the source of truth.
 *
 * `enabled` lets a panel gate the live channel behind a toggle without breaking
 * the rules of hooks — when `false`, no subscription is opened. `onValue` /
 * `onError` are held in refs so a fresh closure each render doesn't churn the
 * subscription; only the path/args/shard identity does.
 */
export function useLiveAdmin<T>(
    functionPath: string,
    args: Record<string, unknown>,
    shardKey: string,
    onValue: (value: T) => void,
    enabled = true,
    onError?: (message: string) => void,
): void {
    const client = useCirrus();
    const callbackRef = useRef(onValue);
    const errorRef = useRef(onError);

    callbackRef.current = onValue;
    errorRef.current = onError;

    // Stable-stringify args so a re-render with an equal-but-new object doesn't
    // tear down and re-open the subscription.
    const argsKey = JSON.stringify(args);

    useEffect(() => {
        if (!enabled) {
            return undefined;
        }

        const parsedArgs = JSON.parse(argsKey) as Record<string, unknown>;

        return client.subscribe(adminRef(functionPath), parsedArgs, (value) => callbackRef.current(value as T), {
            ...callOptions(shardKey),
            onError: (error) => errorRef.current?.(error.message),
        });
    }, [client, functionPath, argsKey, shardKey, enabled]);
}
