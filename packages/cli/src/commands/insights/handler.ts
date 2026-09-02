import { resolveAdminBearer } from "../../util/admin-token";
import { resolveAdminBaseUrl } from "../../util/admin-url";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import type { FetchLike } from "../run/handler";
import type { InsightsOptions } from "./index";

/** The reserved admin RPC the report reads — the per-function metrics feed. */
const GET_FUNCTION_STATS_OP = "__lunora_admin__:getFunctionStats";

/** Default rows shown per report section before `--limit` overrides it. */
const DEFAULT_LIMIT = 10;

/**
 * One per-function metrics row as returned by `__lunora_admin__:getFunctionStats`,
 * mirroring `@lunora/do`'s `FunctionCallStat`. Only the fields the report reads
 * are typed; `conflicts` is optional because a worker predating conflict tracking
 * omits it (treated as 0).
 */
interface FunctionStatRow {
    calls: number;
    conflicts?: number;
    errors: number;
    lastErrorMessage: null | string;
    maxDurationMs: number;
    path: string;
    totalDurationMs: number;
}

/** Payload of a `getFunctionStats` call: the rows plus the collection-window start. */
interface FunctionStatsResult {
    functions: FunctionStatRow[];
    sinceMs: number;
}

/** One ranked row in a report section: the function plus its headline rate/figure. */
interface InsightRow {
    /** Total dispatches. */
    calls: number;
    /** OCC write conflicts (a subset of `errors`). */
    conflicts: number;
    /** Errors that threw. */
    errors: number;
    /** Most recent error message, for the error section. */
    lastErrorMessage: null | string;
    /** Slowest single dispatch, ms. */
    maxDurationMs: number;
    /** Mean dispatch latency, ms. */
    meanDurationMs: number;
    path: string;
    /** Section-specific rate (0–1): conflict rate or error rate; unused for latency. */
    rate: number;
}

/** The structured insights report — pure output of {@link buildInsightsReport}. */
interface InsightsReport {
    /** Functions with errors, worst error rate first. */
    errorHotspots: InsightRow[];
    /** Functions ranked by slowest single dispatch. */
    latencyOutliers: InsightRow[];
    /** Total functions observed. */
    totalFunctions: number;
    /** Functions with OCC write conflicts, worst conflict rate first — the sharding signal. */
    writeContention: InsightRow[];
}

/** Project a raw stats row into an {@link InsightRow}, defaulting the additive `conflicts` field. */
const toInsightRow = (stat: FunctionStatRow, rate: number): InsightRow => {
    return {
        calls: stat.calls,
        conflicts: stat.conflicts ?? 0,
        errors: stat.errors,
        lastErrorMessage: stat.lastErrorMessage,
        maxDurationMs: stat.maxDurationMs,
        meanDurationMs: stat.calls === 0 ? 0 : stat.totalDurationMs / stat.calls,
        path: stat.path,
        rate,
    };
};

/**
 * Build the Convex-Insights-style report from a `getFunctionStats` snapshot —
 * pure and side-effect-free so it can be unit-tested without a worker. Three
 * sections, each capped at `limit`. `writeContention` ranks functions that lost
 * an optimistic-concurrency write (OCC conflict) by conflict rate — the true
 * contention signal, since conflicts are a subset of errors, so a high rate
 * means concurrent writes to one shard are colliding (the cue to `.shardBy`).
 * `errorHotspots` ranks functions that threw by error rate, and
 * `latencyOutliers` ranks every function by its slowest single dispatch.
 */
const buildInsightsReport = (functions: FunctionStatRow[], limit: number): InsightsReport => {
    const writeContention = functions
        .filter((stat) => (stat.conflicts ?? 0) > 0)
        .map((stat) => toInsightRow(stat, stat.calls === 0 ? 0 : (stat.conflicts ?? 0) / stat.calls))
        .toSorted((a, b) => b.rate - a.rate || b.conflicts - a.conflicts)
        .slice(0, limit);

    const errorHotspots = functions
        .filter((stat) => stat.errors > 0)
        .map((stat) => toInsightRow(stat, stat.calls === 0 ? 0 : stat.errors / stat.calls))
        .toSorted((a, b) => b.rate - a.rate || b.errors - a.errors)
        .slice(0, limit);

    const latencyOutliers = functions
        .map((stat) => toInsightRow(stat, 0))
        .toSorted((a, b) => b.maxDurationMs - a.maxDurationMs)
        .slice(0, limit);

    return { errorHotspots, latencyOutliers, totalFunctions: functions.length, writeContention };
};

