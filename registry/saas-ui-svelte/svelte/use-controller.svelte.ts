/**
 * Bind a core controller to Svelte 5 runes — `createFormState`'s seam, for a
 * controller that is not a form.
 *
 * `$state.raw`, not `$state`: the snapshot is replaced whole on every change and
 * never mutated, so a deep proxy over it would only cost a copy of each row.
 *
 * Call it during component initialisation: it registers its own teardown.
 */
const bindController = <TState>(controller: {
    destroy: () => void;
    getState: () => TState;
    subscribe: (onChange: () => void) => () => void;
}): { readonly state: TState } => {
    let snapshot = $state.raw(controller.getState());

    controller.subscribe(() => {
        snapshot = controller.getState();
    });

    $effect(() => () => {
        controller.destroy();
    });

    return {
        get state() {
            return snapshot;
        },
    };
};

export { bindController };
