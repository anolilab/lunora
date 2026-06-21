/**
 * Theme primitives for the studio — a tiny, dependency-free replacement for
 * `next-themes` (which is unmaintained and, more importantly, only ever toggles
 * `document.documentElement`; the studio scopes its `.dark` class to its own
 * root element so it can be embedded inside a host app without recoloring the
 * host). Storage is guarded exactly like {@link ./token-storage} /
 * {@link ./browser-storage} so a missing/throwing `localStorage` (SSR,
 * sandboxed iframe, privacy mode) degrades to in-memory defaults.
 */

/** What the user picked. `system` follows the OS `prefers-color-scheme`. */
type ThemePreference = "system" | "light" | "dark";

/** The concrete theme actually applied. */
type ResolvedTheme = "light" | "dark";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

const store = (): Storage | undefined => {
    try {
        return (globalThis as { localStorage?: Storage }).localStorage;
    } catch {
        // Accessing localStorage can throw in sandboxed iframes / privacy mode.
        return undefined;
    }
};

const isPreference = (value: unknown): value is ThemePreference => value === "system" || value === "light" || value === "dark";

// `matchMedia` is absent in the workerd / SSR runtimes the studio also builds
// for, but lib.dom types it as always-present — read it through an optional
// cast (like `store` above) so the runtime guard stays without a "needless
// optional chain" lint error.
const matchMedia = (): typeof globalThis.matchMedia | undefined => (globalThis as { matchMedia?: typeof globalThis.matchMedia }).matchMedia;

const THEME_STORAGE_KEY = "lunora-studio-theme";

/** Cycle order for the single-button toggle: system → light → dark → system. */
const THEME_ORDER: ReadonlyArray<ThemePreference> = ["system", "light", "dark"];

/** Read the persisted preference, falling back to `fallback` (default `system`) on any miss/throw. */
const loadThemePreference = (fallback: ThemePreference = "system"): ThemePreference => {
    try {
        const raw = store()?.getItem(THEME_STORAGE_KEY);

        return isPreference(raw) ? raw : fallback;
    } catch {
        return fallback;
    }
};

/** Persist the preference; silently no-ops when storage is unavailable. */
const saveThemePreference = (preference: ThemePreference): void => {
    const storage = store();

    if (storage === undefined) {
        return;
    }

    try {
        storage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
        /* quota / disabled storage — preference simply isn't persisted */
    }
};

/** The OS's current color scheme (`light` when `matchMedia` is unavailable). */
const getSystemTheme = (): ResolvedTheme => {
    try {
        return matchMedia()?.(DARK_MEDIA_QUERY).matches ? "dark" : "light";
    } catch {
        return "light";
    }
};

/** Collapse a preference + the live system theme into the concrete theme to apply. */
const resolveTheme = (preference: ThemePreference, system: ResolvedTheme): ResolvedTheme => (preference === "system" ? system : preference);

/** Subscribe to OS color-scheme changes; returns an unsubscribe (no-op when unsupported). */
const subscribeSystemTheme = (onChange: (system: ResolvedTheme) => void): (() => void) => {
    let mql: MediaQueryList | undefined;

    try {
        mql = matchMedia()?.(DARK_MEDIA_QUERY);
    } catch {
        mql = undefined;
    }

    if (mql === undefined) {
        return () => {};
    }

    const handler = (event: MediaQueryListEvent): void => {
        onChange(event.matches ? "dark" : "light");
    };

    mql.addEventListener("change", handler);

    return () => {
        mql.removeEventListener("change", handler);
    };
};

export type { ResolvedTheme, ThemePreference };
export { getSystemTheme, loadThemePreference, resolveTheme, saveThemePreference, subscribeSystemTheme, THEME_ORDER, THEME_STORAGE_KEY };
