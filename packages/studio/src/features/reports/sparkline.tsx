import type { ReactElement } from "react";

import { Bar, EvilBarChart } from "../../components/evilcharts/charts/bar-chart";
import type { ChartConfig } from "../../components/evilcharts/ui/chart";
import { cn } from "../../lib/utils";

/** Single foreground-coloured series keyed `value` (the foreground var flips per theme). */
const SPARK_CONFIG = { value: { colors: { dark: ["var(--foreground)"], light: ["var(--foreground)"] }, label: "" } } satisfies ChartConfig;

interface SparklineProps {
    /** Accessible label for the chart (rendered as the wrapper's `aria-label`). */
    readonly ariaLabel: string;
    /** Extra classes for the wrapper (e.g. sizing). */
    readonly className?: string;
    /** The numeric series to plot, oldest-first. Fewer than two points renders nothing. */
    readonly series: ReadonlyArray<number>;
    /** `data-testid` on the wrapper. */
    readonly testId?: string;
}

/**
 * A compact monochrome bar sparkline over `series`, rendered with evilcharts
 * (Recharts). Returns `null` when there's not enough data to draw, so a caller
 * can render a "collecting…" placeholder in its place.
 */
export const Sparkline = ({ ariaLabel, className, series, testId }: SparklineProps): ReactElement | null => {
    if (series.length < 2) {
        return null;
    }

    const rows = series.slice(-40).map((value, index) => {
        return { index, value };
    });

    return (
        <div aria-label={ariaLabel} className={cn("h-6 w-[120px]", className)} data-testid={testId} role="img">
            <EvilBarChart animationType="none" barCategoryGap={1} className="h-full w-full" config={SPARK_CONFIG} data={rows}>
                <Bar dataKey="value" />
            </EvilBarChart>
        </div>
    );
};

export type { SparklineProps };
