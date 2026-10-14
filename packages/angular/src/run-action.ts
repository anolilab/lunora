import type { ActionCallOptions, ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/client";

import { resolveLunoraClient } from "./client";

/**
 * `RunActionOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface RunActionOptions extends ActionCallOptions {
    /**
     * Client to run the action on. Defaults to the injected `LUNORA_CLIENT`.
     * Because actions usually fire from event handlers — which run *outside* an
     * injection context — capture the client once (`injectLunoraClient()` in a
     * field) and pass it here, or call `client.action(...)` directly.
     */
    client?: LunoraClient;
}

/**
 * Run a Lunora action and resolve with the server result (rejects on failure).
 *
 * The sibling of `mutate`, and a plain function for the same reason: Angular's
 * adapter models writes as calls rather than reactive handles, because they fire
 * from event handlers where a signal-returning primitive has nothing to bind to.
 * The other adapters return a reactive `{ call, pending, … }` handle because
 * their idioms make that natural; this one does not.
 *
 * Unlike `mutate` there are no `optimistic` / `optimisticUpdate` options. An
 * optimistic update patches the subscription cache on the assumption a write
 * will land; an action is not a write — it runs in the Worker, may call a third
 * party, and has no declared effect on any query.
 *
 * ```ts
 * private readonly client = injectLunoraClient();
 * verify = () => runAction(api.commands.run, { command: "lunora", args: ["verify"] }, { client: this.client });
 * ```
 *
 * When called from within an injection context you may omit `client` and let it
 * resolve from the injector.
 * @experimental
 */
export const runAction = <F extends FunctionReference>(reference: F, args: ArgsOf<F>, options: RunActionOptions = {}): Promise<ReturnOf<F>> => {
    const { client, ...callOptions } = options;

    return resolveLunoraClient(client).action(reference, args, callOptions);
};
