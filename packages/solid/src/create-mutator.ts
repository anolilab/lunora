import type { MutatorHandle } from "@lunora/client";
import { createMutatorRunner } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

/**
 * The reactive handle returned by {@link createMutator} — the Solid counterpart
 * to `@lunora/react`'s `useMutator`, re-expressed with signals.
 * `error`/`isError`/`pending` are accessors and `mutate` is an awaitable that
 * resolves once the write is persisted (or rejects).
 */
export interface MutatorHook<TArgs> {
    /** The latest invocation's error, or `undefined`. */
    error: Accessor<Error | undefined>;
    /** `true` when the latest invocation rejected. */
    isError: Accessor<boolean>;
    /** Run the mutator; resolves once the write is persisted, rejects on failure. */
    mutate: (args: TArgs) => Promise<void>;
    /** `true` while ANY invocation from this handle is in flight (ref-counted, so overlapping calls compose). */
    pending: Accessor<boolean>;
    /** Clear the latest `error` back to idle. */
    reset: () => void;
}

/**
 * Ergonomic `{ mutate, pending, error, isError, reset }` wrapper over a bound
 * custom-mutator handle from `@lunora/db`'s `bindMutators` — the Solid
 * equivalent of `@lunora/react`'s `useMutator`. The optimistic overlay and
 * server-authoritative push are owned by the bound handle (and TanStack DB's
 * optimistic-transaction layer rebases pending overlays on every sync tick);
 * this primitive only surfaces signal state for the in-flight/error lifecycle.
 * Reads stay on the existing TanStack `useLiveQuery`; no new query primitive is
 * needed.
 *
 * `pending` is ref-counted across overlapping invocations of THIS handle, so it
 * clears only once every concurrent call has settled.
 */
export const createMutator = <TArgs = Record<string, unknown>>(handle: MutatorHandle<TArgs>): MutatorHook<TArgs> => {
    const [error, setError] = createSignal<Error | undefined>(undefined);
    const [pending, setPending] = createSignal(false);

    const { mutate, reset } = createMutatorRunner(handle, { setError, setPending });

    const isError = (): boolean => error() !== undefined;

    return { error, isError, mutate, pending, reset };
};

export type { MutatorHandle, MutatorTransaction } from "@lunora/client";
