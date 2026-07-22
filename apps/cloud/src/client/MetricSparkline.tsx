import type { ReactElement } from "react";

import { formatValue } from "./metric-format";

/**
 * The metric-trend rendering shared by the Metrics tab and the custom-dashboard
 * metric panels: an inline-SVG sparkline over a series' bucketed points, and a
 * direction/delta trend badge. Extracted so a dashboard `metric` panel renders a
 * series exactly as the Metrics tab does (no divergent copy).
 */

/** One point on a metric's trend line — an epoch-ms bucket start + its value. */
export interface SparklinePoint {
    t: number;
    value: number;
}

/**
 * A minimal inline-SVG sparkline over a metric's bucketed trend points. Points
 * are spaced evenly on x (by index) and scaled to the series' own min→max on y,
 * so a flat series still renders a centered line rather than dividing by zero.
 */
export const Sparkline = ({ points }: { points: readonly SparklinePoint[] }): ReactElement => {
    if (points.length === 0) {
        return <div className="metric-spark metric-spark-empty" />;
    }

    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const step = points.length > 1 ? 100 / (points.length - 1) : 0;

    // y is inverted (SVG origin top-left): the max value sits at y=2, min at y=28.
    const coords = points.map((point, index) => `${(index * step).toFixed(2)},${(28 - ((point.value - min) / span) * 26).toFixed(2)}`).join(" ");

    return (
        <svg className="metric-spark" preserveAspectRatio="none" role="img" viewBox="0 0 100 30">
            {points.length === 1 ? (
                <circle cx="50" cy="15" r="1.5" />
            ) : (
                <polyline fill="none" points={coords} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            )}
        </svg>
    );
};

/** Direction arrow + delta for a series' net movement over the window. */
export const TrendBadge = ({ trend }: { trend: number }): ReactElement => {
    const direction = trend > 0 ? "up" : trend < 0 ? "down" : "flat";
    const arrow = trend > 0 ? "▲" : trend < 0 ? "▼" : "→";

    return (
        <span className={`metric-trend metric-trend-${direction}`}>
            {arrow} {formatValue(Math.abs(trend))}
        </span>
    );
};
