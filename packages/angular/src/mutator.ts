import type { Signal } from "@angular/core";
import { computed, signal } from "@angular/core";
import type { MutatorHandle } from "@lunora/client";
import { createMutatorRunner } from "@lunora/client";

/**
 * `MutatorResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface MutatorResult<TArgs> {
    /** The latest invocation's error, or `undefined`. */
    error: Signal<Error | undefined>;

    /** `true` when the latest invocation rejected. */
    isError: Signal<boolean>;

    /** Run the mutator; resolves once the write is persisted, rejects on failure. */
    mutate: (args: TArgs) => Promise<void>;

    /** `true` while ANY invocation from this handle is in flight. */
    pending: Signal<boolean>;

    /** Clear the latest `error` back to idle. */
    reset: () => void;
}

/**
 * Ergonomic `{ mutate, pending, error, isError, reset }` wrapper over a bound
 * custom-mutator handle from `` `@lunora/db` ``'s `bindMutators` — the Angular
 * equivalent of `` `@lunora/react` ``'s `useMutator`. The optimistic overlay and
 * server-authoritative push are owned by the bound handle; this function only
 * surfaces reactive state for the in-flight/error lifecycle.
 *
 * `pending` is ref-counted across overlapping invocations of THIS handle, so it
 * clears only once every concurrent call has settled.
 *
 * Does NOT require an injection context — it works with plain signals.
 *
 * ```ts
 * private readonly collection = bindMutators(collections);
 * readonly mutator = mutator(this.collection.insert);
 * ```
 * @experimental
 */
export const mutator = <TArgs = Record<string, unknown>>(handle: MutatorHandle<TArgs>): MutatorResult<TArgs> => {
    const error = signal<Error | undefined>(undefined);
    const pending = signal(false);
    const isError = computed(() => error() !== undefined);

    const { mutate, reset } = createMutatorRunner(handle, {
        setError: (value) => {
            error.set(value);
        },
        setPending: (value) => {
            pending.set(value);
        },
    });

    return { error: error.asReadonly(), isError, mutate, pending: pending.asReadonly(), reset };
};