/** Render a 0–1 rate as a one-decimal percentage. */
const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** Render a duration with ms precision under a second, switching to seconds above. */
const formatMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms).toString()}ms` : `${(ms / 1000).toFixed(2)}s`);

/**
 * Render one report section as a heading followed by either its rows (each
 * formatted by `renderRow`) or a single `emptyNote` when nothing qualified.
 * Returning the section's lines (rather than pushing into shared state) keeps
 * {@link formatInsightsReport} a flat compose of three sections.
 */
const formatSection = (heading: string, rows: InsightRow[], emptyNote: string, renderRow: (row: InsightRow) => string): string[] => [
    heading,
    ...(rows.length === 0 ? [`  ${emptyNote}`] : rows.map((row) => `  ${renderRow(row)}`)),
];

/** Format the report as human-readable text — the default (non-`--json`) output. */
const formatInsightsReport = (report: InsightsReport): string => {
    const errorTail = (row: InsightRow): string => (row.lastErrorMessage ? ` — ${row.lastErrorMessage}` : "");

    return [
        `Insights over ${report.totalFunctions.toString()} function${report.totalFunctions === 1 ? "" : "s"}`,
        "",
        ...formatSection(
            "Write-conflict hot-spots (OCC contention — candidates for sharding):",
            report.writeContention,
            "none — no write conflicts observed",
            (row) => `${row.path}  ${row.conflicts.toString()}/${row.calls.toString()} calls (${percent(row.rate)})`,
        ),
        "",
        ...formatSection(
            "Error hot-spots:",
            report.errorHotspots,
            "none — no errors observed",
            (row) => `${row.path}  ${row.errors.toString()}/${row.calls.toString()} calls (${percent(row.rate)})${errorTail(row)}`,
        ),
        "",
        ...formatSection(
            "Latency outliers (slowest single call):",
            report.latencyOutliers,
            "none — no functions have run",
            (row) => `${row.path}  max ${formatMs(row.maxDurationMs)}, mean ${formatMs(row.meanDurationMs)} over ${row.calls.toString()} calls`,
        ),
    ].join("\n");
};

interface InsightsCommandOptions {
    /** Project root, so the running dev server's recorded URL can be found when `--url` is absent. */
    cwd?: string;
    fetchImpl?: FetchLike;
    json?: boolean;
    limit?: number;
    logger: Logger;
    prod?: boolean;
    shard?: string;
    token?: string;
    url?: string;
}

interface InsightsCommandResult {
    code: number;
    report?: InsightsReport;
}

/** Parse `--limit` to a positive integer, falling back to {@link DEFAULT_LIMIT} on an absent/invalid value. */
const resolveLimit = (raw: number | undefined): number => {
    if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
        return DEFAULT_LIMIT;
    }

    return Math.floor(raw);
};

/**
 * `lunora insights` core: read the live worker's per-function metrics over the
 * `__lunora_admin__:getFunctionStats` admin RPC (bearer-gated, resolved by
 * `resolveAdminBearer`), then print the {@link buildInsightsReport} report as
 * text (default) or JSON (`--json`). The admin bearer rides the same
 * `/_lunora/rpc` transport the studio uses; `resolveAdminBaseUrl` refuses to
 * send it in cleartext to a non-loopback host.
 */
const runInsightsCommand = async (options: InsightsCommandOptions): Promise<InsightsCommandResult> => {
    if (options.prod && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to report from the implicit localhost worker)");

        return { code: 1 };
    }

    const baseUrl = resolveAdminBaseUrl(options.url, options.logger, options.cwd);

    if (baseUrl === undefined) {
        return { code: 1 };
    }

    // Resolved after `baseUrl`, and through the shared resolver: the `.dev.vars`
    // fallback is loopback-gated, so it needs the target first. `insights`
    // otherwise demanded a flag against the local worker while `run`, `export`
    // and `import` read the same token straight out of `.dev.vars`.
    const { token } = resolveAdminBearer({ cwd: options.cwd ?? process.cwd(), token: options.token, url: baseUrl });

    if (!token) {
        options.logger.error("admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)");

        return { code: 1 };
    }

    const requestUrl = `${baseUrl}/_lunora/rpc`;
    const fetchImpl: FetchLike = options.fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass fetchImpl or run on Node >= 18");
    }

    const payload: Record<string, unknown> = { args: {}, functionPath: GET_FUNCTION_STATS_OP };

    if (options.shard !== undefined) {
        payload.shardKey = options.shard;
    }

    options.logger.info(`POST ${requestUrl} -> insights`);

    const response = await fetchImpl(requestUrl, {
        body: JSON.stringify(payload),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
    });

    const text = await response.text();

    if (!response.ok) {
        options.logger.error(`insights failed: HTTP ${String(response.status)}: ${text}`);

        return { code: 1 };
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch {
        options.logger.error(`insights failed: worker returned non-JSON: ${text}`);

        return { code: 1 };
    }

    // The RPC may wrap the function result in `{ result }` (the runner envelope)
    // or return it bare; accept either so the command tracks the transport.
    const result = (parsed as { result?: unknown }).result ?? parsed;
    const { functions } = result as Partial<FunctionStatsResult>;

    if (!Array.isArray(functions)) {
        options.logger.error("insights failed: response carried no `functions` array");

        return { code: 1 };
    }

    const report = buildInsightsReport(functions, resolveLimit(options.limit));

    options.logger.info(options.json ? JSON.stringify(report, undefined, 2) : formatInsightsReport(report));

    return { code: 0, report };
};

/** `lunora insights` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<InsightsOptions> = defineHandler<InsightsOptions>(({ cwd, logger, options }) => {
    const limit = options.limit === undefined ? undefined : Number.parseInt(options.limit, 10);

    return runInsightsCommand({
        cwd,
        fetchImpl: undefined,
        json: options.json,
        limit,
        logger,
        prod: options.prod,
        shard: options.shard,
        token: options.token,
        // Fall back to the `.lunora/project.json` link when `--prod` is set, so a
        // linked checkout doesn't need --url repeated for prod insights.
        url: resolveProductionWorkerUrl({ cwd, prod: options.prod === true, url: options.url }),
    });
});

export { buildInsightsReport, execute, formatInsightsReport, runInsightsCommand };
export type { FunctionStatRow, InsightRow, InsightsCommandOptions, InsightsCommandResult, InsightsReport };

export { type FetchLike } from "../run/handler";
