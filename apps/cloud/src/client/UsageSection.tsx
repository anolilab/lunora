import type { ReturnOf } from "@lunora/client";
import { usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import { includedUsageFor } from "../billing/overage";
import { formatDate, formatNumber } from "./format";
import { COLUMN_LABEL } from "./section-ui";
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

type QuotaState = "ok" | "over" | "warn";

/** Where a used/included ratio sits against the plan: amber from 80%, red at or past the allowance. */
const quotaState = (ratio: number): QuotaState => {
    if (ratio >= 1) {
        return "over";
    }

    return ratio >= 0.8 ? "warn" : "ok";
};

/** The state tints the VALUE (the filled segments, the hero number) — never a row or a surface. */
const STATE_FILL: Record<QuotaState, string> = {
    ok: "bg-success",
    over: "bg-destructive",
    warn: "bg-warning",
};

const STATE_TEXT: Record<QuotaState, string> = {
    ok: "text-foreground",
    over: "text-destructive",
    warn: "text-warning",
};

/**
 * Segment ids for the meter bar. A fixed array of values (not `map`'s index) so
 * each block has a stable key; 40 blocks read as a scale while staying discrete.
 */
const METER_SEGMENTS = Array.from({ length: 40 }, (_, index) => index);

/**
 * Included-vs-used meter (GAPS.md ring 3): a plan-quota bar that turns amber
 * approaching the allowance and red past it, with an honest overage label —
 * usage beyond the plan draws prepaid credits, never a surprise invoice.
 *
 * Rendered as the design system's segmented bar rather than a continuous fill:
 * discrete square blocks read as an instrument gauge, and the numeric readout
 * beside the label carries the precision the bar only approximates.
 */
const Meter = ({ included, label, used }: { included: number; label: string; used: number }): ReactElement => {
    const ratio = included > 0 ? used / included : 0;
    const state = quotaState(ratio);
    const filled = Math.min(METER_SEGMENTS.length, Math.round(ratio * METER_SEGMENTS.length));

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-4">
                <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>{label}</span>
                <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    <span className={STATE_TEXT[state]}>{formatNumber(used)}</span> / {formatNumber(included)} included
                </span>
            </div>
            <div aria-hidden className="flex h-2 w-full gap-[2px]">
                {METER_SEGMENTS.map((segment) => (
                    <span className={cn("flex-1", segment < filled ? STATE_FILL[state] : "bg-border")} key={segment} />
                ))}
            </div>
            {state === "over" ? <p className="text-destructive m-0 font-mono text-[11px]">Beyond plan allowance — drawing from prepaid credits.</p> : null}
            {state === "warn" ? <p className="text-warning m-0 font-mono text-[11px]">Approaching the plan allowance.</p> : null}
        </div>
    );
};

/**
 * Zero-dependency daily-usage bar chart (SVG); no chart library needed at this
 * scale. Square-ended bars in the foreground value (no accent colour, no radius,
 * no area fill) — the shape is the data, and the axis labels stay in the mono
 * label voice at the edges.
 */
const UsageBars = ({ series }: { series: { day: number; requests: number }[] }): ReactElement | null => {
    if (series.length === 0) {
        return null;
    }

    const max = Math.max(...series.map((point) => point.requests), 1);
    const barWidth = 100 / series.length;

    return (
        <div className="flex flex-col gap-2">
            <svg className="block h-24 w-full" preserveAspectRatio="none" role="img" viewBox="0 0 100 40">
                <title>Requests per day this period</title>
                {series.map((point, index) => {
                    const height = (point.requests / max) * 36;

                    return (
                        <rect
                            className="fill-foreground"
                            height={height}
                            key={point.day}
                            width={Math.max(0.5, barWidth - 1)}
                            x={index * barWidth + 0.5}
                            y={40 - height}
                        />
                    );
                })}
            </svg>
            <div className={cn(COLUMN_LABEL, "text-muted-foreground flex items-baseline justify-between gap-4")}>
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
 *
 * Hierarchy: request volume is what "usage this month" means, so it is the one
 * value at display size, in mono, tinted by its own quota state — every other
 * number on the screen is smaller. Below it the form varies by weight: segmented
 * quota bars (medium), the daily bar chart (medium), then storage as a plain
 * stat row (lightest). Loading is `[Loading…]` in the mono label voice rather
 * than a skeleton, which the design system forbids.
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
        <Card>
            <CardHeader>
                <CardTitle>Usage this month</CardTitle>
                <CardDescription>Metered platform usage for the current billing period, live as your deployments report it.</CardDescription>
            </CardHeader>
            <CardContent>
                {summary === undefined ? (
                    <p className={cn(COLUMN_LABEL, "text-muted-foreground m-0 py-8 text-center")}>[Loading…]</p>
                ) : (
                    <div className="flex flex-col gap-8">
                        {/* The one thing seen first: the period's request volume, tinted by its quota state. */}
                        <div className="flex flex-col gap-1.5">
                            <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>Requests</span>
                            <span
                                className={cn(
                                    "font-mono text-5xl leading-none tracking-[-0.02em] tabular-nums",
                                    STATE_TEXT[quotaState(included.requests > 0 ? summary.requests / included.requests : 0)],
                                )}
                            >
                                {formatNumber(summary.requests)}
                            </span>
                            <span className="text-muted-foreground font-mono text-[11px] tabular-nums">period from {formatDate(periodStart)}</span>
                        </div>

                        <div className="flex flex-col gap-5">
                            <Meter included={included.requests} label="Requests" used={summary.requests} />
                            <Meter included={included.cpuMs} label="CPU ms" used={summary.cpuMs} />
                        </div>

                        {series && series.length > 0 ? <UsageBars series={series} /> : null}

                        {/* Unmetered against a plan quota, so it stays a plain stat row. */}
                        <div className="border-border flex items-baseline justify-between gap-4 border-t pt-4">
                            <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>Storage</span>
                            <span className="font-mono text-sm tabular-nums">{formatBytes(summary.storageBytes)}</span>
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
};
