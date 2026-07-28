import type { ReturnOf } from "@lunora/client";
import { usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { includedUsageFor } from "../billing/overage";
import { formatDate, formatNumber } from "./format";
import type { SectionProps } from "./tabs";
import { monthStart } from "./usage-period";

const formatBytes = (bytes: number): string => {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

/**
 * Included-vs-used meter (GAPS.md ring 3): a plan-quota bar that turns amber
 * approaching the allowance and red past it, with an honest overage label —
 * usage beyond the plan draws prepaid credits, never a surprise invoice.
 */
const Meter = ({ included, label, used }: { included: number; label: string; used: number }): ReactElement => {
    const ratio = included > 0 ? used / included : 0;
    let state = "ok";

    if (ratio >= 1) {
        state = "over";
    } else if (ratio >= 0.8) {
        state = "warn";
    }

    return (
        <div className="meter">
            <div className="meter-head">
                <span>{label}</span>
                <span className="muted">
                    {formatNumber(used)} / {formatNumber(included)} included
                </span>
            </div>
            <div className="meter-track">
                {}
                <div className={`meter-fill meter-${state}`} style={{ width: `${String(Math.min(100, ratio * 100))}%` }} />
            </div>
            {state === "over" ? <p className="meter-note">Beyond plan allowance — drawing from prepaid credits.</p> : null}
            {state === "warn" ? <p className="meter-note warn">Approaching the plan allowance.</p> : null}
        </div>
    );
};

/** Zero-dependency daily-usage bar chart (SVG); no chart library needed at this scale. */
const UsageBars = ({ series }: { series: { day: number; requests: number }[] }): ReactElement | null => {
    if (series.length === 0) {
        return null;
    }

    const max = Math.max(...series.map((point) => point.requests), 1);
    const barWidth = 100 / series.length;

    return (
        <div className="usage-chart">
            <svg preserveAspectRatio="none" role="img" viewBox="0 0 100 40">
                <title>Requests per day this period</title>
                {series.map((point, index) => {
                    const height = (point.requests / max) * 36;

                    return <rect height={height} key={point.day} rx={0.5} width={Math.max(0.5, barWidth - 1)} x={index * barWidth + 0.5} y={40 - height} />;
                })}
            </svg>
            <div className="usage-chart-legend muted">
                <span>{formatDate(series[0]?.day ?? 0)}</span>
                <span>requests / day</span>
                <span>{formatDate(series.at(-1)?.day ?? 0)}</span>
            </div>
        </div>
    );
};

/**
 * Usage tab: plan-quota meters (included vs used, GAPS.md ring 3), the
 * period's daily request volume, and the raw totals — all live.
 */
export const UsageSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.usage.summary>>): ReactElement => {
    // A primitive `number` that's stable within the month, so recomputing it per
    // render is fine — the query key dedupes on its value, not its reference.
    const periodStart = monthStart();
    const summary = usePreloadedQuery(preloaded);
    const series = useQuery(api.usage.series, { organizationId, periodStart });
    const organizations = useQuery(api.organizations.list, {});
    const plan = organizations?.find((entry) => entry._id === organizationId)?.plan ?? "free";
    const included = includedUsageFor(plan);

    return (
        <section className="card">
            <h3>Usage this month</h3>
            {summary === undefined ? (
                <p className="muted">Loading…</p>
            ) : (
                <>
                    <Meter included={included.requests} label="Requests" used={summary.requests} />
                    <Meter included={included.cpuMs} label="CPU ms" used={summary.cpuMs} />

                    {series && series.length > 0 ? <UsageBars series={series} /> : null}

                    <div className="metrics">
                        <div className="metric">
                            <span className="metric-value">{formatNumber(summary.requests)}</span>
                            <span className="muted">requests</span>
                        </div>
                        <div className="metric">
                            <span className="metric-value">{formatNumber(summary.cpuMs)}</span>
                            <span className="muted">CPU ms</span>
                        </div>
                        <div className="metric">
                            <span className="metric-value">{formatBytes(summary.storageBytes)}</span>
                            <span className="muted">storage</span>
                        </div>
                    </div>
                </>
            )}
        </section>
    );
};
