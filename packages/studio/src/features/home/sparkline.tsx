import type { ReactElement } from "react";

// Geometry of the recharts bar sparkline this replaces, so the stat cards look
// unchanged: a 112×32 box (`w-28 h-8`), recharts' default 5px plot margin, a 1px
// gap either side of each bar, and the 3px the old custom bar shape trimmed off
// every bar's bottom edge.
const WIDTH = 112;
const HEIGHT = 32;
const MARGIN = 5;
const GAP = 1;
const BOTTOM_TRIM = 3;
const MAX_POINTS = 16;

export interface SparklineBar {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
}

/** Bar rectangles (in the 112×32 viewBox) for the newest `MAX_POINTS` values, scaled to the series max. */
export const sparklineBars = (data: ReadonlyArray<number>): SparklineBar[] => {
    const values = data.slice(-MAX_POINTS);
    const max = Math.max(0, ...values);
    const plotHeight = HEIGHT - MARGIN * 2;
    const slot = (WIDTH - MARGIN * 2) / values.length;

    return values.map((value, index) => {
        const barHeight = max > 0 ? (Math.max(0, value) / max) * plotHeight : 0;

        return {
            height: Math.max(0, barHeight - BOTTOM_TRIM),
            width: Math.max(0, slot - GAP * 2),
            x: MARGIN + index * slot + GAP,
            y: HEIGHT - MARGIN - barHeight,
        };
    });
};

/**
 * A compact monochrome bar sparkline drawn from a numeric series (oldest →
 * newest), as plain SVG. The stat cards were the only reason Home fetched
 * `recharts` (plus `motion` and the evilcharts wrapper, ~185 KiB gzipped) for a
 * chart with no axes, tooltip or animation; a handful of `<rect>`s draw the same.
 * Decorative, like the chart it replaces: the card prints the value beside it.
 */
export const Sparkline = ({ data }: { readonly data: ReadonlyArray<number> }): ReactElement => (
    <svg aria-hidden="true" className="h-8 w-28 fill-foreground" data-testid="home-sparkline" viewBox="0 0 112 32">
        {sparklineBars(data).map((bar) => (
            // x is unique per bar, and a bar's slot is its identity.
            <rect height={bar.height} key={bar.x} rx={2} width={bar.width} x={bar.x} y={bar.y} />
        ))}
    </svg>
);
