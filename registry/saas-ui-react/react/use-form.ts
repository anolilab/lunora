"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type { FormController, FormState } from "../core/create-form-controller";

/** Element-wise `Object.is`, the comparison React itself uses for a dependency list. */
const sameDeps = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean =>
    a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/**
 * Bind a core form controller to React. The controller is created once per
 * `deps` (so typing survives a re-render), read through `useSyncExternalStore`,
 * and destroyed on unmount.
 *
 * This is the entire React↔core seam for forms, and it is deliberately the only
 * thing in this directory that knows a hook exists. Everything a form *does* —
 * validation, double-submit, error mapping — is in `core/`, tested once, and
 * identical in the Svelte port ten lines away.
 *
 * The controller is held in state rather than in `useMemo(factory, deps)`:
 * `deps` arrives as a parameter, and both React's lint and the compiler require
 * a dependency list to be an array literal they can read at the call site. A
 * hook forwarding someone else's array cannot satisfy that. Comparing the array
 * and re-deriving state during render is React's documented answer for state
 * that depends on changed inputs — React re-renders immediately with the new
 * controller and discards this pass, so nothing stale ever commits, and unlike a
 * ref it stays readable by the compiler.
 */
const useForm = <TFields extends string>(
    factory: () => FormController<TFields>,
    deps: ReadonlyArray<unknown> = [],
): [FormState<TFields>, FormController<TFields>] => {
    const [cache, setCache] = useState<{ controller: FormController<TFields>; deps: ReadonlyArray<unknown> }>(() => {
        return {
            controller: factory(),
            deps: [...deps],
        };
    });

    if (!sameDeps(cache.deps, deps)) {
        setCache({ controller: factory(), deps: [...deps] });
    }

    const { controller } = cache;
    const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

    useEffect(() => controller.destroy, [controller]);

    return [state, controller];
};

export { useForm };
