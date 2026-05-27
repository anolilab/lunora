import type { ArgsOf, FunctionReference, ReturnOf } from "@cirrus/client";
import { useCallback, useRef, useState } from "react";

import { useCirrus } from "./cirrus-provider.js";
import type { UseMutationCallOptions } from "./types.js";

export interface MutationHook<F extends FunctionReference> {
    mutate: (args: ArgsOf<F>, options?: UseMutationCallOptions<unknown, ReturnOf<F>>) => Promise<ReturnOf<F>>;
    pending: boolean;
}

/**
 * Returns `{ mutate, pending }` for the given mutation reference. Prefer
 * destructuring at the call site so the React linter can track dependencies
 * on `mutate` and `pending` independently.
 */
export function useMutation<F extends FunctionReference>(fn: F): MutationHook<F> {
    const client = useCirrus();
    const [pending, setPending] = useState(false);
    const pendingRef = useRef(false);

    const mutate = useCallback(
        async (args: ArgsOf<F>, options?: UseMutationCallOptions<unknown, ReturnOf<F>>): Promise<ReturnOf<F>> => {
            if (!pendingRef.current) {
                pendingRef.current = true;
                setPending(true);
            }

            try {
                return await client.mutation(fn, args, options);
            } finally {
                pendingRef.current = false;
                setPending(false);
            }
        },
        [client, fn],
    );

    return { mutate, pending };
}
