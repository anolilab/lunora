import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import type { CSSProperties } from "react";

const { fontFamily: geist } = loadGeist();
const { fontFamily: geistMono } = loadGeistMono();

export const FONT_SANS = geist;
export const FONT_MONO = geistMono;

/**
 * remocn components reference `--font-geist-sans` / `--font-geist-mono` CSS
 * variables (they were authored for a Next.js app that defines them globally).
 * Spread this onto the root <AbsoluteFill> of every composition so the
 * variables resolve during both Studio preview and headless render.
 */
export const fontVars = {
    "--font-geist-sans": geist,
    "--font-geist-mono": geistMono,
} as CSSProperties;
