"use client";

import type { ArgsOf, FunctionReference, OptimisticUpdate, ReturnOf } from "@cirrus/client";
import { useCallback, useRef, useState } from "react";

import { useCirrus } from "./cirrus-provider.js";
import type { UseMutationCallOptions } from "./types.js";

interface MutationHook<F extends FunctionReference> {
    mutate: (args: ArgsOf<F>, options?: UseMutationCallOptions<unknown, unknown, ArgsOf<F>>) => Promise<ReturnOf<F>>;
    pending: boolean;

    /**
     * Bind a Convex-parity multi-query optimistic update to this mutation.
     * Returns a `{ mutate, pending }` whose `mutate` forwards `update` as the
     * `optimisticUpdate` for every call — unless a per-call `optimisticUpdate`
     * is supplied in the call options, which overrides the bound one.
     */
    withOptimisticUpdate: (update: OptimisticUpdate<ArgsOf<F>>) => MutationHook<F>;
}

/**
 * Returns `{ mutate, pending }` for the given mutation reference. Prefer
 * destructuring at the call site so the React linter can track dependencies
 * on `mutate` and `pending` independently.
 *
 * `pending` is backed by a ref-counted set of in-flight invocations so
 * overlapping `mutate(...)` calls compose correctly — `pending` only flips
 * back to `false` once every concurrent call has settled.
 */
const useMutation = <F extends FunctionReference>(function_: F): MutationHook<F> => {
    const client = useCirrus();
    const [pending, setPending] = useState(false);
    const pendingCountRef = useRef(0);

    const mutate = useCallback(
        async (args: ArgsOf<F>, options?: UseMutationCallOptions<unknown, unknown, ArgsOf<F>>): Promise<ReturnOf<F>> => {
            pendingCountRef.current += 1;
            setPending(pendingCountRef.current > 0);

            try {
                return await client.mutation(function_, args, options);
            } finally {
                pendingCountRef.current -= 1;
                setPending(pendingCountRef.current > 0);
            }
        },
        [client, function_],
    );

    const withOptimisticUpdate = useCallback(
        (update: OptimisticUpdate<ArgsOf<F>>): MutationHook<F> => {
            // Bound callback is the default; a per-call `optimisticUpdate` in
            // `options` overrides it (spread last wins).
            const boundMutate = async (args: ArgsOf<F>, options?: UseMutationCallOptions<unknown, unknown, ArgsOf<F>>): Promise<ReturnOf<F>> =>
                mutate(args, { optimisticUpdate: update, ...options });

            return { mutate: boundMutate, pending, withOptimisticUpdate };
        },
        [mutate, pending],
    );

    return { mutate, pending, withOptimisticUpdate };
};

export type { MutationHook };
export { useMutation };
