import { Easing, interpolate, useCurrentFrame } from "remotion";

import { FONT_SANS } from "./fonts";
import { BRAND, COPY } from "./theme";

/**
 * The "Lunora" wordmark in a subtle white→grey metallic sheen (monochrome).
 * Ease-out reveal (blur → sharp, slight lift), no spring/bounce.
 */
export const Wordmark: React.FC<{ fontSize?: number; delay?: number }> = ({ fontSize = 150, delay = 0 }) => {
    const frame = useCurrentFrame() - delay;
    const reveal = interpolate(frame, [0, 24], [0, 1], {
        easing: Easing.out(Easing.cubic),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });
    const blur = interpolate(frame, [0, 24], [10, 0], {
        easing: Easing.out(Easing.cubic),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });
    const lift = interpolate(frame, [0, 24], [14, 0], {
        easing: Easing.out(Easing.cubic),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });

    return (
        <span
            style={{
                backgroundImage: BRAND.sheen,
                backgroundClip: "text",
                WebkitBackgroundClip: "text",
                color: "transparent",
                display: "inline-block",
                filter: `blur(${blur}px)`,
                fontFamily: FONT_SANS,
                fontSize,
                fontWeight: 600,
                letterSpacing: -fontSize * 0.025,
                lineHeight: 1,
                opacity: reveal,
                transform: `translateY(${lift}px)`,
            }}
        >
            {COPY.name}
        </span>
    );
};
