"use client";

import type { MutatorHandle } from "@lunora/client";
import { createMutatorRunner } from "@lunora/client";
import { useMemo, useState } from "react";

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
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<Error | undefined>(undefined);

    // One runner per handle so its ref-counted in-flight tally is shared across
    // overlapping calls and only re-created when the bound handle changes. The
    // `useState` setters are referentially stable, so binding them once is safe.
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- load-bearing: `createMutatorRunner` builds a stateful runner that owns the ref-counted in-flight tally; it must be created once per `handle`, not per render, or the tally resets and `pending` breaks. This is a store/identity cache, not a plain-value memo, so React Compiler's memoization is not a safe substitute — keep the explicit `useMemo`.
    const { mutate, reset } = useMemo(() => createMutatorRunner(handle, { setError, setPending }), [handle]);

    return { error, isError: error !== undefined, mutate, pending, reset };
};

export type { MutatorHandle, MutatorTransaction } from "@lunora/client";
export type { MutatorHook };
export { useMutator };
