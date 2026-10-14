/**
 * The Angular↔core seam. `controllerSignal(factory)` is the single bridge every
 * card uses: it creates a core {@link Controller} from the resolved context,
 * mirrors its `getState()` into an Angular `signal` that updates inside
 * `subscribe`, and tears everything down (unsubscribe + `destroy()`) when the
 * owning `DestroyRef` fires. React's `useController` in signal form.
 *
 * It also owns the one moment the context *changes*: server discovery settles
 * once, early, and `resolveContext` answers with a new object. A controller
 * built from the old one holds the old plugin flags — and may have skipped its
 * initial load because a gate was off — so the bridge disposes it and builds a
 * replacement, exactly as React's `useController` does when its memo key moves.
 * Nothing else swaps the identity, so this costs one rebuild per page.
 */
import type { Signal } from "@angular/core";
import { DestroyRef, effect, inject, Injector, signal, untracked } from "@angular/core";

import type { ControllerContext } from "../core/config";
import type { Controller } from "../core/types";
import { injectAuthUIContext } from "./provider";

/**
 * Options for {@link controllerSignal}. Pass `context`/`injector` to call it
 * outside an injection context (e.g. lazily in `ngOnInit`, where option inputs
 * such as a reset `token` are already bound); omit them to resolve both from DI
 * in a field initializer or constructor.
 */
interface ControllerSignalOptions {
    context?: Signal<ControllerContext>;
    injector?: Injector;
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
    const context = options.context ?? injectAuthUIContext();
    const injector = options.injector ?? inject(Injector);

    /*
     * Built eagerly rather than inside the effect: a card reads `state()` in the
     * same tick it is constructed, and effects don't run until the first
     * change-detection pass.
     */
    let controller = untracked(() => factory(untracked(context)));
    let identity = untracked(context);
    const state = signal<TState>(controller.getState());

    /** Mirror one controller's pushes; captured so a stale one can't write back. */
    const listen = (owner: Controller<TState, TActions>): (() => void) =>
        owner.subscribe(() => {
            state.set(owner.getState());
        });

    let unsubscribe = listen(controller);

    effect(
        () => {
            const next = context();

            // The effect runs once for its own subscription too, and a factory is
            // free to read other signals — only a genuine identity swap is a
            // reason to throw away a live controller.
            if (next === identity) {
                return;
            }

            identity = next;
            unsubscribe();
            controller.destroy();
            controller = untracked(() => factory(next));
            state.set(controller.getState());
            unsubscribe = listen(controller);
        },
        { injector },
    );

    injector.get(DestroyRef).onDestroy(() => {
        unsubscribe();
        controller.destroy();
    });

    /*
     * Actions are reached through whichever controller is current, so a template
     * that bound `actions.submit` before a rebuild still calls the live one. The
     * alternative — handing out a signal of actions — would put `actions()` in
     * every binding of every card for a change that happens once.
     */
    const actions = new Proxy(
        {},
        {
            get: (_target: object, property: PropertyKey): unknown => (controller.actions as Record<PropertyKey, unknown>)[property],
        },
    ) as TActions;

    return { actions, state: state.asReadonly() };
};

export type { ControllerSignalOptions, ControllerSignalResult };
export { controllerSignal };
