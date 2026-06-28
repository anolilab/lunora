import type { Readable } from "svelte/store";
import { derived, writable } from "svelte/store";

/**
 * The structural surface of a TanStack `Transaction` a bound mutator returns —
 * its `isPersisted.promise` resolves once the write is persisted and rejects on
 * failure. Typed structurally so `@lunora/svelte` need not depend on
 * `@tanstack/db` or `@lunora/db` (the handle is created app-side by
 * `bindMutators`).
 */
interface MutatorTransaction {
    isPersisted: { promise: Promise<unknown> };
}

/**
 * A bound custom-mutator handle produced by `bindMutators(client, db, mutators)`
 * in `@lunora/db`. Calling it applies the optimistic overlay to the local
 * collections and pushes the authoritative server write; it returns the TanStack
 * transaction whose `isPersisted` promise tracks completion.
 */
type MutatorHandle<TArgs> = (args: TArgs) => MutatorTransaction;

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

    let inFlight = 0;

    const mutate = async (args: TArgs): Promise<void> => {
        inFlight += 1;
        pending.set(true);

        try {
            await handle(args).isPersisted.promise;
            error.set(undefined);
        } catch (error_) {
            const normalized = error_ instanceof Error ? error_ : new Error(String(error_));

            error.set(normalized);

            throw normalized;
        } finally {
            inFlight -= 1;
            pending.set(inFlight > 0);
        }
    };

    const reset = (): void => {
        error.set(undefined);
    };

    return { error, isError, mutate, pending, reset };
};

export type { MutatorHandle, MutatorTransaction };
