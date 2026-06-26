/**
 * Lunora "Luna + Aurora" design tokens for JS/TS consumers (Remotion videos,
 * OG image generators, canvas, etc.). For CSS/Tailwind apps, import the sibling
 * `tokens.css` instead.
 *
 * Plain shared file — import by relative path from a sibling consumer, e.g.:
 *   import { aurora, neutrals } from "../design-tokens/tokens";
 *
 * Mirrors ./DESIGN.md §2. Identity: nocturnal · luminous · precise.
 */

/** Night & moonlight neutrals — cool blue-violet cast (hue ~240), not soot. */
export const neutrals = {
    /** Eclipse — the charcoal page/body base. */
    darkCoal: "#0e0e11",
    /** Midnight — section base. */
    coal: "hsl(240 14% 6%)",
    /** Panels, popovers, consoles. */
    surfaceRaised: "hsl(240 14% 9%)",
    /** Muted moonlight. */
    stone: "hsl(228 12% 86%)",
    /** Moonlight panel (inverted nav, sheets). */
    ivory: "hsl(228 32% 97%)",
    /** Primary text on night (cool, not pure white). */
    moonlight: "hsl(228 30% 96%)",
} as const;

/** The aurora ramp. Accents, not paint — cyan = info/active, violet = primary
 * glow (closest to a brand color), rose = emphasis. */
export const aurora = {
    cyan: "hsl(186 84% 56%)",
    violet: "hsl(256 72% 68%)",
    rose: "hsl(330 80% 64%)",
} as const;

/**
 * Hex equivalents of the canonical HSL tokens above. Same colors — provided for
 * JS consumers that need hex (e.g. concatenating an `${color}00` alpha suffix,
 * as the Remotion mesh-gradient does, which only works on hex).
 */
export const hex = {
    darkCoal: "#0e0e11",
    coal: "#0d0d11",
    surfaceRaised: "#14141a",
    stone: "#d7d9e0",
    ivory: "#f5f6fa",
    moonlight: "#f2f3f8",
    auroraCyan: "#31daed",
    auroraViolet: "#9273e8",
    auroraRose: "#ed5aa3",
} as const;

/** The signature gradient — use only on THE focal moment (headline, active state). */
export const auroraRibbon = `linear-gradient(to right, ${aurora.cyan}, ${aurora.violet}, ${aurora.rose})`;

export const fonts = {
    sans: '"Geist Sans", ui-sans-serif, system-ui, sans-serif',
    mono: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    display: '"Geist Sans", ui-sans-serif, system-ui, sans-serif',
} as const;

export const radius = {
    /** Structural chrome (nav, console, buttons) is sharp. */
    none: "0",
    sm: "calc(0.5rem - 4px)",
    md: "calc(0.5rem - 2px)",
    lg: "0.5rem",
} as const;

export const tokens = { neutrals, aurora, hex, auroraRibbon, fonts, radius } as const;

export default tokens;
