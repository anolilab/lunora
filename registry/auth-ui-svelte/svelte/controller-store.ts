/**
 * The Svelte↔core seam: bind any framework-agnostic {@link Controller} to a
 * Svelte readable store. This one helper is the entire adapter — every card uses
 * it, the mirror of React's `useController`.
 *
 * The controller is created once (during component init, so its form state
 * survives re-renders), its state is exposed through a `readable` store that
 * re-emits on every `subscribe` notification, and it is `destroy()`-ed when the
 * store's last subscriber goes away — i.e. when the component unmounts.
 */
import type { Readable } from "svelte/store";
import { readable } from "svelte/store";

import type { Controller, ControllerContext } from "../core";
import { useAuthUI } from "./context";

/** What {@link controllerStore} hands back: a live state store plus the actions. */
interface ControllerStore<TState, TActions> {
    actions: TActions;
    state: Readable<TState>;
}

/**
 * Create a core controller from the ambient auth-UI context and expose its
 * state as a Svelte readable store. Read the store with the `$store` idiom in a
 * component and it stays current; the controller is disposed automatically when
 * the component tears down.
 * @param create Builds the controller from the resolved context. Because the
 * store subscribes eagerly and the controller is created at call time, invoke
 * `controllerStore` during component initialisation (Svelte's `getContext`
 * constraint), passing any per-mount options the factory closes over.
 */
const controllerStore = <TState, TActions>(create: (context: ControllerContext) => Controller<TState, TActions>): ControllerStore<TState, TActions> => {
    const context = useAuthUI();
    const controller = create(context);

    const state = readable<TState>(controller.getState(), (set) => {
        // Re-read synchronously in case state advanced between construction and
        // the first subscriber attaching.
        set(controller.getState());

        const unsubscribe = controller.subscribe(() => {
            set(controller.getState());
        });

        return () => {
            unsubscribe();
            controller.destroy();
        };
    });

    return { actions: controller.actions, state };
};

export type { ControllerStore };
export { controllerStore };
