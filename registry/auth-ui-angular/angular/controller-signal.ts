/**
 * The Angular↔core seam. `controllerSignal(factory)` is the single bridge every
 * card uses: it creates a core {@link Controller} from the resolved context,
 * mirrors its `getState()` into an Angular `signal` that updates inside
 * `subscribe`, and tears everything down (unsubscribe + `destroy()`) when the
 * owning `DestroyRef` fires. React's `useController` in signal form.
 */
import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";

import type { Controller, ControllerContext } from "../core";
import { injectAuthUI } from "./provider";

/**
 * Options for {@link controllerSignal}. Pass `context`/`destroyRef` to call it
 * outside an injection context (e.g. lazily in `ngOnInit`, where option inputs
 * such as a reset `token` are already bound); omit them to resolve both from DI
 * in a field initializer or constructor.
 */
interface ControllerSignalOptions {
    context?: ControllerContext;
    destroyRef?: DestroyRef;
}

/** The bridged result: a read-only state `signal` plus the controller's actions. */
interface ControllerSignalResult<TState, TActions> {
    actions: TActions;
    state: Signal<TState>;
}

const controllerSignal = <TState, TActions>(
    factory: (context: ControllerContext) => Controller<TState, TActions>,
    options: ControllerSignalOptions = {},
): ControllerSignalResult<TState, TActions> => {
    const context = options.context ?? injectAuthUI();
    const destroyRef = options.destroyRef ?? inject(DestroyRef);
    const controller = factory(context);

    const state = signal<TState>(controller.getState());

    const unsubscribe = controller.subscribe(() => {
        state.set(controller.getState());
    });

    destroyRef.onDestroy(() => {
        unsubscribe();
        controller.destroy();
    });

    return { actions: controller.actions, state: state.asReadonly() };
};

export type { ControllerSignalOptions, ControllerSignalResult };
export { controllerSignal };
