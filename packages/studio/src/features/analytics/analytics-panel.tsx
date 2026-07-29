import type { AnalyticsSqlResult } from "@lunora/bindings/analytics";
import { createAnalyticsSqlClient } from "@lunora/bindings/analytics";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Card } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import type { MessageId } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatCell } from "../../lib/internal";

/**
 * Account-scoped credentials for the Analytics Engine SQL API. A *secret*, never
 * a binding — the host threads `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`
 * (Analytics Read) through from `.dev.vars`/env. Absent ⇒ the panel renders a
 * "configure a token" empty state rather than hard-failing (the analytics panel
 * is optional).
 */
interface AnalyticsConfig {
    readonly accountId: string;
    readonly apiToken: string;
}

interface AnalyticsPanelProps {
    /**
     * SQL-API credentials. When omitted (the default), the panel shows a
     * config-needed empty state — the Studio never ships a real token.
     */
    readonly config?: AnalyticsConfig;

    /**
     * Dataset name to query (the `analytics_engine_datasets[].dataset`, default
     * `ANALYTICS` — the value the config layer reconciles).
     */
    readonly dataset?: string;

    /**
     * Run a SQL-API query. Defaults to a {@link createAnalyticsSqlClient} built
     * from `config`. Injected in tests so the panel never touches the network.
     */
    readonly runQuery?: (sql: string) => Promise<AnalyticsSqlResult>;
}

/** The default reconciled dataset/binding name (see `reconcile-bindings.ts`). */
const DEFAULT_DATASET = "ANALYTICS";

/**
 * One named usage panel: a title and the SQL that backs it. The columns are
 * `@lunora/bindings/analytics`'s `track()` layout — `blob1` is the event name, `blob2`
 * the function path, `double1` the handler duration — so these read against the
 * data points `ctx.analytics.track("function_call", …)` emits.
 */
interface PanelQuery {
    readonly key: string;
    readonly sql: (dataset: string) => string;
    readonly title: MessageId;
}

const PANEL_QUERIES: ReadonlyArray<PanelQuery> = [
    {
        key: "volume",
        sql: (dataset) => `SELECT blob2 AS fn, count() AS calls FROM ${dataset} WHERE blob1 = 'function_call' GROUP BY fn ORDER BY calls DESC LIMIT 25`,
        title: "Request volume per function",
    },
    {
        key: "latency",
        sql: (dataset) =>
            `SELECT blob2 AS fn, quantileWeighted(0.50)(double1, _sample_interval) AS p50, quantileWeighted(0.95)(double1, _sample_interval) AS p95 FROM ${dataset} WHERE blob1 = 'function_call' GROUP BY fn ORDER BY p95 DESC LIMIT 25`,
        title: "Latency p50 / p95 per function",
    },
    {
        key: "hotShards",
        sql: (dataset) => `SELECT blob3 AS shard, count() AS calls FROM ${dataset} WHERE blob1 = 'function_call' GROUP BY shard ORDER BY calls DESC LIMIT 25`,
        title: "Hot shards",
    },
];

/** Lifecycle of a single panel query. */
interface PanelState {
    readonly error: null | string;
    readonly loading: boolean;
    readonly result: AnalyticsSqlResult | null;
}

/** Stable initial/loading state used before a panel's query has resolved. */
const INITIAL_PANEL_STATE: PanelState = { error: null, loading: true, result: null };

