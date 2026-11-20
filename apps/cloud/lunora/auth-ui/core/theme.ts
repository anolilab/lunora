/**
 * The `theme` seam: retint the cards without editing component source.
 *
 * `styles/auth-ui.css` never hard-codes a color — every declaration reads a
 * design token with a fallback (`var(--border, hsl(228 16% 88%))`), so an app
 * that ships the Lunora tokens already themes the auth UI for free. This module
 * covers the other case: overriding a handful of tokens for the auth screens
 * only, from config rather than CSS.
 *
 * The provider hands the defaults to `config.theme`, diffs what comes back, and
 * emits **only the changed** tokens as inline custom properties. That matters —
 * emitting all of them would shadow the app's own `--border`/`--primary` inside
 * the cards and silently break token inheritance for every themed app.
 */

/**
 * The tokens `auth-ui.css` consumes. Keys are camelCase; each maps to the
 * kebab-cased custom property of the same name (`cardForeground` →
 * `--card-foreground`).
 */
interface ThemeTokens {
    background: string;
    border: string;
    card: string;
    cardForeground: string;
    destructive: string;
    fontMono: string;
    fontSans: string;
    input: string;
    muted: string;
    mutedForeground: string;
    primary: string;
    primaryForeground: string;
    radius: string;
    ring: string;
    secondary: string;
    secondaryForeground: string;
    success: string;
}

/** Mirrors the `var(--token, <fallback>)` fallbacks in `styles/auth-ui.css`. */
const DEFAULT_THEME_TOKENS: ThemeTokens = {
    background: "hsl(0 0% 100%)",
    border: "hsl(228 16% 88%)",
    card: "hsl(0 0% 100%)",
    cardForeground: "hsl(240 14% 10%)",
    destructive: "hsl(0 72% 45%)",
    fontMono: "ui-monospace, monospace",
    fontSans: "ui-sans-serif, system-ui, sans-serif",
    input: "hsl(228 16% 88%)",
    muted: "hsl(228 16% 93%)",
    mutedForeground: "hsl(235 9% 42%)",
    primary: "hsl(240 14% 12%)",
    primaryForeground: "hsl(228 32% 97%)",
    radius: "0.5rem",
    ring: "hsl(256 72% 68%)",
    secondary: "hsl(228 16% 93%)",
    secondaryForeground: "hsl(240 14% 14%)",
    success: "hsl(160 60% 28%)",
};

/** `cardForeground` → `--card-foreground`. */
const toCustomProperty = (token: string): string => `--${token.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;

/**
 * Run the caller's `theme` and return the custom properties that actually
 * changed, ready to spread onto an element's inline style. Returns an empty
 * object when no `theme` is configured, so an unthemed app renders exactly the
 * markup it did before — no inline styles, full token inheritance.
 */
const resolveThemeVariables = (theme?: (defaults: ThemeTokens) => ThemeTokens): Readonly<Record<string, string>> => {
    if (!theme) {
        return {};
    }

    const resolved = theme({ ...DEFAULT_THEME_TOKENS });
    const variables: Record<string, string> = {};

    for (const token of Object.keys(DEFAULT_THEME_TOKENS) as (keyof ThemeTokens)[]) {
        const value = resolved[token];

        if (typeof value === "string" && value !== DEFAULT_THEME_TOKENS[token]) {
            variables[toCustomProperty(token)] = value;
        }
    }

    return variables;
};

export type { ThemeTokens };
export { DEFAULT_THEME_TOKENS, resolveThemeVariables };
