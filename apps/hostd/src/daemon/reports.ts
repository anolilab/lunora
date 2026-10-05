/**
 * Request counts for the studio (plan 458 W6, on-box half): hostd tails
 * Caddy's JSON access log, counts requests per alias per whole minute —
 * requests, errors (status ≥ 500) and the median latency — and sends one
 * `report` per closed minute.
 *
 * The control plane records a window only when it starts on a whole minute,
 * once per box and window, and at most an hour long and a day old (protocol
 * §5.1), so only CLOSED minute windows are ever sent, and a window resent
 * after a reconnect is harmless. Reports wait in a bounded queue while the box
 * is offline and drain a few at a time, under the control plane's per-minute
 * cap. Displayed, never billed (D12).
 */
import { HOSTD_PROTOCOL_LIMITS } from "../wire/constants";
import type { AliasReport, ReportMessage, RouteEntry } from "../wire/types";

const MINUTE_MS = 60_000;

/** A `:port` suffix on a Host header. */
const HOST_PORT_PATTERN = /:\d+$/u;

/** How long after a minute ends its window is closed: late access-log lines still land in it. */
const CLOSE_GRACE_MS = 5000;

/** Latency samples kept per alias per minute; beyond it the median is of the first ones. */
const MAX_SAMPLES = 10_000;

interface AliasCounts {
    durations: number[];
    errors: number;
    requests: number;
}

/** One access-log line, reduced to what a report counts. */
interface AccessEntry {
    /** Epoch ms. */
    at: number;
    durationMs: number;
    host: string;
    status: number;
}

/** Parse one Caddy JSON access-log line; `undefined` for anything else. */
const parseAccessLine = (line: string): AccessEntry | undefined => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(line);
    } catch {
        return undefined;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return undefined;
    }

    const { duration, request, status, ts } = parsed as { duration?: unknown; request?: { host?: unknown }; status?: unknown; ts?: unknown };
    const host = request?.host;

    if (typeof ts !== "number" || typeof status !== "number" || typeof duration !== "number" || typeof host !== "string") {
        return undefined;
    }

    // A Host header may carry a port; the routing table never does.
    return { at: Math.round(ts * 1000), durationMs: Math.max(0, duration * 1000), host: host.toLowerCase().replace(HOST_PORT_PATTERN, ""), status };
};

const median = (values: number[]): number => {
    const sorted = values.toSorted((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const value = sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);

    return Math.round(value * 100) / 100;
};

/** Counts access-log entries into minute windows and hands out the closed ones. */
class ReportAggregator {
    private readonly windows = new Map<number, Map<string, AliasCounts>>();

    /** Windows starting before this were already reported; a late line for one is dropped. */
    private closedBefore = 0;

    private hostToAlias = new Map<string, string>();

    /** Use `routes` to tell which alias a hostname belongs to. */
    public setRoutes(routes: ReadonlyArray<RouteEntry>): void {
        this.hostToAlias = new Map(routes.map((route) => [route.hostname, route.alias]));
    }

    /** Count one access-log line. Lines for unrouted hosts, and late lines for closed windows, are dropped. */
    public ingest(line: string): void {
        const entry = parseAccessLine(line);
        const alias = entry === undefined ? undefined : this.hostToAlias.get(entry.host);

        if (entry === undefined || alias === undefined) {
            return;
        }

        const windowStart = Math.floor(entry.at / MINUTE_MS) * MINUTE_MS;

        if (windowStart < this.closedBefore) {
            return;
        }

        const window = this.windows.get(windowStart) ?? new Map<string, AliasCounts>();
        const counts = window.get(alias) ?? { durations: [], errors: 0, requests: 0 };

        counts.requests += 1;
        counts.errors += entry.status >= 500 ? 1 : 0;

        if (counts.durations.length < MAX_SAMPLES) {
            counts.durations.push(entry.durationMs);
        }

        window.set(alias, counts);
        this.windows.set(windowStart, window);
    }

    /** The reports of every window closed by `now`, oldest first; they are forgotten here. */
    public close(now: number): ReportMessage[] {
        const reports: ReportMessage[] = [];

        for (const windowStart of [...this.windows.keys()].toSorted((a, b) => a - b)) {
            if (windowStart + MINUTE_MS + CLOSE_GRACE_MS > now) {
                break;
            }

            const window = this.windows.get(windowStart) ?? new Map<string, AliasCounts>();
            const perAlias: AliasReport[] = [...window.entries()]
                .toSorted(([a, left], [b, right]) => right.requests - left.requests || a.localeCompare(b))
                .slice(0, HOSTD_PROTOCOL_LIMITS.maxReportAliases)
                .map(([alias, counts]) => {
                    return { alias, errors: counts.errors, p50Ms: median(counts.durations), requests: counts.requests };
                });

            this.windows.delete(windowStart);
            this.closedBefore = windowStart + MINUTE_MS;
            reports.push({ perAlias, type: "report", windowEnd: windowStart + MINUTE_MS, windowStart });
        }

        return reports;
    }
}

export type { AccessEntry };
export { CLOSE_GRACE_MS, MINUTE_MS, parseAccessLine, ReportAggregator };
