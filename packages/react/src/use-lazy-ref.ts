import { useRef } from "react";

/**
 * Lazily-initialised ref. Unlike `useState`, `useRef` has no lazy initialiser,
 * so `useRef(new Map())` allocates (and immediately discards) a fresh value on
 * every render. `useLazyRef` runs `create` exactly once, on the first render.
 */
const useLazyRef = function <T>(create: () => T): { current: T } {
    const reference = useRef<T | undefined>(undefined);

    // react-doctor-disable-next-line react-hooks-js/todo -- lazy ref-init: writing `.current` once on first render is React's sanctioned lazy-useRef pattern (https://react.dev/reference/react/useRef#avoiding-recreating-the-ref-contents); the `??=` form trips the compiler's HIR lowering but is the entire purpose of this helper.
    reference.current ??= create();

    return reference as { current: T };
};

export default useLazyRef;
