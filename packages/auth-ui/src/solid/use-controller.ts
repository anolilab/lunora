import { onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import type { ControllerContext } from "../core/config";
import type { Controller } from "../core/types";
import { useAuthUI } from "./provider";

/**
 * Bind any core {@link Controller} to Solid. The controller is created once when
 * the calling component mounts, its state is mirrored into a `createStore` (so
 * reads are fine-grained and only the touched fields re-render), and it's
 * disposed on cleanup. This one function is the entire Solid↔core seam — every
 * card uses it.
 *
 * Unlike the React `useController` there is no dependency array: a Solid
 * component body runs once, so any options the factory closes over are captured
 * at creation. Cards that need to react to changing props should be re-keyed by
 * the caller (`&lt;Show keyed>` / a `key` on the route) instead.
 * @param create Builds the controller from the resolved context.
 */
const createController = <TState extends object, TActions>(create: (context: ControllerContext) => Controller<TState, TActions>): [TState, TActions] => {
    const context = useAuthUI();
    const controller = create(context);

    const [state, setState] = createStore<TState>(controller.getState());

    const unsubscribe = controller.subscribe(() => {
        // `reconcile` diffs the fresh snapshot against the store so Solid only
        // notifies the fields that actually changed — mirrors the granularity of
        // React's `useSyncExternalStore` selector without a manual selector.
        setState(reconcile(controller.getState()));
    });

    onCleanup(() => {
        unsubscribe();
        controller.destroy();
    });

    return [state, controller.actions];
};

export { createController };
