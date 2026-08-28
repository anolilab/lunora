import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

import { formatNumber, formatTime } from "./format";
import { COLUMN_LABEL } from "./section-styles";

/**
 * The rendering half of the Traffic tab — share bars, the volume chart, and the
 * country-code formatting.
 *
 * Split from `TrafficSection.tsx` so neither file mixes data plumbing with
 * drawing, and so these stay reusable by a per-deployment health panel on the
 * project page (which renders the same shapes over a one-script snapshot).
 *
 * Every chart here is inline SVG with no library, matching `MetricSparkline` and
 * the usage bars. At this scale a charting dependency would ship more bytes than
 * the entire dashboard's chart code.
 */

/** ASCII code point of `A`, the base for the regional-indicator offset below. */
const LETTER_A = 65;

/** First regional-indicator symbol (🇦) — flag emoji are two of these, one per ISO letter. */
const REGIONAL_INDICATOR_A = 0x1_f1_e6;

/** An ISO-3166 alpha-2 code. Anything else (`unknown`, an unresolved value) is not a country. */
const ISO_ALPHA_2 = /^[a-z]{2}$/iu;

/**
 * Flag emoji for an ISO-3166 alpha-2 country code, or an empty string when the
 * code is not two letters (`unknown`, or a value Cloudflare could not resolve).
 *
 * Derived from the code rather than looked up: a regional-indicator pair IS the
 * flag, so this needs no asset, no sprite sheet, and no per-country data to fall
 * out of date.
 */
export const countryFlag = (code: string): string => {
    if (!ISO_ALPHA_2.test(code)) {
        return "";
    }

    // Exactly two ASCII letters by the guard above, so the pair is indexed
    // directly rather than spread — a string spread would be a claim about
    // multi-code-point input this function has already ruled out.
    const upper = code.toUpperCase();

    return String.fromCodePoint(
        REGIONAL_INDICATOR_A + (upper.codePointAt(0) ?? LETTER_A) - LETTER_A,
        REGIONAL_INDICATOR_A + (upper.codePointAt(1) ?? LETTER_A) - LETTER_A,
    );
};

/**
 * Human country name for an ISO code, falling back to the code itself.
 *
 * `Intl.DisplayNames` is the platform's own localized region table — shipping a
 * country-name map alongside it would be a second, staler copy of data the
 * runtime already has, in every language it already has it in.
 */
export const countryName = (code: string): string => {
    if (!ISO_ALPHA_2.test(code)) {
        return code === "" ? "Unknown" : code;
    }

    try {
        return new Intl.DisplayNames(undefined, { type: "region" }).of(code.toUpperCase()) ?? code;
    } catch {
        // A runtime without the region table — show the code rather than nothing.
        return code;
    }
};

/** One row of a ranked breakdown: a label, its count, its share, and the bar beneath. */
export interface ShareRow {
    key: string;
    requests: number;
    share: number;
}

/**
 * A ranked breakdown list with an inline share bar under each row.
 *
 * The bar is scaled to the LARGEST row rather than to 100%, so the shape stays
 * readable when the leader holds a few percent — a list of near-invisible slivers
 * communicates nothing, and the percentage is already printed beside it.
 */
export const ShareList = ({
    label,
    rows,
    renderKey,
}: {
    label: string;
    renderKey?: (key: string) => ReactElement | string;
    rows: ReadonlyArray<ShareRow>;
}): ReactElement => {
    const max = Math.max(...rows.map((row) => row.requests), 1);

    return (
        <ul aria-label={label} className="m-0 grid list-none gap-3 p-0">
            {rows.map((row) => (
                <li className="flex flex-col gap-1.5" key={row.key}>
                    <div className="flex items-baseline gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm">{renderKey ? renderKey(row.key) : row.key}</span>
                        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">{formatNumber(row.requests)}</span>
                        <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums">{(row.share * 100).toFixed(1)}%</span>
                    </div>
                    <div className="bg-muted h-1 w-full overflow-hidden">
                        <div className="bg-foreground h-full" style={{ width: `${String((row.requests / max) * 100)}%` }} />
                    </div>
                </li>
            ))}
        </ul>
    );
};

/** Tailwind fill classes per response class — semantic colour, kept out of the accent. */
const STATUS_FILL: Record<string, string> = {
    "2xx": "bg-emerald-500",
    "3xx": "bg-sky-500",
    "4xx": "bg-amber-500",
    "5xx": "bg-red-500",
};

/** Matching text colour, so the class heading reads as the same signal as its bar segment. */
const STATUS_TEXT: Record<string, string> = {
    "2xx": "text-emerald-600 dark:text-emerald-400",
    "3xx": "text-sky-600 dark:text-sky-400",
    "4xx": "text-amber-600 dark:text-amber-400",
    "5xx": "text-red-600 dark:text-red-400",
};

/** One response class with its exact codes, as the breakdown renders it. */
export interface StatusClassRow {
    class: string;
    codes: { code: string; requests: number }[];
    requests: number;
}

