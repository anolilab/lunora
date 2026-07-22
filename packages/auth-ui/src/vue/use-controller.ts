import type { ShallowRef } from "vue";
import { onScopeDispose, shallowRef } from "vue";

import type { Controller, ControllerContext } from "../core";
import { useAuthUI } from "./provider";

/**
 * Bind any core {@link Controller} to Vue. The controller is created once for
 * the lifetime of the calling scope; its state is streamed into a `shallowRef`
 * (results are replaced wholesale on every push, never mutated in place, so deep
 * reactivity would only add overhead), and it is disposed when the owning effect
 * scope stops (component unmount). This one composable is the entire Vue↔core
 * seam — every card uses it.
 *
 * Call inside `setup()` (or any active effect scope). Reactive options that a
 * controller closes over (e.g. a reset token) should be passed as plain values
 * captured at call time — mirror React's `deps` by re-mounting the card instead.
 */
const useController = <TState, TActions>(
    factory: (context: ControllerContext) => Controller<TState, TActions>,
): { actions: TActions; state: ShallowRef<TState> } => {
    const context = useAuthUI();
    const controller = factory(context);

    const state = shallowRef(controller.getState()) as ShallowRef<TState>;

    const stop = controller.subscribe(() => {
        state.value = controller.getState();
    });

    onScopeDispose(() => {
        stop();
        controller.destroy();
    });

    return { actions: controller.actions, state };
};

export { useController };