/** Render one panel's result table (or its loading / error / empty branch). */
const PanelResult = ({ state, title }: { readonly state: PanelState; readonly title: MessageId }): ReactElement => {
    const t = useT();
    const { error, loading, result } = state;

    return (
        <Card className="gap-0 py-0" data-testid={`analytics-panel-${title}`}>
            <header className="border-b border-border px-4 py-3">
                <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t(title)}</span>
            </header>

            {loading && (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="analytics-loading">
                    {t("Loading…")}
                </p>
            )}

            {!loading && error !== null && (
                <p className="px-4 py-8 text-center text-sm text-destructive" data-testid="analytics-error" role="alert">
                    {error}
                </p>
            )}

            {!loading && error === null && result !== null && result.rows.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="analytics-empty-rows">
                    {t("No data points yet.")}
                </p>
            )}

            {!loading && error === null && result !== null && result.rows.length > 0 && (
                <Table>
                    <TableHeader>
                        <TableRow>
                            {result.columns.map((column) => (
                                <TableHead key={column.name}>{column.name}</TableHead>
                            ))}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {result.rows.map((row, rowIndex) => (
                            // eslint-disable-next-line react-x/no-array-index-key -- AE rows have no stable id; the row's position is the only key.
                            <TableRow key={rowIndex}>
                                {result.columns.map((column) => (
                                    <TableCell className="font-mono text-xs" key={column.name}>
                                        {formatCell(row[column.name])}
                                    </TableCell>
                                ))}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </Card>
    );
};

/**
 * Read-only **Analytics Engine usage panel**. Queries the AE SQL API for the top
 * usage panels — request volume per function, p50/p95 latency, hot shards —
 * against the data points `ctx.analytics.track("function_call", …)` emits.
 *
 * The SQL API needs an account-scoped read token, a *secret* the host provides
 * (never a binding, never auto-scaffolded). With no `config` (and no `runQuery`
 * override) the panel renders a "configure a token" empty state and makes **no**
 * network call — the analytics panel is optional and degrades gracefully, it
 * never hard-fails when AE is unconfigured.
 */
export const AnalyticsPanel = ({ config, dataset = DEFAULT_DATASET, runQuery }: AnalyticsPanelProps = {}): ReactElement => {
    const t = useT();

    const [states, setStates] = useState<Record<string, PanelState>>({});

    // Resolve the query runner: an explicit override wins (tests); otherwise build
    // a SQL client from the token config. `null` when neither is available — the
    // panel then renders the config-needed empty state and never fetches.
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is behaviour: feeds `load`, which an effect depends on; a fresh one re-fires the query every render
    const run = useMemo<((sql: string) => Promise<AnalyticsSqlResult>) | null>(() => {
        if (runQuery !== undefined) {
            return runQuery;
        }

        if (config === undefined) {
            return null;
        }

        const client = createAnalyticsSqlClient({ accountId: config.accountId, apiToken: config.apiToken });

        return (sql: string) => client.query(sql);
    }, [config, runQuery]);

    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is behaviour: an effect depends on this, so a fresh one re-runs the load every render
    const load = useCallback(
        async (token: { cancelled: boolean }): Promise<void> => {
            if (run === null) {
                return;
            }

            for (const panel of PANEL_QUERIES) {
                if (token.cancelled) {
                    return;
                }

                setStates((current) => {
                    return { ...current, [panel.key]: { error: null, loading: true, result: null } };
                });

                try {
                    // eslint-disable-next-line no-await-in-loop -- panels run sequentially to stay under the SQL API's per-token rate limit.
                    const result = await run(panel.sql(dataset));

                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is flipped by the effect's cleanup during the await, so TS's narrowing from the loop-top guard is stale.
                    if (!token.cancelled) {
                        setStates((current) => {
                            return { ...current, [panel.key]: { error: null, loading: false, result } };
                        });
                    }
                } catch (error_) {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is flipped by the effect's cleanup during the await, so TS's narrowing from the loop-top guard is stale.
                    if (!token.cancelled) {
                        setStates((current) => {
                            return { ...current, [panel.key]: { error: errorMessage(error_), loading: false, result: null } };
                        });
                    }
                }
            }
        },
        [run, dataset],
    );

    useEffect(() => {
        const token = { cancelled: false };

        fireAndForget(load(token));

        return () => {
            token.cancelled = true;
        };
    }, [load]);

    if (run === null) {
        return (
            <EmptyState
                description={t("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Analytics Read) in your .dev.vars to enable usage panels.")}
                icon={
                    <svg
                        aria-hidden="true"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.6}
                        viewBox="0 0 24 24"
                    >
                        <path d="M5 20V10m6.5 10V4M18 20v-7M3 20h18" />
                    </svg>
                }
                testId="analytics-not-configured"
                title={t("Analytics is not configured.")}
            />
        );
    }

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-analytics-panel">
            {PANEL_QUERIES.map((panel) => (
                <PanelResult key={panel.key} state={states[panel.key] ?? INITIAL_PANEL_STATE} title={panel.title} />
            ))}
        </div>
    );
};

export type { AnalyticsConfig, AnalyticsPanelProps };
