import { useVideoConfig } from "remotion";

export type Orientation = "landscape" | "portrait" | "square";

/**
 * Derives the current composition's orientation + responsive helpers from
 * `useVideoConfig()`, so one set of scenes renders correctly at 16:9, 9:16 and
 * 1:1 (see the three compositions in `root.tsx`). Scenes that hold fixed-width
 * chrome (terminal, code, chat windows) call `fitWidth()` to cap to the canvas.
 */
export const useFormat = () => {
    const { width, height, fps } = useVideoConfig();
    const ratio = width / height;
    const orientation: Orientation = ratio > 1.15 ? "landscape" : ratio < 0.85 ? "portrait" : "square";

    return {
        width,
        height,
        fps,
        orientation,
        isLandscape: orientation === "landscape",
        isPortrait: orientation === "portrait",
        isSquare: orientation === "square",
        /** Cap a design width to the canvas, leaving side margins on narrow formats. */
        fitWidth: (designWidth: number, margin = 70): number => (orientation === "landscape" ? designWidth : Math.min(designWidth, width - margin * 2)),
        /** Pick a value per orientation (landscape default; portrait/square overrides). */
        pick: <T>(landscape: T, portrait: T, square?: T): T =>
            orientation === "landscape" ? landscape : orientation === "square" ? (square ?? portrait) : portrait,
    };
};
