import type { Unsubscribe } from "./types";

/**
 * A tiny observer registry: a Set of callbacks with `add` (returns an
 * unsubscribe), a throw-isolated `emit`, and `clear`. Collapses the client's
 * several hand-rolled listener Sets into one shape so a new observer can't
 * forget to wrap `emit` in try/catch or to `clear()` on teardown. `T = void`
 * supports payload-free signals (e.g. token-expiry): `emit()` takes no argument.
 */
export default class Listeners<T = void> {
    private readonly listeners = new Set<(value: T) => void>();

    public add(listener: (value: T) => void): Unsubscribe {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    // The conditional rest tuple makes `emit()` argument-free for a
    // `Listeners<void>` and one-argument for every other payload.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- `[T] extends [void]` is the discriminant for the payload-free overload, not a value-position void
    public emit(...args: [T] extends [void] ? [] : [T]): void {
        const [value] = args as [T];

        for (const listener of this.listeners) {
            try {
                listener(value);
            } catch {
                /* listener threw — ignore */
            }
        }
    }

    public clear(): void {
        this.listeners.clear();
    }
}
