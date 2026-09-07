import type { AdvisorShardTraffic } from "@lunora/advisor";
import { useLunora } from "@lunora/react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { ShardInput } from "../../components/shard-input";
import { Button } from "../../components/ui/button";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useShardKey } from "../../hooks/use-shard-key";
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
    TablesIndexesResult,
} from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, fireAndForget, formatBytes } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import type { AdvisorRow } from "./advisor-view";
import { AdvisorView, advisoryRow } from "./advisor-view";
import { ApplyIndexButton } from "./apply-index-button";
import { hasIndexMetadata } from "./compose-index-declaration";
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

const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);
const LIST_TABLE_INDEXES = adminRef(ADMIN_FUNCTIONS.listTableIndexes);
const LIST_TABLES_INDEXES = adminRef(ADMIN_FUNCTIONS.listTablesIndexes);

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
        "storage-headroom": t("Storage headroom"),
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
        "storage-headroom": t("{size} of the 10 GiB per-shard ceiling — plan a .shardBy() migration while it still has runway.", {
            size: formatBytes(insight.value),
        }),
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
 * eviction, slow functions, missing indexes, error spikes, storage headroom)
 * into rows. A `missing-index` row carries an inline "add the index" jump to the
 * Schema tab. Both reads are best-effort — one failing still yields the other's
 * insights.
 */
