import type { ReactElement } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { ShardInput } from "../../components/shard-input";
import { StatCard } from "../../components/stat-card";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useShardKey } from "../../hooks/use-shard-key";
import type { TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import type { FanoutMetricsResult, FanoutPathCounters } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";

interface FanoutPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/** Format a coarse millisecond duration for a stat card. */
const formatMs = (ms: number): string => `${ms.toString()} ms`;

/** True once a result has loaded and the shard has no connections and has run no fan-out passes yet. */
const isFanoutIdle = (result: FanoutMetricsResult): boolean => result.totalConnections === 0 && result.shapePoke.passes === 0 && result.whisper.passes === 0;

/**
 * The running counters for one delivery path as a titled grid of stat cards.
 * `includeTiming` is `false` for the whisper path (a synchronous broadcast
 * captures no wall-clock — a DO clock advances only on awaited I/O — so the
 * `0`ms timing fields would mislead and are omitted rather than shown).
 */
const PathCounters = ({
    counters,
    includeTiming,
    prefix,
    t,
    title,
}: {
    counters: FanoutPathCounters;
    includeTiming: boolean;
    prefix: string;
    t: TFunction;
    title: string;
}): ReactElement => (
    <section className="flex flex-col gap-2" data-testid={`${prefix}-section`}>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid={`${prefix}-stats`}>
            <StatCard label={t("Passes")} testId={`${prefix}-passes`} value={counters.passes} />
            <StatCard label={t("Sockets iterated")} testId={`${prefix}-iterated`} value={counters.socketsIterated} />
            <StatCard label={t("Delivered")} testId={`${prefix}-delivered`} value={counters.socketsDelivered} />
            <StatCard label={t("Peak width")} testId={`${prefix}-peak`} value={counters.peakSocketsIterated} />
            {includeTiming && <StatCard label={t("Total time")} testId={`${prefix}-total-ms`} value={formatMs(counters.totalMs)} />}
            {includeTiming && <StatCard label={t("Max time")} testId={`${prefix}-max-ms`} value={formatMs(counters.maxMs)} />}
        </dl>
    </section>
);

/**
 * Fan-out observability for one shard (plan 075 Phase 1): the current
 * per-topic/shape subscriber counts and the running per-flush fan-out cost of
 * the reactive shape-poke and whisper-broadcast paths. Reads the
 * `__lunora_admin__:getFanoutMetrics` RPC via {@link useAdminQuery} (gated by the
 * server's `LUNORA_ADMIN_TOKEN`).
 *
 * This makes the O(subscribers) fan-out cost visible — the "you can see it
 * scale" half of the auto-elastic relay tier, before any topology change exists.
 * Subscriber counts are a point-in-time read (no write-flush fires on a
 * connect/disconnect) and the cost counters reset when the DO hibernates, so the
 * panel polls on a fixed interval to stay current without a manual refresh.
 */
const FanoutPanel = ({ initialShardKey }: FanoutPanelProps): ReactElement => {
    const t = useT();

    const { queryShardKey, setShardKey, shardKey } = useShardKey(initialShardKey);

    const {
        data: result,
        error,
        errorSource,
        refetch,
    } = useAdminQuery<FanoutMetricsResult>(ADMIN_FUNCTIONS.getFanoutMetrics, {}, { keepPreviousData: true, shardKey: queryShardKey });

    // Point-in-time DO read — poll to keep the snapshot current without a manual refresh.
    useAutoRefresh(refetch, true);

    const isIdle = result !== undefined && isFanoutIdle(result);

    return (
        <div className="flex flex-col gap-4" data-testid="fanout-panel">
            <div className="flex flex-wrap items-center gap-2">
                <ShardInput onChange={setShardKey} testId="fanout-shard-input" value={shardKey} />
                {result !== undefined && (
                    <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground" data-testid="fanout-count">
                        {result.promoted && (
                            <Badge data-testid="fanout-promoted" variant={result.relayCount >= result.maxRelays ? "destructive" : "default"}>
                                {result.relayCount >= result.maxRelays
                                    ? t("auto-scaled: {relayCount}/{maxRelays} relays (at ceiling)", {
                                          maxRelays: result.maxRelays,
                                          relayCount: result.relayCount,
                                      })
                                    : t("auto-scaled: {relayCount}/{maxRelays} relays", { maxRelays: result.maxRelays, relayCount: result.relayCount })}
                            </Badge>
                        )}
                        <Badge variant="secondary">{t("{count} connections", { count: result.totalConnections })}</Badge>
                        <Badge variant="secondary">{t("peak {count} subscribers", { count: result.peakSubscribers })}</Badge>
                    </div>
                )}
            </div>

            {error !== null && <ErrorAlert error={errorSource} testId="fanout-error" />}

            {error === null && isIdle && (
                <EmptyState
                    description={t("Realtime fan-out cost and per-topic subscriber counts for this shard.")}
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
                            <path d="M4 12h4l3 7 4-14 3 7h2" />
                        </svg>
                    }
                    testId="fanout-empty"
                    title={t("No fan-out activity yet.")}
                />
            )}

            {error === null && result !== undefined && !isIdle && (
                <>
                    {result.topics.length > 0 && (
                        <section className="flex flex-col gap-2" data-testid="fanout-topics-section">
                            <h3 className="text-sm font-medium text-foreground">{t("Hot topics")}</h3>
                            <Card className="overflow-hidden py-0">
                                <Table data-testid="fanout-topics-table">
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t("Topic")}</TableHead>
                                            <TableHead>{t("Kind")}</TableHead>
                                            <TableHead className="text-right">{t("Subscribers")}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {result.topics.map((topic) => (
                                            <TableRow data-testid="fanout-topic-row" key={`${topic.kind}:${topic.topic}`}>
                                                <TableCell className="font-mono text-xs">{topic.topic}</TableCell>
                                                <TableCell>
                                                    <Badge variant="outline">{topic.kind}</Badge>
                                                </TableCell>
                                                <TableCell className="text-right font-medium tabular-nums">{topic.subscribers}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </Card>
                        </section>
                    )}

                    <section className="flex flex-col gap-3" data-testid="fanout-cost">
                        <h2 className="text-sm font-medium text-muted-foreground">{t("Fan-out cost since this instance woke")}</h2>
                        <PathCounters counters={result.shapePoke} includeTiming prefix="fanout-poke" t={t} title={t("Shape pokes")} />
                        <PathCounters counters={result.whisper} includeTiming={false} prefix="fanout-whisper" t={t} title={t("Whisper broadcasts")} />
                    </section>
                </>
            )}
        </div>
    );
};

export default FanoutPanel;
export type { FanoutPanelProps };
