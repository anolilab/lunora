/**
 * A tiny immutable external store — the shared primitive under every controller,
 * the form engine included. `get` returns a stable reference between `set`s
 * (required by React's `useSyncExternalStore`); `set`/`update` swap in a fresh
 * object and notify; `clear` drops subscribers for teardown.
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
