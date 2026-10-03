import type { AnalyticsSqlQueryResult, FunctionUsagePanel } from "@lunora/bindings/analytics-sql";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Card } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import type { MessageId } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatCell } from "../../lib/internal";

interface AnalyticsPanelProps {
    /**
     * Resolve one usage panel. The panel sends only its key; the host's runner
     * calls an action that builds the statement server-side with
     * `functionUsageQuery(panel)` from `@lunora/bindings/analytics-sql` and runs it
     * through `ctx.analyticsSql`. That action reads account analytics, so it must
     * be admin-gated, and it must take the panel key, never SQL: an action that
     * ran caller-supplied SQL could read every dataset in the account. Studio passes
     * its analyticsSqlQuery prop through here; with none, the panel renders an empty
     * state and makes no network call.
     */
    readonly runQuery?: (panel: FunctionUsagePanel) => Promise<AnalyticsSqlQueryResult>;
}

/**
 * The usage panels, in display order, and their titles. Exhaustive over
 * {@link FunctionUsagePanel}, so a panel the bindings add without a title here
 * is a type error.
 */
const PANEL_TITLES = {
    volume: "Request volume per function",
    latency: "Latency p50 / p95 per function",
    hotShards: "Hot shards",
} as const satisfies Record<FunctionUsagePanel, MessageId>;

const PANELS = Object.keys(PANEL_TITLES) as FunctionUsagePanel[];

/** Lifecycle of a single panel query. */
interface PanelState {
    readonly error: null | string;
    readonly loading: boolean;
    readonly rows: ReadonlyArray<Record<string, unknown>> | null;
}

/** Stable initial/loading state used before a panel's query has resolved. */
const INITIAL_PANEL_STATE: PanelState = { error: null, loading: true, rows: null };

/**
 * The result's columns: the first row's keys, in the order the SELECT list
 * produced them — the binding returns rows without column metadata.
 */
const columnsOf = (rows: ReadonlyArray<Record<string, unknown>>): string[] => Object.keys(rows[0] ?? {});

/** Render one panel's result table (or its loading / error / empty branch). */
const PanelResult = ({ state, title }: { readonly state: PanelState; readonly title: MessageId }): ReactElement => {
    const t = useT();
    const { error, loading, rows } = state;
    const columns = rows === null ? [] : columnsOf(rows);

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

            {!loading && error === null && rows !== null && rows.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="analytics-empty-rows">
                    {t("No data points yet.")}
                </p>
            )}

            {!loading && error === null && rows !== null && rows.length > 0 && (
                <Table>
                    <TableHeader>
                        <TableRow>
                            {columns.map((column) => (
                                <TableHead key={column}>{column}</TableHead>
                            ))}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row, rowIndex) => (
                            // eslint-disable-next-line react-x/no-array-index-key -- AE rows have no stable id; the row's position is the only key.
                            <TableRow key={rowIndex}>
                                {columns.map((column) => (
                                    <TableCell className="font-mono text-xs" key={column}>
                                        {formatCell(row[column])}
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
 * Read-only **Analytics Engine usage panel**: request volume per function,
 * p50/p95 latency, hot shards — over the data points
 * `ctx.analytics.track("function_call", …)` emits.
 *
 * The panel builds no SQL and holds no client: it asks the host's `runQuery`
 * for each panel by key, and the host answers through an admin-gated action on
 * `ctx.analyticsSql`. With no runner the panel renders an empty state and makes
 * **no** network call — it never hard-fails when analytics is unwired.
 */
export const AnalyticsPanel = ({ runQuery }: AnalyticsPanelProps = {}): ReactElement => {
    const t = useT();

    const [states, setStates] = useState<Partial<Record<FunctionUsagePanel, PanelState>>>({});

    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is behaviour: an effect depends on this, so a fresh one re-runs the load every render
    const load = useCallback(
        async (token: { cancelled: boolean }): Promise<void> => {
            if (runQuery === undefined) {
                return;
            }

            for (const panel of PANELS) {
                if (token.cancelled) {
                    return;
                }

                setStates((current) => {
                    return { ...current, [panel]: INITIAL_PANEL_STATE };
                });

                try {
                    /* eslint-disable no-await-in-loop -- panels run sequentially to stay under the SQL API's per-token rate limit. */
                    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential on purpose: each read is a separate worker round-trip and firing them together would burst the very analytics endpoint being measured
                    const { rows } = await runQuery(panel);
                    /* eslint-enable no-await-in-loop */

                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is flipped by the effect's cleanup during the await, so TS's narrowing from the loop-top guard is stale.
                    if (!token.cancelled) {
                        setStates((current) => {
                            return { ...current, [panel]: { error: null, loading: false, rows } };
                        });
                    }
                } catch (error_) {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `cancelled` is flipped by the effect's cleanup during the await, so TS's narrowing from the loop-top guard is stale.
                    if (!token.cancelled) {
                        setStates((current) => {
                            return { ...current, [panel]: { error: errorMessage(error_), loading: false, rows: null } };
                        });
                    }
                }
            }
        },
        [runQuery],
    );

    useEffect(() => {
        const token = { cancelled: false };

        fireAndForget(load(token));

        return () => {
            token.cancelled = true;
        };
    }, [load]);

    if (runQuery === undefined) {
        return (
            <EmptyState
                description={t(
                    "Analytics usage panels read through your worker, never from the browser. Pass studio.analyticsSqlQuery, a runner that calls an admin-only action running functionUsageQuery(panel) through ctx.analyticsSql, to enable these panels.",
                )}
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
                title={t("Analytics usage panels are not wired up.")}
            />
        );
    }

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-analytics-panel">
            {PANELS.map((panel) => (
                <PanelResult key={panel} state={states[panel] ?? INITIAL_PANEL_STATE} title={PANEL_TITLES[panel]} />
            ))}
        </div>
    );
};

export type { AnalyticsPanelProps };
