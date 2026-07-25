import type { ClientDebugSnapshot } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useCallback } from "react";

import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useClientQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";

/** How often the snapshot is re-read. `client.debug()` is pull-only and allocation-cheap. */
const POLL_INTERVAL_MS = 2000;

/** Socket states that should read as healthy. */
const HEALTHY_WS_STATES = new Set(["open"]);

interface SyncClientPanelProps {
    /**
     * Injectable snapshot reader, used by tests to feed a canned
     * {@link ClientDebugSnapshot}. When omitted the panel reads the live
     * `client.debug()` of the connected studio client.
     */
    readonly read?: () => ClientDebugSnapshot;
}

/**
 * The **client half** of the realtime picture: what this browser's sync client
 * believes right now — per-shard socket state and confirmed mutation watermark, every
 * live query / shape subscription with its cursor and ack state, and the offline-queue
 * depth.
 *
 * It pairs with the subscriptions panel above it, which reports the same connections
 * from the *server's* side (the DO's admin view). When the two disagree — a
 * subscription the server lists but this client shows unacked, or a watermark the
 * server has advanced past — that gap is the bug.
 *
 * **Scope caveat, and it matters:** this reads the client running in *this Studio
 * page*, not the client in your application. It cannot tell you why a specific
 * overlay is stuck in your app — for that, call `client.debug()` there (from a
 * devtools console, or render it in your own debug view). What it does give you is a
 * live, real client against the same deployment, which is enough to answer "is the
 * deployment poking at all", "does a shape subscription ack here", and "has this
 * shard's watermark advanced".
 */
const SyncClientPanel = ({ read }: SyncClientPanelProps): ReactElement => {
    const t = useT();
    const client = useLunora();

    // `client.debug()` is a synchronous read of in-memory state, but it rides the
    // studio's one data primitive anyway so the panel gets the same polling, suspense
    // and error behaviour as every other panel. Passed as a plain reference (not an
    // inline literal) so it stays opaque to the query-key exhaustive-deps lint — the
    // key encodes the real input, which is just "which reader".
    // `useClientQuery` wants a promise-returning fetcher; the read itself is
    // synchronous, so resolve it rather than marking the arrow `async` for nothing.
    const sample = useCallback((): Promise<ClientDebugSnapshot> => Promise.resolve(read ? read() : client.debug()), [client, read]);

    const { data: snapshot, refetch } = useClientQuery<ClientDebugSnapshot>(["lunora-studio", "sync-client-debug", read ? "injected" : "live"], sample);

    // The snapshot has no push channel — it's in-memory client state — so polling is
    // the honest "live" here, exactly as for the HTTP-only panels.
    useAutoRefresh(refetch, true, POLL_INTERVAL_MS);

    if (!snapshot) {
        return (
            <Card>
                <CardContent>
                    <EmptyState description={t("Reading the sync client's state…")} title={t("Sync client")} />
                </CardContent>
            </Card>
        );
    }

    const { pendingWrites, shards, subscriptions } = snapshot;

    return (
        <Card>
            <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{t("This Studio session's sync client")}</span>
                    <Badge variant={snapshot.connectionStatus === "connected" ? "default" : "secondary"}>{snapshot.connectionStatus}</Badge>
                    {pendingWrites > 0 ? <Badge variant="secondary">{t("{count} pending writes", { count: pendingWrites })}</Badge> : null}
                </div>

                <p className="text-muted-foreground text-xs">
                    {t(
                        "Reads client.debug() for the client running in this page — not your application's client. Call client.debug() in your app to diagnose a specific stuck overlay there.",
                    )}
                </p>

                {shards.length === 0 ? (
                    <EmptyState description={t("No shard connection has been opened yet.")} title={t("No shards")} />
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("Shard")}</TableHead>
                                <TableHead>{t("Socket")}</TableHead>
                                <TableHead>{t("Confirmed watermark")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {shards.map((shard) => (
                                <TableRow key={shard.shardKey ?? "__default__"}>
                                    <TableCell>{shard.shardKey ?? t("(default)")}</TableCell>
                                    <TableCell>
                                        <Badge variant={HEALTHY_WS_STATES.has(shard.wsState) ? "default" : "secondary"}>{shard.wsState}</Badge>
                                    </TableCell>
                                    {/* The number to check first when an optimistic overlay won't clear. */}
                                    <TableCell>{shard.confirmedMutationWatermark}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}

                {subscriptions.length === 0 ? (
                    <EmptyState description={t("This client holds no live queries or shapes.")} title={t("No subscriptions")} />
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("Subscription")}</TableHead>
                                <TableHead>{t("Kind")}</TableHead>
                                <TableHead>{t("Acked")}</TableHead>
                                <TableHead>{t("Cursor")}</TableHead>
                                <TableHead>{t("Pending overlays")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {subscriptions.map((subscription) => (
                                <TableRow key={subscription.id}>
                                    <TableCell className="font-mono text-xs">{subscription.functionPath}</TableCell>
                                    <TableCell>{subscription.kind}</TableCell>
                                    <TableCell>
                                        <Badge variant={subscription.acked ? "default" : "secondary"}>{subscription.acked ? t("yes") : t("no")}</Badge>
                                    </TableCell>
                                    <TableCell>{subscription.serverCursor ?? "—"}</TableCell>
                                    {/* A non-zero count with no write in flight is a leaked overlay. */}
                                    <TableCell>{subscription.pendingOptimisticLayers}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    );
};

export default SyncClientPanel;
