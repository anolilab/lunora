import { useRef } from "react";

/**
 * Lazily-initialised ref. Unlike `useState`, `useRef` has no lazy initialiser,
 * so `useRef(new Map())` allocates (and immediately discards) a fresh value on
 * every render. `useLazyRef` runs `create` exactly once, on the first render.
 */
const useLazyRef = function <T>(create: () => T): { current: T } {
    const reference = useRef<T | undefined>(undefined);

    reference.current ??= create();

    return reference as { current: T };
};

export default useLazyRef;
