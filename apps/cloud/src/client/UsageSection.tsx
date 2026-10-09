import type { ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import { includedUsageFor } from "../billing/overage";
import { estimatedSpendMinor, spendBreakdown } from "../billing/spend";
import type { UsageTotals } from "../billing/usage";
import { toPeriodUsage } from "../billing/usage";
import { formatDate, formatNumber } from "./format";
import { COLUMN_LABEL } from "./section-styles";
import { Field, FieldForm, FormError, StatusBadge } from "./section-ui";
import type { SectionProps } from "./tabs";
import type { OrgId } from "./types";
import { monthStart } from "./usage-period";

/** Minor units → a plain dollar string. */
const formatMinor = (minor: number): string => `$${(minor / 100).toFixed(2)}`;

/**
 * Nano-cents → dollars for a single breakdown line. Lines carry exact
 * nano-cents (the total rounds once, so rounding each line and summing would
 * disagree with it), and a line worth a fraction of a cent still has to render
 * as something other than zero.
 */
const formatNanoCents = (nanoCents: number): string => {
    const dollars = nanoCents / 100_000_000_000;

    if (dollars > 0 && dollars < 0.01) {
        return "<$0.01";
    }

    return `$${dollars.toFixed(2)}`;
};

/**
 * Cost by product for the period. A single spend figure names no product, and
 * the two quota meters above cover two of the ~35 dimensions the cap actually
 * prices — so a period whose spend was all Durable Object duration would
 * otherwise show nothing at all.
 */
const CostByProduct = ({ totals }: { totals: UsageTotals }): ReactElement => {
    const usage = toPeriodUsage(totals);
    const breakdown = spendBreakdown(usage);

    return (
        <div className="border-border flex flex-col gap-2 border-t pt-4">
            <div className="flex items-baseline justify-between gap-4">
                <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>Estimated cost</span>
                <span className="font-mono text-sm tabular-nums">{formatMinor(estimatedSpendMinor(usage))}</span>
            </div>
            {breakdown.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {breakdown.slice(0, 8).map((line) => (
                        <li className="flex items-baseline justify-between gap-4" key={line.meter}>
                            <span className="text-muted-foreground font-mono text-[11px]">
                                {line.product} · {formatNumber(line.quantity)} {line.unit}
                            </span>
                            <span className="font-mono text-[11px] tabular-nums">{formatNanoCents(line.nanoCents)}</span>
                        </li>
                    ))}
                </ul>
            ) : null}
            <p className="text-muted-foreground m-0 font-mono text-[11px]">
                Estimated at Cloudflare&apos;s marginal rates — your invoice is the authoritative number.
            </p>
        </div>
    );
};

/** The family a metering notice is about, as the Usage tab names it. */
const FAMILY_LABEL = {
    d1: "D1 rows",
    durableObjectDuration: "Durable Object duration",
    durableObjectRequests: "Durable Object requests",
    durableObjects: "Durable Object rows",
    requests: "Requests",
    workersCpu: "Workers CPU time",
} as const;

/**
 * The metering sources that cannot read right now (`usage.meteringStatus`). A
 * source that cannot read records why instead of reporting zero, so the figures
 * above are known to be missing that family rather than shown as complete.
 */
const MeteringNotices = ({ organizationId }: { organizationId: OrgId }): null | ReactElement => {
    const notices = useQuery(api.usage.meteringStatus, { organizationId });

    if (notices === undefined || notices.length === 0) {
        return null;
    }

    return (
        <ul className="border-border m-0 flex list-none flex-col gap-2 border-t p-0 pt-4">
            {notices.map((notice) => (
                <li className="flex flex-col gap-0.5" key={`${notice.source}:${notice.family}`}>
                    <span className="flex items-baseline gap-2">
                        <StatusBadge tone="warning">Not metered</StatusBadge>
                        <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>
                            {FAMILY_LABEL[notice.family]} · {notice.source}
                        </span>
                    </span>
                    <span className="text-muted-foreground font-mono text-[11px]">{notice.message}</span>
                </li>
            ))}
        </ul>
    );
};

const LEVEL_TONE = { breach: "danger", ok: "success", warn: "warning" } as const;

const LEVEL_LABEL = { breach: "Over cap — suspended", ok: "Under limits", warn: "Past warning" } as const;

/**
 * Spend limits (plan 365 W2): the period's estimated spend against the org's
 * soft cap (a `spend` alert) and hard cap (suspension), with the one control a
 * tenant has — the warning threshold. The cap is support-only, so it is shown,
 * never edited. Owners/admins only; the mutation refuses anyone else and the
 * form reports it.
 */
