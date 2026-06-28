"use client";

import { useCallback, useRef, useState } from "react";

/**
 * The structural surface of a TanStack `Transaction` a bound mutator returns —
 * its `isPersisted.promise` resolves once the write is persisted and rejects on
 * failure. Typed structurally so `@lunora/react` need not depend on
 * `@tanstack/db` or `@lunora/db` (the handle is created app-side by
 * `bindMutators`).
 */
interface MutatorTransaction {
    isPersisted: { promise: Promise<unknown> };
}

/**
 * A bound custom-mutator handle produced by `bindMutators(client, ctx, mutators)`
 * in `@lunora/db`. Calling it applies the optimistic overlay to the local
 * collections and pushes the authoritative server write; it returns the TanStack
 * transaction whose `isPersisted` promise tracks completion.
 */
type MutatorHandle<TArgs> = (args: TArgs) => MutatorTransaction;

interface MutatorHook<TArgs> {
    /** The latest invocation's error, or `undefined`. */
    error: Error | undefined;
    /** `true` when the latest invocation rejected. */
    isError: boolean;
    /** Run the mutator; resolves once the write is persisted, rejects on failure. */
    mutate: (args: TArgs) => Promise<void>;
    /** `true` while ANY invocation from this hook is in flight (ref-counted, so overlapping calls compose). */
    pending: boolean;
    /** Clear the latest `error` back to idle. */
    reset: () => void;
}

/**
 * Ergonomic `{ mutate, pending, error, isError, reset }` wrapper over a bound
 * custom-mutator handle from `@lunora/db`'s `bindMutators`. The optimistic
 * overlay and server-authoritative push are owned by the bound handle (and
 * TanStack DB's optimistic-transaction layer rebases pending overlays on every
 * sync tick) — this hook only surfaces React state for the in-flight/error
 * lifecycle. Reads stay on the existing `useLiveQuery`; no new query hook is
 * needed.
 *
 * `pending` is ref-counted across overlapping invocations of THIS hook instance,
 * so it clears only once every concurrent call has settled.
 */
const useMutator = function useMutator<TArgs = Record<string, unknown>>(handle: MutatorHandle<TArgs>): MutatorHook<TArgs> {
    const pendingCountRef = useRef(0);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<Error | undefined>(undefined);

    const mutate = useCallback(
        async (args: TArgs): Promise<void> => {
            pendingCountRef.current += 1;
            setPending(true);

            try {
                await handle(args).isPersisted.promise;
                setError(undefined);
            } catch (error_) {
                const normalized = error_ instanceof Error ? error_ : new Error(String(error_));

                setError(normalized);

                throw normalized;
            } finally {
                pendingCountRef.current -= 1;
                setPending(pendingCountRef.current > 0);
            }
        },
        [handle],
    );

    const reset = useCallback((): void => {
        setError(undefined);
    }, []);

    return { error, isError: error !== undefined, mutate, pending, reset };
};

export type { MutatorHandle, MutatorHook, MutatorTransaction };
export { useMutator };
