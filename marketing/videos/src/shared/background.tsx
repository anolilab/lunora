import { AbsoluteFill } from "remotion";

import { BRAND } from "./theme";

/**
 * A clean, Apple-keynote backdrop: near-black with a whisper of light at the top
 * and a soft vignette to pure black at the edges. No stars, no grid, no motion —
 * the content carries everything; the stage just sits there, calm and dark.
 */
export const Background: React.FC = () => (
    <AbsoluteFill style={{ background: BRAND.base }}>
        <AbsoluteFill style={{ background: "radial-gradient(70% 50% at 50% 0%, rgba(255,255,255,0.05), transparent 70%)" }} />
        <AbsoluteFill style={{ background: "radial-gradient(120% 90% at 50% 45%, transparent 55%, rgba(0,0,0,0.6) 100%)" }} />
    </AbsoluteFill>
);
