import type { ComputedRef, Ref } from "vue";
import { computed, shallowRef } from "vue";

/**
 * The structural surface of a TanStack `Transaction` a bound mutator returns —
 * its `isPersisted.promise` resolves once the write is persisted and rejects on
 * failure. Typed structurally so `@lunora/vue` need not depend on `@tanstack/db`
 * or `@lunora/db` (the handle is created app-side by `bindMutators`).
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
 * The reactive handle returned by {@link useMutator} — the Vue counterpart to
 * `@lunora/react`'s `useMutator`, re-expressed with refs. The surface is
 * identical across the Lunora adapters (`@lunora/solid`, `/svelte`):
 * `error`/`isError`/`pending` are refs you read in a template and `mutate` is an
 * awaitable that resolves once the write is persisted (or rejects).
 */
export interface MutatorHook<TArgs> {
    /** The latest invocation's error, or `undefined`. */
    error: Ref<Error | undefined>;
    /** `true` when the latest invocation rejected. */
    isError: ComputedRef<boolean>;
    /** Run the mutator; resolves once the write is persisted, rejects on failure. */
    mutate: (args: TArgs) => Promise<void>;
    /** `true` while ANY invocation from this handle is in flight (ref-counted, so overlapping calls compose). */
    pending: Ref<boolean>;
    /** Clear the latest `error` back to idle. */
    reset: () => void;
}

/**
 * Ergonomic `{ mutate, pending, error, isError, reset }` wrapper over a bound
 * custom-mutator handle from `@lunora/db`'s `bindMutators` — the Vue equivalent
 * of `@lunora/react`'s `useMutator`. The optimistic overlay and
 * server-authoritative push are owned by the bound handle (and TanStack DB's
 * optimistic-transaction layer rebases pending overlays on every sync tick);
 * this composable only surfaces reactive state for the in-flight/error
 * lifecycle. Reads stay on the existing TanStack `useLiveQuery`; no new query
 * composable is needed.
 *
 * `pending` is ref-counted across overlapping invocations of THIS handle, so it
 * clears only once every concurrent call has settled.
 */
export const useMutator = <TArgs = Record<string, unknown>>(handle: MutatorHandle<TArgs>): MutatorHook<TArgs> => {
    const error = shallowRef<Error | undefined>(undefined);
    const pending = shallowRef(false);
    const isError = computed(() => error.value !== undefined);

    let inFlight = 0;

    const mutate = async (args: TArgs): Promise<void> => {
        inFlight += 1;
        pending.value = true;

        try {
            await handle(args).isPersisted.promise;
            error.value = undefined;
        } catch (error_) {
            const normalized = error_ instanceof Error ? error_ : new Error(String(error_));

            error.value = normalized;

            throw normalized;
        } finally {
            inFlight -= 1;
            pending.value = inFlight > 0;
        }
    };

    const reset = (): void => {
        error.value = undefined;
    };

    return { error, isError, mutate, pending, reset };
};

export type { MutatorHandle, MutatorTransaction };
