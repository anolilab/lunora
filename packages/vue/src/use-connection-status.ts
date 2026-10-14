import type { ConnectionStatus } from "@lunora/client";
import type { Ref } from "vue";
import { shallowRef } from "vue";

import { isBrowser } from "../../../shared/is-browser";
import { useLunora } from "./lunora-provider";
import onScopeDisposeOrWarn from "./scope-dispose";

/**
 * Reactive view of the client's aggregate live-socket status across all shard
 * connections, exposed as a read-only `ref`. The value transitions through
 * `idle` → `connecting` → `connected` → `offline` as sockets open and drop —
 * use it to drive a connection indicator so an operator can tell a healthy live
 * channel from a silently-dropped one. The Vue-idiomatic equivalent of
 * `@lunora/react`'s `useConnectionStatus`.
 *
 * Teardown is wired to the active effect scope (`onScopeDispose`), so the
 * status listener is released on component unmount (or `effectScope().stop()`).
 * Call inside `setup()` / an active effect scope.
 *
 * Client-only, for the same reason as `useFlags`: this runs synchronously
 * inside `setup()` during `renderToString`, and that render scope is never
 * stopped — `onScopeDispose` therefore never fires and an unguarded listener
 * would stay registered on the client for the lifetime of the server process,
 * one per rendered request. The ref still holds the client's current status,
 * which is what the SSR HTML should show; live updates start at hydration.
 */
const useConnectionStatus = (): Readonly<Ref<ConnectionStatus>> => {
    const client = useLunora();
    const status = shallowRef<ConnectionStatus>(client.connectionStatus());

    if (!isBrowser()) {
        return status;
    }

    const unsubscribe = client.onConnectionStatus((next) => {
        status.value = next;
    });

    onScopeDisposeOrWarn(
        unsubscribe,
        "[@lunora/vue] useConnectionStatus called with no active effect scope — its listener will not be cleaned up automatically. " +
            "Call it inside setup()/an effect scope.",
    );

    return status;
};

export default useConnectionStatus;
