import type { ConnectionStatus } from "@lunora/client";
import type { Ref } from "vue";
import { shallowRef } from "vue";

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
 */
const useConnectionStatus = (): Readonly<Ref<ConnectionStatus>> => {
    const client = useLunora();
    const status = shallowRef<ConnectionStatus>(client.connectionStatus());

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
