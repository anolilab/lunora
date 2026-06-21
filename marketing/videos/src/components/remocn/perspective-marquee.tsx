import { AbsoluteFill, useCurrentFrame } from "remotion";

import { useFormat } from "../../shared/format";
import { FONT_SANS } from "../../shared/fonts";
import { BRAND } from "../../shared/theme";

/**
 * A 3D-tilted infinite marquee — a frame-driven adaptation of remocn's
 * `PerspectiveMarquee` (https://www.remocn.dev/docs/typography/perspective-marquee).
 * The scroll is computed from `useCurrentFrame()` (never a CSS animation, which
 * wouldn't render in Remotion); items roll toward the horizon with a
 * depth-of-field blur + edge vignette. Items are tripled for a seamless loop and
 * laid out in fixed-width slots so the wrap is pixel-exact.
 */
export const PerspectiveMarquee: React.FC<{
    items: string[];
    fontSize?: number;
    color?: string;
    fontWeight?: number;
    /** Horizontal scroll speed (px/frame). Negative scrolls the other way. */
    pixelsPerFrame?: number;
    rotateY?: number;
    rotateX?: number;
    perspective?: number;
    /** Color of the edge vignette gradient. */
    fadeColor?: string;
    speed?: number;
    /** Fixed per-item slot width; defaults to scale with `fontSize`. */
    slotWidth?: number;
}> = ({
    items,
    fontSize = 96,
    color = BRAND.ink,
    fontWeight = 700,
    pixelsPerFrame = 2,
    rotateY = -26,
    rotateX = 8,
    perspective = 1200,
    fadeColor = BRAND.base,
    speed = 1,
    slotWidth,
}) => {
    const frame = useCurrentFrame();
    const { width } = useFormat();

    const slot = slotWidth ?? fontSize * 4.4;
    const setWidth = slot * items.length;
    const raw = frame * pixelsPerFrame * speed;
    const offset = ((raw % setWidth) + setWidth) % setWidth; // normalize for either direction
    const tripled = [...items, ...items, ...items];

    return (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "center", perspective: `${perspective}px`, width: "100%" }}>
                <div
                    style={{
                        display: "flex",
                        transform: `rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateX(${-offset}px)`,
                        transformStyle: "preserve-3d",
                        whiteSpace: "nowrap",
                    }}
                >
                    {tripled.map((label, i) => {
                        // Position within the looping strip (0..1) → fade/blur toward horizon.
                        const t = ((((i * slot) % setWidth) + setWidth) % setWidth) / setWidth;
                        const depth = Math.abs(t - 0.5) * 2; // 0 at center of travel, 1 at the wrap edges
                        return (
                            <div key={i} style={{ flexShrink: 0, textAlign: "center", width: slot }}>
                                <span
                                    style={{
                                        color,
                                        filter: `blur(${depth * 4}px)`,
                                        fontFamily: FONT_SANS,
                                        fontSize,
                                        fontWeight,
                                        letterSpacing: -fontSize * 0.02,
                                        opacity: 1 - depth * 0.55,
                                    }}
                                >
                                    {label}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>
            {/* Edge vignette — depth fade to the horizon on both sides. */}
            <AbsoluteFill
                style={{
                    background: `linear-gradient(90deg, ${fadeColor} 0%, transparent 16%, transparent 84%, ${fadeColor} 100%)`,
                    pointerEvents: "none",
                }}
            />
        </AbsoluteFill>
    );
};
