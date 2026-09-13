"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

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
 * The cache is a ref rather than `useMemo(factory, deps)`: `deps` arrives as a
 * parameter, and both React's lint and the compiler require a dependency list to
 * be an array literal they can read at the call site. A hook that forwards someone
 * else's array cannot satisfy that, so it opts out of the contract instead of
 * pretending to keep it — and comparing the array here is exactly what `useMemo`
 * would have done anyway.
 */
const useForm = <TFields extends string>(
    factory: () => FormController<TFields>,
    deps: ReadonlyArray<unknown> = [],
): [FormState<TFields>, FormController<TFields>] => {
    const cache = useRef<{ controller: FormController<TFields>; deps: ReadonlyArray<unknown> } | undefined>(undefined);

    if (cache.current === undefined || !sameDeps(cache.current.deps, deps)) {
        cache.current = { controller: factory(), deps: [...deps] };
    }

    const { controller } = cache.current;
    const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

    useEffect(() => controller.destroy, [controller]);

    return [state, controller];
};

export { useForm };
