import type { FormController, FormState } from "../core";

/**
 * Bind a core form controller to Svelte 5 runes.
 *
 * This is the entire Svelte↔core seam, and it is the port's whole argument: the
 * React version of this file is fifteen lines of `useSyncExternalStore`, this
 * one is fifteen lines of `$state`, and everything a form *does* — validation,
 * double-submit suppression, error mapping — is shared between them, untouched.
 *
 * `$effect` is deliberately not used for the subscription: the controller
 * outlives any single effect scope, and the component owns teardown by calling
 * `destroy()` in its own `$effect` cleanup.
 */
const createFormState = <TFields extends string>(
    controller: FormController<TFields>,
): { readonly controller: FormController<TFields>; readonly state: FormState<TFields> } => {
    let snapshot = $state(controller.getState());

    controller.subscribe(() => {
        snapshot = controller.getState();
    });

    return {
        controller,
        get state() {
            return snapshot;
        },
    };
};

export { createFormState };
