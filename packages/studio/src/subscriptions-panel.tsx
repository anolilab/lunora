import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import type { SubscriptionConnection, SubscriptionInfo, SubscriptionsResult } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { EmptyState } from "./components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { useT } from "./i18n-context";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal";
import { ShardInput } from "./shard-input";

interface SubscriptionsPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const LIST_SUBSCRIPTIONS = adminRef(ADMIN_FUNCTIONS.listSubscriptions);

/** Longest `args` JSON rendered inline before it's truncated; the full value stays in the cell `title`. */
const ARGS_MAX = 80;

/** Serialise a subscription's `args` to a compact, length-bounded string for the table cell. */
const formatArguments = (args: Record<string, unknown> | undefined): string => {
    if (args === undefined) {
        return "";
    }

    const json = JSON.stringify(args);

    return json.length > ARGS_MAX ? `${json.slice(0, ARGS_MAX)}…` : json;
};

/**
 * One flattened table row: a single subscription paired with the connection it
 * belongs to, plus a stable React key. Connections with no subscriptions still
 * surface one row (with a `null` subscription) so an idle socket is visible.
 */
interface SubscriptionRow {
    admin: boolean;
    connectionId: number;
    key: string;
    subscription: null | SubscriptionInfo;
}

/** Flatten the per-connection result into one row per subscription (or one empty row for an idle connection). */
const toRows = (connections: SubscriptionConnection[]): SubscriptionRow[] => {
    const rows: SubscriptionRow[] = [];

    for (const connection of connections) {
        const connectionId = connection.id.toString();

        if (connection.subscriptions.length === 0) {
            rows.push({ admin: connection.admin, connectionId: connection.id, key: `c${connectionId}`, subscription: null });

            continue;
        }

        connection.subscriptions.forEach((subscription, index) => {
            rows.push({ admin: connection.admin, connectionId: connection.id, key: `c${connectionId}-s${index.toString()}`, subscription });
        });
    }

    return rows;
};

const DASH = <span className="text-muted-foreground">—</span>;

/**
 * Realtime subscriptions inspector for one shard: a read-only snapshot of every
 * connected WebSocket on the shard's Durable Object and the live subscriptions
 * it tracks — the `functionPath`/`table`/args each watches, whether the socket
 * is an admin socket, and the aggregate connection / subscription counts. Reads
 * via the `__cirrus_admin__:listSubscriptions` RPC over the {@link useCirrus}
 * client; gated by the server's `CIRRUS_ADMIN_TOKEN`.
 *
 * This is a point-in-time read (sockets and their subscriptions are derived live
 * from the DO, nothing durable): it fetches on mount, on a shard-key change, and
 * on a manual refresh. Connection `id`s are the socket's index within a single
 * read — a label, not a stable identifier across reads.
 */
const SubscriptionsPanel = ({ initialShardKey }: SubscriptionsPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [result, setResult] = useState<null | SubscriptionsResult>(null);
    const [error, setError] = useState<null | string>(null);

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            setError(null);

            try {
                const next = (await client.query(LIST_SUBSCRIPTIONS, {}, callOptions(shard))) as SubscriptionsResult;

                setResult(next);
            } catch (error_) {
                setResult(null);
                setError(errorMessage(error_));
            }
        },
        [client],
    );

    // Fetch on mount and whenever the host changes the initial shard key.
    useEffect(() => {
        fireAndForget(refresh(initialShardKey ?? ""));
    }, [refresh, initialShardKey]);

    const refreshCurrent = useCallback((): void => {
        fireAndForget(refresh(shardKey));
    }, [refresh, shardKey]);

    const rows = result === null ? [] : toRows(result.connections);

    return (
        <div className="flex flex-col gap-4" data-testid="subs-panel">
            <div className="flex flex-wrap items-center gap-2">
                <ShardInput onChange={setShardKey} testId="subs-shard-input" value={shardKey} />
                <Button data-testid="subs-refresh" onClick={refreshCurrent} size="sm" type="button" variant="outline">
                    {t("Refresh")}
                </Button>
                {result !== null && (
                    <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground" data-testid="subs-count">
                        <Badge variant="secondary">{t("{count} connections", { count: result.totalConnections })}</Badge>
                        <Badge variant="secondary">{t("{count} subscriptions", { count: result.totalSubscriptions })}</Badge>
                    </div>
                )}
            </div>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="subs-error" role="alert">
                    {error}
                </p>
            )}

            {error === null && result !== null && rows.length === 0 && (
                <EmptyState
                    description={t("Active WebSocket subscriptions on this shard.")}
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
                            <path d="M5 12a7 7 0 0 1 14 0M8 12a4 4 0 0 1 8 0M12 12v8m0-8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />
                        </svg>
                    }
                    testId="subs-empty"
                    title={t("No active subscriptions.")}
                />
            )}

            {rows.length > 0 && (
                <Table data-testid="subs-table">
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t("Connection")}</TableHead>
                            <TableHead>{t("Function path")}</TableHead>
                            <TableHead>{t("Table")}</TableHead>
                            <TableHead>{t("Arguments")}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => {
                            const { subscription } = row;
                            const args = formatArguments(subscription?.args);

                            return (
                                <TableRow data-testid="subs-row" key={row.key}>
                                    <TableCell className="font-medium tabular-nums">
                                        <span className="inline-flex items-center gap-1.5">
                                            #{row.connectionId}
                                            {row.admin && <Badge variant="outline">{t("admin")}</Badge>}
                                        </span>
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">{subscription?.functionPath ?? DASH}</TableCell>
                                    <TableCell>{subscription?.table ?? DASH}</TableCell>
                                    <TableCell className="max-w-[32ch] truncate font-mono text-xs text-muted-foreground" title={args || undefined}>
                                        {args || DASH}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            )}
        </div>
    );
};

export default SubscriptionsPanel;
export type { SubscriptionsPanelProps };
