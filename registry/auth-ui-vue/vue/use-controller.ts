import type { ShallowRef } from "vue";
import { onScopeDispose, shallowRef, watch } from "vue";

import type { ControllerContext } from "../core/config";
import type { Controller } from "../core/types";
import { useAuthUIContextRef } from "./provider";

/**
 * Bind any core {@link Controller} to Vue. The controller is created for the
 * lifetime of the calling scope; its state is streamed into a `shallowRef`
 * (results are replaced wholesale on every push, never mutated in place, so deep
 * reactivity would only add overhead), and it is disposed when the owning effect
 * scope stops (component unmount). This one composable is the entire Vue↔core
 * seam — every card uses it.
 *
 * It is rebuilt on exactly one other occasion: when the provider swaps the
 * context *identity*, which happens once, when server discovery answers. A
 * controller built on the pre-discovery context is running against the wrong
 * plugin set, so it is thrown away and rebuilt — the same trade React makes by
 * memoizing on the context object. Identity, never value, is the trigger, so
 * ordinary prop churn cannot blank a form mid-typing.
 *
 * Call inside `setup()` (or any active effect scope). Reactive options that a
 * controller closes over (e.g. a reset token) should be passed as plain values
 * captured at call time — mirror React's `deps` by re-mounting the card instead.
 */
const useController = <TState, TActions>(
    factory: (context: ControllerContext) => Controller<TState, TActions>,
): { actions: TActions; state: ShallowRef<TState> } => {
    const context = useAuthUIContextRef();

    let controller = factory(context.value);

    const state = shallowRef(controller.getState()) as ShallowRef<TState>;

    const listen = (): (() => void) =>
        controller.subscribe(() => {
            state.value = controller.getState();
        });

    let unsubscribe = listen();

    const release = (): void => {
        unsubscribe();
        controller.destroy();
    };

    watch(context, (next) => {
        release();
        controller = factory(next);
        // Published before re-subscribing: the rebuilt controller's opening state
        // (a fresh `loading: true`, say) is set while nobody is listening yet.
        state.value = controller.getState();
        unsubscribe = listen();
    });

    onScopeDispose(release);

    /*
     * `actions` is read out of this scope once and then held by the template for
     * good, so it has to outlive the controller it forwards to. This pass-through
     * keeps one identity across a rebuild; the core actions are closures rather
     * than methods, so there is no `this` to preserve.
     */
    const actions = new Proxy({} as object & TActions, {
        get: (_target, key) => Reflect.get(controller.actions as object, key) as unknown,
    }) as TActions;

    return { actions, state };
};

export { useController };
