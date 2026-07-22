/**
 * A tiny immutable external store — the shared primitive under the bespoke
 * controllers (email OTP, and the later resource/list controllers) that don't
 * fit the single-form engine. `get` returns a stable reference between `set`s
 * (required by React's `useSyncExternalStore`); `set`/`update` swap in a fresh
 * object and notify.
 */
interface Store<T> {
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
