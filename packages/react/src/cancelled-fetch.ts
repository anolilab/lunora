import { CancelledError } from "@tanstack/react-query";

/**
 * Whether a rejected fetch was cancelled by TanStack Query rather than failed.
 *
 * A `QueryClient` built by another copy of TanStack Query rejects with that copy's `CancelledError`, and an `instanceof` check
 * against this copy's class misses it. TanStack's constructor always sets `revert` and `silent` (possibly `undefined`) and names the
 * error `CancelledError`, so that shape identifies it in any copy.
 */
const isCancelledFetch = (error: unknown): boolean => {
    if (error instanceof CancelledError) {
        return true;
    }

    return error instanceof Error && error.message === "CancelledError" && "revert" in error && "silent" in error;
};

export default isCancelledFetch;
