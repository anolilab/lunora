"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type { FormController, FormState } from "../core/create-form-controller";

/**
 * Bind a core form controller to React. The controller is created once per
 * mount (so typing survives a re-render), read through `useSyncExternalStore`,
 * and destroyed on unmount.
 *
 * This is the entire React↔core seam for forms, and it is deliberately the only
 * thing in this directory that knows a hook exists. Everything a form *does* —
 * validation, double-submit, error mapping — is in `core/`, tested once, and
 * identical in the Svelte port ten lines away.
 *
 * There is no dependency list on purpose: rebuilding the controller would wipe
 * what the user typed and drop an in-flight submit. A factory that needs a prop
 * that changes reads it through a ref, as `ProjectsCard` does.
 */
const useForm = <TFields extends string>(factory: () => FormController<TFields>): [FormState<TFields>, FormController<TFields>] => {
    const [controller] = useState(factory);
    const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

    useEffect(() => controller.destroy, [controller]);

    return [state, controller];
};

export { useForm };
