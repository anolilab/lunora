import type { AdvisorShardTraffic } from "@lunora/advisor";
import { useLunora } from "@lunora/react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import { ShardInput } from "../../components/shard-input";
import { Button } from "../../components/ui/button";
import type { TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import type {
    AdvisoriesResult,
    AdvisoryFinding,
    FunctionCallStat,
    FunctionStatsResult,
    MetricsIndexHit,
    MetricsSnapshot,
    ShardTrafficResult,
    TableIndexesResult,
    TableInfo,
} from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import useLiveShardSeed from "../data/hooks/use-live-shard-seed";
import type { AdvisorRow } from "./advisor-view";
import { AdvisorView, advisoryRow } from "./advisor-view";
import { ApplyIndexButton } from "./apply-index-button";
import { hasIndexMetadata } from "./compose-index-sql";
import type { Insight } from "./derive-insights";
import { deriveInsights } from "./derive-insights";
import type { DeclaredIndex } from "./derive-runtime-advisories";
import { declaredIndexesFor, deriveRuntimeAdvisories } from "./derive-runtime-advisories";

interface InsightsPanelProps {
    /** Shard key the snapshots target on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;

    /**
     * Fan the cross-shard traffic feed out for `table`, returning each shard's
     * `{ shardKey, requests }` total — the input the `hot_shard` advisor lint
     * needs. Defaults to `client.shardTraffic(table)` (the admin-gated
     * `POST /_lunora/admin/shard-traffic` fan-out). Best-effort: a rejection
     * leaves `hot_shard` dormant rather than blanking the panel. Injectable so
     * tests can drive the skew without a worker.
     */
    readonly loadShardTraffic?: (table: string) => Promise<ShardTrafficResult>;
}

const GET_ADVISORIES = adminRef(ADMIN_FUNCTIONS.getAdvisories);
const GET_FUNCTION_STATS = adminRef(ADMIN_FUNCTIONS.getFunctionStats);
const GET_METRICS = adminRef(ADMIN_FUNCTIONS.getMetrics);
const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);
const LIST_TABLE_INDEXES = adminRef(ADMIN_FUNCTIONS.listTableIndexes);

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
        "high-write-contention": t("High write contention"),
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
        "high-write-contention": t("{rate} of calls hit a write conflict — consider sharding to cut contention.", {
            rate: percent(insight.value),
        }),
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
    const onClick = (): void => {
        onJump(table);
    };

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
export const InsightsPanel = ({ initialShardKey, loadShardTraffic }: InsightsPanelProps): ReactElement => {
    const client = useLunora();
    const navigate = useNavigate();
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
    const [functions, setFunctions] = useState<FunctionCallStat[] | null>(null);
    const [advisories, setAdvisories] = useState<AdvisoryFinding[] | null>(null);
    // Runtime-lint inputs the dead-index advisory reconciles: the per-(table,
    // index) recorded reads from getMetrics and every declared index from
    // listTables + listTableIndexes. Both best-effort — absent on an older
    // worker, where the runtime lints simply find nothing.
    const [indexHits, setIndexHits] = useState<MetricsIndexHit[] | null>(null);
    const [declaredIndexes, setDeclaredIndexes] = useState<DeclaredIndex[] | null>(null);
    // The cross-shard request distribution feeding the hot_shard lint. Fanned
    // out on demand (not on the metrics hot path) and best-effort — null when
    // the worker predates the shard-traffic endpoint, so hot_shard stays quiet.
    const [shardTraffic, setShardTraffic] = useState<AdvisorShardTraffic[] | null>(null);
    const [error, setError] = useState<null | string>(null);

    // Default the shard-traffic fan-out to the client's admin RPC; an injected
    // override lets tests drive a skewed distribution without a worker.
    const fanShardTraffic = loadShardTraffic ?? ((table: string): Promise<ShardTrafficResult> => client.shardTraffic(table));

    // Fan the cross-shard traffic feed out so the hot_shard lint can see
    // cross-shard skew — the one input a single shard's snapshot can't supply.
    // Off the metrics hot path and best-effort: a rejection (older worker / no
    // admin token) leaves hot_shard dormant rather than blanking the panel.
    // Driven by any one table's live shard set — a DO holds every table, so each
    // shard's getMetrics request total is the same regardless of which table
    // seeds the fan-out; we dedupe by shardKey to be safe.
    const loadShardTrafficFeed = async (tableNames: ReadonlyArray<string>): Promise<void> => {
        // The fan-out needs ANY live table to enumerate the shard set; with no
        // tables there's nothing to seed it, so skip the call entirely rather
        // than POST an empty `table` the worker rejects with a 400.
        const seedTable = tableNames[0];

        if (seedTable === undefined || seedTable === "") {
            setShardTraffic(null);

            return;
        }

        try {
            const traffic = await fanShardTraffic(seedTable);
            const byShard = new Map<string, AdvisorShardTraffic>();

            for (const entry of traffic.shards) {
                if (!byShard.has(entry.shardKey)) {
                    byShard.set(entry.shardKey, { requests: entry.requests, shardKey: entry.shardKey });
                }
            }

            setShardTraffic([...byShard.values()]);
        } catch {
            // shard-traffic endpoint unavailable — leave hot_shard dormant.
            setShardTraffic(null);
        }
    };

    const refresh = async (shard: string): Promise<void> => {
        const [snapshot, stats, advisorySnapshot] = await Promise.allSettled([
            client.query(GET_METRICS, {}, callOptions(shard)) as Promise<MetricsSnapshot>,
            client.query(GET_FUNCTION_STATS, {}, callOptions(shard)) as Promise<FunctionStatsResult>,
            client.query(GET_ADVISORIES, {}, callOptions(shard)) as Promise<AdvisoriesResult>,
        ]);

        // Surface an error only when BOTH runtime reads fail — a partial
        // snapshot still yields useful insights, so one failure shouldn't
        // blank it. The static advisories are additive: a worker that
        // predates the RPC simply reports none, never an error.
        if (snapshot.status === "rejected" && stats.status === "rejected") {
            setError(errorMessage(snapshot.reason));
        } else {
            setError(null);
            recordShard(shard);
        }

        setMetrics(snapshot.status === "fulfilled" ? snapshot.value : null);
        setFunctions(stats.status === "fulfilled" ? stats.value.functions : null);
        setAdvisories(advisorySnapshot.status === "fulfilled" ? advisorySnapshot.value.advisories : null);
        setIndexHits(snapshot.status === "fulfilled" ? (snapshot.value.indexHits ?? null) : null);

        // Enumerate the declared indexes for the dead-index reconciliation:
        // the recorded-reads feed only carries USED indexes, so a declared
        // index absent from it is dead. Best-effort and independent of the
        // metrics reads — a worker without listTables / listTableIndexes (or
        // without an admin token for them) just yields no declared indexes,
        // so the dead-index check stays quiet rather than failing the panel.
        let tableNames: string[] = [];

        try {
            const tables = (await client.query(LIST_TABLES, {}, callOptions(shard))) as TableInfo[];

            tableNames = tables.map((table) => table.name);

            const indexResults = await Promise.allSettled(
                tables.map(
                    async (table) =>
                        [table.name, (await client.query(LIST_TABLE_INDEXES, { table: table.name }, callOptions(shard))) as TableIndexesResult] as const,
                ),
            );

            const declared: DeclaredIndex[] = [];

            for (const result of indexResults) {
                if (result.status === "fulfilled") {
                    const [name, payload] = result.value;

                    declared.push(...declaredIndexesFor(name, payload.indexes));
                }
            }

            setDeclaredIndexes(declared);
        } catch {
            // listTables unavailable (older worker / no admin token) — no
            // declared-index enumeration, so the dead-index check is dormant.
            setDeclaredIndexes(null);
        }

        await loadShardTrafficFeed(tableNames);
    };

    // Drive the initial load and re-load whenever `shardKey` changes (debounced),
    // mirroring the `useLiveShardSeed` protocol used by function-stats, audit-panel,
    // and logs-panel. Previously the panel only reloaded on mount + visibility change,
    // so typing a different shard key never re-fetched — operators saw stale data for
    // whatever shard was loaded at mount.
    useLiveShardSeed(shardKey, refresh);

    // Auto-refresh when the tab regains focus. The studio is a standalone app
    // (not a Vite HMR client), so it can't hear codegen reloads directly — but
    // tabbing back from your editor after a schema save (by which point the dev
    // worker has reloaded with the new `LUNORA_ADVISORIES`) re-pulls everything,
    // so advisories land fresh without a manual Refresh.
    useEffect(() => {
        const onVisible = (): void => {
            if (document.visibilityState === "visible") {
                fireAndForget(refresh(shardKey));
            }
        };

        document.addEventListener("visibilitychange", onVisible);

        return () => {
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [refresh, shardKey]);

    // Deep-link the "add the index" jump: open the Schema tab with the scanned
    // table pre-selected (`/schema?table=<name>`) so the operator lands on its
    // index list. The schema route reads the `table` search param and
    // auto-expands it.
    const jumpToSchemaIndex = (table: string): void => {
        fireAndForget(navigate({ search: { table }, to: "/schema" }));
    };

    const insights = deriveInsights(metrics, functions);

    // Tables the `missing-index` insight already reports on. The runtime
    // `index_utilization` hot-scan lint reads the SAME `scannedTables` signal, so
    // without this gate a hot full-scanned table would render twice (once per
    // layer). The insight owns the hot-scan story (it's the causal, latency-aware
    // view with the inline "add index" jump); the runtime lint suppresses its
    // hot-scan finding for those tables and keeps only its unique dead-index half.
    const missingIndexTables = new Set(insights.filter((insight) => insight.kind === "missing-index").flatMap((insight) => insight.tables ?? []));

    // Runtime advisor lints (dead index + hot scan + hot shard) over the recorded
    // metrics. Same verbatim advisory mapping as the static getAdvisories findings
    // — no new i18n. The shardTraffic feed (fanned out above) flows in so hot_shard
    // fires on a genuine cross-shard skew; hot-scan findings for tables the
    // missing-index insight already owns are suppressed so a hot table renders once.
    const runtimeRows = deriveRuntimeAdvisories({
        declaredIndexes: declaredIndexes ?? [],
        functions,
        indexHits,
        shardTraffic,
        suppressHotScanTables: missingIndexTables,
    });

    const rows = useMemo<AdvisorRow[]>(() => {
        const insightRows = insights.map((insight) => {
            const tables = insight.kind === "missing-index" ? (insight.tables ?? []) : [];

            return {
                action: tables.length > 0 ? tables.map((table) => <AddIndexButton key={table} onJump={jumpToSchemaIndex} table={table} />) : undefined,
                description: insight.message === undefined ? insightDetail(t, insight) : `${insightDetail(t, insight)} — ${insight.message}`,
                entity: insight.fn,
                issueType: insightTitle(t, insight),
                key: `${insight.kind}:${insight.fn ?? ""}`,
                level: insight.severity,
            };
        });

        // Static schema advisories (codegen-time lints) first, then the runtime
        // advisor lints (dead index / hot scan), then the derived insights. The
        // severity tabs in AdvisorView regroup them all by level.
        //
        // For `unindexed_foreign_key` / `unindexed_relation_target` findings (and
        // any other finding that carries `suggestedIndex` metadata), attach an
        // "Apply index" action that composes the `CREATE INDEX` SQL and copies it
        // to the operator's clipboard on confirm. This is the Item 5 "create all
        // missing indexes" apply control — per-finding rather than bulk, guarded
        // by ConfirmButton.
        const indexAdvisoryLints = new Set(["unindexed_foreign_key", "unindexed_relation_target"]);
        const staticRows: AdvisorRow[] = (advisories ?? []).map((finding) => {
            const base = advisoryRow(finding);

            if (indexAdvisoryLints.has(finding.name) && hasIndexMetadata(finding.metadata)) {
                const { table, suggestedIndex } = finding.metadata;
                const testId = `in-apply-index-${table}-${suggestedIndex.name}`;

                return {
                    ...base,
                    action: <ApplyIndexButton fields={suggestedIndex.fields} indexName={suggestedIndex.name} table={table} testId={testId} />,
                };
            }

            return base;
        });

        return [...staticRows, ...runtimeRows, ...insightRows];
    }, [advisories, insights, jumpToSchemaIndex, runtimeRows, t]);

    const toolbar = <ShardInput onChange={setShardKey} testId="in-shard-input" value={shardKey} />;

    return <AdvisorView error={error} rows={rows} testId="lunora-insights" toolbar={toolbar} />;
};

export type { InsightsPanelProps };
