import { createStore, onCleanup, reconcile } from "solid-js";

import type { ControllerContext } from "../core/config";
import type { Controller } from "../core/types";
import { useAuthUI } from "./provider";

/**
 * Solid 2's `createStore` overloads on "initial value" vs "projection function"
 * and separates the two with an internal `NoFn<T>` guard, which the package does
 * not export. This mirrors it so the value overload can be selected explicitly
 * for a generic state type.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- must match solid-js's own `NoFn<T> = T extends Function ? never : T` exactly, or the conditional types don't relate.
type NoFunction<T> = T extends Function ? never : T;

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
 * the caller (`<Show keyed>` / a `key` on the route) instead.
 * @param create Builds the controller from the resolved context.
 */
const createController = <TState extends object, TActions>(create: (context: ControllerContext) => Controller<TState, TActions>): [TState, TActions] => {
    const context = useAuthUI();
    const controller = create(context);

    // A bare `TState extends object` could structurally be a function, so the
    // value overload has to be selected explicitly — that is all this cast says.
    const [state, setState] = createStore<TState>(controller.getState() as NoFunction<TState>);

    const unsubscribe = controller.subscribe(() => {
        // `reconcile` diffs the fresh snapshot against the store so Solid only
        // notifies the fields that actually changed — mirrors the granularity of
        // React's `useSyncExternalStore` selector without a manual selector.
        //
        // Solid 2 setters are draft-first: `reconcile(next)` returns a function
        // that is applied to the draft, rather than a value handed to the setter
        // (which is how 1.x spelled it).
        setState((draft) => {
            reconcile(controller.getState())(draft);
        });
    });

    onCleanup(() => {
        unsubscribe();
        controller.destroy();
    });

    return [state, controller.actions];
};

export { createController };
