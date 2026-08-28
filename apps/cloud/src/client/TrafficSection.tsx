import { useLunora, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import { formatMs, formatNumber, formatTime } from "./format";
import { COLUMN_LABEL } from "./section-styles";
import { TimeRangePicker, useTimeRange } from "./TimeRangeProvider";
import type { ShareRow, StatusClassRow, VolumePoint } from "./TrafficCharts";
import { countryFlag, countryName, ShareList, StatusBreakdown, VolumeChart } from "./TrafficCharts";
import type { OrgId } from "./types";

/**
 * Traffic tab — what the org's deployed apps actually served.
 *
 * Two data sources, deliberately (see `lunora/traffic.ts` for the full reasoning):
 * the breakdowns and the volume chart come from `traffic.snapshot`, an action over
 * the sampled Analytics-Engine metering stream; the live request list and the
 * latency percentiles come from `traffic.live`, a reactive query over the
 * unsampled span store. So the top of this page is "roughly, over 24 hours" and
 * the bottom is "exactly, right now" — the section labels which is which rather
 * than blending them into one number an operator would over-trust.
 *
 * There is no world map. The ranked country list carries every fact a map would
 * (who, how many, what share) and several it cannot (exact counts, the long tail),
 * so the map is decoration and is not what gates this tab shipping.
 */

/** All-domains sentinel for the filter — `Select` needs a non-empty item value. */
const ALL_DOMAINS = "__all__";

/** The snapshot shape as `traffic.snapshot` returns it. */
interface TrafficSnapshot {
    countries: ShareRow[];
    hostnames: ShareRow[];
    routes: ShareRow[];
    series: VolumePoint[];
    statuses: StatusClassRow[];
    totalRequests: number;
}

/** The snapshot over the window (`undefined` while loading), plus any read error. */
interface SnapshotState {
    error: string | undefined;
    snapshot: TrafficSnapshot | undefined;
}

/**
 * Poll `traffic.snapshot` for one org over a window and domain.
 *
 * An action, not a reactive query — the read is a `fetch` over the AE SQL API —
 * so this re-fetches when the org, window or domain changes, writing state only
 * in the async callbacks with an out-of-order guard. Same shape as
 * `useMetricsSeries`, which exists for the same reason.
 */
const useTrafficSnapshot = (organizationId: OrgId, from: number, to: number, hostname: string | undefined): SnapshotState => {
    const client = useLunora();
    const [snapshot, setSnapshot] = useState<TrafficSnapshot | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;

        void (async () => {
            try {
                const result = await client.action(api.traffic.snapshot, {
                    from,
                    organizationId,
                    to,
                    ...(hostname === undefined ? {} : { hostname }),
                });

                if (!cancelled) {
                    setSnapshot(result);
                    setError(undefined);
                }
            } catch (error_: unknown) {
                if (!cancelled) {
                    setError(error_ instanceof Error ? error_.message : "failed to load traffic");
                    setSnapshot(undefined);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [client, from, to, hostname, organizationId]);

    return { error, snapshot };
};

/** A headline figure: a large mono number with its label beneath, in the label voice. */
const Stat = ({ label, value }: { label: string; value: string }): ReactElement => (
    <div className="flex flex-col gap-1">
        <span className="font-mono text-2xl leading-none tabular-nums">{value}</span>
        <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>{label}</span>
    </div>
);

interface TrafficSectionProps {
    organizationId: OrgId;
}

export const TrafficSection = ({ organizationId }: TrafficSectionProps): ReactElement => {
    const { from, to } = useTimeRange();
    const [domain, setDomain] = useState<string>(ALL_DOMAINS);
    const hostname = domain === ALL_DOMAINS ? undefined : domain;
    const { error, snapshot } = useTrafficSnapshot(organizationId, from, to, hostname);
    const live = useQuery(api.traffic.live, { organizationId });

    // Derived during render, not stored: the snapshot's hostname breakdown is read
    // unfiltered by design (see `createTrafficReader`), so the option list stays
    // complete even while a domain is selected and there is nothing to keep in sync.
    const domainOptions = snapshot?.hostnames.map((row) => row.key) ?? [];

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div className="flex flex-col gap-1.5">
                        <CardTitle>Traffic</CardTitle>
                        <CardDescription>
                            Requests your deployed apps served over the selected window — by country, route and response code. Breakdowns are sampled from the
                            metering stream; the live stream and percentiles below are exact.
                        </CardDescription>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        {domainOptions.length > 1 ? (
                            <Select
                                onValueChange={(value) => {
                                    setDomain(value ?? ALL_DOMAINS);
                                }}
                                value={domain}
                            >
                                <SelectTrigger aria-label="Filter by domain" className="w-[200px]">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        <SelectItem value={ALL_DOMAINS}>All domains</SelectItem>
                                        {domainOptions.map((option) => (
                                            <SelectItem key={option} value={option}>
                                                {option}
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        ) : null}
                        <TimeRangePicker />
                    </div>
                </CardHeader>
            </Card>

            {error === undefined ? null : (
                <Card>
                    <CardContent className="text-muted-foreground py-6 text-sm">Traffic could not be read: {error}</CardContent>
                </Card>
            )}

            {snapshot === undefined && error === undefined ? (
                <Card>
                    <CardContent className="text-muted-foreground py-8 text-center font-mono text-xs tracking-[0.09em] uppercase">[Loading…]</CardContent>
                </Card>
            ) : null}

            {snapshot?.totalRequests === 0 ? (
                <Card>
                    <CardContent className="text-muted-foreground py-8 text-center text-sm">
                        No traffic in this window. Once a deployment serves requests they appear here — nothing needs to be enabled.
                    </CardContent>
                </Card>
            ) : null}

            {snapshot !== undefined && snapshot.totalRequests > 0 ? (
                <>
                    <Card>
                        <CardContent className="grid gap-6 pt-6 sm:grid-cols-2 xl:grid-cols-5">
                            <Stat label="Requests" value={formatNumber(snapshot.totalRequests)} />
                            <Stat label="Countries" value={formatNumber(snapshot.countries.length)} />
                            <Stat label="p50 latency" value={formatMs(live?.latency.p50 ?? 0)} />
                            <Stat label="p95 latency" value={formatMs(live?.latency.p95 ?? 0)} />
                            <Stat label="p99 latency" value={formatMs(live?.latency.p99 ?? 0)} />
                        </CardContent>
                    </Card>

                    <div className="grid gap-6 xl:grid-cols-2">
                        <Card>
                            <CardHeader>
                                <CardTitle>Visitors by country</CardTitle>
                                <CardDescription>
                                    {formatNumber(snapshot.totalRequests)} requests from {formatNumber(snapshot.countries.length)} countries
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <ShareList
                                    label="Requests by country"
                                    renderKey={(key) => `${countryFlag(key)} ${countryName(key)}`.trim()}
                                    rows={snapshot.countries}
                                />
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>Top paths</CardTitle>
                                <CardDescription>
                                    Route labels with record ids collapsed, so an endpoint reads as one row rather than thousands.
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <ShareList
                                    label="Requests by route"
                                    renderKey={(key) => <code className="font-mono text-xs">{key}</code>}
                                    rows={snapshot.routes}
                                />
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>Responses</CardTitle>
                                <CardDescription>Status classes with the exact codes inside them.</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <StatusBreakdown classes={snapshot.statuses} />
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>Usage over time</CardTitle>
                                <CardDescription>Request volume (filled) with bytes served drawn over it, on independent scales.</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <VolumeChart points={snapshot.series} />
                            </CardContent>
                        </Card>
                    </div>
                </>
            ) : null}

            <Card>
                <CardHeader>
                    <CardTitle>Live requests</CardTitle>
                    <CardDescription>
                        Every request as it completes, pushed live from the span store — exact timings, no sampling.{" "}
                        {live === undefined ? null : `${formatNumber(live.latency.count)} in the retained window.`}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {live === undefined ? (
                        <p className="text-muted-foreground py-6 text-center font-mono text-xs tracking-[0.09em] uppercase">[Loading…]</p>
                    ) : null}

                    {live?.requests.length === 0 ? (
                        <p className="text-muted-foreground py-6 text-center text-sm">No requests yet. This list fills in as your apps serve traffic.</p>
                    ) : null}

                    {live !== undefined && live.requests.length > 0 ? (
                        <ul className="m-0 grid list-none gap-0 p-0">
                            {live.requests.map((request) => (
                                <li
                                    className="border-border flex items-baseline gap-3 border-b px-1 py-2 text-sm last:border-b-0"
                                    key={`${request.traceId}:${String(request.startedAt)}`}
                                >
                                    <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">{formatTime(request.startedAt)}</span>
                                    <span
                                        className={cn(
                                            "shrink-0 font-mono text-[10px] tracking-[0.09em] uppercase",
                                            request.level === "error" ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
                                        )}
                                    >
                                        {request.level}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{request.name}</span>
                                    {request.serviceName === undefined ? null : (
                                        <span className="text-muted-foreground hidden shrink-0 truncate font-mono text-[11px] sm:block">
                                            {request.serviceName}
                                        </span>
                                    )}
                                    <span className="shrink-0 font-mono text-xs tabular-nums">{formatMs(request.durationMs)}</span>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </CardContent>
            </Card>
        </div>
    );
};
