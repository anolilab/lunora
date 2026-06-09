import { useCirrus } from "@cirrus/react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { FunctionCallStat, FunctionStatsResult, ShardMetrics } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import type { AdvisorRow } from "./advisor-view";
import { AdvisorView } from "./advisor-view";
import { Button } from "./components/ui/button";
import type { Insight } from "./derive-insights";
import { deriveInsights } from "./derive-insights";
import type { TFunction } from "./i18n-context";
import { useT } from "./i18n-context";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal";
import { recordShard } from "./shard-history";
import { ShardInput } from "./shard-input";

interface InsightsPanelProps {
    /** Shard key the snapshots target on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_FUNCTION_STATS = adminRef(ADMIN_FUNCTIONS.getFunctionStats);
const GET_METRICS = adminRef(ADMIN_FUNCTIONS.getMetrics);

/** A 0–1 rate as a one-decimal percentage. */
const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** A millisecond figure as seconds (slow-function values are always ≥ 1s by construction). */
const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

/** A human list of table names: `posts`, `posts and tags`, `posts, tags and authors`. */
const tableList = (tables: string[]): string => {
    if (tables.length <= 1) {
        return tables[0] ?? "";
    }

    const last = tables[tables.length - 1] ?? "";

    return `${tables.slice(0, -1).join(", ")} and ${last}`;
};

/** Localized headline per insight kind, shown in the Issue type column. */
const insightTitle = (t: TFunction, insight: Insight): string =>
    ({
        "high-error-rate": t("High error rate"),
        "high-evictions": t("High cache eviction rate"),
        "low-cache-hit-rate": t("Low cache hit rate"),
        "missing-index": t("Missing index"),
        "slow-function": t("Slow function"),
    })[insight.kind];

/**
 * Localized one-line explanation per insight kind. `missing-index` is the causal
 * read — it names the table(s) the slow function full-scanned, so the operator
 * sees *why* it's slow ("…BECAUSE it full-scanned `posts`") rather than just
 * that it's slow.
 */
const insightDetail = (t: TFunction, insight: Insight): string =>
    ({
        "high-error-rate": t("{rate} of calls failed.", { rate: percent(insight.value) }),
        "high-evictions": t("{count} entries evicted recently.", { count: insight.value }),
        "low-cache-hit-rate": t("{rate} hit rate over recent traffic.", { rate: percent(insight.value) }),
        "missing-index": t("Slowest call took {duration} — it full-scanned {tables} with no index.", {
            duration: seconds(insight.value),
            tables: tableList(insight.tables ?? []),
        }),
        "slow-function": t("Slowest call took {duration}.", { duration: seconds(insight.value) }),
    })[insight.kind];

interface AddIndexButtonProps {
    /** Invoked with `table` on click — the stable deep-link jump from the panel. */
    readonly onJump: (table: string) => void;
    /** The full-scanned table this button adds an index for. */
    readonly table: string;
}

/**
 * One "add the index" deep-link button for a scanned table. Extracted so each
 * button binds its `table` through a stable `onClick` (closing over the table +
 * the panel's `onJump`) rather than minting a fresh inline handler per render.
 */
const AddIndexButton = ({ onJump, table }: AddIndexButtonProps): ReactElement => {
    const t = useT();
    const onClick = useCallback((): void => {
        onJump(table);
    }, [onJump, table]);

    return (
        <Button data-testid={`in-add-index-${table}`} onClick={onClick} size="sm" type="button" variant="outline">
            {t("Add index on {table}", { table })}
        </Button>
    );
};

/**
 * The Performance Advisor — a 1-to-1 of Supabase's Performance Advisor: severity
 * tabs over a findings table (via {@link AdvisorView}). It pulls the `getMetrics`
 * health snapshot and `getFunctionStats` per-function table for one shard, then
 * maps the issues {@link deriveInsights} detects (low cache hit rate, high
 * eviction, slow functions, missing indexes, error spikes) into rows. A
 * `missing-index` row carries an inline "add the index" jump to the Schema tab.
 * Both reads are best-effort — one failing still yields the other's insights.
 */
export const InsightsPanel = ({ initialShardKey }: InsightsPanelProps): ReactElement => {
    const client = useCirrus();
    const navigate = useNavigate();
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [metrics, setMetrics] = useState<ShardMetrics | null>(null);
    const [functions, setFunctions] = useState<FunctionCallStat[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [loading, setLoading] = useState<boolean>(false);

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            setLoading(true);

            const [snapshot, stats] = await Promise.allSettled([
                client.query(GET_METRICS, {}, callOptions(shard)) as Promise<ShardMetrics>,
                client.query(GET_FUNCTION_STATS, {}, callOptions(shard)) as Promise<FunctionStatsResult>,
            ]);

            // Surface an error only when BOTH reads fail — a partial snapshot
            // still yields useful insights, so one failure shouldn't blank it.
            if (snapshot.status === "rejected" && stats.status === "rejected") {
                setError(errorMessage(snapshot.reason));
            } else {
                setError(null);
                recordShard(shard);
            }

            setMetrics(snapshot.status === "fulfilled" ? snapshot.value : null);
            setFunctions(stats.status === "fulfilled" ? stats.value.functions : null);
            setLoading(false);
        },
        [client],
    );

    useEffect(() => {
        fireAndForget(refresh(initialShardKey ?? ""));
    }, [refresh, initialShardKey]);

    const onRefresh = useCallback((): void => {
        fireAndForget(refresh(shardKey));
    }, [refresh, shardKey]);

    // Deep-link the "add the index" jump: open the Schema tab with the scanned
    // table pre-selected (`/schema?table=<name>`) so the operator lands on its
    // index list. The schema route reads the `table` search param and
    // auto-expands it.
    const jumpToSchemaIndex = useCallback(
        (table: string): void => {
            fireAndForget(navigate({ search: { table }, to: "/schema" }));
        },
        [navigate],
    );

    const insights = useMemo<Insight[]>(() => deriveInsights(metrics, functions), [metrics, functions]);

    const rows = useMemo<AdvisorRow[]>(
        () =>
            insights.map((insight) => {
                const tables = insight.kind === "missing-index" ? (insight.tables ?? []) : [];

                return {
                    action: tables.length > 0 ? tables.map((table) => <AddIndexButton key={table} onJump={jumpToSchemaIndex} table={table} />) : undefined,
                    description: insight.message === undefined ? insightDetail(t, insight) : `${insightDetail(t, insight)} — ${insight.message}`,
                    entity: insight.fn,
                    issueType: insightTitle(t, insight),
                    key: `${insight.kind}:${insight.fn ?? ""}`,
                    level: insight.severity,
                };
            }),
        [insights, jumpToSchemaIndex, t],
    );

    const toolbar = <ShardInput onChange={setShardKey} testId="in-shard-input" value={shardKey} />;

    return <AdvisorView error={error} loading={loading} onRefresh={onRefresh} rows={rows} testId="cirrus-insights" toolbar={toolbar} />;
};

export type { InsightsPanelProps };
