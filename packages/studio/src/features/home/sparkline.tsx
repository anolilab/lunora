import type { ReactElement } from "react";

import { Bar, EvilBarChart } from "../../components/evilcharts/charts/bar-chart";
import type { ChartConfig } from "../../components/evilcharts/ui/chart";

/** Series colour for the stat-card sparkline (the foreground var already flips per theme). */
const SPARKLINE_CONFIG = { value: { colors: { dark: ["var(--foreground)"], light: ["var(--foreground)"] }, label: "" } } satisfies ChartConfig;

/**
 * A compact monochrome bar sparkline (evilcharts) drawn from a numeric series
 * (oldest → newest). Split into its own module so the Home panel can lazy-load
 * it: `recharts` (the chart engine behind evilcharts) is the studio's heaviest
 * client dep, and this is Home's only consumer of it, so deferring it keeps the
 * chart engine off the studio's entry bundle — Home's structure paints first and
 * each sparkline streams in on its own chunk.
 */
const Sparkline = ({ data }: { readonly data: ReadonlyArray<number> }): ReactElement | null => {
    const bars = data.slice(-16);

    // A single point can't read as a trend (and renders as one fat block), so a
    // sparkline only shows once there are at least a few buckets.
    if (bars.length < 3) {
        return null;
    }

    const rows = bars.map((value, index) => {
        return { index, value };
    });

    return (
        <div aria-hidden="true" className="h-8 w-28">
            <EvilBarChart animationType="none" barCategoryGap={1} className="h-8 w-full" config={SPARKLINE_CONFIG} data={rows}>
                <Bar dataKey="value" />
            </EvilBarChart>
        </div>
    );
};
export default Sparkline;
