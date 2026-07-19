import type { ArgsOf, FunctionReference, LunoraClient, MutationCallOptions, ReturnOf } from "@lunora/client";

import { resolveLunoraClient } from "./client";

/**
 * `MutateOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface MutateOptions<F extends FunctionReference> extends MutationCallOptions<unknown, unknown, ArgsOf<F>> {
    /**
     * Client to run the mutation on. Defaults to the injected `LUNORA_CLIENT`.
     * Because mutations usually fire from event handlers — which run *outside* an
     * injection context — capture the client once (`injectLunoraClient()` in a
     * field) and pass it here, or call `client.mutation(...)` directly.
     */
    client?: LunoraClient;
}

/**
 * Run a Lunora mutation and resolve with the server result (rejects on failure).
 *
 * Optimistic updates stay client-owned: the `optimistic` / `optimisticUpdate`
 * call options pass straight through to `client.mutation`, which applies and
 * rolls them back against the live subscription cache — the same cache
 * `liveQuery` reads, so an optimistic write reflects immediately and
 * reverts on failure. The client's offline queue also engages when the socket is
 * down, so the write stays durable across reconnects.
 *
 * ```ts
 * private readonly client = injectLunoraClient();
 * send = (text: string) => mutate(api.messages.send, { text }, { client: this.client });
 * ```
 *
 * When called from within an injection context you may omit `client` and let it
 * resolve from the injector.
 * @experimental
 */
export const mutate = <F extends FunctionReference>(reference: F, args: ArgsOf<F>, options: MutateOptions<F> = {}): Promise<ReturnOf<F>> => {
    const { client, ...callOptions } = options;

    return resolveLunoraClient(client).mutation(reference, args, callOptions);
};
