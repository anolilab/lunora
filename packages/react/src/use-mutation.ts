"use client";

import type { ArgsOf, FunctionReference, OptimisticUpdate, ReturnOf } from "@lunora/client";
import { useMutation as useTanStackMutation } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { useLunora } from "./lunora-provider";
import type { UseMutationCallOptions } from "./types";

type CallOptions<F extends FunctionReference> = UseMutationCallOptions<unknown, unknown, ArgsOf<F>>;
type MutateVariables<F extends FunctionReference> = { args: ArgsOf<F>; options?: CallOptions<F> };

interface MutationHook<F extends FunctionReference> {
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    data: ReturnOf<F> | undefined;
    /** The latest invocation's error, or `null`. */
    error: Error | null;
    /** `true` when the latest invocation rejected. */
    isError: boolean;
    mutate: (args: ArgsOf<F>, options?: CallOptions<F>) => Promise<ReturnOf<F>>;
    /** `true` while ANY invocation from this hook is in flight (ref-counted, so overlapping calls compose). */
    pending: boolean;
    /** Clear the latest `data`/`error` back to idle. */
    reset: () => void;

    /**
     * Bind a Convex-parity multi-query optimistic update to this mutation.
     * Returns a `{ mutate, pending, … }` whose `mutate` forwards `update` as the
     * `optimisticUpdate` for every call — unless a per-call `optimisticUpdate`
     * is supplied in the call options, which overrides the bound one.
     */
    withOptimisticUpdate: (update: OptimisticUpdate<ArgsOf<F>>) => MutationHook<F>;
}

/**
 * Returns `{ mutate, pending, data, error, reset, withOptimisticUpdate }` for the
 * given mutation reference. Prefer destructuring at the call site so the React
 * linter can track dependencies on each field independently.
 *
 * Built on TanStack Query's mutation cache (the same cache the query hooks use),
 * so it composes with Query Devtools and exposes the latest call's `data`/`error`
 * plus `reset()`. `mutate` maps to `mutateAsync`, so it stays an awaitable that
 * rejects on failure (rather than TanStack's fire-and-forget `mutate`).
 *
 * `pending` is ref-counted across overlapping invocations of THIS hook instance
 * (driven by the mutation's `onMutate`/`onSettled` lifecycle), so it flips back to
 * `false` only once every concurrent call has settled — and a sibling component
 * mutating the same function never affects it (TanStack's own `isPending` tracks
 * just the latest invocation).
 *
 * Optimistic updates stay client-owned: the `optimistic` / `optimisticUpdate`
 * call options pass straight through to `client.mutation`, which applies and
 * rolls them back against the Lunora subscription cache (Convex parity) — not
 * through TanStack's `onMutate`.
 */
const useMutation = <F extends FunctionReference>(function_: F): MutationHook<F> => {
    const client = useLunora();

    // Local, ref-counted pending across overlapping calls of this hook instance.
    const pendingCountRef = useRef(0);
    const [pending, setPending] = useState(false);

    const mutation = useTanStackMutation<ReturnOf<F>, Error, MutateVariables<F>>({
        mutationFn: ({ args, options }) => client.mutation(function_, args, options),
        // `onMutate` fires when a call starts, `onSettled` when it resolves or
        // rejects — so overlapping calls compose and `pending` only clears once
        // the last one settles.
        onMutate: () => {
            pendingCountRef.current += 1;
            setPending(true);
        },
        onSettled: () => {
            pendingCountRef.current -= 1;
            setPending(pendingCountRef.current > 0);
        },
    });

    // `mutateAsync`/`reset` are referentially stable across renders.
    const { data, error, isError, mutateAsync, reset } = mutation;

    const mutate = useCallback((args: ArgsOf<F>, options?: CallOptions<F>): Promise<ReturnOf<F>> => mutateAsync({ args, options }), [mutateAsync]);

    const withOptimisticUpdate = useCallback(
        (update: OptimisticUpdate<ArgsOf<F>>): MutationHook<F> => {
            // Bound update is the default; a per-call `optimisticUpdate` in
            // `options` overrides it (spread last wins).
            const boundMutate = (args: ArgsOf<F>, options?: CallOptions<F>): Promise<ReturnOf<F>> =>
                mutateAsync({ args, options: { optimisticUpdate: update, ...options } });

            return { data, error, isError, mutate: boundMutate, pending, reset, withOptimisticUpdate };
        },
        [mutateAsync, data, error, isError, pending, reset],
    );

    return { data, error, isError, mutate, pending, reset, withOptimisticUpdate };
};

export type { MutationHook };
export { useMutation };
