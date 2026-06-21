import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import type { ReactNode } from "react";

const ENTER = Easing.bezier(0.16, 1, 0.3, 1);
const EXIT = Easing.bezier(0.4, 0, 1, 1);

/**
 * Wraps a scene with a consistent enter (fade + lift up) and exit (fade + lift
 * away) keyed off the scene's local frame, so sequential <Sequence> cuts read
 * as soft crossfades. Pass the scene's own `durationInFrames`.
 */
export const Stage: React.FC<{
    durationInFrames: number;
    children: ReactNode;
    enter?: number;
    exit?: number;
}> = ({ durationInFrames, children, enter = 16, exit = 14 }) => {
    const frame = useCurrentFrame();

    const enterO = interpolate(frame, [0, enter], [0, 1], {
        easing: ENTER,
        extrapolateRight: "clamp",
    });
    const exitO = interpolate(frame, [durationInFrames - exit, durationInFrames], [1, 0], {
        easing: EXIT,
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });
    const enterY = interpolate(frame, [0, enter], [18, 0], {
        easing: ENTER,
        extrapolateRight: "clamp",
    });
    const exitY = interpolate(frame, [durationInFrames - exit, durationInFrames], [0, -14], {
        easing: EXIT,
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });

    return (
        <AbsoluteFill
            style={{
                opacity: enterO * exitO,
                transform: `translateY(${enterY + exitY}px)`,
            }}
        >
            {children}
        </AbsoluteFill>
    );
};
