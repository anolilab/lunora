import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { OrgId } from "./types";

interface UsageSectionProps {
    organizationId: OrgId;
}

/** Epoch ms for the first instant of the current UTC month. */
const monthStart = (): number => {
    const now = new Date();

    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
};

const formatNumber = (value: number): string => value.toLocaleString();

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
 * Usage tab: the current billing period's aggregated usage for the org
 * (`usage.summary`), keyed to the start of the current UTC month.
 */
export const UsageSection = ({ organizationId }: UsageSectionProps): ReactElement => {
    // A primitive `number` that's stable within the month, so recomputing it per
    // render is fine — the query key dedupes on its value, not its reference.
    const periodStart = monthStart();
    const summary = useQuery(api.usage.summary, { organizationId, periodStart });

    return (
        <section className="card">
            <h3>Usage this month</h3>
            {summary === undefined ? (
                <p className="muted">Loading…</p>
            ) : (
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
            )}
        </section>
    );
};
