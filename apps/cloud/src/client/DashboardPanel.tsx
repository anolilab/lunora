import { Link, useParams } from "@tanstack/react-router";
import type { ReactElement } from "react";

import type { DashboardPanel } from "../telemetry/dashboards";
import { statValue } from "../telemetry/dashboards";
import { formatValue } from "./metric-format";
import { Sparkline, TrendBadge } from "./MetricSparkline";
import type { MetricSeries } from "./use-metrics-series";

/**
 * The custom-dashboard panel widgets. Each renders one saved panel from data the
 * console already serves: `metric`/`stat` panels off the shared metric series,
 * and `traces`/`logs` panels as a deep-link shortcut into that tab. The board
 * owns the panel chrome (title, move/remove); this file owns the widget bodies.
 */

interface PanelBodyProps {
    panel: DashboardPanel;
    /** `undefined` while the metric read is loading; `[]` once resolved-empty. */
    series: MetricSeries[] | undefined;
}

/** A metric-trend widget — the named series' last value, trend badge, and sparkline. */
const MetricPanelBody = ({ panel, series }: { panel: DashboardPanel; series: MetricSeries[] | undefined }): ReactElement => {
    if (series === undefined) {
        return <p className="muted">Loading…</p>;
    }

    const match = series.find((candidate) => candidate.name === panel.config.metricName);

    if (match === undefined) {
        return <p className="muted">No data for {panel.config.metricName ?? "this metric"} in this window.</p>;
    }

    return (
        <div className="dash-metric">
            <div className="metric-tile-value">
                <span className="metric-last">{formatValue(match.lastValue)}</span>
                <TrendBadge trend={match.trend} />
            </div>
            <Sparkline points={match.points} />
        </div>
    );
};

/** A single-stat widget — one big number reduced from the named series. */
const StatPanelBody = ({ panel, series }: { panel: DashboardPanel; series: MetricSeries[] | undefined }): ReactElement => {
    if (series === undefined) {
        return <p className="muted">Loading…</p>;
    }

    const value = statValue(series, panel);

    if (value === undefined) {
        return <p className="muted">No data for {panel.config.metricName ?? "this metric"} in this window.</p>;
    }

    return (
        <div className="dash-stat">
            <span className="dash-stat-value">{formatValue(value)}</span>
            <span className="muted">{panel.config.metricName}</span>
        </div>
    );
};

/**
 * A Traces/Logs shortcut widget — its saved filter + a link into the tab. Now a
 * router `Link` (was a button firing the dashboard's `onOpenTab` callback), so the
 * shortcut is an ordinary, shareable URL like every other tab link.
 */
const ShortcutPanelBody = ({ panel }: PanelBodyProps): ReactElement => {
    const tab = panel.kind === "logs" ? "logs" : "traces";
    const { organizationId } = useParams({ from: "/_authed/orgs/$organizationId" });

    return (
        <div className="dash-shortcut">
            <p className="muted">{panel.config.filter ? <code>{panel.config.filter}</code> : `Open the ${tab} tab.`}</p>
            <Link className="link" params={{ organizationId }} to={tab === "logs" ? "/orgs/$organizationId/logs" : "/orgs/$organizationId/traces"}>
                Open {tab} →
            </Link>
        </div>
    );
};

/** Render a panel's body for its kind. */
export const PanelWidget = ({ panel, series }: PanelBodyProps): ReactElement => {
    if (panel.kind === "metric") {
        return <MetricPanelBody panel={panel} series={series} />;
    }

    if (panel.kind === "stat") {
        return <StatPanelBody panel={panel} series={series} />;
    }

    return <ShortcutPanelBody panel={panel} series={series} />;
};
