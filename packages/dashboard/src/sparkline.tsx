import type { ReactElement } from "react";

/** Inline-SVG sparkline geometry, shared by the Metrics and Health/SLO panels. */
const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 24;

/**
 * Build an SVG polyline `points` string for a series, scaled to fit the
 * {@link SPARK_WIDTH} x {@link SPARK_HEIGHT} viewbox. A flat series (or one with
 * fewer than two points) renders along the vertical midline / as the empty
 * string, so callers can treat `""` as "nothing to draw yet".
 */
const sparklinePoints = (series: ReadonlyArray<number>): string => {
    if (series.length < 2) {
        return "";
    }

    const max = Math.max(...series);
    const min = Math.min(...series);
    const span = max - min;
    const stepX = SPARK_WIDTH / (series.length - 1);

    return series
        .map((value, index) => {
            const x = index * stepX;
            const y = span === 0 ? SPARK_HEIGHT / 2 : SPARK_HEIGHT - ((value - min) / span) * SPARK_HEIGHT;

            return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ");
};

interface SparklineProps {
    /** Accessible label for the chart (rendered as the SVG `aria-label`). */
    readonly ariaLabel: string;
    /** Extra classes for the `&lt;svg>` (e.g. a text colour the stroke inherits via `currentColor`). */
    readonly className?: string;
    /** The numeric series to plot, oldest-first. Fewer than two points renders nothing. */
    readonly series: ReadonlyArray<number>;
    /** `data-testid` on the `&lt;svg>`. */
    readonly testId?: string;
}

/**
 * A compact inline-SVG line chart over `series`, scaled to the shared
 * {@link SPARK_WIDTH} x {@link SPARK_HEIGHT} box. Returns `null` when there's not
 * enough data to draw a line, so a caller can render a "collecting…" placeholder
 * in its place. The stroke uses `currentColor`, so colour is set via `className`.
 */
export const Sparkline = ({ ariaLabel, className, series, testId }: SparklineProps): ReactElement | null => {
    const points = sparklinePoints(series);

    if (points === "") {
        return null;
    }

    return (
        <svg
            aria-label={ariaLabel}
            className={className}
            data-testid={testId}
            height={SPARK_HEIGHT}
            preserveAspectRatio="none"
            role="img"
            viewBox={`0 0 ${SPARK_WIDTH.toString()} ${SPARK_HEIGHT.toString()}`}
            width={SPARK_WIDTH}
        >
            <polyline fill="none" points={points} stroke="currentColor" strokeWidth={1} />
        </svg>
    );
};

export { SPARK_HEIGHT, SPARK_WIDTH, sparklinePoints };
export type { SparklineProps };
