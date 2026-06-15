import type { MutationCallOptions } from "./lunora-client";
import type { ArgsOf, FunctionReference, ReturnOf } from "./types";

/** The single transport method a mutation runner needs — narrowed so adapters can test against a stub. */
interface MutationCapableClient<F extends FunctionReference> {
    mutation: (function_: F, args: ArgsOf<F>, options?: MutationCallOptions<unknown, unknown, ArgsOf<F>>) => Promise<ReturnOf<F>>;
}

/**
 * Reactive sinks an adapter binds to its own primitive's setters (a Solid
 * signal, a Vue ref, a Svelte store). The runner pushes into them; how they
 * store the value is the adapter's concern (e.g. Solid wraps function-valued
 * results in a thunk).
 */
export interface MutationRunnerSinks<R> {
    /** Receives the normalized {@link Error} when an invocation rejects. */
    setError: (error: Error) => void;
    /** Receives `true` while at least one invocation is in flight (ref-counted across overlapping calls), else `false`. */
    setPending: (pending: boolean) => void;
    /** Receives the resolved value when an invocation succeeds. */
    setResult: (result: R) => void;
}

/**
 * Build the framework-neutral `mutate` half of an adapter's mutation hook.
 *
 * Owns the orchestration every adapter otherwise copy-pastes: ref-counts
 * overlapping invocations into `setPending` (so it only clears once the last
 * settles), normalizes a thrown non-`Error`, and routes success/failure to
 * `setResult`/`setError` before re-throwing. Each adapter (`@lunora/react`,
 * `/solid`, `/svelte`, `/vue`) binds the three sinks to its own reactive
 * setters, so this logic lives in exactly one place. Optimistic-update options
 * pass straight through to `client.mutation`.
 */
export const createMutationRunner = <F extends FunctionReference>(
    client: MutationCapableClient<F>,
    function_: F,
    sinks: MutationRunnerSinks<ReturnOf<F>>,
): ((args: ArgsOf<F>, options?: MutationCallOptions<unknown, unknown, ArgsOf<F>>) => Promise<ReturnOf<F>>) => {
    // Ref-counted across overlapping calls of this one handle instance.
    let inFlight = 0;

    return async (args, options) => {
        inFlight += 1;
        sinks.setPending(true);

        try {
            const result = await client.mutation(function_, args, options);

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
