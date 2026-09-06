import type { ConnectionStatus, LunoraClient } from "@lunora/client";
import type { Readable } from "svelte/store";
import { readable } from "svelte/store";

import { isBrowser } from "../../../shared/is-browser";
import { getLunoraClient } from "./context";

/** The shape held by a {@link connectionStatus} store: the latest aggregate live-socket status. */
export type ConnectionStatusStore = Readable<ConnectionStatus>;

/**
 * Expose the client's aggregate live-socket status as a Svelte readable store.
 * Read it with the `$store` idiom (`{$status}`) and it stays current: the value
 * transitions through `idle` → `connecting` → `connected` → `offline` as
 * sockets open and drop — the Svelte equivalent of `@lunora/react`'s
 * `useConnectionStatus`. Use it to drive a connection indicator.
 *
 * The status listener attaches inside `readable`'s start callback (on the first
 * `$`-read / `.subscribe()`) and is released by the returned stop function when
 * the last subscriber goes away, so a store that's never read attaches nothing.
 *
 * Client-only, like every other subscribing primitive here: `$status` in a
 * template subscribes during `renderToString`, so an unguarded start callback
 * registers a listener per server render. The store still reports the client's
 * current status on the server — that value is a plain read, and nothing
 * transitions during a render.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setLunoraClient` (which must therefore be called during component init,
 * before this runs).
 */
export const connectionStatus = (client?: LunoraClient): ConnectionStatusStore => {
    const resolved = client ?? getLunoraClient();

    return readable<ConnectionStatus>(resolved.connectionStatus(), (set) => {
        // Re-read on attach in case the status moved between store creation and
        // the first subscriber.
        set(resolved.connectionStatus());

        if (!isBrowser()) {
            return () => {};
        }

        return resolved.onConnectionStatus((next) => {
            set(next);
        });
    });
};
