import type { ConnectionStatus } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createSignal, onCleanup } from "solid-js";

import { useLunora } from "./context";

/**
 * Reactive accessor of the client's aggregate live-socket status across all
 * shard connections. Reads the current status synchronously and updates on
 * every transition (`idle` → `connecting` → `connected` → `offline`) — Solid's
 * fine-grained signals mean only the components that read the accessor
 * re-render. The Solid equivalent of `@lunora/react`'s `useConnectionStatus`.
 *
 * The status listener is torn down via `onCleanup` when the owning reactive
 * scope disposes (component unmount). Call inside a component / reactive root.
 */
const createConnectionStatus = (): Accessor<ConnectionStatus> => {
    const client = useLunora();
    const [status, setStatus] = createSignal<ConnectionStatus>(client.connectionStatus());

    const unsubscribe = client.onConnectionStatus((next) => {
        setStatus(next);
    });

    onCleanup(unsubscribe);

    return status;
};

export default createConnectionStatus;