/**
 * Response-code breakdown: one stacked bar across all classes, then each class
 * with its exact codes nested underneath.
 *
 * The nesting is the point. `4xx` rising is not actionable on its own — a spike
 * in 404s means broken links and a spike in 429s means someone is being rate
 * limited, and only the exact code distinguishes them.
 */
export const StatusBreakdown = ({ classes }: { classes: ReadonlyArray<StatusClassRow> }): ReactElement => {
    const total = classes.reduce((sum, group) => sum + group.requests, 0);

    return (
        <div className="flex flex-col gap-5">
            <div aria-label="Responses by status class" className="flex h-1.5 w-full overflow-hidden" role="img">
                {classes.map((group) => (
                    <div
                        className={STATUS_FILL[group.class] ?? "bg-muted-foreground"}
                        key={group.class}
                        style={{ width: `${String(total === 0 ? 0 : (group.requests / total) * 100)}%` }}
                    />
                ))}
            </div>

            <div className="flex flex-col gap-4">
                {classes.map((group) => (
                    <div className="flex flex-col gap-1" key={group.class}>
                        <div className="flex items-baseline gap-3">
                            <span className={cn("flex-1 font-mono text-sm font-medium", STATUS_TEXT[group.class] ?? "text-foreground")}>{group.class}</span>
                            <span className="shrink-0 font-mono text-xs tabular-nums">{formatNumber(group.requests)}</span>
                            <span className="text-muted-foreground w-12 shrink-0 text-right font-mono text-xs tabular-nums">
                                {(total === 0 ? 0 : (group.requests / total) * 100).toFixed(1)}%
                            </span>
                        </div>
                        {group.codes.map((entry) => (
                            <div className="text-muted-foreground flex items-baseline gap-3 pl-4" key={entry.code}>
                                <span className="flex-1 font-mono text-xs">{entry.code}</span>
                                <span className="shrink-0 font-mono text-xs tabular-nums">{formatNumber(entry.requests)}</span>
                                <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums">
                                    {(total === 0 ? 0 : (entry.requests / total) * 100).toFixed(1)}%
                                </span>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
};

/** One bucket of the volume series. */
export interface VolumePoint {
    avgDurationMs: number;
    bytes: number;
    requests: number;
    t: number;
}

/** Bytes rendered on the chart's right-hand axis label. */
const formatBytes = (bytes: number): string => {
    if (bytes < 1024) {
        return `${String(Math.round(bytes))} B`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? "B"}`;
};

/** The polyline through `values`, each scaled to `max`, spread evenly across the 0–100 viewBox. */
const linePoints = (values: ReadonlyArray<number>, max: number): string => {
    const step = values.length > 1 ? 100 / (values.length - 1) : 0;

    return values.map((value, index) => `${(index * step).toFixed(2)},${(40 - (value / max) * 38).toFixed(2)}`).join(" ");
};

/** The same shape closed down to the baseline, for the filled area beneath it. */
const areaPoints = (values: ReadonlyArray<number>, max: number): string => {
    if (values.length === 0) {
        return "";
    }

    return `0,40 ${linePoints(values, max)} ${values.length > 1 ? "100" : "0"},40`;
};

/**
 * Usage over time — request volume as a filled area with the byte volume drawn
 * over it as a line, on independent scales.
 *
 * Two scales on one frame rather than two stacked charts: the question an
 * operator actually asks here is whether bytes moved WITH requests or apart from
 * them (a few huge responses look completely different from a traffic spike), and
 * that comparison only exists when the shapes overlap.
 */
export const VolumeChart = ({ points }: { points: ReadonlyArray<VolumePoint> }): ReactElement | null => {
    if (points.length === 0) {
        return null;
    }

    const maxRequests = Math.max(...points.map((point) => point.requests), 1);
    const maxBytes = Math.max(...points.map((point) => point.bytes), 1);

    return (
        <div className="flex flex-col gap-2">
            <svg className="block h-40 w-full" preserveAspectRatio="none" role="img" viewBox="0 0 100 40">
                <title>Requests and bytes served over the selected window</title>
                <polygon
                    className="fill-foreground/15"
                    points={areaPoints(
                        points.map((point) => point.requests),
                        maxRequests,
                    )}
                />
                <polyline
                    className="stroke-foreground fill-none"
                    points={linePoints(
                        points.map((point) => point.bytes),
                        maxBytes,
                    )}
                    strokeWidth="0.4"
                    vectorEffect="non-scaling-stroke"
                />
            </svg>
            <div className={cn(COLUMN_LABEL, "text-muted-foreground flex items-baseline justify-between gap-4")}>
                <span>{formatTime(points[0]?.t ?? 0)}</span>
                <span>
                    peak {formatNumber(maxRequests)} req · {formatBytes(maxBytes)}
                </span>
                <span>{formatTime(points.at(-1)?.t ?? 0)}</span>
            </div>
        </div>
    );
};
