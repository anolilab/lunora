import type { MutatorHandle } from "@lunora/client";
import { createMutatorRunner } from "@lunora/client";
import type { Readable } from "svelte/store";
import { derived, writable } from "svelte/store";

/**
 * The reactive handle returned by {@link mutator} — the Svelte counterpart to
 * `@lunora/react`'s `useMutator`, re-expressed as stores you read with `$`.
 * `error`/`isError`/`pending` are readable stores and `mutate` is an awaitable
 * that resolves once the write is persisted (or rejects).
 */
export interface MutatorHandleStore<TArgs> {
    /** The latest invocation's error, or `undefined`. */
    error: Readable<Error | undefined>;
    /** `true` when the latest invocation rejected. */
    isError: Readable<boolean>;
    /** Run the mutator; resolves once the write is persisted, rejects on failure. */
    mutate: (args: TArgs) => Promise<void>;
    /** `true` while ANY invocation from this handle is in flight (ref-counted, so overlapping calls compose). */
    pending: Readable<boolean>;
    /** Clear the latest `error` back to idle. */
    reset: () => void;
}

/**
 * Ergonomic `{ mutate, pending, error, isError, reset }` wrapper over a bound
 * custom-mutator handle from `@lunora/db`'s `bindMutators` — the Svelte
 * equivalent of `@lunora/react`'s `useMutator`. The optimistic overlay and
 * server-authoritative push are owned by the bound handle (and TanStack DB's
 * optimistic-transaction layer rebases pending overlays on every sync tick);
 * this helper only surfaces store state for the in-flight/error lifecycle. Reads
 * stay on the existing TanStack `useLiveQuery`; no new query store is needed.
 *
 * `pending` is ref-counted across overlapping invocations of THIS handle, so it
 * clears only once every concurrent call has settled.
 */
export const mutator = <TArgs = Record<string, unknown>>(handle: MutatorHandle<TArgs>): MutatorHandleStore<TArgs> => {
    const error = writable<Error | undefined>();
    const pending = writable(false);
    const isError = derived(error, ($error) => $error !== undefined);

    const { mutate, reset } = createMutatorRunner(handle, {
        setError: (value) => {
            error.set(value);
        },
        setPending: (value) => {
            pending.set(value);
        },
    });

    return { error, isError, mutate, pending, reset };
};

export type { MutatorHandle, MutatorTransaction } from "@lunora/client";