export const InsightsPanel = ({ initialShardKey, loadShardTraffic }: InsightsPanelProps): ReactElement => {
    const client = useLunora();
    const navigate = useNavigate();
    const t = useT();

    const { queryShardKey, setShardKey, shardKey } = useShardKey(initialShardKey);

    // Runtime-lint inputs the dead-index advisory reconciles: every declared index
    // from listTables + listTableIndexes. Best-effort — absent on an older worker,
    // where the runtime lints simply find nothing.
    const [declaredIndexes, setDeclaredIndexes] = useState<DeclaredIndex[] | null>(null);
    // The cross-shard request distribution feeding the hot_shard lint. Fanned
    // out on demand (not on the metrics hot path) and best-effort — null when
    // the worker predates the shard-traffic endpoint, so hot_shard stays quiet.
    const [shardTraffic, setShardTraffic] = useState<AdvisorShardTraffic[] | null>(null);

    // The most recently requested enumeration shard. `enumerateShard` runs
    // fire-and-forget from both the shard-change effect and the visibility handler,
    // so a slower request for a previous shard can resolve last; every state write
    // is gated on this ref still naming the shard it was issued for, so a stale
    // completion can't overwrite the current shard's `declaredIndexes`/`shardTraffic`.
    const latestEnumeratedShard = useRef<string>("");

    // The three simple shard-scoped reads, each live so a write-flush re-pushes
    // without a manual refresh. `metrics`/`functions`/`advisories` are best-effort:
    // a partial snapshot still yields useful insights, so a single failure doesn't
    // blank the panel — only a failure of BOTH runtime reads surfaces a hard error.
    const metricsQuery = useAdminQuery<MetricsSnapshot>(ADMIN_FUNCTIONS.getMetrics, {}, { live: true, shardKey: queryShardKey });
    const functionsQuery = useAdminQuery<FunctionStatsResult>(ADMIN_FUNCTIONS.getFunctionStats, {}, { live: true, shardKey: queryShardKey });
    const advisoriesQuery = useAdminQuery<AdvisoriesResult>(ADMIN_FUNCTIONS.getAdvisories, {}, { live: true, shardKey: queryShardKey });

    const metrics: MetricsSnapshot | null = metricsQuery.data ?? null;
    const functions: FunctionCallStat[] | null = functionsQuery.data?.functions ?? null;
    const advisories: AdvisoryFinding[] | null = advisoriesQuery.data?.advisories ?? null;
    // The recorded per-(table, index) reads from the metrics snapshot — the other
    // half of the dead-index reconciliation (a declared index absent here is dead).
    const indexHits: MetricsIndexHit[] | null = metricsQuery.data?.indexHits ?? null;

    // Surface an error only when BOTH runtime reads fail — a partial snapshot still
    // yields useful insights. The static advisories are additive: a worker that
    // predates the RPC simply reports none, never an error.
    const error = metricsQuery.error !== null && functionsQuery.error !== null ? metricsQuery.error : null;

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
    const loadShardTrafficFeed = async (tableNames: ReadonlyArray<string>, shard: string): Promise<void> => {
        // The fan-out needs ANY live table to enumerate the shard set; with no
        // tables there's nothing to seed it, so skip the call entirely rather
        // than POST an empty `table` the worker rejects with a 400.
        const seedTable = tableNames[0];

        if (seedTable === undefined || seedTable === "") {
            if (latestEnumeratedShard.current === shard) {
                setShardTraffic(null);
            }

            return;
        }

        try {
            const traffic = await fanShardTraffic(seedTable);

            // A newer shard enumeration superseded this one mid-flight — drop the
            // result rather than overwrite the current shard's traffic.
            if (latestEnumeratedShard.current !== shard) {
                return;
            }

            const byShard = new Map<string, AdvisorShardTraffic>();

            for (const entry of traffic.shards) {
                if (!byShard.has(entry.shardKey)) {
                    byShard.set(entry.shardKey, { requests: entry.requests, shardKey: entry.shardKey });
                }
            }

            setShardTraffic([...byShard.values()]);
        } catch {
            // shard-traffic endpoint unavailable — leave hot_shard dormant.
            if (latestEnumeratedShard.current === shard) {
                setShardTraffic(null);
            }
        }
    };

    // Per-table fan-out fallback: one `listTableIndexes` call per table, kept
    // for a worker predating the batched `listTablesIndexes` RPC. `Promise.allSettled`
    // so ONE table's rejected call doesn't drop every other table's declared
    // indexes — a partial reply degrades gracefully rather than going dormant.
    const fetchDeclaredIndexesPerTable = async (tableNames: ReadonlyArray<string>, shard: string): Promise<DeclaredIndex[]> => {
        const indexResults = await Promise.allSettled(
            tableNames.map(
                async (name) => [name, (await client.query(LIST_TABLE_INDEXES, { table: name }, callOptions(shard))) as TableIndexesResult] as const,
            ),
        );

        const declared: DeclaredIndex[] = [];

        for (const result of indexResults) {
            if (result.status === "fulfilled") {
                const [name, payload] = result.value;

                declared.push(...declaredIndexesFor(name, payload.indexes));
            }
        }

        return declared;
    };

    // Enumerate the declared indexes (listTables + one batched listTablesIndexes
    // call) and fan out the cross-shard traffic feed for `shard` — the two
    // imperative, multi-step flows that don't fit a single live read. The live
    // `metricsQuery` already owns the recorded-reads (`indexHits`) half of the
    // dead-index reconciliation; this supplies the declared-index half.
    // Best-effort and independent of the metrics reads — a worker without
    // listTables / listTablesIndexes (or without an admin token for them) just
    // yields no declared indexes, so the dead-index check stays quiet rather than
    // failing the panel. `recordShard` runs only on a successful read, mirroring
    // the old refresh.
    //
    // AN EFFECT EVENT, not a `useCallback`: it reads `fanShardTraffic` /
    // `loadShardTrafficFeed` / `fetchDeclaredIndexesPerTable`, render-fresh
    // closures over `loadShardTraffic` and `client`. A memoized callback pinned
    // to `[client]` would keep whichever of those closures was in scope the
    // render it was (re)created — so an injected `loadShardTraffic` override
    // changing later, with `client` unchanged, would silently keep fanning out
    // through the STALE override. An effect event always resolves through the
    // latest committed closures without becoming a reactive dependency itself,
    // so callers (the effect below, and `refreshOnVisible`) don't re-run just
    // because it was called.
    const enumerateShard = useEffectEvent(async (shard: string): Promise<void> => {
        // Claim this as the latest enumeration; any earlier in-flight call now
        // sees a ref mismatch after its awaits and drops its (stale) writes.
        latestEnumeratedShard.current = shard;

        let tableNames: string[] = [];

        try {
            const tables = (await client.query(LIST_TABLES, {}, callOptions(shard))) as TableInfo[];

            if (latestEnumeratedShard.current !== shard) {
                return;
            }

            recordShard(shard);
            tableNames = tables.map((table) => table.name);

            let declared: DeclaredIndex[] = [];

            if (tableNames.length > 0) {
                try {
                    // One RPC for every table instead of one per table — the
                    // fan-out this collapses used to cost a full admin RPC PER
                    // table on every shard change and `visibilitychange` refresh.
                    const batched = (await client.query(LIST_TABLES_INDEXES, { tables: tableNames }, callOptions(shard))) as TablesIndexesResult;

                    if (latestEnumeratedShard.current !== shard) {
                        return;
                    }

                    for (const [name, indexes] of Object.entries(batched.indexesByTable)) {
                        declared.push(...declaredIndexesFor(name, indexes));
                    }
                } catch {
                    // Older worker without listTablesIndexes — fall back to the
                    // per-table fan-out so the dead-index check still works.
                    declared = await fetchDeclaredIndexesPerTable(tableNames, shard);

                    if (latestEnumeratedShard.current !== shard) {
                        return;
                    }
                }
            }

            setDeclaredIndexes(declared);
        } catch {
            // listTables unavailable (older worker / no admin token) — no
            // declared-index enumeration, so the dead-index check is dormant.
            if (latestEnumeratedShard.current === shard) {
                setDeclaredIndexes(null);
            }
        }

        await loadShardTrafficFeed(tableNames, shard);
    });

    // Drive the imperative enumeration + traffic fan-out on the debounced shard —
    // the live reads (metrics/function-stats/advisories) re-fetch via their own
    // cache key. Previously the panel only reloaded on mount + visibility change, so
    // typing a different shard key never re-fetched the enumeration either.
    // `enumerateShard` is an effect event, so it's deliberately omitted below —
    // listing it would be listing a value that's stable by construction and
    // exists precisely so it ISN'T a reactive dependency.
    useEffect(() => {
        // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- drives an imperative enumeration over the debounced shard — an async load, not derived state
        fireAndForget(enumerateShard(queryShardKey));
    }, [queryShardKey]);

    // Auto-refresh when the tab regains focus. The studio is a standalone app
    // (not a Vite HMR client), so it can't hear codegen reloads directly — but
    // tabbing back from your editor after a schema save (by which point the dev
    // worker has reloaded with the new `LUNORA_ADVISORIES`) re-pulls everything,
    // so advisories land fresh without a manual Refresh.
    //
    // The refresh itself is an EFFECT EVENT: it reads five values that change on
    // nearly every render, and listing them as deps tore down and re-registered
    // the `visibilitychange` listener each time. An effect event always sees the
    // latest values without being a dep, so the listener is bound once.
    const refreshOnVisible = useEffectEvent((): void => {
        metricsQuery.refetch();
        functionsQuery.refetch();
        advisoriesQuery.refetch();
        fireAndForget(enumerateShard(queryShardKey));
    });

    useEffect(() => {
        const onVisible = (): void => {
            if (document.visibilityState === "visible") {
                refreshOnVisible();
            }
        };

        document.addEventListener("visibilitychange", onVisible);

        return () => {
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, []);

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

    // Memoized, not a bare call: `insights` and `runtimeRows` below are deps of
    // the `rows` memo, so a fresh array identity on every render made that memo
    // inert — `deriveRuntimeAdvisories` re-ran the whole lint set, and every
    // action element was rebuilt, on each render of the panel.
    const insights = useMemo(() => deriveInsights(metrics, functions), [functions, metrics]);

    // Tables the `missing-index` insight already reports on. The runtime
    // `index_utilization` hot-scan lint reads the SAME `scannedTables` signal, so
    // without this gate a hot full-scanned table would render twice (once per
    // layer). The insight owns the hot-scan story (it's the causal, latency-aware
    // view with the inline "add index" jump); the runtime lint suppresses its
    // hot-scan finding for those tables and keeps only its unique dead-index half.
    const missingIndexTables = useMemo(
        // react-doctor-disable-next-line react-doctor/js-combine-iterations -- two passes over the advisor insights for one shard — a findings list, built once per fetch
        () => new Set(insights.filter((insight) => insight.kind === "missing-index").flatMap((insight) => insight.tables ?? [])),
        [insights],
    );

    // Runtime advisor lints (dead index + hot scan + hot shard) over the recorded
    // metrics. Same verbatim advisory mapping as the static getAdvisories findings
    // — no new i18n. The shardTraffic feed (fanned out above) flows in so hot_shard
    // fires on a genuine cross-shard skew; hot-scan findings for tables the
    // missing-index insight already owns are suppressed so a hot table renders once.
    const runtimeRows = useMemo(
        () =>
            deriveRuntimeAdvisories({
                declaredIndexes: declaredIndexes ?? [],
                functions,
                indexHits,
                shardTraffic,
                suppressHotScanTables: missingIndexTables,
            }),
        [declaredIndexes, functions, indexHits, missingIndexTables, shardTraffic],
    );

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
        // action that composes the `.index(...)` schema declaration and copies it
        // to the operator's clipboard on confirm — per-finding rather than bulk,
        // guarded by ConfirmButton. It copies rather than applies: the index has
        // to be declared in `lunora/schema.ts`, which is what the migration
        // system tracks and what nothing here can write.
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
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- `advisories` IS `advisoriesQuery.data?.advisories`, destructured above and listed in the deps
    }, [advisories, insights, jumpToSchemaIndex, runtimeRows, t]);

    const toolbar = <ShardInput onChange={setShardKey} testId="in-shard-input" value={shardKey} />;

    return (
        <AdvisorView error={error} errorSource={error === null ? undefined : metricsQuery.errorSource} rows={rows} testId="lunora-insights" toolbar={toolbar} />
    );
};

export type { InsightsPanelProps };
