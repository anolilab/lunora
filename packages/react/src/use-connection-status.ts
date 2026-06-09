"use client";

import type { ConnectionStatus } from "@cirrus/client";
import { useSyncExternalStore } from "react";

import { useCirrus } from "./cirrus-provider";

/**
 * Reactive view of the client's aggregate live-socket status across all shard
 * connections. Re-renders on every transition (`idle` → `connecting` →
 * `connected` → `offline`). Use it to drive a connection indicator so an
 * operator can tell a healthy live channel from a silently-dropped socket.
 */
const useConnectionStatus = (): ConnectionStatus => {
    const client = useCirrus();

    // No manual memoization: React Compiler (enabled in the build) stabilises
    // the subscribe callback, so the store subscription stays steady.
    return useSyncExternalStore(
        (onChange) =>
            client.onConnectionStatus(() => {
                onChange();
            }),
        () => client.connectionStatus(),
        () => client.connectionStatus(),
    );
};

export default useConnectionStatus;
