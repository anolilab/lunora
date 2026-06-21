/**
 * Lunora marketing-video tokens — pure monochrome (white on black). The video
 * is an Apple-style teaser: black space, white type, hairline instrument-panel
 * windows. Differentiate with weight, size, spacing, and OPACITY — never hue.
 */

export const BRAND = {
    /** Clean near-black base (Apple-keynote). */
    base: "#08080A",
    ink: "#FFFFFF",
    inkMuted: "rgba(255, 255, 255, 0.64)",
    inkFaint: "rgba(255, 255, 255, 0.40)",

    /** SOLID window/panel surface — code & terminal are never transparent. */
    surface: "#121216",
    surfaceSoft: "#1B1B21",
    /** Hairline borders — depth via line, never shadow. */
    hairline: "rgba(255, 255, 255, 0.16)",
    hairlineStrong: "rgba(255, 255, 255, 0.30)",

    /** In monochrome the "accent" is simply full white (emphasis = brightness). */
    accent: "#FFFFFF",
    /** Subtle metallic sheen for the wordmark (white → soft grey). */
    sheen: "linear-gradient(180deg, #FFFFFF 0%, #FFFFFF 45%, #BFBFC6 100%)",
    /**
     * The ONE deliberate aurora-violet moment: a soft glow behind the Lunora mark
     * on both logo reveals (kinetic climax + outro), so the single color beat is a
     * recurring brand signature, not an accident.
     */
    markGlow: "drop-shadow(0 12px 50px rgba(146, 115, 232, 0.35))",
} as const;

/**
 * Monochrome code syntax — differentiate tokens by OPACITY (lunora-design:
 * opacity before color). Brightest = keywords, dimmest = comments.
 */
export const SYNTAX = {
    plain: "rgba(255, 255, 255, 0.90)",
    keyword: "#FFFFFF",
    string: "rgba(255, 255, 255, 0.60)",
    number: "rgba(255, 255, 255, 0.78)",
    comment: "rgba(255, 255, 255, 0.32)",
    fn: "rgba(255, 255, 255, 0.90)",
    punct: "rgba(255, 255, 255, 0.48)",
} as const;

export const COPY = {
    name: "Lunora",
    domain: "lunora.sh",
    repo: "github.com/anolilab/lunora",
    builtFor: "Built for Cloudflare",
    tagline: "Real-time. End-to-end typed. On your own Cloudflare.",
    outroTagline: "Real-time, typed, and entirely yours.",
    /** Closing call-to-action — the first concrete step, mirrors the install scene. */
    cta: "pnpm dlx lunorash init",
    /** Kinetic-intro word flashes — one per beat, cut on the music stabs. */
    kinetic: ["REAL-TIME.", "TYPE-SAFE.", "EDGE-NATIVE.", "NO LOCK-IN.", "YOUR CLOUDFLARE."] as string[],
} as const;
