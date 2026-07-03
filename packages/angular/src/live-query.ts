import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";

import { injectLunoraClient } from "./client";

export interface LiveQueryOptions {
    /**
     * Client to bind to. Defaults to the injected `LUNORA_CLIENT`; pass one
     * explicitly to use `liveQuery` outside an injection context (or in a test).
     */
    client?: LunoraClient;

    /**
     * `DestroyRef` whose `onDestroy` tears the subscription down. Defaults to
     * `inject(DestroyRef)` — the calling component/service — so it closes when that
     * component is destroyed. Pass one explicitly to control the lifetime yourself.
     */
    destroyRef?: DestroyRef;

    /** Route to a specific shard when the target function is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

/**
 * Subscribe to a server query and mirror its value into an Angular `signal`.
 *
 * Reads `undefined` until the first server frame lands, then updates on every
 * delta the WebSocket pushes. The underlying subscription is torn down
 * automatically when the owning `DestroyRef` fires (the component/service is
 * destroyed), so there is no leaked socket subscription.
 *
 * Call it from an injection context (a component/service field initializer or
 * constructor) so the default `inject(DestroyRef)` resolves the caller's
 * lifetime:
 *
 * ```ts
 * export class MessagesComponent {
 *     readonly messages = liveQuery(api.messages.list, { channelId: "general" });
 * }
 * ```
 *
 * Pass `"skip"` (the `SKIP` sentinel from `@lunora/client/query`) as `args` to
 * short-circuit — no network call, no socket; the signal stays `undefined`. To
 * call outside an injection context (e.g. lazily in `ngOnInit`), supply `client`
 * and `destroyRef` via {@link LiveQueryOptions}.
 */
export const liveQuery = <F extends FunctionReference>(
    reference: F,
    args: ArgsOf<F> | "skip",
    options: LiveQueryOptions = {},
): Signal<ReturnOf<F> | undefined> => {
    const client = options.client ?? injectLunoraClient();
    const destroyRef = options.destroyRef ?? inject(DestroyRef);

    const value = signal<ReturnOf<F> | undefined>(undefined);

    const unsubscribe = createQuerySubscription<F>(
        client,
        reference,
        args,
        {
            onData: (next) => {
                value.set(next);
            },
            onReset: () => {
                value.set(undefined);
            },
        },
        { shardKey: options.shardKey },
    );

    destroyRef.onDestroy(unsubscribe);

    return value.asReadonly();
};
