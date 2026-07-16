import { LunoraError } from "@lunora/errors";
import type { ReactNode } from "react";
import { createContext, use, useEffect, useState } from "react";

import type { ResolvedTheme, ThemePreference } from "../lib/theme";
import { getSystemTheme, loadThemePreference, resolveTheme, saveThemePreference, subscribeSystemTheme, THEME_ORDER } from "../lib/theme";

/**
 * A dependency-free theme provider in the shape of the shadcn Vite dark-mode
 * pattern (https://ui.shadcn.com/docs/dark-mode/vite) — `next-themes` is
 * unmaintained and only toggles `document.documentElement`. The one deliberate
 * divergence from the shadcn snippet: this provider does NOT touch
 * `documentElement`. It exposes `resolvedTheme` and the studio applies the
 * `.dark` class to its own scoped root, so the studio can be embedded inside a
 * host app without recoloring the host. Default is `system`.
 */
interface ThemeContextValue {
    /** Advance the preference one step: system → light → dark → system. */
    readonly cycleTheme: () => void;
    /** The concrete `light`/`dark` to apply, after resolving `system`. */
    readonly resolvedTheme: ResolvedTheme;
    /** Set (and persist) the preference. */
    readonly setTheme: (theme: ThemePreference) => void;
    /** The live OS color scheme. */
    readonly systemTheme: ResolvedTheme;
    /** The user's selection: `system` follows the OS. */
    readonly theme: ThemePreference;
}

interface ThemeProviderProps {
    readonly children: ReactNode;
    /** Preference used when nothing is persisted yet. Defaults to `system`. */
    readonly defaultTheme?: ThemePreference;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const ThemeProvider = ({ children, defaultTheme = "system" }: ThemeProviderProps): ReactNode => {
    const [theme, setThemeState] = useState<ThemePreference>(() => loadThemePreference(defaultTheme));
    const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());

    // Track the OS scheme live so `system` re-resolves when the OS flips.
    useEffect(() => subscribeSystemTheme(setSystemTheme), []);

    const setTheme = (next: ThemePreference): void => {
        saveThemePreference(next);
        setThemeState(next);
    };

    const cycleTheme = (): void => {
        setThemeState((current) => {
            // The modulo keeps the index in range, but `noUncheckedIndexedAccess`
            // still types the access as `… | undefined`; fall back to `current`.
            const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length] ?? current;

            saveThemePreference(next);

            return next;
        });
    };

    const value = { cycleTheme, resolvedTheme: resolveTheme(theme, systemTheme), setTheme, systemTheme, theme };

    return <ThemeContext value={value}>{children}</ThemeContext>;
};

/**
 * Render `children` under a theme context, creating a {@link ThemeProvider}
 * only when the host didn't already mount one. `StudioApp` owns a provider (so
 * its login page and scoped root share the preference), but the composable
 * `&lt;Studio>` is a public export an embedder mounts bare — without this its
 * header `&lt;ThemeToggle>` would throw. Mirrors the inherit-or-own pattern the
 * i18n provider uses.
 */
const EnsureThemeProvider = ({ children }: { readonly children: ReactNode }): ReactNode => {
    const existing = use(ThemeContext);

    return existing === null ? <ThemeProvider>{children}</ThemeProvider> : children;
};

/** Read the theme context. Throws if used outside {@link ThemeProvider}. */
const useTheme = (): ThemeContextValue => {
    const context = use(ThemeContext);

    if (context === null) {
        throw new LunoraError("INTERNAL", "useTheme must be used within a <ThemeProvider>");
    }

    return context;
};

export type { ThemeContextValue, ThemeProviderProps };
export { EnsureThemeProvider, ThemeProvider, useTheme };
