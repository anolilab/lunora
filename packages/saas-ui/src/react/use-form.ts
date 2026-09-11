"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { FormController, FormState } from "../core";

/**
 * Bind a core form controller to React. The controller is created once per
 * `deps` (so typing survives a re-render), read through `useSyncExternalStore`,
 * and destroyed on unmount.
 *
 * This is the entire React↔core seam for forms, and it is deliberately the only
 * thing in this directory that knows a hook exists. Everything a form *does* —
 * validation, double-submit, error mapping — is in `core/`, tested once, and
 * identical in the Svelte port ten lines away.
 */
const useForm = <TFields extends string>(
    factory: () => FormController<TFields>,
    deps: ReadonlyArray<unknown> = [],
): [FormState<TFields>, FormController<TFields>] => {
    const controller = useMemo(factory, deps);
    const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

    useEffect(() => controller.destroy, [controller]);

    return [state, controller];
};

export { useForm };
