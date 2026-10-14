import type { ReactElement } from "react";

import ErrorAlert from "../../components/error-alert";
import { ShardInput } from "../../components/shard-input";
import StatCard from "../../components/stat-card";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useShardKey } from "../../hooks/use-shard-key";
import type { TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import type { FanoutMetricsResult, FanoutPathCounters, GlobalPollCounters, ShapeProbeCounters } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";

interface FanoutPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/** Format a coarse millisecond duration for a stat card. */
const formatMs = (ms: number): string => `${ms.toString()} ms`;

/**
 * True once a result has loaded and the shard has no connections and has recorded
 * no work at all on any counted path.
 *
 * Every counter the panel renders has to appear here: the probe and global-poll
 * tallies outlive the sockets that produced them (they reset on hibernation, not
 * on disconnect), so a predicate that ignored one would replace a shard's whole
 * recorded history with an empty state the moment its last socket dropped —
 * exactly when someone is looking at the panel to find out what it just did.
 *
 * Spelled out rather than scanned over the counter objects. A scan cannot fall
 * behind the fields it scans, but it also cannot tell a WORK count from a
 * derived one: `maxMs` and `peakSocketsIterated` are dimensions of the passes,
 * not passes, and a scan reads either as activity. One `passes`/`run`/`drains`
 * per path is the honest test, and a path added without a term here is a visible
 * omission rather than a silent over-reach.
 */
const isFanoutIdle = (result: FanoutMetricsResult): boolean =>
    result.totalConnections === 0 &&
    result.shapePoke.passes === 0 &&
    result.whisper.passes === 0 &&
    result.shapeProbe.run === 0 &&
    result.shapeProbe.served === 0 &&
    result.globalPoll.drains === 0 &&
    result.globalPoll.pairsSkipped === 0;

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
 * Read sharing on the shape-poke path: how many reads the shard issued to SQLite
 * versus how many the per-flush cache answered because another socket had
 * already asked the identical question. Both halves of the diff are counted —
 * the changed-key scan, keyed by `(table, op range)`, and the membership probe,
 * keyed by `(predicate, that same range)`.
 *
 * The two numbers are only meaningful together. `served` near zero is not a
 * problem to fix — it means this app's shape predicates genuinely vary per
 * caller (RLS on the caller's own id), so there is nothing to share. `served`
 * far above `run` is the shape of a broadly-subscribed public shape, where the
 * cache is doing the work a per-socket loop would have repeated.
 */
const ProbeCounters = ({ counters, t }: { counters: ShapeProbeCounters; t: TFunction }): ReactElement => (
    <section className="flex flex-col gap-2" data-testid="fanout-probe-section">
        <h3 className="text-sm font-medium text-foreground">{t("Membership probes")}</h3>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="fanout-probe-stats">
            <StatCard label={t("Queries run")} testId="fanout-probe-run" value={counters.run} />
            <StatCard label={t("Shared from cache")} testId="fanout-probe-served" value={counters.served} />
        </dl>
    </section>
);

/**
 * The `.global()` poll tallies, as their own section rather than another
 * {@link ProbeCounters} with different labels.
 *
 * The two are two numbers each and mean different things: a membership probe is
 * one question asked of the shard's own storage and answered from cache or not,
 * a global poll is a whole membership drain over the network against the
 * `(socket, shape)` pairs a tick never had to ask about. Rendering them through
 * one component made the captions the only thing keeping them apart.
 */
const GlobalPollCountersSection = ({ counters, t }: { counters: GlobalPollCounters; t: TFunction }): ReactElement => (
    <section className="flex flex-col gap-2" data-testid="fanout-global-poll-section">
        <h3 className="text-sm font-medium text-foreground">{t("Global shape polls")}</h3>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="fanout-global-poll-stats">
            <StatCard label={t("Global reads")} testId="fanout-global-poll-drains" value={counters.drains} />
            <StatCard label={t("Pairs skipped")} testId="fanout-global-poll-pairs-skipped" value={counters.pairsSkipped} />
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
                        <ProbeCounters counters={result.shapeProbe} t={t} />
                        <GlobalPollCountersSection counters={result.globalPoll} t={t} />
                    </section>
                </>
            )}
        </div>
    );
};

export default FanoutPanel;
export type { FanoutPanelProps };
