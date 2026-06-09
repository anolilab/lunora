import { useCallback, useMemo, useState } from "react";

/** The selection state + actions returned by {@link useKeySelection}. */
interface KeySelection {
    /** True when every current item is selected (and there is at least one). */
    readonly allSelected: boolean;
    /** Reset the selection to empty. */
    readonly clear: () => void;
    /** The selected keys. */
    readonly selected: ReadonlySet<string>;
    /** True when some — but not all — items are selected (drives an indeterminate checkbox). */
    readonly someSelected: boolean;
    /** Add or remove a single key from the selection. */
    readonly toggle: (key: string) => void;
    /** Select every current item, or clear when all are already selected. */
    readonly toggleAll: () => void;
}

/**
 * A generic checkbox-selection model over an arbitrary list, keyed by `keyOf`.
 * Tracks the selected keys in a `ReadonlySet` (correct for arbitrary string
 * keys — independent of any table library) and derives the header-checkbox
 * `allSelected` / `someSelected` flags from the live `items`.
 *
 * `toggleAll` selects everything currently in `items`, or clears when all are
 * already selected. The caller resets the selection on navigation via `clear`.
 */
const useKeySelection = <T>(items: ReadonlyArray<T>, keyOf: (item: T) => string): KeySelection => {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

    const toggle = useCallback((key: string): void => {
        setSelected((current) => {
            const next = new Set(current);

            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }

            return next;
        });
    }, []);

    const clear = useCallback((): void => {
        setSelected(new Set());
    }, []);

    const keys = useMemo(() => items.map((item) => keyOf(item)), [items, keyOf]);

    const allSelected = keys.length > 0 && keys.every((key) => selected.has(key));
    const someSelected = !allSelected && keys.some((key) => selected.has(key));

    const toggleAll = useCallback((): void => {
        setSelected((current) => (keys.every((key) => current.has(key)) ? new Set() : new Set(keys)));
    }, [keys]);

    return { allSelected, clear, selected, someSelected, toggle, toggleAll };
};

export { useKeySelection };
export type { KeySelection };
