/**
 * The structural surface of a TanStack `Transaction` a bound custom mutator
 * returns — its `isPersisted.promise` resolves once the write is persisted and
 * rejects on failure. Typed structurally so the framework adapters need not
 * depend on `@tanstack/db` or `@lunora/db` (the handle is created app-side by
 * `bindMutators`).
 */
export interface MutatorTransaction {
    isPersisted: { promise: Promise<unknown> };
}

/**
 * A bound custom-mutator handle produced by `bindMutators(client, ctx, mutators)`
 * in `@lunora/db`. Calling it applies the optimistic overlay to the local
 * collections and pushes the authoritative server write; it returns the TanStack
 * transaction whose `isPersisted` promise tracks completion.
 */
export type MutatorHandle<TArgs> = (args: TArgs) => MutatorTransaction;

/**
 * Reactive sinks an adapter binds to its own primitive's setters (a React
 * `useState`, a Solid signal, a Vue ref, a Svelte store). The runner pushes into
 * them; how they store the value is the adapter's concern.
 */
export interface MutatorRunnerSinks {
    /** Receives the normalized {@link Error} when an invocation rejects, or `undefined` on success / reset. */
    setError: (error: Error | undefined) => void;
    /** Receives `true` while at least one invocation is in flight (ref-counted across overlapping calls), else `false`. */
    setPending: (pending: boolean) => void;
}

/**
 * Build the framework-neutral `mutate` / `reset` pair of an adapter's
 * custom-mutator hook (`useMutator` / `createMutator` / `mutator`).
 *
 * Owns the orchestration every adapter otherwise copy-pastes: ref-counts
 * overlapping invocations into `setPending` (so it only clears once the last
 * settles), awaits the bound handle's `isPersisted` promise, normalizes a thrown
 * non-`Error`, and routes failure to `setError` (clearing it on success) before
 * re-throwing. Each adapter (`@lunora/react`, `/solid`, `/svelte`, `/vue`) binds
 * the two sinks to its own reactive setters, so this logic lives in exactly one
 * place. The optimistic overlay + server push are owned by the bound handle.
 *
 * `error` tracks the LATEST invocation, not the last to settle: overlapping
 * calls can resolve out of order, so an earlier call that finishes later must
 * not clobber a newer call's outcome. Each invocation takes a monotonic token
 * and only writes `setError` while it is still the most recent one — otherwise
 * `error`/`isError` could surface a stale success or failure (the documented
 * "latest invocation's error" contract every adapter advertises).
 */
export const createMutatorRunner = <TArgs>(
    handle: MutatorHandle<TArgs>,
    sinks: MutatorRunnerSinks,
): { mutate: (args: TArgs) => Promise<void>; reset: () => void } => {
    // Ref-counted across overlapping calls of this one handle instance.
    let inFlight = 0;
    // Monotonic per-invocation token; only the latest may write `error`.
    let latestInvocation = 0;

    const mutate = async (args: TArgs): Promise<void> => {
        latestInvocation += 1;
        const invocation = latestInvocation;
        inFlight += 1;
        sinks.setPending(true);

        try {
            await handle(args).isPersisted.promise;

            if (invocation === latestInvocation) {
                sinks.setError(undefined);
            }
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));

            if (invocation === latestInvocation) {
                sinks.setError(normalized);
            }

            throw normalized;
        } finally {
            inFlight -= 1;
            sinks.setPending(inFlight > 0);
        }
    };

    const reset = (): void => {
        sinks.setError(undefined);
    };

    return { mutate, reset };
};