const SpendLimits = ({ organizationId }: { organizationId: OrgId }): ReactElement | null => {
    const status = useQuery(api.usage.spendStatus, { organizationId });
    const setSpendWarning = useMutation(api.usage.setSpendWarning);
    const [draft, setDraft] = useState("");
    const [error, setError] = useState<null | string>(null);

    if (status === undefined) {
        return null;
    }

    const save = (warnMinor: null | number): void => {
        setError(null);

        const run = async (): Promise<void> => {
            await setSpendWarning.mutate({ organizationId, warnMinor });
            setDraft("");
        };

        void run().catch((error_: unknown) => {
            setError(error_ instanceof Error ? error_.message : "could not save the warning threshold");
        });
    };

    return (
        <div className="border-border flex flex-col gap-3 border-t pt-4">
            <div className="flex items-baseline justify-between gap-4">
                <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>Spend limits</span>
                <StatusBadge tone={LEVEL_TONE[status.level]}>{LEVEL_LABEL[status.level]}</StatusBadge>
            </div>
            <dl className="m-0 grid grid-cols-3 gap-4 font-mono text-xs tabular-nums">
                <div>
                    <dt className="text-muted-foreground">Spent</dt>
                    <dd className="m-0">{formatMinor(status.spendMinor)}</dd>
                </div>
                <div>
                    <dt className="text-muted-foreground">Warn at{status.warnCustomized ? "" : " (default)"}</dt>
                    <dd className="m-0">{status.warnMinor === null ? "off" : formatMinor(status.warnMinor)}</dd>
                </div>
                <div>
                    <dt className="text-muted-foreground">Cap</dt>
                    <dd className="m-0">{status.capMinor === null ? "none" : formatMinor(status.capMinor)}</dd>
                </div>
            </dl>
            <FieldForm
                action={() => {
                    const dollars = Number(draft);

                    save(Number.isFinite(dollars) ? Math.round(dollars * 100) : Number.NaN);
                }}
                className="max-w-md sm:grid-cols-[1fr_auto_auto] sm:items-end"
            >
                <Field htmlFor="spend-warn" label="Warn at ($, 0 = off)">
                    <Input
                        id="spend-warn"
                        inputMode="decimal"
                        min="0"
                        onChange={(event) => {
                            setDraft(event.target.value);
                        }}
                        placeholder={status.warnMinor === null ? "off" : (status.warnMinor / 100).toFixed(2)}
                        required
                        step="0.01"
                        type="number"
                        value={draft}
                    />
                </Field>
                <Button type="submit" variant="outline">
                    Save
                </Button>
                {status.warnCustomized ? (
                    <Button
                        onClick={() => {
                            save(null);
                        }}
                        type="button"
                        variant="ghost"
                    >
                        Use default
                    </Button>
                ) : null}
            </FieldForm>
            <FormError message={error} />
            <p className="text-muted-foreground m-0 font-mono text-[11px]">
                The warning fires your organization&apos;s &quot;spend&quot; alert rules once a period. Reaching the cap suspends every deployment.
            </p>
        </div>
    );
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
    const includedRequests = included.requests ?? 0;
    const includedCpuMs = included.cpuMs ?? 0;

    // `undefined` only after an identity switch, until the new subscription answers.
    if (summary === undefined) {
        return (
            <Card>
                <CardContent className="text-muted-foreground py-8 text-center font-mono text-xs tracking-[0.09em] uppercase">[Loading…]</CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Usage this month</CardTitle>
                <CardDescription>Metered platform usage for the current billing period, live as your deployments report it.</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="flex flex-col gap-8">
                    {/* The one thing seen first: the period's request volume, tinted by its quota state. */}
                    <div className="flex flex-col gap-1.5">
                        <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>Requests</span>
                        <span
                            className={cn(
                                "font-mono text-5xl leading-none tracking-[-0.02em] tabular-nums",
                                STATE_TEXT[quotaState(includedRequests > 0 ? summary.requests / includedRequests : 0)],
                            )}
                        >
                            {formatNumber(summary.requests)}
                        </span>
                        <span className="text-muted-foreground font-mono text-[11px] tabular-nums">period from {formatDate(periodStart)}</span>
                    </div>

                    <div className="flex flex-col gap-5">
                        <Meter included={includedRequests} label="Requests" used={summary.requests} />
                        <Meter included={includedCpuMs} label="CPU ms" used={summary.cpuMs} />
                    </div>

                    {series && series.length > 0 ? <UsageBars series={series} /> : null}

                    <CostByProduct totals={summary} />

                    <MeteringNotices organizationId={organizationId} />

                    <SpendLimits organizationId={organizationId} />
                </div>
            </CardContent>
        </Card>
    );
};
