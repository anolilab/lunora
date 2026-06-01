import type { ConnectionStatus } from "@cirrus/client";
import { useCallback, useSyncExternalStore } from "react";

import { useCirrus } from "./cirrus-provider.js";

/**
 * Reactive view of the client's aggregate live-socket status across all shard
 * connections. Re-renders on every transition (`idle` → `connecting` →
 * `connected` → `offline`). Use it to drive a connection indicator so an
 * operator can tell a healthy live channel from a silently-dropped socket.
 */
const useConnectionStatus = (): ConnectionStatus => {
    const client = useCirrus();

    return useSyncExternalStore(
        useCallback(
            (onChange) =>
                client.onConnectionStatus(() => {
                    onChange();
                }),
            [client],
        ),
        () => client.connectionStatus(),
        () => client.connectionStatus(),
    );
};

export default useConnectionStatus;
