import type { ArgsOf, FunctionReference, ReturnOf } from "@cirrus/client";
import { useCallback, useRef, useState } from "react";

import { useCirrus } from "./cirrus-provider.js";
import type { UseMutationCallOptions } from "./types.js";

export interface MutationHook<F extends FunctionReference> {
    mutate: (args: ArgsOf<F>, options?: UseMutationCallOptions) => Promise<ReturnOf<F>>;
    pending: boolean;
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
export function useMutation<F extends FunctionReference>(function_: F): MutationHook<F> {
    const client = useCirrus();
    const [pending, setPending] = useState(false);
    const pendingCountRef = useRef(0);

    const mutate = useCallback(
        async (args: ArgsOf<F>, options?: UseMutationCallOptions): Promise<ReturnOf<F>> => {
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

    return { mutate, pending };
}
