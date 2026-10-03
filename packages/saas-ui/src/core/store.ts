/**
 * A tiny immutable external store — the primitive under every controller here.
 *
 * `get` returns a stable reference between `set`s, which is what React's
 * `useSyncExternalStore` compares; a store that rebuilt its snapshot per call
 * would re-render forever. Svelte and the other adapters read the same handle
 * through their own subscription primitive.
 *
 * This is deliberately a copy of `packages/auth-ui/src/core/store.ts` rather
 * than an import of it. The two packages are both *source* that gets copied
 * into user projects, so a shared import would have to resolve inside every
 * consumer's `lunora/` directory — coupling two copy-in item families at the
 * file level to save thirty lines.
 */
interface Store<T> {
    /**
     * Drop every subscriber. This is what a controller's `destroy()` means:
     * releasing listeners, **not** pushing an emptied state at views that are
     * about to unmount.
     */
    clear: () => void;
    get: () => T;
    set: (next: T) => void;
    subscribe: (onChange: () => void) => () => void;
    update: (patch: Partial<T>) => void;
}

const createStore = <T extends object>(initial: T): Store<T> => {
    let state = initial;
    const listeners = new Set<() => void>();

    const notify = (): void => {
        for (const listener of listeners) {
            listener();
        }
    };

    return {
        clear: () => {
            listeners.clear();
        },
        get: () => state,
        set: (next: T) => {
            state = next;
            notify();
        },
        subscribe: (onChange: () => void) => {
            listeners.add(onChange);

            return () => {
                listeners.delete(onChange);
            };
        },
        update: (patch: Partial<T>) => {
            state = { ...state, ...patch };
            notify();
        },
    };
};

export type { Store };
export { createStore };
