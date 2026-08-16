import type { ArgsOf, FunctionReference, ReturnOf } from "./types";

/** Per-call options an action accepts — the same shape `client.action` takes. */
interface ActionCallOptions {
    /** Route the call to a specific shard. */
    shardKey?: string;
}

/** The single transport method an action runner needs — narrowed so adapters can test against a stub. */
interface ActionCapableClient<F extends FunctionReference> {
    action: (function_: F, args: ArgsOf<F>, options?: ActionCallOptions) => Promise<ReturnOf<F>>;
}

/**
 * Reactive sinks an adapter binds to its own primitive's setters (a Solid
 * signal, a Vue ref, a Svelte store). The runner pushes into them; how they
 * store the value is the adapter's concern (e.g. Solid wraps function-valued
 * results in a thunk).
 */
interface ActionRunnerSinks<R> {
    /** Receives the normalized {@link Error} when an invocation rejects. */
    setError: (error: Error) => void;
    /** Receives `true` while at least one invocation is in flight (ref-counted across overlapping calls), else `false`. */
    setPending: (pending: boolean) => void;
    /** Receives the resolved value when an invocation succeeds. */
    setResult: (result: R) => void;
}

/**
 * Build the framework-neutral `call` half of an adapter's action hook.
 *
 * The sibling of `createMutationRunner`, and deliberately a separate export
 * rather than a reuse of it: the two differ in the option type they forward — a
 * mutation carries `optimistic`/`optimisticUpdate`, an action carries only
 * `shardKey`. Collapsing them would have meant offering optimistic updates on
 * actions, which cannot honour them: an optimistic update patches the
 * subscription cache on the assumption a write will land, and an action is not a
 * write. It runs in the Worker, may call a third party, and has no declared
 * effect on any query.
 *
 * What it does share is the orchestration every adapter otherwise copy-pastes:
 * ref-counting overlapping invocations into `setPending` (so it clears only once
 * the last settles), normalizing a thrown non-`Error`, and routing
 * success/failure to `setResult`/`setError` before re-throwing.
 */
const createActionRunner = <F extends FunctionReference>(
    client: ActionCapableClient<F>,
    function_: F,
    sinks: ActionRunnerSinks<ReturnOf<F>>,
): ((args: ArgsOf<F>, options?: ActionCallOptions) => Promise<ReturnOf<F>>) => {
    // Ref-counted across overlapping calls of this one handle instance.
    let inFlight = 0;

    return async (args, options) => {
        inFlight += 1;
        sinks.setPending(true);

        try {
            const result = await client.action(function_, args, options);

            sinks.setResult(result);

            return result;
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));

            sinks.setError(normalized);

            throw normalized;
        } finally {
            inFlight -= 1;
            sinks.setPending(inFlight > 0);
        }
    };
};

export type { ActionCallOptions, ActionRunnerSinks };
export { createActionRunner };
