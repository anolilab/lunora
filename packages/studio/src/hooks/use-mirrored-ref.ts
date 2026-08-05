import type { RefObject } from "react";
import { useEffect, useRef } from "react";

/**
 * A ref that always holds the latest COMMITTED `value`.
 *
 * The pattern this replaces is a render-phase write — `const ref = useRef(x);
 * ref.current = x;` — which is impure: React may render without committing (a
 * concurrent re-render, an offscreen pass), so the ref can publish a value that
 * never became the UI. Mirroring in an effect records only what actually
 * committed.
 *
 * It exists as one call rather than a ref plus a hand-written effect because the
 * two halves must not drift apart. The mirror has to be REGISTERED BEFORE any
 * effect that reads the ref — effects run in hook-declaration order, so a
 * consumer declared earlier would read the previous commit's value. Keeping both
 * halves in a single call means "move the refs together for readability" cannot
 * silently separate them, and a new consumer only has to be placed after this
 * call rather than after some other effect elsewhere in the file.
 *
 * **Scope of that guarantee: one component.** React flushes a CHILD's effects
 * before its parent's, so a value mirrored in a parent and read by an effect in
 * a child is one commit behind on the render where it changes. Mirror in the
 * component that reads it, or pass the value down as a prop.
 */
// A function DECLARATION, not a generic arrow: in a `.ts` file packem's Babel
// reads a lone `<T>` on an arrow as the start of a JSX element and the build
// fails, prettier strips the `<T,>` form that would disambiguate it, and
// `<T extends unknown>` trips `no-unnecessary-type-constraint`. A declaration
// sidesteps all three.
// eslint-disable-next-line func-style -- see above: the arrow forms all break either the build or a lint rule
function useMirroredRef<T>(value: T): RefObject<T> {
    const ref = useRef<T>(value);

    // No dep array: track every commit, not a guessed subset.
    useEffect(() => {
        ref.current = value;
    });

    return ref;
}

export default useMirroredRef;
