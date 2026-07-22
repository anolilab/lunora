import { useLunora } from "@lunora/react";
import { useEffect, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { OrgId } from "./types";

/**
 * Load the org's metric series for a `[from, to]` window — the data both the
 * Metrics tab and the custom-dashboard metric/stat panels render. `metrics.list`
 * is an action (the AE read is a `fetch`, not reactive), so this polls it when
 * the org or window changes, writing state only in the async callbacks (the
 * sanctioned effect pattern) with an out-of-order guard. Kept as a hook so the
 * Dashboards board fetches once and shares the result across every metric panel.
 */

/** One metric series as `metrics.list` returns it. */
export interface MetricSeries {
    firstValue: number;
    functionPath?: string;
    kind: string;
    lastValue: number;
    name: string;
    points: { t: number; value: number }[];
    trend: number;
}

/** The series over the window (`undefined` while loading) plus any read error. */
export interface MetricsSeriesState {
    error: string | undefined;
    series: MetricSeries[] | undefined;
}

/** Poll `metrics.list` for one org over a window; re-fetches when org/from/to change. */
export const useMetricsSeries = (organizationId: OrgId, from: number, to: number): MetricsSeriesState => {
    const client = useLunora();
    const [series, setSeries] = useState<MetricSeries[] | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;

        client
            .action(api.metrics.list, { from, organizationId, to })
            .then((result) => {
                if (!cancelled) {
                    setSeries(result);
                    setError(undefined);
                }
            })
            .catch((caught: unknown) => {
                if (!cancelled) {
                    setError(caught instanceof Error ? caught.message : "failed to load metrics");
                    setSeries([]);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [client, from, to, organizationId]);

    return { error, series };
};
