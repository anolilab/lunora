import { Easing, interpolate, useCurrentFrame } from "remotion";

import { FONT_SANS } from "./fonts";
import { BRAND } from "./theme";

const EASE = Easing.out(Easing.cubic);

/**
 * A single section title pinned near the top of a feature scene. Self-reveals
 * from its local frame 0 (fade + small lift). No counters — the title carries it.
 */
export const SceneLabel: React.FC<{ title: string }> = ({ title }) => {
    const frame = useCurrentFrame();
    const reveal = interpolate(frame, [0, 16], [0, 1], { easing: EASE, extrapolateRight: "clamp" });
    const lift = interpolate(frame, [0, 16], [-10, 0], { easing: EASE, extrapolateRight: "clamp" });

    return (
        <div
            style={{
                fontFamily: FONT_SANS,
                left: 0,
                opacity: reveal,
                position: "absolute",
                right: 0,
                textAlign: "center",
                top: 100,
                transform: `translateY(${lift}px)`,
            }}
        >
            <span style={{ color: BRAND.ink, fontSize: 42, fontWeight: 600, letterSpacing: -1 }}>{title}</span>
        </div>
    );
};
