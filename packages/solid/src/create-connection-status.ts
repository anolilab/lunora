import type { ConnectionStatus } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import { useLunora } from "./context";
import { onMounted } from "./solid-compat";

/**
 * Reactive accessor of the client's aggregate live-socket status across all
 * shard connections. Reads the current status synchronously and updates on
 * every transition (`idle` → `connecting` → `connected` → `offline`) — Solid's
 * fine-grained signals mean only the components that read the accessor
 * re-render. The Solid equivalent of `@lunora/react`'s `useConnectionStatus`.
 *
 * The listener is registered at **mount**, not in the component body, because
 * `onConnectionStatus` invokes it synchronously on subscribe: Solid 2 rejects a
 * signal write inside an owned scope (`REACTIVE_WRITE_IN_OWNED_SCOPE`) and — since
 * the throw escapes render — halts the reactive system for the whole page, not
 * just this component. Nothing is missed by waiting: the initial value comes
 * from `client.connectionStatus()`, and the immediate callback re-syncs at
 * mount. Torn down when the owning scope disposes. Call inside a component /
 * reactive root.
 */
const createConnectionStatus = (): Accessor<ConnectionStatus> => {
    const client = useLunora();
    const [status, setStatus] = createSignal<ConnectionStatus>(client.connectionStatus());

    onMounted(() =>
        client.onConnectionStatus((next) => {
            setStatus(next);
        }),
    );

    return status;
};

export default createConnectionStatus;
