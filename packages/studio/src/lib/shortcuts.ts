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
let current: Shortcuts = { ...DEFAULT_SHORTCUTS, ...loadJsonArray<Shortcuts>(STORAGE_KEY)[0] };

const listeners = new Set<() => void>();

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

    current = { ...current, [name]: key.toLowerCase() };
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

export { DEFAULT_SHORTCUTS, resetShortcuts, setShortcut, useShortcuts };
export type { Shortcuts };
