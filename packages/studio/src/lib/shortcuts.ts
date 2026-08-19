import { useSyncExternalStore } from "react";

import { loadJsonArray, saveJson } from "./browser-storage";

/** The rebindable keys, by what they open. */
interface Shortcuts {
    /** The key pressed with Ctrl to toggle the operation console. */
    readonly console: string;
    /** The key pressed with ⌘/Ctrl to open the command palette. */
    readonly palette: string;
}

/** What ships, and what "Reset" restores. */
const DEFAULT_SHORTCUTS: Shortcuts = { console: "`", palette: "k" };

const STORAGE_KEY = "lunora-studio-shortcuts";

/**
 * The live bindings, plus everyone watching them.
 *
 * A module-level store rather than a `usePersistedValue` per consumer, because
 * the palette, the console and the settings pane are three separate components
 * and three separate `useState`s would not see each other's writes — rebinding a
 * key would only take effect on the next reload, which is exactly the kind of
 * setting that reads as broken.
 */
const listeners = new Set<() => void>();

/**
 * A stored value is only honoured when BOTH fields are the single characters
 * `setShortcut` would accept.
 *
 * Case-folded before every check and returned folded, because the consumers
 * compare against `event.key.toLowerCase()`: a binding persisted as `"K"` would
 * otherwise validate, store, and then never match a keypress. Folding first also
 * makes the duplicate check mean what it says — `"K"` and `"k"` are one binding,
 * not two.
 */
const validate = (stored: Partial<Shortcuts> | undefined): Shortcuts => {
    const toggle = typeof stored?.console === "string" ? stored.console.toLowerCase() : undefined;
    const palette = typeof stored?.palette === "string" ? stored.palette.toLowerCase() : undefined;

    return toggle?.length === 1 && palette?.length === 1 && toggle !== palette ? { console: toggle, palette } : DEFAULT_SHORTCUTS;
};

let current: Shortcuts = DEFAULT_SHORTCUTS;

/**
 * Hydrate from storage. `loadJsonArray` only proves the stored value is an array,
 * so a hand-edited or corrupted entry (`{"console": null}`, or both bindings the
 * same) would otherwise walk straight past every check `setShortcut` performs.
 */
const hydrateShortcuts = (): void => {
    current = validate(loadJsonArray<Partial<Shortcuts>>(STORAGE_KEY)[0]);

    for (const listener of listeners) {
        listener();
    }
};

hydrateShortcuts();

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};

/** The current snapshot. Identity is stable between writes, which `useSyncExternalStore` requires. */
const snapshot = (): Shortcuts => current;

/** Read the live bindings, re-rendering the caller whenever they change. */
const useShortcuts = (): Shortcuts => useSyncExternalStore(subscribe, snapshot, snapshot);

/**
 * Rebind one shortcut, persist it, and wake every consumer.
 *
 * A blank or multi-character key is refused rather than stored: `event.key` is
 * `"Shift"` or `"Dead"` for a modifier or a dead key, and binding one of those
 * produces a shortcut that can never fire and cannot be un-set from the UI that
 * set it.
 */
const setShortcut = (name: keyof Shortcuts, key: string): void => {
    if (key.length !== 1) {
        return;
    }

    const next = key.toLowerCase();
    const other = name === "console" ? "palette" : "console";

    // Both bindings accept Ctrl, so an identical key would fire BOTH on one
    // keydown — Ctrl+K would open the palette and toggle the console at once.
    // Swapping rather than refusing keeps every key reachable and never leaves
    // the pair in a state the operator cannot get out of.
    current = current[other] === next ? { ...current, [name]: next, [other]: current[name] } : { ...current, [name]: next };
    saveJson(STORAGE_KEY, [current]);

    for (const listener of listeners) {
        listener();
    }
};

/** Restore the shipped bindings. */
const resetShortcuts = (): void => {
    current = DEFAULT_SHORTCUTS;
    saveJson(STORAGE_KEY, [current]);

    for (const listener of listeners) {
        listener();
    }
};

export { DEFAULT_SHORTCUTS, hydrateShortcuts, resetShortcuts, setShortcut, useShortcuts };
export type { Shortcuts };
