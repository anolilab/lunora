/**
 * Light / dark / system, for the appearance row in account settings.
 *
 * This is the one piece of the set that has nothing to do with better-auth — it
 * is here because the settings screen is where users look for it, and because
 * `styles/auth-ui.css` already reads the Lunora design tokens that a mode
 * switch has to flip.
 *
 * The mode is written to `document.documentElement` as `data-theme` and mirrored
 * to `localStorage`, which is the convention the Lunora templates already use.
 * An app with its own theme system passes `apply` and this stays a controlled
 * radio group over that.
 */
import { createStore } from "./store";
import type { Controller } from "./types";

type ThemeMode = "dark" | "light" | "system";

const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"];

/** Where the chosen mode is remembered across reloads. */
const THEME_STORAGE_KEY = "lunora-theme";

interface ThemeModeState {
    mode: ThemeMode;
    /** What `system` currently resolves to, so a view can show the effective theme. */
    resolved: "dark" | "light";
}

interface ThemeModeActions {
    setMode: (mode: ThemeMode) => void;
}

type ThemeModeController = Controller<ThemeModeState, ThemeModeActions>;

interface ThemeModeOptions {
    /** Replace the default DOM write with your own theme system's setter. */
    apply?: (mode: ThemeMode, resolved: "dark" | "light") => void;
    /** Skip reading/writing `localStorage` (for tests, or an app that persists server-side). */
    persist?: boolean;
}

const isThemeMode = (value: unknown): value is ThemeMode => typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);

/** What the OS currently prefers. Defaults to light where `matchMedia` is absent (SSR). */
const systemPrefers = (): "dark" | "light" => {
    const matchMedia = (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia;

    return matchMedia?.("(prefers-color-scheme: dark)").matches === true ? "dark" : "light";
};

const readStored = (): ThemeMode | undefined => {
    try {
        const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(THEME_STORAGE_KEY);

        return isThemeMode(stored) ? stored : undefined;
    } catch {
        // Safari in private mode throws on `localStorage` access rather than
        // returning null. A theme preference is not worth breaking a page over.
        return undefined;
    }
};

const createThemeModeController = (options: ThemeModeOptions = {}): ThemeModeController => {
    const initial = (options.persist === false ? undefined : readStored()) ?? "system";
    const store = createStore<ThemeModeState>({ mode: initial, resolved: initial === "system" ? systemPrefers() : initial });

    const apply = (mode: ThemeMode): void => {
        const resolved = mode === "system" ? systemPrefers() : mode;

        if (options.apply) {
            options.apply(mode, resolved);
        } else {
            const dataset = (globalThis as { document?: { documentElement?: { dataset?: Record<string, string> } } }).document?.documentElement?.dataset;

            if (dataset) {
                dataset["theme"] = resolved;
            }
        }

        store.update({ mode, resolved });
    };

    apply(initial);

    return {
        actions: {
            setMode: (mode: ThemeMode) => {
                if (options.persist !== false) {
                    try {
                        (globalThis as { localStorage?: Storage }).localStorage?.setItem(THEME_STORAGE_KEY, mode);
                    } catch {
                        // See `readStored` — a blocked storage jar must not break the toggle.
                    }
                }

                apply(mode);
            },
        },
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

export type { ThemeMode, ThemeModeActions, ThemeModeController, ThemeModeOptions, ThemeModeState };
export { createThemeModeController, THEME_MODES, THEME_STORAGE_KEY };
