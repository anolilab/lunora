import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { ConnectionStatus, LunoraClient } from "@lunora/client";

import { resolveLunoraClient } from "./client";

/**
 * `ConnectionStatusOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface ConnectionStatusOptions {
    /** Client to observe. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /** `DestroyRef` whose `onDestroy` removes the status listener. Defaults to `inject(DestroyRef)`. */
    destroyRef?: DestroyRef;
}

/**
 * A `signal` of the client's aggregate live-socket status across all shard
 * connections. Reads the current status synchronously and updates on every
 * transition (`idle` → `connecting` → `connected` → `offline`). The Angular
 * equivalent of `@lunora/react`'s `useConnectionStatus`.
 *
 * The listener is removed when the owning `DestroyRef` fires. Call from an
 * injection context (component/service field or constructor).
 * @experimental
 */
export const connectionStatus = (options: ConnectionStatusOptions = {}): Signal<ConnectionStatus> => {
    const client = resolveLunoraClient(options.client);
    const destroyRef = options.destroyRef ?? inject(DestroyRef);

    const status = signal<ConnectionStatus>(client.connectionStatus());

    const unsubscribe = client.onConnectionStatus((next) => {
        status.set(next);
    });

    destroyRef.onDestroy(unsubscribe);

    return status.asReadonly();
};
