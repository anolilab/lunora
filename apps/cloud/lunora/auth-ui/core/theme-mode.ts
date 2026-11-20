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

const THEME_MODES: ReadonlyArray<ThemeMode> = ["system", "light", "dark"];

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

/**
 * The browser's storage, structurally typed. Naming the DOM `Storage` type (or
 * the bare `localStorage` global) trips the Node-builtins lint, which reads it
 * as the experimental Node API of the same name — this is the browser one.
 */
interface ThemeStorage {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
}

const storage = (): ThemeStorage | undefined =>
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- this is the browser's localStorage, reached off globalThis and guarded; the rule is matching Node's unrelated experimental global of the same name.
    (globalThis as { localStorage?: ThemeStorage }).localStorage;

const isThemeMode = (value: unknown): value is ThemeMode => typeof value === "string" && (THEME_MODES as ReadonlyArray<string>).includes(value);

/** What the OS currently prefers. Defaults to light where `matchMedia` is absent (SSR). */
const systemPrefers = (): "dark" | "light" => {
    const { matchMedia } = globalThis as { matchMedia?: (query: string) => { matches: boolean } };

    return matchMedia?.("(prefers-color-scheme: dark)").matches === true ? "dark" : "light";
};

const readStored = (): ThemeMode | undefined => {
    try {
        const stored = storage()?.getItem(THEME_STORAGE_KEY);

        return isThemeMode(stored) ? stored : undefined;
    } catch {
        // Safari in private mode throws on `localStorage` access rather than
        // returning null. A theme preference is not worth breaking a page over.
        return undefined;
    }
};

const createThemeModeController = (options: ThemeModeOptions = {}): ThemeModeController => {
    /*
     * `readStored()` returns undefined off the browser, so a server render
     * resolves `"system"` and the client resolves whatever was saved. That is a
     * genuine hydration difference — in *which radio reads as selected*, and
     * nothing more: nothing is written to the DOM here (see `apply`, which only
     * runs from `setMode`), so no theme is applied and no user-visible flash
     * occurs. An SSR app that wants the two renders identical passes
     * `persist: false` and drives the mode itself.
     */
    const stored = options.persist === false ? undefined : readStored();
    const initial = stored ?? "system";
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

    /*
     * Applied only when the user actually chose it through this control and it
     * was remembered — otherwise a saved "dark" is shown as selected on reload
     * while the page renders light, which reads as the setting not working.
     *
     * A *defaulted* mode is still not applied. Constructing a controller — which happens
     * merely by mounting an appearance card — must not reach out and rewrite a
     * global document attribute: an app with its own theming would be flipped to
     * the OS preference with no user action. The DOM is written on `setMode`,
     * and `state.resolved` reports what the mode means so a view can render the
     * current selection without anything having been changed.
     */
    if (stored !== undefined) {
        apply(stored);
    }

    return {
        actions: {
            setMode: (mode: ThemeMode) => {
                if (options.persist !== false) {
                    try {
                        storage()?.setItem(THEME_STORAGE_KEY, mode);
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
